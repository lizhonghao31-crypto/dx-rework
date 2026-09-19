import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { EmployeeAccessService } from "../../apps/api/src/access/employee-access-service.js";
import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import {
  OfficialDingTalkProvider,
  type DirectoryOrganizationMember,
  type OrganizationMember,
} from "../../apps/api/src/auth/provider.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
type Manifest = { migrations: Array<{ version: string; checksum: string }> };

class FixtureDirectoryProvider extends OfficialDingTalkProvider {
  constructor(
    private readonly members: readonly DirectoryOrganizationMember[],
    private readonly departedUserIds: readonly string[],
  ) {
    super({
      corpId: "corp",
      h5AppKey: "fixture",
      h5AppSecret: "fixture",
      webClientId: "fixture",
      webClientSecret: "fixture",
      qrRedirectUri: "https://fixture.invalid/callback",
    });
  }

  override async listOrganizationMembers(corpId: string): Promise<DirectoryOrganizationMember[]> {
    if (corpId !== "corp") throw new Error("unexpected fixture corporation");
    return [...this.members];
  }

  override async listDepartedUserIds(
    corpId: string,
    startAt: Date,
    endAt: Date,
  ): Promise<readonly string[]> {
    void startAt;
    void endAt;
    if (corpId !== "corp") throw new Error("unexpected fixture corporation");
    return [...this.departedUserIds];
  }
}

