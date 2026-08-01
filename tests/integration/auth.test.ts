import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@dx-rework/config";

import { buildApp } from "../../apps/api/src/app.js";
import type { DingTalkIdentity, DingTalkProvider, OrganizationMember } from "../../apps/api/src/auth/provider.js";
import { AuthService, type AuthStore, type AuthUser, type QrChallenge, type SessionRecord } from "../../apps/api/src/auth/service.js";

const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost/test", DINGTALK_CORP_ID: "corp-a", DINGTALK_H5_APP_KEY: "key", DINGTALK_H5_APP_SECRET: "secret", DINGTALK_WEB_CLIENT_ID: "qr", DINGTALK_WEB_CLIENT_SECRET: "web-secret", DINGTALK_QR_REDIRECT_URI: "https://example.test/callback", APP_BASE_PATH: "/rework/", SESSION_SECRET: "a-test-secret-that-is-longer-than-32-characters" });
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

class MemoryStore implements AuthStore {
  codes = new Set<string>(); states = new Map<string, QrChallenge>(); sessions = new Map<string, SessionRecord>(); users = new Map<string, AuthUser>(); admission = new Map<string, boolean>();
  async consumeCode(value: string) { if (this.codes.has(value)) return false; this.codes.add(value); return true; }
  async createQrState(value: QrChallenge) { this.states.set(value.stateHash, value); }
  async consumeQrState(value: string, now: Date) { const item = this.states.get(value); if (!item || item.usedAt || item.expiresAt <= now) return null; this.states.set(value, { ...item, usedAt: now }); return item; }
  async upsertIdentity(member: OrganizationMember) { const key = `${member.corpId}:${member.unionId}`; const existing = this.users.get(key); const user = existing ?? { id: `internal-${member.userId}`, displayName: member.displayName, capabilities: member.userId === "role-user" ? ["rework:read"] : [] }; this.users.set(key, user); this.admission.set(user.id, member.active && member.employed); return user; }
  async createSession(value: SessionRecord) { this.sessions.set(value.tokenHash, value); }
  async findSession(value: string, now: Date) { const session = this.sessions.get(value); if (!session || session.revokedAt || session.expiresAt <= now || !this.admission.get(session.userId)) return null; const user = [...this.users.values()].find((item) => item.id === session.userId); return user ? { ...session, user } : null; }
  async revokeSession(value: string, now: Date) { const session = this.sessions.get(value); if (session) this.sessions.set(value, { ...session, revokedAt: now }); }
}

class FakeProvider implements DingTalkProvider {
  constructor(public member: OrganizationMember | null) {}
  async exchangeMobileCode(code: string): Promise<DingTalkIdentity> { return { userId: code, unionId: `union-${code}` }; }
  async exchangeQrCode(code: string): Promise<DingTalkIdentity> { return this.exchangeMobileCode(code); }
  async getOrganizationMember() { return this.member; }
  buildQrAuthorizationUrl(state: string) { return `https://login.example/?state=${state}`; }
}

function create(member: OrganizationMember | null) { const store = new MemoryStore(); const auth = new AuthService(new FakeProvider(member), store, "corp-a", 60_000, config.sessionSecret); const app = buildApp({ config, auth, checkDatabase: async () => undefined, getAppliedSchemaHistory: async () => null }); apps.push(app); return { app, store }; }
const member = (overrides: Partial<OrganizationMember> = {}): OrganizationMember => ({ corpId: "corp-a", userId: "role-user", unionId: "union-role-user", active: true, employed: true, displayName: "公司员工", ...overrides });

describe("DingTalk organization admission", () => {
  it("admits an active employee and protects APIs with a server session", async () => { const { app } = create(member()); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "ok" } }); expect(login.statusCode).toBe(200); expect(login.headers["set-cookie"]).toContain("HttpOnly"); const cookie = login.headers["set-cookie"]!.split(";")[0]; expect((await app.inject({ method: "GET", url: "/api/protected", headers: { cookie } })).statusCode).toBe(200); });
  it.each([[null, "NOT_ORGANIZATION_MEMBER"], [member({ employed: false }), "NOT_EMPLOYED"], [member({ active: false }), "ACCOUNT_DISABLED"]] as const)("rejects non-member, departed, or disabled identities", async (candidate, code) => { const { app } = create(candidate); const response = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: code } }); expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe(code); });
  it("isolates an admitted user without a role from business data", async () => { const { app } = create(member({ userId: "no-role" })); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "no-role" } }); expect(login.json().status).toBe("no_role"); const cookie = login.headers["set-cookie"]!.split(";")[0]; expect((await app.inject({ method: "GET", url: "/api/protected", headers: { cookie } })).statusCode).toBe(403); });
  it("never merges similar display names", async () => { const store = new MemoryStore(); const first = await store.upsertIdentity(member({ userId: "li-sheng", unionId: "union-li-sheng", displayName: "李生" })); const second = await store.upsertIdentity(member({ userId: "li-tongsheng", unionId: "union-li-tongsheng", displayName: "李同生" })); expect(first.id).not.toBe(second.id); });
  it("accepts authCode/state, redirects to the base path, and safely redirects failures", async () => { const { app } = create(member()); const invalid = await app.inject({ method: "GET", url: "/auth/qr/callback?authCode=x&state=wrong" }); expect(invalid.statusCode).toBe(303); expect(invalid.headers.location).toBe("/rework/auth/denied"); const start = await app.inject({ method: "POST", url: "/auth/qr/start" }); const state = new URL(start.json().authorizationUrl).searchParams.get("state")!; const callback = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=qr1&state=${state}` }); expect(callback.statusCode).toBe(303); expect(callback.headers.location).toBe("/rework/"); expect(callback.headers["set-cookie"]).toContain("Path=/rework/"); expect((await app.inject({ method: "GET", url: `/auth/qr/callback?code=qr2&state=${state}` })).headers.location).toBe("/rework/auth/denied"); });
  it("exposes only public client configuration", async () => { const { app } = create(member()); const response = await app.inject({ method: "GET", url: "/auth/client-config" }); expect(response.json()).toEqual({ corpId: "corp-a", mobileClientId: "key" }); expect(response.body).not.toContain("secret"); });
  it("keeps one internal user for two entry identities with the same unionId", async () => { const store = new MemoryStore(); const mobile = await store.upsertIdentity(member({ userId: "mobile-user", unionId: "same-union" })); const scan = await store.upsertIdentity(member({ userId: "scan-user", unionId: "same-union" })); expect(scan.id).toBe(mobile.id); });
  it("rejects a replayed auth code", async () => { const { app } = create(member()); expect((await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "once" } })).statusCode).toBe(200); expect((await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "once" } })).statusCode).toBe(401); });
  it("invalidates the session on logout and clears the same scoped cookie", async () => { const { app } = create(member()); expect((await app.inject({ method: "GET", url: "/api/protected" })).statusCode).toBe(401); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "logout" } }); expect(login.headers["set-cookie"]).toContain("Path=/rework/"); const cookie = login.headers["set-cookie"]!.split(";")[0]; const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } }); expect(logout.statusCode).toBe(204); expect(logout.headers["set-cookie"]).toContain("Path=/rework/"); expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401); });
  it("persists inactive status before rejecting and invalidates an existing session", async () => { const store = new MemoryStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret); const login = await auth.loginMobile("active"); provider.member = member({ active: false }); await expect(auth.loginMobile("inactive")).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" }); expect(store.sessions.size).toBe(1); await expect(auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" }); });
});
