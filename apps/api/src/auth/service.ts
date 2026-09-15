import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import type { AcceptanceControlIdentity } from "./acceptance-control.js";
import type { DingTalkIdentity, DingTalkProvider, OrganizationMember } from "./provider.js";

export type AuthUser = Readonly<{ id: string; displayName: string; capabilities: readonly string[]; businessRoles?: readonly string[]; effectiveWriteCapabilities?: readonly string[]; readOnlyModules?: readonly ("rework" | "sourcing")[] }>;
export type SessionRecord = Readonly<{ id: string; tokenHash: string; userId: string; expiresAt: Date; revokedAt: Date | null }>;
export type QrChallenge = Readonly<{ stateHash: string; bindingHash: string; expiresAt: Date; usedAt: Date | null }>;
export type SessionIdentity = Readonly<{ userId: string; unionId: string; corpId: string; active: boolean; employed: boolean; lastVerifiedAt: Date }>;

export interface AuthStore {
  cleanupExpiredAuthArtifacts(now: Date): Promise<void>;
  consumeCode(codeHash: string, expiresAt: Date): Promise<boolean>;
  consumeQrState(stateHash: string, bindingHash: string, now: Date): Promise<boolean>;
  createQrState(challenge: QrChallenge): Promise<void>;
  upsertIdentity(member: OrganizationMember): Promise<AuthUser>;
  createSession(session: SessionRecord): Promise<void>;
  findSession(tokenHash: string, now: Date): Promise<(SessionRecord & { user: AuthUser; identity: SessionIdentity }) | null>;
  deactivateIdentity(userId: string, verifiedAt: Date): Promise<void>;
  revokeSession(tokenHash: string, now: Date): Promise<void>;
}

export class AuthDeniedError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "AuthDeniedError"; }
}

const hash = (value: string) => createHash("sha256").update(value).digest("hex");

type AcceptanceControllableProvider = DingTalkProvider & Readonly<{
  beginAcceptanceControl: (code: string) => Promise<string>;
  assertAcceptanceControl: (token: string | undefined) => void;
  listAcceptanceIdentities: (token: string | undefined) => Promise<readonly AcceptanceControlIdentity[]>;
  issueAcceptanceLoginCode: (token: string | undefined, alias: string) => Promise<string>;
  endAcceptanceControl: (token: string | undefined) => Promise<void>;
}>;

const isAcceptanceControllableProvider = (provider: DingTalkProvider): provider is AcceptanceControllableProvider => {
  const candidate = provider as Partial<AcceptanceControllableProvider>;
  return typeof candidate.beginAcceptanceControl === "function"
    && typeof candidate.assertAcceptanceControl === "function"
    && typeof candidate.listAcceptanceIdentities === "function"
    && typeof candidate.issueAcceptanceLoginCode === "function"
    && typeof candidate.endAcceptanceControl === "function";
};

