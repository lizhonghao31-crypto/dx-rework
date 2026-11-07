import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";
import { DEFAULT_SESSION_TTL_SECONDS, MAX_ACCEPTANCE_SESSION_TTL_SECONDS } from "@dx-rework/config";

import { DingTalkProtocolError } from "./provider.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTROL_CODE_TTL_MS = 5 * 60_000;
const RETIRED_ACCEPTANCE_ALIASES = new Set([
  "administrative-clerk",
  "sample-approver",
  "tail-inspector",
]);

type ControlCodePayload = Readonly<{
  purpose: "acceptance-control";
  expiresAt: number;
  nonce: string;
}>;

export type AcceptanceControlIdentity = Readonly<{
  alias: string;
  userId: string;
  displayName: string;
  active: boolean;
  employed: boolean;
  roleCodes: readonly string[];
  capabilities: readonly string[];
}>;

type IdentityRow = Readonly<{
  user_id: string;
  provider_user_id: string;
  display_name: string;
  active: boolean;
  employed: boolean;
  role_codes: string[] | null;
  capabilities: string[] | null;
}>;

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
const sign = (encoded: string, secret: string): string =>
  createHmac("sha256", secret).update(`dx-acceptance-control:${encoded}`).digest("hex");

const secureEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const normalizeAlias = (alias: string): string => {
  const value = alias.trim().toLowerCase();
  if (!ALIAS_PATTERN.test(value)) throw new DingTalkProtocolError("Acceptance identity alias is invalid");
  return value;
};

