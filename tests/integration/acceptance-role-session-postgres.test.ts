import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig } from "@dx-rework/config";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { buildApp } from "../../apps/api/src/app.js";
import {
  AcceptanceDingTalkProvider,
  mintAcceptanceLoginCode,
} from "../../apps/api/src/auth/acceptance-provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import { AuthService } from "../../apps/api/src/auth/service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const inertDatabaseUrl = databaseUrl ?? "postgresql://acceptance:acceptance@127.0.0.1:1/acceptance_skip";
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

runWithPostgres("acceptance role sessions", () => {
  const schema = `acceptance_roles_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: inertDatabaseUrl });
  const database = new Pool({
    connectionString: inertDatabaseUrl,
    options: `-c search_path=${schema}`,
  });
  const corpId = "corp-acceptance";
  const acceptanceSecret = "acceptance-role-session-secret-with-more-than-32-characters";
  const sessionSecret = "acceptance-session-secret-with-more-than-32-characters";
  const ids = {
    root: randomUUID(),
    worker: randomUUID(),
    financeDirector: randomUUID(),
  };

  const config = loadConfig({
    NODE_ENV: "test",
    DATABASE_URL: inertDatabaseUrl,
    DINGTALK_CORP_ID: corpId,
    DINGTALK_H5_APP_KEY: "acceptance-disabled",
    DINGTALK_H5_APP_SECRET: "acceptance-disabled",
    DINGTALK_WEB_CLIENT_ID: "acceptance-disabled",
    DINGTALK_WEB_CLIENT_SECRET: "acceptance-disabled",
    DINGTALK_QR_REDIRECT_URI: "https://acceptance.invalid/auth/qr/callback",
    SESSION_SECRET: sessionSecret,
    ROOT_DINGTALK_USER_ID: "uat-root",
    ACCEPTANCE_LAB_ENABLED: "true",
    ACCEPTANCE_LAB_SECRET: acceptanceSecret,
  });

  const rootAuthority = new RootAuthority(database, corpId, "uat-root");
  const store = new PostgresAuthStore(database, corpId, "uat-root");
  const provider = new AcceptanceDingTalkProvider(database, corpId, acceptanceSecret);
  const auth = new AuthService(provider, store, corpId, 60 * 60_000, sessionSecret);
  const access = new AccessMasterDataService(database, corpId);
  const app = buildApp({
    config,
    checkDatabase: async () => undefined,
    getAppliedSchemaHistory: async () => null,
    auth,
    access: {
      authenticate: (token) => auth.authenticate(token),
      service: access,
      root: rootAuthority,
    },
  });

  const seedUser = async (userId: string, alias: string, displayName: string, roleCode: string) => {
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)",
      [userId, displayName],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,
         active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, corpId, `uat-${alias}`, `uat-union-${alias}`],
    );
    await database.query(
      `INSERT INTO user_role_assignments(
         assignment_id,user_id,role_code,granted_by,grant_reason
       ) VALUES($1,$2,$3,$4,'隔离验收身份')`,
      [randomUUID(), userId, roleCode, ids.root],
    );
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
    }

    await seedUser(ids.root, "root", "[UAT] Root", "owner_group");
    await seedUser(ids.worker, "worker-a", "[UAT] 工人甲", "worker");
    await seedUser(ids.financeDirector, "finance-director", "[UAT] 财务总监", "finance_director");
    await database.query(
      `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
       VALUES(true,$1,'uat-root',$2)`,
      [ids.root, corpId],
    );
    await access.ensureOrganizationPolicy();
    await rootAuthority.assertConfigurationConsistency();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  const login = async (alias: string) => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/mobile",
      payload: { code: mintAcceptanceLoginCode(alias, acceptanceSecret) },
    });
    expect(response.statusCode).toBe(200);
    const header = response.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    expect(raw).toContain("dx_rework_session=");
    return raw!.split(";", 1)[0]!;
  };

  it("creates independent real sessions whose authorization is loaded from role assignments", async () => {
    const workerCookie = await login("worker-a");
    const financeCookie = await login("finance-director");

    const worker = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: workerCookie } });
    const finance = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: financeCookie } });

    expect(worker.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.worker, isRoot: false, businessRoles: ["worker"] },
    });
    expect(finance.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.financeDirector, isRoot: false, businessRoles: ["finance_director"] },
    });
    expect(worker.json().user.capabilities).not.toEqual(finance.json().user.capabilities);
  });

  it("never turns a selected business role into Root and keeps privileged routes protected", async () => {
    const workerCookie = await login("worker-a");
    const workerRoles = await app.inject({ method: "GET", url: "/access/roles", headers: { cookie: workerCookie } });
    expect(workerRoles.statusCode).toBe(403);

    const rootCookie = await login("root");
    const root = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie: rootCookie } });
    expect(root.json()).toMatchObject({
      status: "authorized",
      user: { id: ids.root, isRoot: true, businessRoles: ["owner_group"] },
    });
    const rootRoles = await app.inject({ method: "GET", url: "/access/roles", headers: { cookie: rootCookie } });
    expect(rootRoles.statusCode).toBe(200);
  });

  it("rejects replay of the same signed login code through the real AuthService", async () => {
    const code = mintAcceptanceLoginCode("finance-director", acceptanceSecret);
    const first = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code } });
    const replay = await app.inject({ method: "POST", url: "/auth/mobile", payload: { code } });
    expect(first.statusCode).toBe(200);
    expect(replay.statusCode).toBe(401);
    expect(replay.json()).toMatchObject({ error: { code: "CODE_REPLAYED" } });
  });
});