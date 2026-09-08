import { createHmac, timingSafeEqual } from "node:crypto";

import type { Pool } from "pg";

import {
  AcceptanceControlAuthority,
  type AcceptanceControlIdentity,
} from "./acceptance-control.js";
import {
  DingTalkProtocolError,
  OfficialDingTalkProvider,
  type DingTalkIdentity,
  type DirectoryOrganizationMember,
  type OrganizationMember,
} from "./provider.js";

const ALIAS_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const PROVIDER_PREFIX = "uat-";
const UNION_PREFIX = "uat-union-";
const DEFAULT_TTL_MS = 5 * 60_000;
const MAX_TTL_MS = 10 * 60_000;

type AcceptanceCodePayload = Readonly<{
  alias: string;
  expiresAt: number;
}>;

type AcceptanceIdentityRow = Readonly<{
  provider_user_id: string;
  union_id: string;
  display_name: string;
  active: boolean;
  employed: boolean;
  department_names?: string[];
}>;

export type AcceptanceIdentityDatabase = Pick<Pool, "query">;

const signature = (payload: string, secret: string): string =>
  createHmac("sha256", secret).update(`dx-acceptance:${payload}`).digest("hex");

const secureEqual = (left: string, right: string): boolean => {
  if (!/^[0-9a-f]{64}$/i.test(left) || !/^[0-9a-f]{64}$/i.test(right)) return false;
  return timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));
};

const normalizeAlias = (alias: string): string => {
  const value = alias.trim().toLowerCase();
  if (!ALIAS_PATTERN.test(value)) {
    throw new DingTalkProtocolError("Acceptance identity alias is invalid");
  }
  return value;
};

