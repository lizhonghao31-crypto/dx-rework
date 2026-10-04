import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { loadConfig } from "@dx-rework/config";

import { buildApp } from "../../apps/api/src/app.js";
import type { DingTalkIdentity, DingTalkProvider, OrganizationMember } from "../../apps/api/src/auth/provider.js";
import { AuthService, stableEqual, type AuthStore, type AuthUser, type QrChallenge, type SessionRecord } from "../../apps/api/src/auth/service.js";

const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://test:test@localhost/test", DINGTALK_CORP_ID: "corp-a", DINGTALK_H5_APP_KEY: "key", DINGTALK_H5_APP_SECRET: "secret", DINGTALK_WEB_CLIENT_ID: "qr", DINGTALK_WEB_CLIENT_SECRET: "web-secret", DINGTALK_QR_REDIRECT_URI: "https://example.test/callback", APP_BASE_PATH: "/rework/", SESSION_SECRET: "a-test-secret-that-is-longer-than-32-characters" });
const apps: FastifyInstance[] = [];
afterEach(async () => Promise.all(apps.splice(0).map((app) => app.close())));

class MemoryStore implements AuthStore {
  codes = new Map<string, Date>(); states = new Map<string, QrChallenge>(); sessions = new Map<string, SessionRecord>(); users = new Map<string, AuthUser>(); identities = new Map<string, OrganizationMember & { lastVerifiedAt: Date }>();
  async consumeCode(value: string, expiresAt: Date) { if (this.codes.has(value)) return false; this.codes.set(value, expiresAt); return true; }
  cleanupCalls = 0;
  async cleanupExpiredAuthArtifacts(now: Date) { this.cleanupCalls += 1; for (const [key, expiresAt] of this.codes) if (expiresAt <= now) this.codes.delete(key); for (const [key, value] of this.states) if (value.expiresAt <= now) this.states.delete(key); }
  async createQrState(value: QrChallenge) { this.states.set(value.stateHash, value); }
  async consumeQrState(value: string, bindingHash: string, now: Date) { const item = this.states.get(value); if (!item || item.usedAt || item.expiresAt <= now || !stableEqual(item.bindingHash, bindingHash)) return false; this.states.set(value, { ...item, usedAt: now }); return true; }
  async upsertIdentity(member: OrganizationMember) { const key = `${member.corpId}:${member.unionId}`; const existing = this.users.get(key); const user = existing ?? { id: `internal-${member.userId}`, displayName: member.displayName, capabilities: member.userId === "role-user" ? ["rework:read"] : [] }; this.users.set(key, user); this.identities.set(user.id, { ...member, lastVerifiedAt: new Date() }); return user; }
  async createSession(value: SessionRecord) { this.sessions.set(value.tokenHash, value); }
  async findSession(value: string, now: Date) { const session = this.sessions.get(value); if (!session || session.revokedAt || session.expiresAt <= now) return null; const user = [...this.users.values()].find((item) => item.id === session.userId); const identity = this.identities.get(session.userId); return user && identity ? { ...session, user, identity: { userId: identity.userId, unionId: identity.unionId, corpId: identity.corpId, active: identity.active, employed: identity.employed, lastVerifiedAt: identity.lastVerifiedAt } } : null; }
  async deactivateIdentity(userId: string, verifiedAt: Date) { for (const [key, session] of this.sessions) if (session.userId === userId && !session.revokedAt) this.sessions.set(key, { ...session, revokedAt: verifiedAt }); const identity = this.identities.get(userId); if (identity) this.identities.set(userId, { ...identity, active: false, employed: false, lastVerifiedAt: verifiedAt }); }
  async revokeSession(value: string, now: Date) { const session = this.sessions.get(value); if (session) this.sessions.set(value, { ...session, revokedAt: now }); }
}

class FakeProvider implements DingTalkProvider {
  organizationQueries = 0;
  organizationError: Error | null = null;
  constructor(public member: OrganizationMember | null) {}
  async exchangeMobileCode(code: string): Promise<DingTalkIdentity> { return { userId: code, unionId: `union-${code}` }; }
  async exchangeQrCode(code: string): Promise<DingTalkIdentity> { return this.exchangeMobileCode(code); }
  async getOrganizationMember() { this.organizationQueries += 1; if (this.organizationError) throw this.organizationError; return this.member; }
  buildQrAuthorizationUrl(state: string) { return `https://login.example/?state=${state}`; }
}

