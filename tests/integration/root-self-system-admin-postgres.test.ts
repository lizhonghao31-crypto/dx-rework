import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { businessActor } from "../../apps/api/src/access/business-authority.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import type { AuthUser } from "../../apps/api/src/auth/service.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

type Manifest = { migrations: Array<{ version: string; checksum: string }> };

async function applyMigrations(database: pg.Pool): Promise<void> {
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
      "INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",
      [migration.version, migration.checksum],
    );
  }
}

runWithPostgres("Root self system administrator assignment", () => {
  const admin = new Pool({ connectionString: databaseUrl! });

  afterAll(async () => {
    await admin.end();
  });

  it("allows only Root to self-assign system_admin and preserves every other self-assignment denial", async () => {
    const schema = `root_self_admin_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const database = new Pool({
      connectionString: databaseUrl!,
      options: `-c search_path=${schema}`,
    });

    try {
      await applyMigrations(database);
      const rootUserId = randomUUID();
      const otherUserId = randomUUID();
      const rootDingtalkUserId = "root-self-system-admin";

      for (const [userId, displayName, dingtalkUserId] of [
        [rootUserId, "唯一超级用户", rootDingtalkUserId],
        [otherUserId, "普通员工", "ordinary-user"],
      ] as const) {
        await database.query(
          "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
          [userId, displayName],
        );
        await database.query(
          `INSERT INTO identity_mappings(
             id,user_id,provider,corp_id,provider_user_id,union_id,
             active,employed,last_verified_at
           ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
          [randomUUID(), userId, dingtalkUserId, `union-${dingtalkUserId}`],
        );
      }

      const service = new AccessMasterDataService(database, "corp");
      await service.ensureOrganizationPolicy();
      await database.query(
        `INSERT INTO owner_bootstrap_consumptions(
           singleton,user_id,provider_user_id,corp_id
         ) VALUES(true,$1,$2,'corp')`,
        [rootUserId, rootDingtalkUserId],
      );

      const root = new RootAuthority(database, "corp", rootDingtalkUserId);
      const rootUser: AuthUser = {
        id: rootUserId,
        displayName: "唯一超级用户",
        capabilities: [],
        businessRoles: ["owner_group"],
      };
      const rootActor = await businessActor(root, rootUser, randomUUID(), "access:admin");

      const granted = await service.assignRole(rootActor, {
        userId: rootUserId,
        roleCode: "system_admin",
        reason: "作为钉钉待办运行身份",
      });
      const repeated = await service.assignRole(rootActor, {
        userId: rootUserId,
        roleCode: "system_admin",
        reason: "重复提交必须幂等",
      });
      expect(repeated.assignmentId).toBe(granted.assignmentId);

      const assignment = await database.query<{
        role_code: string;
        granted_by: string;
      }>(
        `SELECT role_code,granted_by
         FROM user_role_assignments
         WHERE assignment_id=$1 AND revoked_at IS NULL`,
        [granted.assignmentId],
      );
      expect(assignment.rows[0]).toEqual({
        role_code: "system_admin",
        granted_by: rootUserId,
      });

      const audit = await database.query<{
        actor_id: string;
        actor_roles: string[];
        authorization_capability: string;
      }>(
        `SELECT actor_id,actor_roles,authorization_capability
         FROM operation_events
         WHERE entity_id=$1 AND action='access.role.assign'`,
        [granted.assignmentId],
      );
      expect(audit.rows[0]).toEqual({
        actor_id: rootUserId,
        actor_roles: expect.arrayContaining(["owner_group", "root_superuser"]),
        authorization_capability: "access:admin",
      });

      await expect(service.assignRole(rootActor, {
        userId: rootUserId,
        roleCode: "production_management",
        reason: "Root 也不能自授业务角色",
      })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

      const expectDatabaseSelfGrantRejected = async (
        userId: string,
        roleCode: string,
      ): Promise<void> => {
        const client = await database.connect();
        try {
          await client.query("BEGIN");
          await client.query(
            `SELECT
               set_config('dx_rework.role_assign_event_id',$1,true),
               set_config('dx_rework.role_assign_request_id',$2,true)`,
            [randomUUID(), randomUUID()],
          );
          await expect(client.query(
            `INSERT INTO user_role_assignments(
               assignment_id,user_id,role_code,granted_by,grant_reason
             ) VALUES($1,$2,$3,$2,'数据库边界自授校验')`,
            [randomUUID(), userId, roleCode],
          )).rejects.toMatchObject({ code: "42501" });
        } finally {
          await client.query("ROLLBACK");
          client.release();
        }
      };

      await expectDatabaseSelfGrantRejected(rootUserId, "owner_group");
      await expectDatabaseSelfGrantRejected(otherUserId, "system_admin");
    } finally {
      await database.end();
      await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    }
  });
});

