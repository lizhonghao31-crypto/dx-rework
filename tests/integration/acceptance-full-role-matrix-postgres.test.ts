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
import {
  ACCEPTANCE_ROLE_MATRIX,
  evaluateAcceptanceSnapshot,
  evaluateHttpProbe,
} from "../../apps/web/src/acceptance-matrix.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL;
const inertDatabaseUrl = databaseUrl ?? "postgresql://acceptance:acceptance@127.0.0.1:1/acceptance_skip";
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };
type SessionUser = {
  id: string;
  displayName: string;
  capabilities: readonly string[];
  businessRoles?: readonly string[];
  isRoot?: boolean;
};

runWithPostgres("full acceptance role matrix", () => {
  const schema = `acceptance_roles_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: inertDatabaseUrl });
  const database = new Pool({
    connectionString: inertDatabaseUrl,
    options: `-c search_path=${schema}`,
  });
  const corpId = "corp-acceptance";
  const acceptanceSecret = "acceptance-full-matrix-secret-with-more-than-32-characters";
  const sessionSecret = "acceptance-full-session-secret-with-more-than-32-characters";
  const userIds = new Map(ACCEPTANCE_ROLE_MATRIX.map((entry) => [entry.alias, randomUUID()]));
  const rootId = userIds.get("root")!;

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

  const seedUser = async (alias: string, roleCode: string) => {
    const userId = userIds.get(alias)!;
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)",
      [userId, `[UAT] ${alias}`],
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
       ) VALUES($1,$2,$3,$4,'全角色隔离验收身份')`,
      [randomUUID(), userId, roleCode, rootId],
    );
  };

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    await database.query(`
      CREATE TABLE schema_migrations (
        version text PRIMARY KEY,
        checksum char(64) NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    for (const migration of manifest.migrations) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
      await database.query(
        "INSERT INTO schema_migrations (version, checksum) VALUES ($1, $2)",
        [migration.version, migration.checksum],
      );
    }

    const root = ACCEPTANCE_ROLE_MATRIX.find((entry) => entry.alias === "root")!;
    await seedUser(root.alias, root.expectedRole);
    for (const entry of ACCEPTANCE_ROLE_MATRIX) {
      if (entry.alias !== "root") await seedUser(entry.alias, entry.expectedRole);
    }
    await database.query(
      `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
       VALUES(true,$1,'uat-root',$2)`,
      [rootId, corpId],
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

  const login = async (alias: string): Promise<{ cookie: string; user: SessionUser }> => {
    const response = await app.inject({
      method: "POST",
      url: "/auth/mobile",
      payload: { code: mintAcceptanceLoginCode(alias, acceptanceSecret) },
    });
    expect(response.statusCode, `${alias}: login`).toBe(200);
    const header = response.headers["set-cookie"];
    const raw = Array.isArray(header) ? header[0] : header;
    const cookie = raw!.split(";", 1)[0]!;
    const me = await app.inject({ method: "GET", url: "/auth/me", headers: { cookie } });
    expect(me.statusCode, `${alias}: auth/me`).toBe(200);
    return { cookie, user: me.json().user as SessionUser };
  };

  it("switches every active Golden Source identity through real AuthService/RBAC and reports every mismatch in one run", async () => {
    const failures: string[] = [];

    for (const expectation of ACCEPTANCE_ROLE_MATRIX) {
      const { cookie, user } = await login(expectation.alias);
      const expectedUserId = userIds.get(expectation.alias)!;
      const checks = evaluateAcceptanceSnapshot(
        expectation,
        {
          alias: expectation.alias,
          userId: expectedUserId,
          roleCodes: [expectation.expectedRole],
          capabilities: user.capabilities,
        },
        user,
      );
      for (const check of checks.filter((entry) => entry.verdict !== "pass")) {
        failures.push(`${check.key}: expected=${check.expected}; actual=${check.actual}; rule=${check.ruleId}; verdict=${check.verdict}`);
      }

      for (const probe of expectation.probes ?? []) {
        if (!['access-roles', 'supplier-list'].includes(probe.id)) continue;
        const url = probe.id === 'access-roles' ? '/access/roles' : '/master-data/suppliers';
        const response = await app.inject({ method: "GET", url, headers: { cookie } });
        const check = evaluateHttpProbe(expectation, probe, response.statusCode);
        if (check.verdict !== "pass") {
          failures.push(`${check.key}: expected=${check.expected}; actual=${check.actual}; rule=${check.ruleId}; verdict=${check.verdict}`);
        }
      }
    }

    expect(failures, failures.join("\n")).toEqual([]);
  });
});