function create(member: OrganizationMember | null) { const store = new MemoryStore(); const auth = new AuthService(new FakeProvider(member), store, "corp-a", 60_000, config.sessionSecret); const app = buildApp({ config, auth, checkDatabase: async () => undefined, getAppliedSchemaHistory: async () => null }); apps.push(app); return { app, store }; }
const member = (overrides: Partial<OrganizationMember> = {}): OrganizationMember => ({ corpId: "corp-a", userId: "role-user", unionId: "union-role-user", active: true, employed: true, displayName: "公司员工", ...overrides });

describe("DingTalk organization admission", () => {
  it("admits an active employee and protects the proxy-stripped internal route", async () => { const { app } = create(member()); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "ok" } }); expect(login.statusCode).toBe(200); expect(login.headers["set-cookie"]).toContain("HttpOnly"); const cookie = login.headers["set-cookie"]!.split(";")[0]; expect((await app.inject({ method: "GET", url: "/protected", headers: { cookie } })).statusCode).toBe(200); });
  it.each([[null, "NOT_ORGANIZATION_MEMBER"], [member({ employed: false }), "NOT_EMPLOYED"], [member({ active: false }), "ACCOUNT_DISABLED"]] as const)("rejects non-member, departed, or disabled identities", async (candidate, code) => { const { app } = create(candidate); const response = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: code } }); expect(response.statusCode).toBe(401); expect(response.json().error.code).toBe(code); });
  it("isolates an admitted user without a role from business data", async () => { const { app } = create(member({ userId: "no-role" })); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "no-role" } }); expect(login.json().status).toBe("no_role"); const cookie = login.headers["set-cookie"]!.split(";")[0]; expect((await app.inject({ method: "GET", url: "/protected", headers: { cookie } })).statusCode).toBe(403); });
  it("never merges similar display names", async () => { const store = new MemoryStore(); const first = await store.upsertIdentity(member({ userId: "li-sheng", unionId: "union-li-sheng", displayName: "李生" })); const second = await store.upsertIdentity(member({ userId: "li-tongsheng", unionId: "union-li-tongsheng", displayName: "李同生" })); expect(first.id).not.toBe(second.id); });
  it("binds a QR state to its initiating browser and rejects missing, wrong, and replayed cookies", async () => { const { app } = create(member()); const missingStart = await app.inject({ method: "POST", url: "/auth/qr/start" }); const missingState = new URL(missingStart.json().authorizationUrl).searchParams.get("state")!; const missing = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=x&state=${missingState}` }); expect(missing.headers.location).toBe("/rework/auth/denied"); expect(missing.headers["set-cookie"]).toBeUndefined(); const wrongStart = await app.inject({ method: "POST", url: "/auth/qr/start" }); const wrongState = new URL(wrongStart.json().authorizationUrl).searchParams.get("state")!; expect((await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=x&state=${wrongState}`, headers: { cookie: "dx_rework_qr_binding=wrong" } })).headers.location).toBe("/rework/auth/denied"); const start = await app.inject({ method: "POST", url: "/auth/qr/start" }); expect(start.body).not.toContain("bindingToken"); const state = new URL(start.json().authorizationUrl).searchParams.get("state")!; const bindingCookie = start.headers["set-cookie"]!.split(";")[0]; const callback = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=qr1&state=${state}`, headers: { cookie: bindingCookie } }); expect(callback.headers.location).toBe("/rework/"); expect(callback.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringContaining("dx_rework_qr_binding=;"), expect.stringContaining("dx_rework_session=")])); expect((await app.inject({ method: "GET", url: `/auth/qr/callback?code=qr2&state=${state}`, headers: { cookie: bindingCookie } })).headers.location).toBe("/rework/auth/denied"); });
  it("preserves a newer QR binding when an older callback is rejected", async () => { const { app } = create(member()); const first = await app.inject({ method: "POST", url: "/auth/qr/start" }); const firstState = new URL(first.json().authorizationUrl).searchParams.get("state")!; const second = await app.inject({ method: "POST", url: "/auth/qr/start" }); const secondState = new URL(second.json().authorizationUrl).searchParams.get("state")!; const secondCookie = second.headers["set-cookie"]!.split(";")[0]; const stale = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=stale&state=${firstState}`, headers: { cookie: secondCookie } }); expect(stale.headers.location).toBe("/rework/auth/denied"); expect(stale.headers["set-cookie"]).toBeUndefined(); const current = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=current&state=${secondState}`, headers: { cookie: secondCookie } }); expect(current.headers.location).toBe("/rework/"); });
  it("does not consume a QR challenge for the wrong browser and permits only one concurrent success", async () => { const { app } = create(member()); const start = await app.inject({ method: "POST", url: "/auth/qr/start" }); const state = new URL(start.json().authorizationUrl).searchParams.get("state")!; const bindingCookie = start.headers["set-cookie"]!.split(";")[0]; const wrong = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=wrong&state=${state}`, headers: { cookie: "dx_rework_qr_binding=wrong" } }); expect(wrong.headers.location).toBe("/rework/auth/denied"); const attempts = await Promise.all(["first", "second"].map((code) => app.inject({ method: "GET", url: `/auth/qr/callback?authCode=${code}&state=${state}`, headers: { cookie: bindingCookie } }))); expect(attempts.map((response) => response.headers.location).sort()).toEqual(["/rework/", "/rework/auth/denied"]); const replay = await app.inject({ method: "GET", url: `/auth/qr/callback?authCode=replay&state=${state}`, headers: { cookie: bindingCookie } }); expect(replay.headers.location).toBe("/rework/auth/denied"); });
  it("exposes only public client configuration", async () => { const { app } = create(member()); const response = await app.inject({ method: "GET", url: "/auth/client-config" }); expect(response.json()).toEqual({ corpId: "corp-a", mobileClientId: "key" }); expect(response.body).not.toContain("secret"); });
  it("keeps one internal user for two entry identities with the same unionId", async () => { const store = new MemoryStore(); const mobile = await store.upsertIdentity(member({ userId: "mobile-user", unionId: "same-union" })); const scan = await store.upsertIdentity(member({ userId: "scan-user", unionId: "same-union" })); expect(scan.id).toBe(mobile.id); });
  it("rejects a replayed auth code", async () => { const { app } = create(member()); expect((await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "once" } })).statusCode).toBe(200); expect((await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "once" } })).statusCode).toBe(401); });
  it("bounds concurrent anonymous login creation without reflecting credentials", async () => { const { app } = create(member()); const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => app.inject({ method: "POST", url: "/auth/mobile", payload: { code: `private-code-${index}` } }))); expect(attempts.filter((response) => response.statusCode === 429)).toHaveLength(2); const limited = attempts.find((response) => response.statusCode === 429)!; expect(limited.headers["retry-after"]).toBeDefined(); expect(limited.body).not.toContain("private-code"); });
  it("gives different clients behind the trusted loopback proxy independent limits", async () => { const { app } = create(member()); const request = (client: string, index: number) => app.inject({ method: "POST", url: "/auth/mobile", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": client }, payload: { code: `${client}-${index}` } }); const first = await Promise.all(Array.from({ length: 10 }, (_, index) => request("198.51.100.10", index))); const second = await Promise.all(Array.from({ length: 10 }, (_, index) => request("198.51.100.11", index))); expect(first.every((response) => response.statusCode === 200)).toBe(true); expect(second.every((response) => response.statusCode === 200)).toBe(true); expect((await request("198.51.100.10", 10)).statusCode).toBe(429); expect((await request("198.51.100.11", 10)).statusCode).toBe(429); });
  it("uses the proxy-observed client instead of an attacker-supplied forwarded prefix", async () => { const { app } = create(member()); const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => app.inject({ method: "POST", url: "/auth/mobile", remoteAddress: "127.0.0.1", headers: { "x-forwarded-for": `203.0.113.${index}, 198.51.100.20` }, payload: { code: `proxied-${index}` } }))); expect(attempts.filter((response) => response.statusCode === 429)).toHaveLength(2); });
  it("ignores forwarding headers from direct non-loopback clients", async () => { const { app } = create(member()); const attempts = await Promise.all(Array.from({ length: 12 }, (_, index) => app.inject({ method: "POST", url: "/auth/mobile", remoteAddress: "198.51.100.30", headers: { "x-forwarded-for": `203.0.113.${index}` }, payload: { code: `direct-${index}` } }))); expect(attempts.filter((response) => response.statusCode === 429)).toHaveLength(2); });
  it("cleans expired login artifacts before creating new public-login records", async () => { const { app, store } = create(member()); store.codes.set("expired-code", new Date(0)); store.states.set("expired", { stateHash: "expired", bindingHash: "binding", expiresAt: new Date(0), usedAt: null }); await app.inject({ method: "POST", url: "/auth/qr/start" }); expect(store.states.has("expired")).toBe(false); expect(store.codes.has("expired-code")).toBe(false); expect(store.cleanupCalls).toBe(1); await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "cleanup" } }); expect(store.cleanupCalls).toBe(2); });
  it("invalidates the session on logout and clears the same scoped cookie", async () => { const { app } = create(member()); expect((await app.inject({ method: "GET", url: "/protected" })).statusCode).toBe(401); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "logout" } }); expect(login.headers["set-cookie"]).toContain("Path=/rework/"); const cookie = login.headers["set-cookie"]!.split(";")[0]; const logout = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie } }); expect(logout.statusCode).toBe(204); expect(logout.headers["set-cookie"]).toContain("Path=/rework/"); expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(401); });
  it("rejects cross-origin browser logout before the session can be revoked", async () => { const { app } = create(member()); const login = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "csrf-logout" } }); const cookie = login.headers["set-cookie"]!.split(";")[0]; const rejected = await app.inject({ method: "POST", url: "/auth/logout", headers: { cookie, origin: "https://staging-api.dxerp.org.cn", "sec-fetch-site": "same-site" } }); expect(rejected.statusCode).toBe(403); expect(rejected.json().error.code).toBe("CROSS_SITE_REQUEST_REJECTED"); expect((await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } })).statusCode).toBe(200); });
  it.each([[null], [member({ employed: false })], [member({ active: false })]] as const)("invalidates a session on the next protected request when membership is missing, departed, or disabled", async (current) => { const store = new MemoryStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret); const login = await auth.loginMobile("active"); provider.member = current; await expect(auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" }); expect(provider.organizationQueries).toBe(2); expect(store.identities.get(login.user.id)).toMatchObject({ active: false, employed: false }); });
  it("revalidates every sequential protected request", async () => { const store = new MemoryStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret); const login = await auth.loginMobile("continuous"); await auth.authenticate(login.token); await auth.authenticate(login.token); expect(provider.organizationQueries).toBe(3); });
  it("coalesces concurrent directory reads without caching sequential reads", async () => { const store = new MemoryStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret); const login = await auth.loginMobile("concurrent"); await expect(Promise.all([auth.authenticate(login.token), auth.authenticate(login.token), auth.authenticate(login.token)])).resolves.toHaveLength(3); expect(provider.organizationQueries).toBe(2); });
  it("rejects a later disabled check while an earlier active check is still finishing", async () => { let reached!: () => void; let release!: () => void; const activeUpsertReached = new Promise<void>((resolve) => { reached = resolve; }); const releaseActiveUpsert = new Promise<void>((resolve) => { release = resolve; }); class BlockingStore extends MemoryStore { upserts = 0; override async upsertIdentity(candidate: OrganizationMember) { this.upserts += 1; if (this.upserts === 2) { reached(); await releaseActiveUpsert; } return super.upsertIdentity(candidate); } } const store = new BlockingStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret); const login = await auth.loginMobile("race"); const earlier = auth.authenticate(login.token); await activeUpsertReached; provider.member = member({ active: false, employed: false }); await expect(auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" }); expect(provider.organizationQueries).toBe(3); release(); await expect(earlier).rejects.toMatchObject({ code: "SESSION_INVALID" }); });
  it("fails closed on a provider error without marking the employee departed", async () => { const store = new MemoryStore(); const provider = new FakeProvider(member()); const auth = new AuthService(provider, store, "corp-a", 3_600_000, config.sessionSecret); const login = await auth.loginMobile("error"); provider.organizationError = new Error("temporary upstream error"); await expect(auth.authenticate(login.token)).rejects.toThrow("temporary upstream error"); expect(store.identities.get(login.user.id)).toMatchObject({ active: true, employed: true }); });
});

