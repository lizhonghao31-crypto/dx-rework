import { createHmac, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { loadConfig, MAX_ACCEPTANCE_SESSION_TTL_SECONDS } from "@dx-rework/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ownedPostgresSchema, createOwnedPostgresSchema, releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { buildApp } from "../../apps/api/src/app.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { EmployeeAccessService } from "../../apps/api/src/access/employee-access-service.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { mintAcceptanceControlCode } from "../../apps/api/src/auth/acceptance-control.js";
import { AcceptanceDingTalkProvider } from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("Acceptance persistent browser sessions through native authentication", () => {
  const schema = ownedPostgresSchema("acceptance_roles");
  const admin = new pg.Pool({ connectionString: url });
  const database = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}`, max: 5 });
  const corp = "TEST-retained-acceptance";
  const secret = "TEST-acceptance-control-secret-more-than-32-characters";
  const sessionSecret = "TEST-acceptance-business-secret-more-than-32-characters";
  const ttl = MAX_ACCEPTANCE_SESSION_TTL_SECONDS;
  const ids = { root: randomUUID(), worker: randomUUID(), pmc: randomUUID() };
  const apps = new Set<FastifyInstance>();
  const root = new RootAuthority(database, corp, "uat-root");
  const access = new AccessMasterDataService(database, corp);
  const tokenHash = (token: string) => createHmac("sha256", sessionSecret).update(token).digest("hex");
  const makeLab = (clock = () => Date.now(), authoritySecret = secret, localHttp = false) => {
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_URL: url!, DINGTALK_CORP_ID: corp,
      DINGTALK_H5_APP_KEY: "TEST-disabled", DINGTALK_H5_APP_SECRET: "TEST-disabled",
      DINGTALK_WEB_CLIENT_ID: "TEST-disabled", DINGTALK_WEB_CLIENT_SECRET: "TEST-disabled",
      DINGTALK_QR_REDIRECT_URI: localHttp ? "http://127.0.0.1/auth/qr/callback" : "https://acceptance.invalid/auth/qr/callback",
      ROOT_DINGTALK_USER_ID: "uat-root", SESSION_SECRET: sessionSecret, SESSION_TTL_SECONDS: String(ttl),
      ACCEPTANCE_LAB_ENABLED: "true", ACCEPTANCE_LAB_SECRET: authoritySecret,
    });
    const provider = new AcceptanceDingTalkProvider(database, corp, authoritySecret, clock, config.sessionTtlSeconds);
    const store = new PostgresAuthStore(database, corp, "uat-root");
    const auth = new AuthService(provider, store, corp, config.sessionTtlSeconds * 1000, sessionSecret, () => new Date(clock()));
    const app = buildApp({ config, auth, checkDatabase: async () => undefined, getAppliedSchemaHistory: async () => null,
      access: { authenticate: token => auth.authenticate(token), service: access, root } });
    apps.add(app);
    return { app, auth, provider, store, config };
  };
  const close = async (app: FastifyInstance) => { await app.close(); apps.delete(app); };
  const control = (lab: ReturnType<typeof makeLab>, now = Date.now()) => lab.auth.beginAcceptanceControl(mintAcceptanceControlCode(secret, now));
  const cookie = (controlToken: string, businessToken: string) => `dx_acceptance_control=${controlToken}; dx_rework_session=${businessToken}`;
  const seed = async (id: string, alias: string, role: string) => {
    await database.query("INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)", [id, "TEST " + alias]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id, corp, `uat-${alias}`, `uat-union-${alias}`]);
    await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST retained session native fixture')", [randomUUID(), id, role, ids.root]);
  };
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin, schema);
    const manifest = JSON.parse(await readFile("apps/api/src/platform/migration-manifest.json", "utf8")) as { migrations: { version: string; checksum: string }[] };
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for (const entry of manifest.migrations) {
      await database.query(await readFile(`apps/api/migrations/${entry.version}.sql`, "utf8"));
      await database.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [entry.version, entry.checksum]);
    }
    await seed(ids.root, "root", "owner_group");
    await seed(ids.worker, "retained-worker", "worker");
    await seed(ids.pmc, "retained-pmc", "pmc");
    await database.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root',$2)", [ids.root, corp]);
    await access.ensureOrganizationPolicy();
    await root.assertConfigurationConsistency();
  });
  afterAll(async () => {
    await Promise.all([...apps].map(close));
    await database.end();
    await releaseOwnedPostgresSchema(admin, schema);
    await admin.end();
  });

  it("restores both layers after replacing all application/provider instances and rejects the exact 30-day boundary", async () => {
    const started = Date.now(); let now = started;
    const original = makeLab(() => now), controller = await control(original, now);
    const login = await original.auth.switchAcceptanceIdentity(controller, "retained-worker");
    const persisted = (await database.query("SELECT * FROM acceptance_control_sessions WHERE business_token_hash=$1", [tokenHash(login.token)])).rows[0];
    expect(persisted.token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(persisted)).not.toContain(controller);
    expect(JSON.stringify(persisted)).not.toContain(login.token);
    expect(persisted.expires_at.getTime()).toBe(started + ttl * 1000);
    await close(original.app);
    now += 29 * 86400000;
    const restarted = makeLab(() => now);
    expect((await restarted.auth.listAcceptanceIdentities(controller)).map(i => i.alias)).toContain("retained-worker");
    expect((await restarted.auth.authenticate(login.token)).businessRoles).toEqual(["worker"]);
    const switched = await restarted.auth.switchAcceptanceIdentity(controller, "retained-pmc", login.token);
    const business = (await database.query("SELECT expires_at FROM auth_sessions WHERE token_hash=$1", [tokenHash(switched.token)])).rows[0];
    expect(business.expires_at.getTime()).toBe(persisted.expires_at.getTime());
    now = started + ttl * 1000;
    await expect(restarted.auth.listAcceptanceIdentities(controller)).rejects.toMatchObject({ code: "ACCEPTANCE_CONTROL_REQUIRED" });
    await expect(restarted.auth.authenticate(switched.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("keeps another controller's same-role session valid during switch and current-browser logout", async () => {
    const lab = makeLab(), a = await control(lab), b = await control(lab);
    const one = await lab.auth.switchAcceptanceIdentity(a, "retained-worker");
    const two = await lab.auth.switchAcceptanceIdentity(b, "retained-worker");
    const changed = await lab.auth.switchAcceptanceIdentity(a, "retained-pmc", one.token);
    await expect(lab.auth.authenticate(one.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    expect((await lab.auth.authenticate(two.token)).id).toBe(ids.worker);
    expect((await lab.auth.authenticate(changed.token)).businessRoles).toEqual(["pmc"]);
    const response = await lab.app.inject({ method: "POST", url: "/auth/logout", headers: { cookie: cookie(a, changed.token) } });
    expect(response.statusCode).toBe(204);
    expect(response.headers["set-cookie"]).toEqual(expect.arrayContaining([expect.stringContaining("dx_acceptance_control=;"), expect.stringContaining("dx_rework_session=;")]));
    await expect(lab.auth.authenticate(changed.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await expect(lab.auth.listAcceptanceIdentities(a)).rejects.toMatchObject({ code: "ACCEPTANCE_CONTROL_REQUIRED" });
    expect((await lab.auth.authenticate(two.token)).id).toBe(ids.worker);
    await lab.auth.listAcceptanceIdentities(b);
  });

  it("serializes concurrent switches across provider instances without leaving two business sessions valid", async () => {
    const first = makeLab(), second = makeLab(), c = await control(first);
    const logins = await Promise.all([first.auth.switchAcceptanceIdentity(c, "retained-worker"), second.auth.switchAcceptanceIdentity(c, "retained-pmc")]);
    const valid = await Promise.all(logins.map(async login => {
      try { await first.auth.authenticate(login.token); return true; } catch { return false; }
    }));
    expect(valid.filter(Boolean)).toHaveLength(1);
    const row = (await database.query("SELECT business_token_hash FROM acceptance_control_sessions WHERE business_token_hash=ANY($1::text[])", [logins.map(x => tokenHash(x.token))])).rows;
    expect(row).toHaveLength(1);
  });

  it("revokes an in-flight real session when control ends before its database binding", async () => {
    const lab = makeLab(), c = await control(lab);
    const bind = lab.provider.bindAcceptanceBusinessSession.bind(lab.provider);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }), pending = new Promise<void>(resolve => { release = resolve; });
    lab.provider.bindAcceptanceBusinessSession = async (...args) => { entered(); await pending; return bind(...args); };
    const switching = lab.auth.switchAcceptanceIdentity(c, "retained-worker");
    await started;
    try { await lab.auth.endAcceptanceControl(c, undefined); } finally { release(); }
    await expect(switching).rejects.toMatchObject({ code: "ACCEPTANCE_CONTROL_REQUIRED" });
    const active = await database.query("SELECT count(*)::int n FROM auth_sessions WHERE user_id=$1 AND revoked_at IS NULL AND token_hash NOT IN (SELECT business_token_hash FROM acceptance_control_sessions WHERE business_token_hash IS NOT NULL)", [ids.worker]);
    expect(active.rows[0].n).toBe(0);
  });

  it("immediately rejects database revocation and missing control records instead of falling back to ordinary login", async () => {
    const lab = makeLab(), a = await control(lab), b = await control(lab);
    const one = await lab.auth.switchAcceptanceIdentity(a, "retained-worker"), two = await lab.auth.switchAcceptanceIdentity(b, "retained-pmc");
    await database.query("UPDATE acceptance_control_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE business_token_hash=$1", [tokenHash(one.token)]);
    await expect(lab.auth.authenticate(one.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    await database.query("DELETE FROM acceptance_control_sessions WHERE business_token_hash=$1", [tokenHash(two.token)]);
    await expect(lab.auth.authenticate(two.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("does not resurrect either layer after rotating the dedicated control secret", async () => {
    const lab = makeLab(), c = await control(lab), login = await lab.auth.switchAcceptanceIdentity(c, "retained-worker");
    const rotated = makeLab(() => Date.now(), secret + "-rotated");
    await expect(rotated.auth.listAcceptanceIdentities(c)).rejects.toMatchObject({ code: "ACCEPTANCE_CONTROL_REQUIRED" });
    await expect(rotated.auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
  });

  it("keeps real employee disable/restore authoritative and never revives old business tokens", async () => {
    const lab = makeLab(), c = await control(lab), login = await lab.auth.switchAcceptanceIdentity(c, "retained-worker");
    const employees = new EmployeeAccessService(database, corp, access, lab.store, lab.provider, { enabled: false, dingtalkUserId: undefined, secret: undefined }, "uat-root");
    const actor = { actorId: ids.root, actorRoles: ["root_superuser", "owner_group"], authorizationCapability: "access:admin", authorizationCapabilities: ["access:admin"], requestId: randomUUID() };
    await employees.disableAccess(actor, ids.worker, "TEST retained login disable");
    try {
      await expect(lab.auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
      await expect(lab.auth.switchAcceptanceIdentity(c, "retained-worker")).rejects.toMatchObject({ code: "ACCEPTANCE_IDENTITY_UNAVAILABLE" });
    } finally { await employees.restoreAccess(actor, ids.worker, "TEST restore dedicated fixture"); }
    await expect(lab.auth.authenticate(login.token)).rejects.toMatchObject({ code: "SESSION_INVALID" });
    const fresh = await lab.auth.switchAcceptanceIdentity(c, "retained-worker");
    expect((await lab.auth.authenticate(fresh.token)).businessRoles).toEqual(["worker"]);
  });

  it("preserves 30-day Secure/HttpOnly/path cookies and rejects cross-origin control mutations", async () => {
    const lab = makeLab();
    const start = await lab.app.inject({ method: "POST", url: "/acceptance/control/start", payload: { code: mintAcceptanceControlCode(secret) } });
    const header = String(start.headers["set-cookie"]);
    for (const part of ["HttpOnly", "Secure", "SameSite=Strict", "Max-Age=2592000", "Path=/"]) expect(header).toContain(part);
    const controllerCookie = header.split(";", 1)[0]!;
    const switched = await lab.app.inject({ method: "POST", url: "/acceptance/control/switch", headers: { cookie: controllerCookie }, payload: { alias: "retained-worker" } });
    const businessCookie = String(switched.headers["set-cookie"]);
    for (const part of ["HttpOnly", "Secure", "SameSite=Lax", "Max-Age=2592000", "Path=/"]) expect(businessCookie).toContain(part);
    const denied = await lab.app.inject({ method: "POST", url: "/acceptance/control/end", headers: { cookie: controllerCookie, origin: "https://hostile.invalid" } });
    expect(denied.statusCode).toBe(403);
    expect((await lab.app.inject({ method: "GET", url: "/acceptance/control/status", headers: { cookie: controllerCookie } })).statusCode).toBe(200);
  });

  it("retains two independent Chromium cookie stores across browser and backend restarts", async () => {
    const { chromium } = await import("playwright-core");
    const launch = () => chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE ? { executablePath: process.env.M01_SETTINGS_BROWSER_EXECUTABLE } : {}) });
    let browser = await launch(); const first = makeLab(() => Date.now(), secret, true);
    const address = await first.app.listen({ host: "127.0.0.1", port: 0 });
    try {
      const a = await browser.newContext(), b = await browser.newContext();
      for (const context of [a, b]) {
        expect((await context.request.post(address + "/acceptance/control/start", { data: { code: mintAcceptanceControlCode(secret) } })).status()).toBe(200);
        expect((await context.request.post(address + "/acceptance/control/switch", { data: { alias: "retained-worker" } })).status()).toBe(200);
        const cookies = await context.cookies(address);
        expect(cookies.filter(x => x.name === "dx_acceptance_control" || x.name === "dx_rework_session")).toHaveLength(2);
        for (const cookie of cookies) { expect(cookie.httpOnly).toBe(true); expect(cookie.expires).toBeGreaterThan(Date.now() / 1000 + 29 * 86400); }
        const page = await context.newPage();
        expect((await page.goto(address + "/auth/me"))?.status()).toBe(200);
        expect(await page.evaluate(() => document.cookie)).toBe("");
      }
      const states = await Promise.all([a.storageState(), b.storageState()]);
      expect(states[0].cookies.find(x => x.name === "dx_acceptance_control")?.value).not.toBe(states[1].cookies.find(x => x.name === "dx_acceptance_control")?.value);
      await browser.close(); await close(first.app);
      const restarted = makeLab(() => Date.now(), secret, true);
      await restarted.app.listen({ host: "127.0.0.1", port: Number(new URL(address).port) });
      browser = await launch();
      const restored = await Promise.all(states.map(storageState => browser.newContext({ storageState })));
      for (const context of restored) {
        expect((await context.request.get(address + "/acceptance/control/status")).status()).toBe(200);
        const page = await context.newPage(); expect((await page.goto(address + "/auth/me"))?.status()).toBe(200);
      }
      expect((await restored[0]!.request.post(address + "/acceptance/control/switch", { data: { alias: "retained-pmc" } })).status()).toBe(200);
      expect((await (await restored[1]!.request.get(address + "/auth/me")).json()).user.businessRoles).toEqual(["worker"]);
      expect((await restored[0]!.request.post(address + "/auth/logout")).status()).toBe(204);
      expect((await restored[0]!.request.get(address + "/acceptance/control/status")).status()).toBe(401);
      expect((await restored[1]!.request.get(address + "/auth/me")).status()).toBe(200);
    } finally { await browser.close(); }
  });
});
