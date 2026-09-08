import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import { AuthDeniedError, type AuthService, type AuthUser } from "./service.js";
import { mintAcceptanceLoginCode } from "./acceptance-provider.js";

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
  if (!ALIAS_PATTERN.test(value)) throw new AuthDeniedError("ACCEPTANCE_ALIAS_INVALID", "验收身份无效");
  return value;
};

export function mintAcceptanceControlCode(
  secret: string,
  now = Date.now(),
  ttlMs = CONTROL_CODE_TTL_MS,
): string {
  if (secret.length < 32) throw new Error("Acceptance lab secret is too short");
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > CONTROL_CODE_TTL_MS) {
    throw new Error("Acceptance control code lifetime is invalid");
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
    throw new AuthDeniedError("ACCEPTANCE_CONTROL_INVALID", "验收控制凭证无效");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new AuthDeniedError("ACCEPTANCE_CONTROL_INVALID", "验收控制凭证无效");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new AuthDeniedError("ACCEPTANCE_CONTROL_INVALID", "验收控制凭证无效");
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
    throw new AuthDeniedError("ACCEPTANCE_CONTROL_EXPIRED", "验收控制凭证已过期或无效");
  }
  return { purpose: "acceptance-control", expiresAt, nonce: payload.nonce };
};

export class AcceptanceControlService {
  private readonly sessions = new Map<string, number>();
  private readonly consumedCodes = new Map<string, number>();
  private loginSequence = 0;

  constructor(
    private readonly database: Pick<Pool, "query">,
    private readonly auth: AuthService,
    private readonly secret: string,
    private readonly now: () => number = Date.now,
  ) {
    if (secret.length < 32) throw new Error("Acceptance lab secret is too short");
  }

  begin(code: string): string {
    this.cleanup();
    const payload = readControlCode(code, this.secret, this.now());
    const codeHash = hash(code);
    if (this.consumedCodes.has(codeHash)) {
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_REPLAYED", "验收控制凭证已使用");
    }
    this.consumedCodes.set(codeHash, payload.expiresAt);
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
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_REQUIRED", "请先取得验收控制权限");
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
       WHERE i.provider='dingtalk'
         AND i.provider_user_id LIKE 'uat-%'
         AND i.union_id LIKE 'uat-union-%'
       GROUP BY i.user_id,i.provider_user_id,u.display_name,i.active,i.employed
       ORDER BY i.provider_user_id`,
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

  async switchIdentity(
    token: string | undefined,
    alias: string,
  ): Promise<{ token: string; user: AuthUser }> {
    this.assertControl(token);
    const normalized = normalizeAlias(alias);
    const identities = await this.listIdentities(token);
    if (!identities.some((identity) => identity.alias === normalized && identity.active && identity.employed)) {
      throw new AuthDeniedError("ACCEPTANCE_IDENTITY_UNAVAILABLE", "验收身份不存在或不可用");
    }
    this.loginSequence = (this.loginSequence + 1) % 1_000;
    const loginCode = mintAcceptanceLoginCode(
      normalized,
      this.secret,
      this.now(),
      5 * 60_000 + this.loginSequence,
    );
    return this.auth.loginMobile(loginCode);
  }

  async end(controlToken: string | undefined, businessToken?: string): Promise<void> {
    this.assertControl(controlToken);
    this.sessions.delete(hash(controlToken!));
    if (businessToken) await this.auth.logout(businessToken);
  }

  private cleanup(): void {
    const now = this.now();
    for (const [key, expiresAt] of this.sessions) if (expiresAt <= now) this.sessions.delete(key);
    for (const [key, expiresAt] of this.consumedCodes) if (expiresAt <= now) this.consumedCodes.delete(key);
  }
}