runWithPostgres("employee access role lifecycle", () => {
  const schema = `employee_access_${randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("preserves existing role holders and atomically follows first grant and last revoke", async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest = JSON.parse(await readFile(
      new URL("../../apps/api/src/platform/migration-manifest.json", import.meta.url),
      "utf8",
    )) as Manifest;
    const lifecycle = manifest.migrations.at(-1);
    expect(lifecycle?.version).toBe("0089_employee_access_role_lifecycle");

    for (const migration of manifest.migrations.slice(0, -1)) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration.version}.sql`, import.meta.url),
        "utf8",
      ));
    }

    const rootId = randomUUID();
    const roleHolderId = randomUUID();
    const noRoleId = randomUUID();
    const manuallyDisabledRoleHolderId = randomUUID();
    const rootDingtalkUserId = "root-access-lifecycle";
    const users = [
      [rootId, "Root", rootDingtalkUserId, true],
      [roleHolderId, "已有角色员工", "existing-role", true],
      [noRoleId, "零角色员工", "no-role", true],
      [manuallyDisabledRoleHolderId, "人工停用员工", "manual-stop", true],
    ] as const;
    for (const [userId, displayName, dingtalkUserId, enabled] of users) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,$3)",
        [userId, displayName, enabled],
      );
      await database.query(
        `INSERT INTO identity_mappings(
           id,user_id,provider,corp_id,provider_user_id,union_id,
           active,employed,last_verified_at
         ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
        [randomUUID(), userId, dingtalkUserId, `union-${dingtalkUserId}`],
      );
    }
    await database.query(
      `INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id)
       VALUES(true,$1,$2,'corp')`,
      [rootId, rootDingtalkUserId],
    );
    for (const userId of [roleHolderId, manuallyDisabledRoleHolderId]) {
      await database.query(
        `INSERT INTO user_role_assignments(
           assignment_id,user_id,role_code,granted_by,grant_reason
         ) VALUES($1,$2,'worker',$3,'迁移前既有角色')`,
        [randomUUID(), userId, rootId],
      );
    }
    await database.query(
      "UPDATE app_users SET enabled=false WHERE id=$1",
      [manuallyDisabledRoleHolderId],
    );
    for (const [userId, token] of [
      [roleHolderId, "existing-role-session"],
      [noRoleId, "no-role-session"],
    ] as const) {
      await database.query(
        `INSERT INTO auth_sessions(id,token_hash,user_id,expires_at)
         VALUES($1,$2,$3,CURRENT_TIMESTAMP+interval '1 day')`,
        [randomUUID(), token, userId],
      );
    }

    await database.query(await readFile(
      new URL(`../../apps/api/migrations/${lifecycle!.version}.sql`, import.meta.url),
      "utf8",
    ));

    const migrated = await database.query<{
      id: string;
      enabled: boolean;
      manual_access_disabled: boolean;
    }>(
      `SELECT id,enabled,manual_access_disabled
       FROM app_users
       WHERE id=ANY($1::uuid[])
       ORDER BY id`,
      [[rootId, roleHolderId, noRoleId, manuallyDisabledRoleHolderId]],
    );
    const state = new Map(migrated.rows.map((row) => [row.id, row]));
    expect(state.get(rootId)).toMatchObject({ enabled: true, manual_access_disabled: false });
    expect(state.get(roleHolderId)).toMatchObject({ enabled: true, manual_access_disabled: false });
    expect(state.get(noRoleId)).toMatchObject({ enabled: false, manual_access_disabled: false });
    expect(state.get(manuallyDisabledRoleHolderId)).toMatchObject({
      enabled: false,
      manual_access_disabled: true,
    });
    expect((await database.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE token_hash='no-role-session'",
    )).rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect((await database.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE token_hash='existing-role-session'",
    )).rows[0]?.revoked_at).toBeNull();

    const candidateId = randomUUID();
    await database.query(
      "INSERT INTO app_users(id,display_name) VALUES($1,'新员工')",
      [candidateId],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,
         active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp','new-employee','union-new-employee',true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), candidateId],
    );
    expect((await database.query<{ enabled: boolean }>(
      "SELECT enabled FROM app_users WHERE id=$1",
      [candidateId],
    )).rows[0]?.enabled).toBe(false);

    const service = new AccessMasterDataService(database, "corp");
    await service.ensureOrganizationPolicy();
    const rootActor: TrustedActorContext = {
      actorId: rootId,
      actorRoles: ["root_superuser"],
      authorizationCapability: "access:admin",
      authorizationCapabilities: ["access:admin"],
      requestId: randomUUID(),
    };
    const manuallyDisabledAssignment = await database.query<{ assignment_id: string }>(
      `SELECT assignment_id
       FROM user_role_assignments
       WHERE user_id=$1 AND role_code='worker' AND revoked_at IS NULL`,
      [manuallyDisabledRoleHolderId],
    );
    await service.revokeRole(
      rootActor,
      manuallyDisabledAssignment.rows[0]!.assignment_id,
      "清除人工停用员工的最后角色",
    );
    expect((await database.query<{
      enabled: boolean;
      manual_access_disabled: boolean;
    }>(
      "SELECT enabled,manual_access_disabled FROM app_users WHERE id=$1",
      [manuallyDisabledRoleHolderId],
    )).rows[0]).toEqual({ enabled: false, manual_access_disabled: false });
    await service.assignRole(
      { ...rootActor, requestId: randomUUID() },
      {
        userId: manuallyDisabledRoleHolderId,
        roleCode: "tail_inspector",
        reason: "重新授予首个角色无需人工恢复",
      },
    );
    expect((await database.query<{ enabled: boolean }>(
      "SELECT enabled FROM app_users WHERE id=$1",
      [manuallyDisabledRoleHolderId],
    )).rows[0]?.enabled).toBe(true);

    const assignment = await service.assignRole(rootActor, {
      userId: candidateId,
      roleCode: "worker",
      reason: "授予首个业务角色",
    });
    expect((await database.query<{ enabled: boolean }>(
      "SELECT enabled FROM app_users WHERE id=$1",
      [candidateId],
    )).rows[0]?.enabled).toBe(true);
    await database.query(
      `INSERT INTO auth_sessions(id,token_hash,user_id,expires_at)
       VALUES($1,'candidate-session',$2,CURRENT_TIMESTAMP+interval '1 day')`,
      [randomUUID(), candidateId],
    );

    await service.revokeRole(
      { ...rootActor, requestId: randomUUID() },
      assignment.assignmentId,
      "撤销最后一个有效角色",
    );
    expect((await database.query<{
      enabled: boolean;
      manual_access_disabled: boolean;
    }>(
      "SELECT enabled,manual_access_disabled FROM app_users WHERE id=$1",
      [candidateId],
    )).rows[0]).toEqual({ enabled: false, manual_access_disabled: false });
    expect((await database.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE token_hash='candidate-session'",
    )).rows[0]?.revoked_at).toBeInstanceOf(Date);
    expect((await database.query<{ action: string }>(
      `SELECT action FROM operation_events
       WHERE entity_id=$1 AND action IN ('access.employee.auto_enable','access.employee.auto_disable')
       ORDER BY occurred_at`,
      [candidateId],
    )).rows.map((row) => row.action)).toEqual([
      "access.employee.auto_enable",
      "access.employee.auto_disable",
    ]);

    await expect(database.query(
      "UPDATE app_users SET enabled=false WHERE id=$1",
      [rootId],
    )).rejects.toMatchObject({ code: "23514" });

    const authStore = new PostgresAuthStore(database, "corp", rootDingtalkUserId);
    const member = (
      userId: string,
      unionId: string,
      displayName: string,
    ): OrganizationMember => ({
      corpId: "corp",
      userId,
      unionId,
      active: true,
      employed: true,
      displayName,
    });
    await expect(authStore.upsertIdentity(
      member("no-role", "union-no-role", "零角色员工"),
    )).rejects.toMatchObject({ code: "ACCOUNT_DISABLED" });
    await expect(authStore.upsertIdentity(
      member(rootDingtalkUserId, `union-${rootDingtalkUserId}`, "Root"),
    )).resolves.toMatchObject({ id: rootId });

    const newDirectoryUserId = "new-directory-hire";
    const provider = new FixtureDirectoryProvider([
      {
        corpId: "corp",
        userId: rootDingtalkUserId,
        unionId: `union-${rootDingtalkUserId}`,
        displayName: "Root",
        active: true,
        employed: true,
        departmentNames: ["管理部"],
      },
      {
        corpId: "corp",
        userId: newDirectoryUserId,
        unionId: "union-new-directory-hire",
        displayName: "新入职同事",
        active: true,
        employed: true,
        departmentNames: ["业务部"],
      },
    ], ["existing-role"]);

    const employeeAccess = new EmployeeAccessService(
      database,
      "corp",
      service,
      authStore,
      provider,
      { enabled: false, dingtalkUserId: undefined, secret: undefined },
      rootDingtalkUserId,
    );
    const synced = await employeeAccess.syncDirectory({
      ...rootActor,
      requestId: randomUUID(),
    });
    expect(synced.scanned).toBe(2);

    const newHire = await database.query<{
      user_id: string;
      active: boolean;
      employed: boolean;
      enabled: boolean;
      departments: string[];
    }>(
      `SELECT i.user_id,i.active,i.employed,u.enabled,
              COALESCE(p.department_names,'{}'::text[]) departments
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
       WHERE i.provider='dingtalk' AND i.corp_id='corp' AND i.provider_user_id=$1`,
      [newDirectoryUserId],
    );
    expect(newHire.rows[0]).toMatchObject({
      active: true,
      employed: true,
      enabled: false,
      departments: ["业务部"],
    });

    const departed = await database.query<{
      active: boolean;
      employed: boolean;
      enabled: boolean;
      role_count: string;
    }>(
      `SELECT i.active,i.employed,u.enabled,
              (SELECT count(*)::text FROM user_role_assignments ura
               WHERE ura.user_id=u.id AND ura.role_code='worker' AND ura.revoked_at IS NULL) role_count
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       WHERE i.provider='dingtalk' AND i.corp_id='corp' AND i.provider_user_id='existing-role'`,
    );
    expect(departed.rows[0]).toEqual({
      active: false,
      employed: false,
      enabled: false,
      role_count: "1",
    });
    expect((await database.query<{ revoked_at: Date | null }>(
      "SELECT revoked_at FROM auth_sessions WHERE token_hash='existing-role-session'",
    )).rows[0]?.revoked_at).toBeInstanceOf(Date);

    const absentButNotDeparted = await database.query<{ active: boolean; employed: boolean }>(
      `SELECT active,employed FROM identity_mappings
       WHERE provider='dingtalk' AND corp_id='corp' AND provider_user_id='no-role'`,
    );
    expect(absentButNotDeparted.rows[0]).toEqual({ active: true, employed: true });
    expect((await database.query<{ action: string }>(
      `SELECT action FROM operation_events
       WHERE entity_id=$1 AND action='access.directory.employee.departed'`,
      [roleHolderId],
    )).rows).toEqual([{ action: "access.directory.employee.departed" }]);
  }, 120_000);
});