export function mintAcceptanceLoginCode(
  alias: string,
  secret: string,
  now = Date.now(),
  ttlMs = DEFAULT_TTL_MS,
): string {
  if (secret.length < 32) throw new DingTalkProtocolError("Acceptance lab secret is too short");
  if (!Number.isInteger(ttlMs) || ttlMs < 1_000 || ttlMs > MAX_TTL_MS) {
    throw new DingTalkProtocolError("Acceptance login code lifetime is invalid");
  }
  const payload: AcceptanceCodePayload = {
    alias: normalizeAlias(alias),
    expiresAt: now + ttlMs,
  };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(encoded, secret)}`;
}

const readAcceptanceLoginCode = (
  code: string,
  secret: string,
  now: number,
): AcceptanceCodePayload => {
  const [encoded, presentedSignature, extra] = code.split(".");
  if (!encoded || !presentedSignature || extra !== undefined) {
    throw new DingTalkProtocolError("Acceptance login code is invalid");
  }
  if (!secureEqual(presentedSignature, signature(encoded, secret))) {
    throw new DingTalkProtocolError("Acceptance login code signature is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    throw new DingTalkProtocolError("Acceptance login code payload is invalid");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DingTalkProtocolError("Acceptance login code payload is invalid");
  }
  const payload = value as Partial<AcceptanceCodePayload>;
  const alias = typeof payload.alias === "string" ? normalizeAlias(payload.alias) : "";
  const expiresAt = Number(payload.expiresAt);
  if (!alias || !Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt - now > MAX_TTL_MS) {
    throw new DingTalkProtocolError("Acceptance login code has expired or is invalid");
  }
  return { alias, expiresAt };
};

export class AcceptanceDingTalkProvider extends OfficialDingTalkProvider {
  private readonly control: AcceptanceControlAuthority;

  constructor(
    private readonly acceptanceDatabase: AcceptanceIdentityDatabase,
    private readonly acceptanceCorporationId: string,
    private readonly acceptanceSecret: string,
    private readonly acceptanceNow: () => number = Date.now,
  ) {
    super({
      corpId: acceptanceCorporationId,
      h5AppKey: "acceptance-disabled",
      h5AppSecret: "acceptance-disabled",
      webClientId: "acceptance-disabled",
      webClientSecret: "acceptance-disabled",
      qrRedirectUri: "https://acceptance.invalid/auth/qr/callback",
    });
    if (acceptanceSecret.length < 32) {
      throw new DingTalkProtocolError("Acceptance lab secret is too short");
    }
    this.control = new AcceptanceControlAuthority(
      acceptanceDatabase,
      acceptanceCorporationId,
      acceptanceSecret,
      acceptanceNow,
    );
  }

  beginAcceptanceControl(code: string): Promise<string> {
    return this.control.begin(code);
  }

  listAcceptanceIdentities(token: string | undefined): Promise<readonly AcceptanceControlIdentity[]> {
    return this.control.listIdentities(token);
  }

  issueAcceptanceLoginCode(token: string | undefined, alias: string): Promise<string> {
    return this.control.issueLoginCode(token, alias);
  }

  endAcceptanceControl(token: string | undefined): Promise<void> {
    return this.control.end(token);
  }

  override buildQrAuthorizationUrl(state: string): string {
    void state;
    throw new DingTalkProtocolError("Acceptance lab does not support QR login");
  }

  override async exchangeMobileCode(code: string): Promise<DingTalkIdentity> {
    const payload = readAcceptanceLoginCode(code, this.acceptanceSecret, this.acceptanceNow());
    const member = await this.memberByProviderUserId(`${PROVIDER_PREFIX}${payload.alias}`);
    if (!member) throw new DingTalkProtocolError("Acceptance identity was not found");
    return { userId: member.userId, unionId: member.unionId, corpId: member.corpId };
  }

  override async exchangeQrCode(code: string): Promise<DingTalkIdentity> {
    void code;
    throw new DingTalkProtocolError("Acceptance lab does not support QR login");
  }

  override async getOrganizationMember(identity: DingTalkIdentity, corpId: string): Promise<OrganizationMember | null> {
    if (corpId !== this.acceptanceCorporationId || (identity.corpId && identity.corpId !== corpId)) return null;
    if (!identity.userId.startsWith(PROVIDER_PREFIX) || !identity.unionId.startsWith(UNION_PREFIX)) return null;
    const member = await this.memberByProviderUserId(identity.userId);
    if (!member || member.unionId !== identity.unionId) return null;
    return member;
  }

  override async listOrganizationMembers(corpId: string): Promise<DirectoryOrganizationMember[]> {
    if (corpId !== this.acceptanceCorporationId) {
      throw new DingTalkProtocolError("Acceptance directory belongs to a different corporation");
    }
    const result = await this.acceptanceDatabase.query<AcceptanceIdentityRow>(
      `SELECT i.provider_user_id,i.union_id,u.display_name,i.active,i.employed,
              COALESCE(profile.department_names,'{}'::text[]) department_names
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       LEFT JOIN employee_directory_profiles profile ON profile.user_id=u.id
       WHERE i.provider='dingtalk' AND i.corp_id=$1
         AND i.provider_user_id LIKE 'uat-%'
         AND i.union_id LIKE 'uat-union-%'
       ORDER BY i.provider_user_id`,
      [corpId],
    );
    return result.rows.map((row) => ({
      corpId,
      userId: row.provider_user_id,
      unionId: row.union_id,
      displayName: row.display_name,
      active: row.active,
      employed: row.employed,
      departmentNames: row.department_names ?? [],
    }));
  }

  private async memberByProviderUserId(providerUserId: string): Promise<OrganizationMember | null> {
    if (!providerUserId.startsWith(PROVIDER_PREFIX)) return null;
    const result = await this.acceptanceDatabase.query<AcceptanceIdentityRow>(
      `SELECT i.provider_user_id,i.union_id,u.display_name,i.active,i.employed
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       WHERE i.provider='dingtalk' AND i.corp_id=$1
         AND i.provider_user_id=$2
         AND i.provider_user_id LIKE 'uat-%'
         AND i.union_id LIKE 'uat-union-%'
       LIMIT 1`,
      [this.acceptanceCorporationId, providerUserId],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      corpId: this.acceptanceCorporationId,
      userId: row.provider_user_id,
      unionId: row.union_id,
      displayName: row.display_name,
      active: row.active,
      employed: row.employed,
    };
  }
}