export function mintAcceptanceControlCode(
  secret: string,
  now = Date.now(),
  ttlMs = CONTROL_CODE_TTL_MS,
): string {
  if (secret.length < 32) throw new DingTalkProtocolError("Acceptance lab secret is too short");
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > CONTROL_CODE_TTL_MS) {
    throw new DingTalkProtocolError("Acceptance control code lifetime is invalid");
  }
  const payload: ControlCodePayload = {
    purpose: "acceptance-control",
    expiresAt: now + ttlMs,
    nonce: randomBytes(16).toString("base64url"),
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, secret)}`;
}

const readControlCode = (code: string, secret: string, now: number): ControlCodePayload => {
  const [encoded, presentedSignature, extra] = code.split(".");
  if (!encoded || !presentedSignature || extra !== undefined || !secureEqual(presentedSignature, sign(encoded, secret))) {
    throw new DingTalkProtocolError("Acceptance control code is invalid");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new DingTalkProtocolError("Acceptance control code is invalid");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new DingTalkProtocolError("Acceptance control code is invalid");
  }
  const payload = parsed as Partial<ControlCodePayload>;
  const expiresAt = Number(payload.expiresAt);
  if (
    payload.purpose !== "acceptance-control"
    || typeof payload.nonce !== "string"
    || payload.nonce.length < 10
    || !Number.isSafeInteger(expiresAt)
    || expiresAt <= now
    || expiresAt - now > CONTROL_CODE_TTL_MS
  ) {
    throw new DingTalkProtocolError("Acceptance control code has expired or is invalid");
  }
  return { purpose: "acceptance-control", expiresAt, nonce: payload.nonce };
};

export class AcceptanceControlAuthority {
  constructor(
    private readonly database: Pick<Pool, "query">,
    private readonly corporationId: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
    private readonly sessionTtlSeconds = DEFAULT_SESSION_TTL_SECONDS,
  ) {
    if (secret.length < 32) throw new DingTalkProtocolError("Acceptance lab secret is too short");
    if (!Number.isInteger(sessionTtlSeconds) || sessionTtlSeconds < 300 || sessionTtlSeconds > MAX_ACCEPTANCE_SESSION_TTL_SECONDS) {
      throw new DingTalkProtocolError("Acceptance session lifetime is invalid");
    }
  }

  async begin(code: string): Promise<string> {
    const now = this.now();
    const payload = readControlCode(code, this.secret, now);
    // Expired controllers cannot have a live bound business session: binding clamps its expiry.
    await this.database.query("DELETE FROM acceptance_control_sessions WHERE corp_id=$1 AND expires_at<=$2", [this.corporationId, new Date(now)]);
    const token = randomBytes(32).toString("base64url");
    const consumed = await this.database.query(
      `WITH consumed AS (
         INSERT INTO auth_consumed_codes(code_hash,expires_at) VALUES($1,$2)
         ON CONFLICT DO NOTHING RETURNING code_hash
       )
       INSERT INTO acceptance_control_sessions(token_hash,corp_id,authority_hash,created_at,expires_at)
       SELECT $3,$4,$5,$6,$7 FROM consumed`,
      [hash(`acceptance-control:${code}`), new Date(payload.expiresAt), this.tokenHash(token),
        this.corporationId, this.authorityHash(), new Date(now), new Date(now + this.sessionTtlSeconds * 1000)],
    );
    if (consumed.rowCount !== 1) {
      throw new DingTalkProtocolError("Acceptance control code has already been used");
    }
    return token;
  }

  async assertControl(token: string | undefined): Promise<void> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) {
      throw new DingTalkProtocolError("Acceptance control session is required");
    }
    const result = await this.database.query(
      `SELECT token_hash FROM acceptance_control_sessions
       WHERE token_hash=$1 AND corp_id=$2 AND authority_hash=$3 AND revoked_at IS NULL AND expires_at>$4`,
      [this.tokenHash(token), this.corporationId, this.authorityHash(), new Date(this.now())],
    );
    if (result.rowCount !== 1) {
      throw new DingTalkProtocolError("Acceptance control session is required");
    }
  }

  async listIdentities(token: string | undefined): Promise<readonly AcceptanceControlIdentity[]> {
    await this.assertControl(token);
    const result = await this.database.query<IdentityRow>(
      `SELECT i.user_id,i.provider_user_id,u.display_name,(i.active AND u.enabled) AS active,i.employed,
              COALESCE(array_agg(DISTINCT ura.role_code ORDER BY ura.role_code)
                FILTER (WHERE ura.role_code IS NOT NULL),'{}'::text[]) role_codes,
              COALESCE(array_agg(DISTINCT rc.capability ORDER BY rc.capability)
                FILTER (WHERE rc.capability IS NOT NULL),'{}'::text[]) capabilities
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       LEFT JOIN user_role_assignments ura ON ura.user_id=i.user_id AND ura.revoked_at IS NULL
       LEFT JOIN role_capabilities rc ON rc.role_code=ura.role_code
       WHERE i.provider='dingtalk' AND i.corp_id=$1
         AND i.provider_user_id LIKE 'uat-%'
         AND i.union_id LIKE 'uat-union-%'
       GROUP BY i.user_id,i.provider_user_id,u.display_name,i.active,i.employed,u.enabled
       ORDER BY i.provider_user_id`,
      [this.corporationId],
    );
    return result.rows
      .filter((row) => !RETIRED_ACCEPTANCE_ALIASES.has(row.provider_user_id.slice(4)))
      .map((row) => ({
        alias: row.provider_user_id.slice(4),
        userId: row.user_id,
        displayName: row.display_name,
        active: row.active,
        employed: row.employed,
        roleCodes: row.role_codes ?? [],
        capabilities: row.capabilities ?? [],
      }));
  }

  async issueLoginCode(token: string | undefined, alias: string): Promise<string> {
    const normalized = normalizeAlias(alias);
    const identities = await this.listIdentities(token);
    if (!identities.some((identity) => identity.alias === normalized && identity.active && identity.employed)) {
      throw new DingTalkProtocolError("Acceptance identity is unavailable");
    }
    const expiresAt = this.now() + 5 * 60_000;
    const payload = Buffer.from(JSON.stringify({ alias: normalized, expiresAt, nonce: randomBytes(16).toString("base64url") }), "utf8").toString("base64url");
    const loginSignature = createHmac("sha256", this.secret)
      .update(`dx-acceptance:${payload}`)
      .digest("hex");
    return `${payload}.${loginSignature}`;
  }

  async end(token: string | undefined): Promise<void> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return;
    await this.database.query(
      `WITH ended AS (
         UPDATE acceptance_control_sessions SET revoked_at=COALESCE(revoked_at,$4)
         WHERE token_hash=$1 AND corp_id=$2 AND authority_hash=$3 RETURNING business_token_hash
       )
       UPDATE auth_sessions session SET revoked_at=COALESCE(session.revoked_at,$4)
       FROM ended WHERE session.token_hash=ended.business_token_hash`,
      [this.tokenHash(token), this.corporationId, this.authorityHash(), new Date(this.now())],
    );
  }

  async bindBusinessSession(token: string | undefined, businessTokenHash: string): Promise<void> {
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token) || !/^[0-9a-f]{64}$/.test(businessTokenHash)) {
      throw new DingTalkProtocolError("Acceptance control session is required");
    }
    // Lock the controller before reading its current pointer. Switch/end across processes
    // serialize on this row, rather than revoking other browsers or racing a stale snapshot.
    const result = await this.database.query(
      `WITH controller AS MATERIALIZED (
         SELECT token_hash,business_token_hash,expires_at FROM acceptance_control_sessions
         WHERE token_hash=$1 AND corp_id=$2 AND authority_hash=$3 AND revoked_at IS NULL AND expires_at>$4
         FOR UPDATE
       ), new_session AS (
         UPDATE auth_sessions session SET expires_at=LEAST(session.expires_at,controller.expires_at)
         FROM controller,identity_mappings identity,app_users app_user
         WHERE session.token_hash=$5 AND session.revoked_at IS NULL AND session.expires_at>$4
           AND identity.user_id=session.user_id AND app_user.id=session.user_id AND app_user.enabled
           AND identity.provider='dingtalk' AND identity.corp_id=$2
           AND identity.provider_user_id LIKE 'uat-%' AND identity.union_id LIKE 'uat-union-%'
           AND identity.active AND identity.employed
         RETURNING session.token_hash
       ), revoked_previous AS (
         UPDATE auth_sessions session SET revoked_at=$4 FROM controller,new_session
         WHERE session.token_hash=controller.business_token_hash AND session.token_hash<>new_session.token_hash
           AND session.revoked_at IS NULL RETURNING session.id
       )
       UPDATE acceptance_control_sessions target SET business_token_hash=new_session.token_hash
       FROM controller,new_session WHERE target.token_hash=controller.token_hash
       RETURNING target.token_hash`,
      [this.tokenHash(token), this.corporationId, this.authorityHash(), new Date(this.now()), businessTokenHash],
    );
    if (result.rowCount !== 1) throw new DingTalkProtocolError("Acceptance control session is required");
  }

  async assertBusinessSession(businessTokenHash: string): Promise<void> {
    const result = await this.database.query(
      `SELECT token_hash FROM acceptance_control_sessions
       WHERE business_token_hash=$1 AND corp_id=$2 AND authority_hash=$3 AND revoked_at IS NULL AND expires_at>$4`,
      [businessTokenHash, this.corporationId, this.authorityHash(), new Date(this.now())],
    );
    if (result.rowCount !== 1) throw new DingTalkProtocolError("Acceptance control session is required");
  }

  private tokenHash(token: string): string {
    return createHmac("sha256", this.secret).update(`dx-acceptance-session:${this.corporationId}:${token}`).digest("hex");
  }

  private authorityHash(): string {
    return createHmac("sha256", this.secret).update(`dx-acceptance-authority:${this.corporationId}`).digest("hex");
  }
}