describe("security admission regressions", () => {
  it.each([null, member({ active: false }), member({ employed: false })])("never revives old sessions after membership restoration", async (inactive) => {
    const store = new MemoryStore(); const provider = new FakeProvider(member());
    const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret);
    const old = await auth.loginMobile("old"); const sibling = await auth.loginMobile("sibling");
    provider.member = inactive;
    await expect(auth.authenticate(old.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    provider.member = member(); const fresh = await auth.loginMobile("fresh");
    await expect(auth.authenticate(old.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(auth.authenticate(sibling.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(auth.authenticate(fresh.token)).resolves.toMatchObject({ id: old.user.id });
  });
  it("shares an IP budget across QR start and legacy callback before database work", async () => {
    const { app, store } = create(member());
    for (let index = 0; index < 10; index += 1) expect((await app.inject({ method: "POST", url: "/auth/qr/start" })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/auth/qr/callback?code=x&state=x" })).statusCode).toBe(429);
    expect((await app.inject({ method: "POST", url: "/auth/mobile", payload: { code: "blocked" } })).statusCode).toBe(429);
    expect(store.codes.size).toBe(0); expect(store.states.size).toBe(10);
  });
  it("bounds public work and releases slots after failures", async () => {
    let release!: () => void; const blocked = new Promise<void>(resolve => { release = resolve; });
    class BlockingStore extends MemoryStore { override async cleanupExpiredAuthArtifacts(now: Date) { await blocked; return super.cleanupExpiredAuthArtifacts(now); } }
    const auth = new AuthService(new FakeProvider(member()), new BlockingStore(), "corp-a", 60_000, config.sessionSecret);
    const pending = Array.from({ length: 16 }, () => auth.beginQr());
    await expect(auth.beginQr()).rejects.toMatchObject({ code: "AUTH_BUSY" });
    release(); await Promise.all(pending); await expect(auth.beginQr()).resolves.toHaveProperty("state");
  });
  it("releases a failed shared directory read and retries without a stale cache", async () => {
    const store = new MemoryStore(); const provider = new FakeProvider(member());
    const auth = new AuthService(provider, store, "corp-a", 60_000, config.sessionSecret);
    const login = await auth.loginMobile("failure-retry"); provider.organizationError = new Error("upstream timeout");
    const outcomes = await Promise.allSettled(Array.from({ length: 8 }, () => auth.authenticate(login.token)));
    expect(outcomes.every(value => value.status === "rejected")).toBe(true);
    provider.organizationError = null; await expect(auth.authenticate(login.token)).resolves.toHaveProperty("id");
  });
});

it("caps QR creation globally across client addresses", async () => {
  const { app, store } = create(member());
  for (let index = 0; index < 200; index += 1) expect((await app.inject({ method: "POST", url: "/auth/qr/start", remoteAddress: `198.51.${Math.floor(index / 250)}.${index % 250 + 1}` })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/auth/qr/start", remoteAddress: "203.0.113.1" })).statusCode).toBe(429);
  expect(store.states.size).toBe(200);
});

it("does not let IP-rejected traffic consume other clients' global login budget", async () => {
  const { app, store } = create(member());
  for (let index = 0; index < 210; index += 1) {
    const response = await app.inject({ method: "POST", url: "/auth/qr/start", remoteAddress: "198.51.100.1" });
    expect(response.statusCode).toBe(index < 10 ? 200 : 429);
  }
  expect((await app.inject({ method: "POST", url: "/auth/qr/start", remoteAddress: "198.51.100.2" })).statusCode).toBe(200);
  expect(store.states.size).toBe(11);
});

it("returns a retryable busy callback without consuming its valid QR state", async () => {
  let release!: () => void;
  const blocked = new Promise<void>(resolve => { release = resolve; });
  class BlockingStore extends MemoryStore {
    block = false;
    override async cleanupExpiredAuthArtifacts(now: Date) { if (this.block) await blocked; return super.cleanupExpiredAuthArtifacts(now); }
  }
  const store = new BlockingStore();
  const auth = new AuthService(new FakeProvider(member()), store, "corp-a", 60_000, config.sessionSecret);
  const app = buildApp({ config, auth, checkDatabase: async () => undefined, getAppliedSchemaHistory: async () => null });
  apps.push(app);
  const start = await app.inject({ method: "POST", url: "/auth/qr/start" });
  const state = start.json().frame.state;
  const callback = { method: "GET" as const, url: `/auth/qr/callback?authCode=retry&state=${state}`, headers: { cookie: start.headers["set-cookie"]!.split(";")[0] } };
  store.block = true;
  const pending = Array.from({ length: 16 }, () => auth.beginQr());
  try {
    const busy = await app.inject(callback);
    expect(busy.statusCode).toBe(429);
    expect(busy.headers["retry-after"]).toBe("1");
    expect(busy.headers.location).toBeUndefined();
    expect(busy.headers["set-cookie"]).toBeUndefined();
  } finally { release(); await Promise.all(pending); }
  expect((await app.inject(callback)).headers.location).toBe("/rework/");
});