export class AuthService {
  constructor(
    private readonly provider: DingTalkProvider,
    private readonly store: AuthStore,
    private readonly corpId: string,
    private readonly sessionTtlMs: number,
    private readonly sessionSecret: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  acceptanceControlAvailable(): boolean {
    return isAcceptanceControllableProvider(this.provider);
  }

  async beginAcceptanceControl(code: string): Promise<string> {
    const provider = this.acceptanceProvider();
    try {
      return await provider.beginAcceptanceControl(code);
    } catch {
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_INVALID", "验收控制凭证无效、已过期或已使用");
    }
  }

  async listAcceptanceIdentities(token: string | undefined): Promise<readonly AcceptanceControlIdentity[]> {
    const provider = this.acceptanceProvider();
    try {
      return await provider.listAcceptanceIdentities(token);
    } catch {
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_REQUIRED", "请先取得验收控制权限");
    }
  }

  async switchAcceptanceIdentity(
    controlToken: string | undefined,
    alias: string,
  ): Promise<{ token: string; user: AuthUser }> {
    const provider = this.acceptanceProvider();
    let loginCode: string;
    try {
      loginCode = await provider.issueAcceptanceLoginCode(controlToken, alias);
    } catch {
      throw new AuthDeniedError("ACCEPTANCE_IDENTITY_UNAVAILABLE", "验收身份不存在、不可用或控制会话已失效");
    }
    const result = await this.loginMobile(loginCode);
    try {
      provider.assertAcceptanceControl(controlToken);
    } catch {
      await this.logout(result.token);
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_REQUIRED", "验收控制会话已失效，未保留新业务会话");
    }
    return result;
  }

  async endAcceptanceControl(
    controlToken: string | undefined,
    businessToken: string | undefined,
  ): Promise<void> {
    const provider = this.acceptanceProvider();
    try {
      await provider.endAcceptanceControl(controlToken);
    } catch {
      throw new AuthDeniedError("ACCEPTANCE_CONTROL_REQUIRED", "验收控制会话已失效");
    }
    await this.logout(businessToken);
  }

  async beginQr(): Promise<{ authorizationUrl: string; state: string; bindingToken: string }> {
    await this.store.cleanupExpiredAuthArtifacts(this.now());
    const state = randomBytes(32).toString("base64url");
    const bindingToken = randomBytes(32).toString("base64url");
    await this.store.createQrState({ stateHash: hash(state), bindingHash: this.hashBinding(bindingToken), expiresAt: new Date(this.now().getTime() + 5 * 60_000), usedAt: null });
    return { authorizationUrl: this.provider.buildQrAuthorizationUrl(state), state, bindingToken };
  }

  async loginMobile(code: string): Promise<{ token: string; user: AuthUser }> {
    await this.store.cleanupExpiredAuthArtifacts(this.now());
    return this.completeCode(code, () => this.provider.exchangeMobileCode(code));
  }

  async loginQr(code: string, state: string, bindingToken: string | undefined): Promise<{ token: string; user: AuthUser }> {
    const presentedHash = this.hashBinding(bindingToken ?? "");
    if (!(await this.store.consumeQrState(hash(state), presentedHash, this.now()))) throw new AuthDeniedError("INVALID_QR_STATE", "扫码请求无效、已过期或已使用");
    return this.completeCode(code, () => this.provider.exchangeQrCode(code));
  }

  async authenticate(token: string | undefined): Promise<AuthUser> {
    if (!token) throw new AuthDeniedError("AUTH_REQUIRED", "请先通过钉钉登录");
    const record = await this.store.findSession(this.hashSession(token), this.now());
    if (!record) throw new AuthDeniedError("SESSION_INVALID", "登录已失效，请重新登录");
    if (!record.identity.active || !record.identity.employed) throw new AuthDeniedError("SESSION_INVALID", "登录已失效，请重新登录");
    return this.revalidate(record.user.id, record.identity);
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.revokeSession(this.hashSession(token), this.now());
  }

  private async completeCode(code: string, exchange: () => Promise<DingTalkIdentity>): Promise<{ token: string; user: AuthUser }> {
    if (!code || !(await this.store.consumeCode(hash(code), new Date(this.now().getTime() + 10 * 60_000)))) {
      throw new AuthDeniedError("CODE_REPLAYED", "临时登录凭证无效或已使用");
    }
    const identity = await exchange();
    const member = await this.provider.getOrganizationMember(identity, this.corpId);
    if (!member || !stableEqual(member.corpId, this.corpId)) throw new AuthDeniedError("NOT_ORGANIZATION_MEMBER", "仅限本公司组织成员使用");
    const user = await this.store.upsertIdentity(member);
    if (!member.employed) throw new AuthDeniedError("NOT_EMPLOYED", "账号不属于在职人员");
    if (!member.active) throw new AuthDeniedError("ACCOUNT_DISABLED", "账号已停用");
    const token = randomBytes(32).toString("base64url");
    await this.store.createSession({ id: randomUUID(), tokenHash: this.hashSession(token), userId: user.id, expiresAt: new Date(this.now().getTime() + this.sessionTtlMs), revokedAt: null });
    return { token, user };
  }

  private acceptanceProvider(): AcceptanceControllableProvider {
    if (!isAcceptanceControllableProvider(this.provider)) {
      throw new AuthDeniedError("ACCEPTANCE_NOT_AVAILABLE", "隔离验收中心未启用");
    }
    return this.provider;
  }

  private hashSession(token: string): string { return createHmac("sha256", this.sessionSecret).update(token).digest("hex"); }
  private hashBinding(token: string): string { return createHmac("sha256", this.sessionSecret).update(`qr-binding:${token}`).digest("hex"); }

  private async revalidate(userId: string, identity: SessionIdentity): Promise<AuthUser> {
    const member = await this.provider.getOrganizationMember(identity, this.corpId);
    if (!member || !stableEqual(member.corpId, this.corpId)) {
      await this.store.deactivateIdentity(userId, this.now());
      throw new AuthDeniedError("SESSION_INVALID", "登录已失效，请重新登录");
    }
    const user = await this.store.upsertIdentity(member);
    if (!member.active || !member.employed) {
      await this.store.deactivateIdentity(userId, this.now());
      throw new AuthDeniedError("SESSION_INVALID", "登录已失效，请重新登录");
    }
    return user;
  }
}

export function stableEqual(left: string, right: string): boolean {
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
