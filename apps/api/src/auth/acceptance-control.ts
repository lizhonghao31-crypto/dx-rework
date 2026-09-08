import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import { DingTalkProtocolError } from "./provider.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const CONTROL_CODE_TTL_MS = 5 * 60_000;
const CONTROL_SESSION_TTL_MS = 8 * 60 * 60_000;
const MAX_CONTROL_SESSIONS = 32;

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
  private readonly sessions = new Map<string, number>();
  private loginSequence = 0;

  constructor(
    private readonly database: Pick<Pool, "query">,
    private readonly corporationId: string,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new DingTalkProtocolError("Acceptance lab secret is too short");
  }

  async begin(code: string): Promise<string> {
    this.cleanup();
    const payload = readControlCode(code, this.secret, this.now());
    const consumed = await this.database.query(
      "INSERT INTO auth_consumed_codes(code_hash,expires_at) VALUES($1,$2) ON CONFLICT DO NOTHING",
      [hash(`acceptance-control:${code}`), new Date(payload.expiresAt)],
    );
    if (consumed.rowCount !== 1) {
      throw new DingTalkProtocolError("Acceptance control code has already been used");
    }
    if (this.sessions.size >= MAX_CONTROL_SESSIONS) {
      const oldest = this.sessions.keys().next().value as string | undefined;
      if (oldest) this.sessions.delete(oldest);
    }
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(hash(token), this.now() + CONTROL_SESSION_TTL_MS);
    return token;
  }

  assertControl(token: string | undefined): void {
    this.cleanup();
    if (!token || !this.sessions.has(hash(token))) {
      throw new DingTalkProtocolError("Acceptance control session is required");
    }
  }

  async listIdentities(token: string | undefined): Promise<readonly AcceptanceControlIdentity[]> {
    this.assertControl(token);
    const result = await this.database.query<IdentityRow>(
      `SELECT i.user_id,i.provider_user_id,u.display_name,i.active,i.employed,
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
       GROUP BY i.user_id,i.provider_user_id,u.display_name,i.active,i.employed
       ORDER BY i.provider_user_id`,
      [this.corporationId],
    );
    return result.rows.map((row) => ({
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
    this.assertControl(token);
    const normalized = normalizeAlias(alias);
    const identities = await this.listIdentities(token);
    if (!identities.some((identity) => identity.alias === normalized && identity.active && identity.employed)) {
      throw new DingTalkProtocolError("Acceptance identity is unavailable");
    }
    await this.revokeBusinessSessions();
    this.loginSequence = (this.loginSequence + 1) % 1_000;
    const expiresAt = this.now() + 5 * 60_000 + this.loginSequence;
    const payload = Buffer.from(JSON.stringify({ alias: normalized, expiresAt }), "utf8").toString("base64url");
    const loginSignature = createHmac("sha256", this.secret)
      .update(`dx-acceptance:${payload}`)
      .digest("hex");
    return `${payload}.${loginSignature}`;
  }

  async end(token: string | undefined): Promise<void> {
    this.assertControl(token);
    await this.revokeBusinessSessions();
    this.sessions.delete(hash(token!));
  }

  private async revokeBusinessSessions(): Promise<void> {
    await this.database.query(
      `UPDATE auth_sessions session
       SET revoked_at=$1
       FROM identity_mappings identity
       WHERE session.user_id=identity.user_id
         AND identity.provider='dingtalk'
         AND identity.corp_id=$2
         AND identity.provider_user_id LIKE 'uat-%'
         AND identity.union_id LIKE 'uat-union-%'
         AND session.revoked_at IS NULL`,
      [new Date(this.now()), this.corporationId],
    );
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
  }
}
