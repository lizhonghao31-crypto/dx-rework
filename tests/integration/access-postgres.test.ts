import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { CreateSupplierSchema, SUPPLIER_BATCH_COLUMNS, type SupplierBatchApply, type SupplierBatchCell, type SupplierBatchField, type SupplierBatchRow } from "@dx-rework/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AccessMasterDataService } from "../../apps/api/src/access/service.js";
import { PostgresAuthStore } from "../../apps/api/src/auth/postgres-store.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const { Pool } = pg;
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("role permissions and versioned master data", () => {
  const schema = `access_${randomUUID().replaceAll("-", "")}`;
  const adminDatabase = new Pool({ connectionString: databaseUrl! });
  const database = new Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const service = new AccessMasterDataService(database, "corp");
  const authStore = new PostgresAuthStore(database, "corp");

  const adminId = randomUUID();
  const bootstrapOwnerId = randomUUID();
  const liOwnerId = randomUUID();
  const wuOwnerId = randomUUID();
  const zhangId = randomUUID();
  const liTongshengId = randomUUID();
  const financeId = randomUUID();
  const foreignOwnerId = randomUUID();
  const userIds = [adminId, bootstrapOwnerId, liOwnerId, wuOwnerId, zhangId, liTongshengId, financeId, foreignOwnerId];
  const displayNames = ["系统管理员", "启动老板", "李总", "伍云峰", "张文豪", "李同生", "财务", "外部组织老板"];

  const adminActor: TrustedActorContext = {
    actorId: adminId,
    actorRoles: ["system_admin"],
    authorizationCapability: "access:admin",
    requestId: randomUUID(),
  };
  const ownerActor: TrustedActorContext = {
    actorId: bootstrapOwnerId,
    actorRoles: ["owner_group"],
    authorizationCapability: "access:admin",
    requestId: randomUUID(),
  };
  const masterDataActor: TrustedActorContext = {
    ...adminActor,
    authorizationCapability: "master_data:manage",
  };
  const supplierWriteActor: TrustedActorContext = {
    ...adminActor,
    authorizationCapability: "supplier_profile:write",
    authorizationCapabilities: ["supplier_profile:write"],
  };
  const ownerPrivateProfileActor: TrustedActorContext = {
    ...ownerActor,
    authorizationCapability: "people:read",
    authorizationCapabilities: ["people:read", "temporary_worker_private:read"],
  };
  const ownerTemporaryWorkerActor: TrustedActorContext = {
    ...ownerActor,
    authorizationCapability: "temporary_worker:manage",
    authorizationCapabilities: ["temporary_worker:manage", "temporary_worker_private:read"],
  };
  const tailN02Actor: TrustedActorContext = {
    actorId: liTongshengId,
    actorRoles: ["tail_supervisor"],
    authorizationCapability: "process:configure",
    authorizationCapabilities: ["process:configure", "work:assign"],
    requestId: randomUUID(),
  };
  const delegationActor: TrustedActorContext = {
    ...ownerActor,
    authorizationCapability: "delegation:manage",
  };

  const addLogin = async (userId: string, tokenHash: string): Promise<void> => {
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), userId, `ding-${userId}`, `union-${userId}`],
    );
    await database.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,$2,$3,CURRENT_TIMESTAMP+interval '1 day')",
      [randomUUID(), tokenHash, userId],
    );
  };

  beforeAll(async () => {
    await adminDatabase.query(`CREATE SCHEMA ${schema}`);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0071_n04_assignment_workforce_ux.sql",
      "0083_rework_v2_temporary_worker_private_profile.sql",
      "0084_rework_v2_process_default_worker_roster.sql",
    ]) {
      const sql = await readFile(new URL(`../../apps/api/migrations/${migration}`, import.meta.url), "utf8");
      await database.query(sql);
      if (migration === "0005_access_master_data.sql") {
        // This access-only fixture omits rework tables, but the current people service
        // requires the real temporary-identity DDL introduced at the start of 0059.
        const identityMigration = await readFile(new URL("../../apps/api/migrations/0059_phase1_assignment_and_final_reporting.sql", import.meta.url), "utf8");
        await database.query(identityMigration.split("ALTER TABLE rework_work_reports")[0]!);
      }
    }
    await database.query(
      `CREATE TABLE owner_bootstrap_consumptions (
         singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton=true),
         user_id uuid NOT NULL REFERENCES app_users(id)
       )`,
    );
    await database.query(await readFile(
      new URL("../../apps/api/migrations/0089_employee_access_role_lifecycle.sql", import.meta.url),
      "utf8",
    ));
    await database.query(await readFile(
      new URL("../../apps/api/migrations/0092_temporary_worker_profile_update.sql", import.meta.url),
      "utf8",
    ));
    await database.query(await readFile(
      new URL("../../apps/api/migrations/0098_tail_default_worker_roster.sql", import.meta.url),
      "utf8",
    ));
    await database.query(await readFile(
      new URL("../../apps/api/migrations/0143_sourcing_supplier_profile_foundation.sql", import.meta.url),
      "utf8",
    ));
    for (const [index, userId] of userIds.entries()) {
      await database.query(
        "INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",
        [userId, displayNames[index]],
      );
    }
    await database.query(
      `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
       VALUES
       ($1,$2,'system_admin',$2,'controlled bootstrap'),
       ($3,$4,'owner_group',$4,'controlled bootstrap'),
       ($5,$6,'owner_group',$6,'controlled foreign-corporation fixture')`,
      [randomUUID(), adminId, randomUUID(), bootstrapOwnerId, randomUUID(), foreignOwnerId],
    );
    await database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','foreign-corp',$3,$4,true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), foreignOwnerId, `ding-${foreignOwnerId}`, `union-${foreignOwnerId}`],
    );
    for (const [userId, token] of [
      [adminId, "admin-token"],
      [bootstrapOwnerId, "bootstrap-token"],
      [liOwnerId, "li-token"],
      [wuOwnerId, "wu-token"],
      [zhangId, "zhang-token"],
      [liTongshengId, "litongsheng-token"],
      [financeId, "finance-token"],
    ] as const) await addLogin(userId, token);
    await service.ensureOrganizationPolicy();
  });

  afterAll(async () => {
    await database.end();
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminDatabase.end();
  });

  it("binds two owners identically while keeping production management and 李同生 distinct", async () => {
    await service.assignRole(ownerActor, { userId: liOwnerId, roleCode: "owner_group", reason: "老板同级同权" });
    await service.assignRole(ownerActor, { userId: wuOwnerId, roleCode: "owner_group", reason: "老板同级同权" });
    const zhangAssignment = await service.assignRole(adminActor, { userId: zhangId, roleCode: "production_management", reason: "生产执行" });
    const repeatedZhangAssignment = await service.assignRole(adminActor, { userId: zhangId, roleCode: "production_management", reason: "重复提交不得重复授权" });
    expect(repeatedZhangAssignment.assignmentId).toBe(zhangAssignment.assignmentId);
    await service.assignRole(adminActor, { userId: liTongshengId, roleCode: "tail_supervisor", reason: "尾部主管" });

    const li = await authStore.findSession("li-token", new Date());
    const wu = await authStore.findSession("wu-token", new Date());
    const zhang = await authStore.findSession("zhang-token", new Date());
    const liTongsheng = await authStore.findSession("litongsheng-token", new Date());
    expect(li?.user.businessRoles).toEqual(["owner_group"]);
    expect(wu?.user.businessRoles).toEqual(["owner_group"]);
    expect(li?.user.capabilities).toEqual(wu?.user.capabilities);
    expect(li?.user.capabilities).toContain("own_factory:approve");
    expect(zhang?.user.businessRoles).toEqual(["production_management"]);
    expect(zhang?.user.capabilities).toContain("dashboard:management:read");
    expect(zhang?.user.capabilities).toContain("liability:takeover");
    expect(zhang?.user.capabilities).not.toContain("own_factory:approve");
    expect(liTongsheng?.user.businessRoles).toEqual(["tail_supervisor"]);
    expect(liTongsheng?.user.id).not.toBe(li?.user.id);
    expect(await service.listRoleAssignments({ userId: zhangId })).toEqual([
      expect.objectContaining({ userId: zhangId, displayName: "张文豪", roleCode: "production_management", revokedAt: null }),
    ]);
    expect((await database.query(
      "SELECT 1 FROM operation_events WHERE action='access.role.assign' AND entity_type='user_role_assignment'",
    )).rowCount).toBe(4);
    await expect(database.query(
      `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
       VALUES($1,$2,'finance_read',$3,'绕过受控服务直接授权')`,
      [randomUUID(), liOwnerId, adminId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "INSERT INTO role_capabilities(role_code,capability) VALUES('production_management','own_factory:approve')",
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE business_roles SET enabled=false WHERE role_code='owner_group'",
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "UPDATE capability_catalog SET capability='own_factory:approve_bypass' WHERE capability='own_factory:approve'",
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("keeps legacy direct capabilities inert after role migration", async () => {
    await database.query(
      "INSERT INTO user_capabilities(user_id,capability) VALUES($1,'access:admin')",
      [zhangId],
    );
    expect((await authStore.findSession("zhang-token", new Date()))?.user.capabilities).not.toContain("access:admin");
    await expect(service.createDelegation(delegationActor, {
      grantorUserId: zhangId,
      granteeUserId: financeId,
      capability: "access:admin",
      scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "旧版直授权限不得继续转授",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
  });

  it("keeps authentication and authorization bound to the configured corporation", async () => {
    await expect(new AccessMasterDataService(database, "other-corp").ensureOrganizationPolicy())
      .rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    await expect(database.query(
      "UPDATE access_security_policy SET dingtalk_corp_id='other-corp' WHERE policy_key='primary'",
    )).rejects.toMatchObject({ code: "55000" });
    await expect(authStore.upsertIdentity({
      corpId: "foreign-corp",
      userId: "foreign-user",
      unionId: "foreign-union",
      active: true,
      employed: true,
      displayName: "外部组织人员",
    })).rejects.toThrow("different corporation");
    await expect(authStore.upsertIdentity({
      corpId: "corp",
      userId: "rotated-zhang-entry",
      unionId: `union-${zhangId}`,
      active: true,
      employed: true,
      displayName: "张文豪",
    })).resolves.toMatchObject({ id: zhangId });
    expect((await database.query<{ provider_user_id: string; union_id: string }>(
      "SELECT provider_user_id,union_id FROM identity_mappings WHERE user_id=$1",
      [zhangId],
    )).rows[0]).toEqual({
      provider_user_id: `ding-${zhangId}`,
      union_id: `union-${zhangId}`,
    });
    await expect(database.query(
      `UPDATE identity_mappings
       SET user_id=$2,corp_id='foreign-corp',provider_user_id='forged-user',union_id='forged-union'
       WHERE user_id=$1`,
      [zhangId, financeId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      `INSERT INTO identity_mappings(
         id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at
       ) VALUES($1,$2,'dingtalk','corp','forged-owner-entry','forged-owner-union',true,true,CURRENT_TIMESTAMP)`,
      [randomUUID(), liOwnerId],
    )).rejects.toMatchObject({ code: "23505" });
    await database.query(
      "INSERT INTO auth_sessions(id,token_hash,user_id,expires_at) VALUES($1,'foreign-token',$2,CURRENT_TIMESTAMP+interval '1 day')",
      [randomUUID(), foreignOwnerId],
    );
    await expect(authStore.findSession("foreign-token", new Date())).resolves.toBeNull();
  });

  it("maps 李生 only to 李总 and keeps temporary workers outside login users", async () => {
    await expect(database.query(
      `INSERT INTO business_people(person_id,person_type,display_name,created_by)
       VALUES($1,'temporary','绕过受控服务的人员',$2)`,
      [randomUUID(), adminId],
    )).rejects.toMatchObject({ code: "55000" });
    const li = await service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liOwnerId,
      displayName: "李总",
      aliases: ["李生"],
      reason: "受控建立李总人员档案与确认称呼",
    });
    await expect(service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liTongshengId,
      displayName: "李同生",
      aliases: ["李生"],
      reason: "验证别名冲突",
    })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    const liTongshengPerson = await service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liTongshengId,
      displayName: "李同生",
      aliases: [],
      reason: "建立独立人员档案",
    });
    const temporary = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "临时工甲",
      aliases: ["临工甲"],
      temporaryPhoneNumber: "13800138000",
      temporaryIdentityNumber: "44010619900101123X",
      reason: "临时人员建档",
    });
    const canonicalAuditPerson = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "审计归一化测试人员",
      aliases: ["\u200b审计别名\u2060"],
      reason: "验证父事件复用数据库归一化规范",
    });
    const canonicalAudit = await database.query<{
      event_normalized_alias: string;
      row_normalized_alias: string;
    }>(
      `SELECT
         e.after_state->'aliases'->0->>'normalizedAlias' AS event_normalized_alias,
         a.normalized_alias AS row_normalized_alias
       FROM operation_events e
       JOIN business_person_aliases a ON a.person_id=e.entity_id::uuid
       WHERE e.action='master_data.person.create' AND e.entity_id=$1`,
      [canonicalAuditPerson.personId],
    );
    expect(canonicalAudit.rows[0]).toEqual({
      event_normalized_alias: "审计别名",
      row_normalized_alias: "审计别名",
    });
    const alias = await database.query<{ person_id: string }>(
      "SELECT person_id FROM business_person_aliases WHERE normalized_alias=$1",
      ["李生".normalize("NFKC").toLocaleLowerCase("zh-CN")],
    );
    expect(alias.rows[0]?.person_id).toBe(li.personId);
    const personCreationAudit = await database.query<{ after_state: {
      aliases: Array<{ aliasId: string; alias: string; normalizedAlias: string; reason: string }>;
    } }>(
      "SELECT after_state FROM operation_events WHERE entity_id=$1 AND action='master_data.person.create'",
      [li.personId],
    );
    expect(personCreationAudit.rows[0]?.after_state.aliases).toEqual([
      expect.objectContaining({ aliasId: expect.any(String), alias: "李生", reason: "受控建立李总人员档案与确认称呼" }),
    ]);
    const initialAliasId = personCreationAudit.rows[0]!.after_state.aliases[0]!.aliasId;
    expect(await database.query(
      `SELECT 1 FROM operation_events
       WHERE entity_id=$1 AND action='master_data.person_alias.create'
         AND reason='受控建立李总人员档案与确认称呼'`,
      [initialAliasId],
    )).toHaveProperty("rowCount", 1);
    await expect(database.query(
      "UPDATE business_people SET app_user_id=$2 WHERE person_id=$1",
      [li.personId, financeId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      `INSERT INTO business_person_aliases(
         alias_id,person_id,alias,normalized_alias,created_by,create_reason
       ) VALUES($1,$2,'李老板','李老板',$3,'绕过受控服务直接绑定别名')`,
      [randomUUID(), liTongshengPerson.personId, adminId],
    )).rejects.toMatchObject({ code: "55000" });
    const directAliasClient = await database.connect();
    try {
      await directAliasClient.query("BEGIN");
      await directAliasClient.query(
        `SELECT
           set_config('dx_rework.alias_create_event_id',$1,true),
           set_config('dx_rework.alias_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await expect(directAliasClient.query(
        `INSERT INTO business_person_aliases(
           alias_id,person_id,alias,normalized_alias,created_by,create_reason
         ) VALUES($1,$2,$3,'caller-controlled-bypass',$4,'验证数据库先兼容归一化再去除边界空格')`,
        [randomUUID(), liTongshengPerson.personId, "\u00a0李生", adminId],
      )).rejects.toMatchObject({ code: "23505" });
      await directAliasClient.query("ROLLBACK");
      await directAliasClient.query("BEGIN");
      await directAliasClient.query(
        `SELECT
           set_config('dx_rework.alias_create_event_id',$1,true),
           set_config('dx_rework.alias_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await expect(directAliasClient.query(
        `INSERT INTO business_person_aliases(
           alias_id,person_id,alias,normalized_alias,created_by,create_reason
         ) VALUES($1,$2,$3,'caller-controlled-bypass',$4,'验证数据库去除完整 Unicode 边界空白')`,
        [randomUUID(), liTongshengPerson.personId, "\u1680李生", adminId],
      )).rejects.toMatchObject({ code: "23505" });
      await directAliasClient.query("ROLLBACK");
      await directAliasClient.query("BEGIN");
      await directAliasClient.query(
        `SELECT
           set_config('dx_rework.alias_create_event_id',$1,true),
           set_config('dx_rework.alias_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await expect(directAliasClient.query(
        `INSERT INTO business_person_aliases(
           alias_id,person_id,alias,normalized_alias,created_by,create_reason
         ) VALUES($1,$2,'李老板','李老板',$3,'伪造审计上下文绑定别名')`,
        [randomUUID(), liTongshengPerson.personId, zhangId],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await directAliasClient.query("ROLLBACK");
      directAliasClient.release();
    }
    const temp = await database.query<{ app_user_id: string | null; person_type: string }>(
      "SELECT app_user_id,person_type FROM business_people WHERE person_id=$1",
      [temporary.personId],
    );
    expect(temp.rows[0]).toEqual({ app_user_id: null, person_type: "temporary" });
    expect(await service.listPeople()).toContainEqual(expect.objectContaining({
      personId: temporary.personId,
      temporaryPhoneNumber: "138****8000",
      temporaryIdentityNumber: "440***********123X",
      privateProfileMasked: true,
    }));
    expect(await service.listPeople({}, ownerPrivateProfileActor)).toContainEqual(expect.objectContaining({
      personId: temporary.personId,
      temporaryPhoneNumber: "13800138000",
      temporaryIdentityNumber: "44010619900101123X",
      privateProfileMasked: false,
    }));
    const temporaryAudit = await database.query<{ after_state: Record<string, unknown> }>(
      "SELECT after_state FROM operation_events WHERE entity_id=$1 AND action='master_data.person.create'",
      [temporary.personId],
    );
    expect(temporaryAudit.rows[0]?.after_state).toEqual(expect.objectContaining({
      hasTemporaryPhoneNumber: true,
      hasTemporaryIdentityNumber: true,
    }));
    expect(JSON.stringify(temporaryAudit.rows[0]?.after_state)).not.toContain("13800138000");
    expect(JSON.stringify(temporaryAudit.rows[0]?.after_state)).not.toContain("44010619900101123X");
    await expect(database.query(
      "UPDATE business_people SET temporary_phone_number='13900139000' WHERE person_id=$1",
      [temporary.personId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(service.getTemporaryWorkerProfile(ownerTemporaryWorkerActor, li.personId))
      .rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    expect(await service.getTemporaryWorkerProfile(ownerTemporaryWorkerActor, temporary.personId)).toEqual({
      personId: temporary.personId,
      displayName: "临时工甲",
      temporaryRemark: null,
      temporaryPhoneNumber: "13800138000",
      temporaryIdentityNumber: "44010619900101123X",
    });
    const updatedTemporary = await service.updateTemporaryWorkerProfile(
      { ...ownerTemporaryWorkerActor, requestId: randomUUID() },
      temporary.personId,
      {
        temporaryRemark: "旺季补充人员",
        temporaryPhoneNumber: "13900139000",
        temporaryIdentityNumber: "440106199101011234",
        reason: "N02 补录临时工资料",
      },
    );
    expect(updatedTemporary).toEqual(expect.objectContaining({
      personId: temporary.personId,
      displayName: "临时工甲",
      temporaryRemark: "旺季补充人员",
      temporaryPhoneNumber: "13900139000",
      temporaryIdentityNumber: "440106199101011234",
    }));
    const profileAudit = await database.query<{
      before_state: Record<string, unknown>;
      after_state: Record<string, unknown>;
    }>(
      `SELECT before_state,after_state FROM operation_events
       WHERE entity_id=$1 AND action='master_data.temporary_worker_profile.update'`,
      [temporary.personId],
    );
    expect(profileAudit.rows[0]).toEqual({
      before_state: {
        hasTemporaryRemark: false,
        hasTemporaryPhoneNumber: true,
        hasTemporaryIdentityNumber: true,
      },
      after_state: {
        hasTemporaryRemark: true,
        hasTemporaryPhoneNumber: true,
        hasTemporaryIdentityNumber: true,
      },
    });
    const serializedProfileAudit = JSON.stringify(profileAudit.rows[0]);
    expect(serializedProfileAudit).not.toContain("13900139000");
    expect(serializedProfileAudit).not.toContain("440106199101011234");
    expect(serializedProfileAudit).not.toContain("旺季补充人员");
    const correctedTemporary = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "临时工乙",
      aliases: [],
      reason: "建立待纠正归属的既有人员档案",
    });
    const temporaryDirectory = await service.listPeople();
    const temporaryAliasId = temporaryDirectory
      .find((person) => person.personId === temporary.personId)?.aliases[0]?.aliasId;
    expect(temporaryAliasId).toEqual(expect.any(String));
    await service.revokePersonAlias(masterDataActor, temporaryAliasId!, "纠正临时工别名归属");
    const correctedAlias = await service.addPersonAlias(masterDataActor, correctedTemporary.personId, {
      alias: "临工甲",
      reason: "将别名重建到既有人员档案",
    });
    const currentTemporaryAlias = await database.query<{ person_id: string }>(
      "SELECT person_id FROM business_person_aliases WHERE normalized_alias=$1 AND revoked_at IS NULL",
      ["临工甲".normalize("NFKC").toLocaleLowerCase("zh-CN")],
    );
    expect(currentTemporaryAlias.rows[0]?.person_id).toBe(correctedTemporary.personId);
    await expect(database.query(
      `UPDATE business_person_aliases
       SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason='绕过服务直接修改'
       WHERE alias_id=$1`,
      [correctedAlias.aliasId, adminId],
    )).rejects.toMatchObject({ code: "55000" });
    const aliasRevocationAudit = await database.query<{ after_state: Record<string, unknown> }>(
      `SELECT after_state FROM operation_events
       WHERE entity_type='business_person_alias' AND entity_id=$1
         AND action='master_data.person_alias.revoke'
         AND actor_id=$2 AND authorization_capability='master_data:manage'`,
      [temporaryAliasId, adminId],
    );
    expect(aliasRevocationAudit.rows[0]?.after_state).toEqual(expect.objectContaining({
      revokedBy: adminId,
      revokeReason: "纠正临时工别名归属",
      revokedAt: expect.any(String),
    }));
    await service.deactivatePerson(masterDataActor, correctedTemporary.personId, "临时工离场");
    expect((await database.query<{ after_state: Record<string, unknown> }>(
      `SELECT after_state FROM operation_events
       WHERE action='master_data.person.deactivate' AND entity_id=$1`,
      [correctedTemporary.personId],
    )).rows[0]?.after_state).toEqual(expect.objectContaining({
      active: false,
      deactivatedBy: adminId,
      deactivateReason: "临时工离场",
    }));
    expect(await database.query(
      `SELECT 1 FROM operation_events
       WHERE entity_type='business_person_alias' AND entity_id=$1
         AND action='master_data.person_alias.revoke'`,
      [correctedAlias.aliasId],
    )).toHaveProperty("rowCount", 1);
    expect((await service.listPeople()).some((person) => person.personId === correctedTemporary.personId)).toBe(false);
    expect(await service.listPeople({ includeInactive: true, includeRevokedAliases: true })).toContainEqual(
      expect.objectContaining({
        personId: correctedTemporary.personId,
        active: false,
        aliases: [expect.objectContaining({
          aliasId: correctedAlias.aliasId,
          alias: "临工甲",
          revokedAt: expect.any(String),
          revokeReason: "临时工离场",
        })],
      }),
    );

    const concurrentAliasTarget = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "并发别名测试人员",
      aliases: [],
      reason: "验证同一人员并发别名新增",
    });
    const concurrentAliases = await Promise.allSettled([
      service.addPersonAlias({ ...masterDataActor, requestId: randomUUID() }, concurrentAliasTarget.personId, {
        alias: "并发别名甲",
        reason: "并发新增甲",
      }),
      service.addPersonAlias({ ...masterDataActor, requestId: randomUUID() }, concurrentAliasTarget.personId, {
        alias: "并发别名乙",
        reason: "并发新增乙",
      }),
    ]);
    expect(concurrentAliases).toEqual([
      expect.objectContaining({ status: "fulfilled" }),
      expect.objectContaining({ status: "fulfilled" }),
    ]);

    const aliasRaceTarget = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "并发停用测试人员",
      aliases: [],
      reason: "验证停用与别名新增互斥",
    });
    const deactivationClient = await database.connect();
    const aliasRaceClient = await database.connect();
    try {
      await deactivationClient.query("BEGIN");
      await deactivationClient.query(
        "SELECT person_id FROM business_people WHERE person_id=$1 FOR UPDATE",
        [aliasRaceTarget.personId],
      );
      await deactivationClient.query(
        `SELECT
           set_config('dx_rework.person_deactivate_event_id',$1,true),
           set_config('dx_rework.person_deactivate_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await deactivationClient.query(
        `UPDATE business_people
         SET active=false,deactivated_at=CURRENT_TIMESTAMP,deactivated_by=$2,deactivate_reason='验证停用锁'
         WHERE person_id=$1`,
        [aliasRaceTarget.personId, adminId],
      );

      await aliasRaceClient.query("BEGIN");
      await aliasRaceClient.query(
        `SELECT
           set_config('dx_rework.alias_create_event_id',$1,true),
           set_config('dx_rework.alias_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      const raceMarker = `alias-race-${randomUUID()}`;
      const observedInsert = aliasRaceClient.query(
        `/* ${raceMarker} */
         INSERT INTO business_person_aliases(
           alias_id,person_id,alias,normalized_alias,created_by,create_reason
         ) VALUES($1,$2,'并发别名','caller-value',$3,'验证停用锁')`,
        [randomUUID(), aliasRaceTarget.personId, adminId],
      ).then(
        (value) => ({ status: "fulfilled" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      let insertReachedLock = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const activity = await database.query<{ wait_event_type: string | null }>(
          `SELECT wait_event_type
           FROM pg_stat_activity
           WHERE state='active' AND query LIKE $1`,
          [`%${raceMarker}%`],
        );
        if (activity.rows[0]?.wait_event_type === "Lock") {
          insertReachedLock = true;
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
      }
      expect(insertReachedLock).toBe(true);
      await deactivationClient.query("COMMIT");
      const insertResult = await observedInsert;
      expect(insertResult).toMatchObject({
        status: "rejected",
        error: expect.objectContaining({ code: "23514" }),
      });
    } finally {
      await deactivationClient.query("ROLLBACK");
      await aliasRaceClient.query("ROLLBACK");
      deactivationClient.release();
      aliasRaceClient.release();
    }
  });

  it("appends process and supplier versions instead of overwriting history", async () => {
    await expect(database.query(
      "INSERT INTO process_catalog_items(process_id,process_code) VALUES($1,'ORPHAN_PROCESS')",
      [randomUUID()],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(database.query(
      "INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type) VALUES($1,'ORPHAN_SUPPLIER','factory')",
      [randomUUID()],
    )).rejects.toMatchObject({ code: "55000" });

    const process = await service.createProcess(masterDataActor, {
      processCode: "QC_RECHECK",
      processName: "返查",
      pricingUnit: "piece",
      active: true,
      changeReason: "建档",
    });
    await expect(database.query(
      `INSERT INTO process_catalog_versions(
         process_id,version,process_name,pricing_unit,active,change_reason,changed_by
       ) VALUES($1,2,'绕过审计的工序','piece',true,'绕过受控服务',$2)`,
      [process.processId, adminId],
    )).rejects.toMatchObject({ code: "55000" });
    await service.reviseProcess(masterDataActor, process.processId, {
      processName: "成品返查",
      pricingUnit: "piece",
      active: true,
      changeReason: "名称明确",
    });
    const processCurrent = await database.query<{ version: number; process_name: string }>(
      "SELECT version,process_name FROM current_process_catalog WHERE process_id=$1",
      [process.processId],
    );
    expect(processCurrent.rows[0]).toEqual({ version: 2, process_name: "成品返查" });
    expect((await database.query("SELECT 1 FROM process_catalog_versions WHERE process_id=$1", [process.processId])).rowCount).toBe(2);
    const processAudit = await database.query<{ before_state: Record<string, unknown>; after_state: Record<string, unknown> }>(
      "SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='master_data.process.revise'",
      [process.processId],
    );
    expect(processAudit.rows[0]).toEqual({
      before_state: expect.objectContaining({ version: 1, processName: "返查", pricingUnit: "piece", active: true }),
      after_state: expect.objectContaining({ version: 2, processName: "成品返查", pricingUnit: "piece", active: true }),
    });
    const defaultWorker = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "返查默认临时工",
      aliases: [],
      reason: "验证工序默认名单",
    });
    expect(await service.listProcessDefaultWorkerCandidates()).toContainEqual(expect.objectContaining({
      personId: defaultWorker.personId,
      personType: "temporary",
      displayName: "返查默认临时工",
    }));
    await service.replaceProcessDefaultWorkers(masterDataActor, process.processId, {
      personIds: [defaultWorker.personId],
      changeReason: "设定返查默认人员",
    });
    await service.replaceProcessDefaultWorkers(tailN02Actor, process.processId, {
      personIds: [],
      changeReason: "清空返查默认人员",
    });
    expect(await database.query(
      "SELECT 1 FROM process_default_worker_roster_versions WHERE process_id=$1",
      [process.processId],
    )).toHaveProperty("rowCount", 2);
    await expect(database.query(
      "DELETE FROM process_default_worker_roster_versions WHERE process_id=$1",
      [process.processId],
    )).rejects.toMatchObject({ code: "55000" });
    await service.replaceTailInspectionDefaultWorkers(tailN02Actor, {
      personIds: [defaultWorker.personId],
      changeReason: "设定尾查默认人员",
    });
    expect((await database.query<{ person_ids: string[] }>(
      "SELECT person_ids FROM tail_inspection_default_worker_roster_versions ORDER BY roster_version DESC LIMIT 1",
    )).rows[0]?.person_ids).toEqual([defaultWorker.personId]);
    await expect(database.query(
      "DELETE FROM tail_inspection_default_worker_roster_versions",
    )).rejects.toMatchObject({ code: "55000" });

    const supplier = await service.createSupplier(supplierWriteActor, {
      supplierCode: "FACTORY_01",
      supplierType: "factory",
      supplierName: "加工厂一",
      active: true,
      notes: "首批试点供应商",
      contactPerson: "陈经理",
      contactPhone: "13800138000",
      address: "广州市海珠区测试路1号",
      contractEntityName: "广州加工厂一有限公司",
      partyBRepresentative: "陈经理",
      payeeName: "广州加工厂一有限公司",
      bankAccount: "6222000000000000",
      bankName: "测试银行广州支行",
      supportedCrafts: ["车缝", "整烫"],
      dailyCapacity: 1200,
      changeReason: "建档",
    });
    await expect(database.query(
      `INSERT INTO supplier_catalog_versions(
         supplier_id,version,supplier_name,active,change_reason,changed_by
       ) VALUES($1,2,'绕过审计的供应商',true,'绕过受控服务',$2)`,
      [supplier.supplierId, adminId],
    )).rejects.toMatchObject({ code: "55000" });
    await expect(service.createSupplier(supplierWriteActor, {
      supplierCode: "FACTORY_DUPLICATE",
      supplierType: "factory",
      supplierName: " 加工厂一 ",
      active: true,
      notes: "",
      supportedCrafts: [],
      changeReason: "验证启用供应商重名",
    })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });

    await service.reviseSupplier(supplierWriteActor, supplier.supplierId, {
      supplierName: "加工厂一号",
      active: true,
      notes: "首批试点供应商",
      contactPerson: "陈经理",
      contactPhone: "13800138000",
      address: "广州市海珠区测试路2号",
      contractEntityName: "广州加工厂一有限公司",
      partyBRepresentative: "陈经理",
      payeeName: "广州加工厂一有限公司",
      bankAccount: "6222000000000000",
      bankName: "测试银行广州支行",
      supportedCrafts: ["车缝", "整烫"],
      dailyCapacity: 1500,
      expectedVersion: 1,
      changeReason: "名称和产能修订",
    });
    await expect(service.reviseSupplier(supplierWriteActor, supplier.supplierId, {
      supplierName: "并发覆盖名称",
      active: true,
      notes: "",
      supportedCrafts: [],
      expectedVersion: 1,
      changeReason: "验证旧版本拒绝",
    })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    const supplierCurrent = await database.query<{ version: number; supplier_name: string }>(
      "SELECT version,supplier_name FROM current_supplier_catalog WHERE supplier_id=$1",
      [supplier.supplierId],
    );
    expect(supplierCurrent.rows[0]).toEqual({ version: 2, supplier_name: "加工厂一号" });
    expect(await service.getSupplier(supplier.supplierId, false)).toEqual(expect.objectContaining({
      supplierId: supplier.supplierId,
      version: 2,
      supplierName: "加工厂一号",
      dailyCapacity: 1500,
      supportedCrafts: ["车缝", "整烫"],
      contractDataMissing: [],
    }));
    expect(await service.getSupplier(supplier.supplierId, false)).not.toHaveProperty("bankAccount");
    expect(await service.getSupplier(supplier.supplierId, true)).toEqual(expect.objectContaining({
      contractEntityName: "广州加工厂一有限公司",
      bankAccount: "6222000000000000",
    }));
    await service.reviseSupplier(supplierWriteActor, supplier.supplierId, {
      dailyCapacity: 1600,
      expectedVersion: 2,
      changeReason: "只修订常规产能",
    });
    expect(await service.getSupplier(supplier.supplierId, true)).toEqual(expect.objectContaining({
      version: 3,
      supplierName: "加工厂一号",
      dailyCapacity: 1600,
      contractEntityName: "广州加工厂一有限公司",
      bankAccount: "6222000000000000",
    }));
    expect((await database.query<{ authorization_capability: string }>(
      `SELECT authorization_capability
       FROM operation_events
       WHERE entity_type='supplier_catalog' AND entity_id=$1
       ORDER BY created_at DESC,event_id DESC LIMIT 1`,
      [supplier.supplierId],
    )).rows[0]?.authorization_capability).toBe("supplier_profile:write");
    expect(await service.listSupplierHistory(supplier.supplierId, true)).toEqual([
      expect.objectContaining({ supplierId: supplier.supplierId, version: 3, dailyCapacity: 1600 }),
      expect.objectContaining({ supplierId: supplier.supplierId, version: 2, dailyCapacity: 1500 }),
      expect.objectContaining({ supplierId: supplier.supplierId, version: 1, dailyCapacity: 1200 }),
    ]);
    const supplierAudit = await database.query<{ before_state: Record<string, unknown>; after_state: Record<string, unknown> }>(
      "SELECT before_state,after_state FROM operation_events WHERE entity_id=$1 AND action='master_data.supplier.revise'",
      [supplier.supplierId],
    );
    expect(supplierAudit.rows[0]).toEqual({
      before_state: expect.objectContaining({ version: 1, supplierName: "加工厂一", active: true }),
      after_state: expect.objectContaining({ version: 2, supplierName: "加工厂一号", active: true }),
    });
    const supplierCapacityAudit = await database.query<{ before_state: Record<string, unknown>; after_state: Record<string, unknown> }>(
      `SELECT before_state,after_state FROM operation_events
       WHERE entity_id=$1 AND action='master_data.supplier.revise'
         AND after_state->>'version'='3'`,
      [supplier.supplierId],
    );
    expect(supplierCapacityAudit.rows[0]).toEqual({
      before_state: expect.objectContaining({
        contractEntityName: "广州加工厂一有限公司",
        bankAccountMasked: "62**********0000",
      }),
      after_state: expect.objectContaining({
        contractEntityName: "广州加工厂一有限公司",
        bankAccountMasked: "62**********0000",
      }),
    });
    expect(JSON.stringify(supplierCapacityAudit.rows[0])).not.toContain("6222000000000000");
    await service.reviseSupplier(supplierWriteActor, supplier.supplierId, {
      bankAccount: "12345",
      expectedVersion: 3,
      changeReason: "验证短收款账号脱敏",
    });
    const shortBankAccountAudit = await database.query<{ after_state: Record<string, unknown> }>(
      `SELECT after_state FROM operation_events
       WHERE entity_id=$1 AND action='master_data.supplier.revise'
         AND after_state->>'version'='4'`,
      [supplier.supplierId],
    );
    expect(shortBankAccountAudit.rows[0]?.after_state).toEqual(expect.objectContaining({
      bankAccountMasked: "*****",
    }));
    expect(JSON.stringify(shortBankAccountAudit.rows[0])).not.toContain("12345");
    expect(await service.listProcesses()).toEqual([
      expect.objectContaining({ processId: process.processId, processName: "成品返查", version: 2, defaultWorkerPersonIds: [] }),
    ]);
    expect(await service.listSuppliers()).toEqual([
      expect.objectContaining({ supplierId: supplier.supplierId, supplierName: "加工厂一号", version: 4 }),
    ]);
  });

  it("imports supplier batches with idempotent writes, supplementation, explicit changes and stale-preview rejection", async () => {
    const rootActor = { ...supplierWriteActor, actorRoles: ["root_superuser"] };
    const header = SUPPLIER_BATCH_COLUMNS.map(([, label]) => label);
    const cells = (fields: Partial<Record<SupplierBatchField, SupplierBatchCell>>) => SUPPLIER_BATCH_COLUMNS.map(([field]) => fields[field] ?? null);
    const preview = async (fields: Partial<Record<SupplierBatchField, SupplierBatchCell>>) => (await service.previewSupplierBatch(rootActor, [header, cells(fields)]))[0]!;
    const input = (row: SupplierBatchRow, confirmedFields: SupplierBatchField[] = []): SupplierBatchApply => ({ cells: row.cells, supplierCode: row.supplierCode, expectedSupplierId: row.supplierId, expectedVersion: row.version, confirmedFields });
    await expect(service.previewSupplierBatch(supplierWriteActor, [header, cells({})])).rejects.toMatchObject({ statusCode: 403 });
    await expect(service.previewSupplierBatch(rootActor, [["错误表头"], []])).rejects.toMatchObject({ statusCode: 400 });
    const data = { supplierName: "批量新增测试厂", supplierType: "加工厂", contactPerson: "张三", contactPhone: "12345", address: "地址", payeeName: "张三", bankAccount: "001234567890123456789", bankName: "开户行", supportedCrafts: "车缝" };
    const row = await preview(data);
    const competingPreview = await preview(data);
    const key = randomUUID();
    await expect(service.applySupplierBatchRow(rootActor, { ...input(row), supplierCode: "MANUAL_CODE" }, randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    const created = await service.applySupplierBatchRow(rootActor, input(row), key);
    expect(created).toMatchObject({ reused: false, response: { version: 1, unchanged: false } });
    expect(await service.applySupplierBatchRow(rootActor, input(row), key)).toEqual({ ...created, reused: true });
    await expect(service.applySupplierBatchRow(rootActor, { ...input(row), confirmedFields: ["bankName"] }, key)).rejects.toMatchObject({ statusCode: 409 });
    await expect(service.applySupplierBatchRow(rootActor, input(competingPreview), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    expect((await service.listSupplierHistory(created.response.supplierId, true))).toHaveLength(1);
    expect(await service.getSupplier(created.response.supplierId, true)).toHaveProperty("bankAccount", data.bankAccount);

    const existing = await service.createSupplier(supplierWriteActor, CreateSupplierSchema.parse({ supplierCode: "BATCH_PARTIAL", supplierName: "批量空资料测试厂", supplierType: "factory", contactPerson: "旧联系人", active: false, dailyCapacity: 500, supportedCrafts: ["车缝"], changeReason: "历史空资料测试" }));
    const patch = { supplierCode: "BATCH_PARTIAL", address: "补齐地址", contactPerson: "新联系人", supportedCrafts: "车缝、锁眼" };
    expect((await preview({ ...data, supplierCode: "UNKNOWN_TYPO" })).status).toBe("conflict");
    const mismatched = await preview({ supplierCode: "BATCH_PARTIAL", supplierName: "拼错的另一个名称" });
    expect(mismatched.status).toBe("conflict");
    await expect(service.applySupplierBatchRow(rootActor, input(mismatched), randomUUID())).rejects.toMatchObject({ statusCode: 400 });
    expect(await service.getSupplier(existing.supplierId, true)).toMatchObject({ supplierName: "批量空资料测试厂", version: 1 });
    const supplement = await preview(patch);
    expect(supplement).toMatchObject({ status: "review", supplierId: existing.supplierId, version: 1 });
    await expect(service.applySupplierBatchRow(supplierWriteActor, input(supplement), randomUUID())).rejects.toMatchObject({ statusCode: 403 });
    await service.applySupplierBatchRow(rootActor, input(supplement), randomUUID());
    expect(await service.getSupplier(existing.supplierId, true)).toMatchObject({ version: 2, address: "补齐地址", contactPerson: "旧联系人", active: false, dailyCapacity: 500, supportedCrafts: ["车缝", "锁眼"] });
    await expect(service.applySupplierBatchRow(rootActor, input(supplement, ["contactPerson"]), randomUUID())).rejects.toMatchObject({ statusCode: 409 });
    const difference = await preview(patch);
    await service.applySupplierBatchRow(rootActor, input(difference, ["contactPerson"]), randomUUID());
    expect(await service.getSupplier(existing.supplierId, true)).toMatchObject({ version: 3, contactPerson: "新联系人" });
    const unchanged = await preview(patch);
    expect(unchanged.status).toBe("unchanged");
    expect((await service.applySupplierBatchRow(rootActor, input(unchanged), randomUUID())).response).toMatchObject({ unchanged: true, version: 3 });
    expect(await service.listSupplierHistory(existing.supplierId, true)).toHaveLength(3);
    const audits = await database.query("SELECT action FROM operation_events WHERE entity_id=$1", [existing.supplierId]);
    expect(audits.rows.map(item => item.action).sort()).toEqual(["master_data.supplier.create", "master_data.supplier.revise", "master_data.supplier.revise"]);
  });

  it("projects the supplier current version timestamp without exposing contract fields", async () => {
    const supplier = await service.createSupplier(supplierWriteActor, {
      supplierCode: "TIMESTAMP_FIXTURE", supplierType: "factory", supplierName: "供应商版本时间测试厂",
      active: true, notes: "", supportedCrafts: ["车缝"], bankAccount: "6222000000000001", changeReason: "建档",
    });
    await service.reviseSupplier(supplierWriteActor, supplier.supplierId, {
      expectedVersion: 1, active: false, changeReason: "停用测试",
    });
    const summary = (await service.listSuppliers(true)).find(item => item.supplierId === supplier.supplierId)!;
    const latest = await service.getSupplier(supplier.supplierId, false);
    expect(summary.version).toBe(2);
    expect(summary.changedAt).toBe(latest.changedAt);
    expect(Number.isNaN(Date.parse(summary.changedAt))).toBe(false);
    expect(summary).not.toHaveProperty("bankAccount");
    expect(summary).not.toHaveProperty("contractEntityName");
    expect((await service.listSuppliers()).some(item => item.supplierId === supplier.supplierId)).toBe(false);
  });


  it("pages and searches the process catalog with explicit page metadata", async () => {
    await Promise.all(Array.from({ length: 17 }, (_, index) => service.createProcess(masterDataActor, {
      processCode: `PAGE_PROCESS_${String(index + 1).padStart(2, "0")}`,
      processName: `分页工序${String(index + 1).padStart(2, "0")}`,
      pricingUnit: "piece",
      active: true,
      changeReason: "验证工序目录分页",
    })));
    await service.createProcess(masterDataActor, {
      processCode: "PERCENT_PROCESS",
      processName: "百分比%工序",
      pricingUnit: "piece",
      active: true,
      changeReason: "验证字面量搜索",
    });

    const firstPage = await service.listProcessPage({ query: "分页工序" });
    expect(firstPage.items).toHaveLength(15);
    expect(firstPage).toMatchObject({ page: 1, pageSize: 15, totalCount: 17, totalPages: 2 });
    const secondPage = await service.listProcessPage({
      query: "分页工序",
      page: 2,
    });
    expect(secondPage.items).toHaveLength(2);
    expect(secondPage).toMatchObject({ page: 2, totalCount: 17, totalPages: 2 });
    expect(new Set([...firstPage.items, ...secondPage.items].map((item) => item.processId)).size).toBe(17);

    expect((await service.listProcessPage({ query: "%" })).items).toEqual([
      expect.objectContaining({ processCode: "PERCENT_PROCESS", processName: "百分比%工序" }),
    ]);
    await expect(service.listProcessPage({
      query: "分页工序",
      page: 0,
    })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    const longQuery = "长".repeat(98);
    await Promise.all(Array.from({ length: 16 }, (_, index) => service.createProcess(masterDataActor, {
      processCode: `LONG_PROCESS_${String(index + 1).padStart(2, "0")}`,
      processName: `${longQuery}${String(index + 1).padStart(2, "0")}`,
      pricingUnit: "piece",
      active: true,
      changeReason: "验证多字节搜索分页",
    })));
    await expect(service.listProcessPage({ query: "长".repeat(101) })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect((await service.listProcessPage({ query: `${longQuery}01` })).items).toHaveLength(1);
    const longFirstPage = await service.listProcessPage({ query: longQuery });
    expect(longFirstPage.items).toHaveLength(15);
    expect(longFirstPage).toMatchObject({ page: 1, totalCount: 16, totalPages: 2 });
    expect((await service.listProcessPage({
      query: longQuery,
      page: 2,
    })).items).toHaveLength(1);
  });

  it("adds only active global delegations to session-wide capabilities", async () => {
    await service.assignRole(adminActor, { userId: financeId, roleCode: "finance_read", reason: "财务只读" });
    await service.createDelegation(delegationActor, {
      grantorUserId: financeId,
      granteeUserId: zhangId,
      capability: "finance:read",
      scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "临时全局查看",
    });
    const scopedDelegation = await service.createDelegation(delegationActor, {
      grantorUserId: financeId,
      granteeUserId: liTongshengId,
      capability: "finance:read",
      scopeType: "rework_order",
      scopeId: "rework-001",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "仅限指定返工单",
    });
    expect((await authStore.findSession("zhang-token", new Date()))?.user.capabilities).toContain("finance:read");
    expect((await authStore.findSession("litongsheng-token", new Date()))?.user.capabilities).not.toContain("finance:read");
    const delegatedAccessAdmin = await service.createDelegation(delegationActor, {
      grantorUserId: bootstrapOwnerId,
      granteeUserId: zhangId,
      capability: "access:admin",
      scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "临时角色管理代理",
    });
    const delegatedAdminActor: TrustedActorContext = {
      actorId: zhangId,
      actorRoles: ["production_management"],
      authorizationCapability: "access:admin",
      requestId: randomUUID(),
    };
    const delegatedAssignment = await service.assignRole(delegatedAdminActor, {
      userId: financeId,
      roleCode: "payroll_review",
      reason: "验证数据库承认有效全局代理",
    });
    await service.revokeRole(delegatedAdminActor, delegatedAssignment.assignmentId, "全局代理鉴权验证完成");
    await service.revokeDelegation(delegationActor, delegatedAccessAdmin.delegationId, "全局代理鉴权验证完成");
    expect(await service.listDelegations({ userId: liTongshengId })).toEqual([
      expect.objectContaining({
        granteeUserId: liTongshengId,
        capability: "finance:read",
        scopeType: "rework_order",
        scopeId: "rework-001",
        revokedAt: null,
      }),
    ]);
    await service.revokeDelegation(delegationActor, scopedDelegation.delegationId, "代理任务结束");
    expect(await service.listDelegations({ userId: liTongshengId, includeRevoked: true })).toEqual([
      expect.objectContaining({ delegationId: scopedDelegation.delegationId, revokedAt: expect.any(Date) }),
    ]);
    const delegationAudit = await database.query<{ after_state: Record<string, unknown> }>(
      "SELECT after_state FROM operation_events WHERE entity_id=$1 AND action='access.delegation.revoke'",
      [scopedDelegation.delegationId],
    );
    expect(delegationAudit.rows[0]?.after_state).toEqual(expect.objectContaining({
      revokedBy: bootstrapOwnerId,
      revokeReason: "代理任务结束",
    }));
  });

  it("blocks self-escalation and global approval delegation while allowing scoped owner proxy", async () => {
    await expect(service.assignRole(adminActor, {
      userId: adminId,
      roleCode: "production_management",
      reason: "self escalation",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.createDelegation(delegationActor, {
      grantorUserId: liOwnerId,
      granteeUserId: zhangId,
      capability: "own_factory:approve",
      scopeType: "global",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "不可转授权",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    const systemDelegationActor: TrustedActorContext = {
      ...adminActor,
      authorizationCapability: "delegation:manage",
      requestId: randomUUID(),
    };
    await expect(service.createDelegation(systemDelegationActor, {
      grantorUserId: liOwnerId,
      granteeUserId: zhangId,
      capability: "own_factory:approve",
      scopeType: "rework_order",
      scopeId: "rework-admin-impersonation",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "管理员不得代填老板授权",
    })).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });
    await expect(service.createDelegation(delegationActor, {
      grantorUserId: bootstrapOwnerId,
      granteeUserId: zhangId,
      capability: "own_factory:approve",
      scopeType: "rework_order",
      scopeId: "rework-exception-001",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "老板离岗期间指定单据代理",
    })).resolves.toMatchObject({ delegationId: expect.any(String) });

    const directClient = await database.connect();
    try {
      await directClient.query("BEGIN");
      await directClient.query(
        `SELECT
           set_config('dx_rework.delegation_create_event_id',$1,true),
           set_config('dx_rework.delegation_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await expect(directClient.query(
        `INSERT INTO delegated_authorizations(
           delegation_id,grantor_user_id,grantee_user_id,capability,scope_type,scope_id,
           valid_from,valid_until,granted_by,grant_reason
         ) VALUES($1,$2,$3,'own_factory:approve','global',NULL,
           CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour',$4,'绕过服务创建全局审批代理')`,
        [randomUUID(), liOwnerId, zhangId, liOwnerId],
      )).rejects.toMatchObject({ code: "23514" });
      await directClient.query("ROLLBACK");
      await directClient.query("BEGIN");
      await directClient.query(
        `SELECT
           set_config('dx_rework.delegation_create_event_id',$1,true),
           set_config('dx_rework.delegation_create_request_id',$2,true)`,
        [randomUUID(), randomUUID()],
      );
      await expect(directClient.query(
        `INSERT INTO delegated_authorizations(
           delegation_id,grantor_user_id,grantee_user_id,capability,scope_type,scope_id,
           valid_from,valid_until,granted_by,grant_reason
         ) VALUES($1,$2,$3,'own_factory:approve','rework_order','rework-sql-impersonation',
           CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour',$4,'管理员伪装老板直接写库')`,
        [randomUUID(), liOwnerId, zhangId, adminId],
      )).rejects.toMatchObject({ code: "42501" });
    } finally {
      await directClient.query("ROLLBACK");
      directClient.release();
    }
  });

  it("serializes concurrent revocations and preserves the last usable owner", async () => {
    const usableOwners = await database.query<{ assignment_id: string; user_id: string }>(
      `SELECT assignment_id,user_id
       FROM user_role_assignments
       WHERE role_code='owner_group' AND revoked_at IS NULL AND user_id IN ($1,$2,$3)
       ORDER BY user_id`,
      [bootstrapOwnerId, liOwnerId, wuOwnerId],
    );
    expect(usableOwners.rows).toHaveLength(3);

    const results = await Promise.allSettled(usableOwners.rows.map((assignment) => {
      const selfActor: TrustedActorContext = {
        actorId: assignment.user_id,
        actorRoles: ["owner_group"],
        authorizationCapability: "access:admin",
        requestId: randomUUID(),
      };
      return service.revokeRole(selfActor, assignment.assignment_id, "并发撤权校验");
    }));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "CONFLICT", statusCode: 409 }),
    });
    const roleRevocationAudit = await database.query<{ after_state: Record<string, unknown> }>(
      "SELECT after_state FROM operation_events WHERE action='access.role.revoke' AND reason='并发撤权校验'",
    );
    expect(roleRevocationAudit.rows).toHaveLength(2);
    expect(roleRevocationAudit.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        after_state: expect.objectContaining({
          roleCode: "owner_group",
          revokedBy: expect.any(String),
          revokeReason: "并发撤权校验",
        }),
      }),
    ]));

    const remainingUsable = await database.query<{ assignment_id: string; user_id: string }>(
      `SELECT ura.assignment_id
              ,ura.user_id
       FROM user_role_assignments ura
       JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
       WHERE ura.role_code='owner_group' AND ura.revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM identity_mappings i
           WHERE i.user_id=ura.user_id AND i.provider='dingtalk' AND i.corp_id='corp'
             AND i.active=true AND i.employed=true
         )`,
    );
    expect(remainingUsable.rows).toHaveLength(1);
    expect(await database.query(
      `SELECT 1 FROM user_role_assignments ura
       JOIN identity_mappings i ON i.user_id=ura.user_id
       WHERE ura.user_id=$1 AND ura.role_code='owner_group' AND ura.revoked_at IS NULL
         AND i.corp_id='foreign-corp' AND i.active=true AND i.employed=true`,
      [foreignOwnerId],
    )).toHaveProperty("rowCount", 1);
    const lastOwnerActor: TrustedActorContext = {
      actorId: remainingUsable.rows[0]!.user_id,
      actorRoles: ["owner_group"],
      authorizationCapability: "access:admin",
      requestId: randomUUID(),
    };
    await expect(service.revokeRole(
      lastOwnerActor,
      remainingUsable.rows[0]!.assignment_id,
      "外部组织老板不能计入本公司保底人数",
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });
});
