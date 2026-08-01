import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
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
  const service = new AccessMasterDataService(database);
  const authStore = new PostgresAuthStore(database);

  const adminId = randomUUID();
  const bootstrapOwnerId = randomUUID();
  const liOwnerId = randomUUID();
  const wuOwnerId = randomUUID();
  const zhangId = randomUUID();
  const liTongshengId = randomUUID();
  const financeId = randomUUID();
  const userIds = [adminId, bootstrapOwnerId, liOwnerId, wuOwnerId, zhangId, liTongshengId, financeId];
  const displayNames = ["系统管理员", "启动老板", "李总", "伍云峰", "张文豪", "李同生", "财务"];

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
    ]) {
      const sql = await readFile(new URL(`../../apps/api/migrations/${migration}`, import.meta.url), "utf8");
      await database.query(sql);
    }
    for (const [index, userId] of userIds.entries()) {
      await database.query("INSERT INTO app_users(id,display_name) VALUES($1,$2)", [userId, displayNames[index]]);
    }
    await database.query(
      `INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason)
       VALUES
       ($1,$2,'system_admin',$2,'controlled bootstrap'),
       ($3,$4,'owner_group',$4,'controlled bootstrap')`,
      [randomUUID(), adminId, randomUUID(), bootstrapOwnerId],
    );
    for (const [userId, token] of [
      [liOwnerId, "li-token"],
      [wuOwnerId, "wu-token"],
      [zhangId, "zhang-token"],
      [liTongshengId, "litongsheng-token"],
      [financeId, "finance-token"],
    ] as const) await addLogin(userId, token);
  });

  afterAll(async () => {
    await database.end();
    await adminDatabase.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await adminDatabase.end();
  });

  it("binds two owners identically while keeping production management and 李同生 distinct", async () => {
    await service.assignRole(ownerActor, { userId: liOwnerId, roleCode: "owner_group", reason: "老板同级同权" });
    await service.assignRole(ownerActor, { userId: wuOwnerId, roleCode: "owner_group", reason: "老板同级同权" });
    await service.assignRole(adminActor, { userId: zhangId, roleCode: "production_management", reason: "生产执行" });
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

  it("maps 李生 only to 李总 and keeps temporary workers outside login users", async () => {
    const li = await service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liOwnerId,
      displayName: "李总",
      aliases: ["李生"],
    });
    await expect(service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liTongshengId,
      displayName: "李同生",
      aliases: ["李生"],
    })).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
    await service.createPerson(masterDataActor, {
      personType: "internal",
      appUserId: liTongshengId,
      displayName: "李同生",
      aliases: [],
    });
    const temporary = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "临时工甲",
      aliases: ["临工甲"],
    });
    const alias = await database.query<{ person_id: string }>(
      "SELECT person_id FROM business_person_aliases WHERE normalized_alias=$1",
      ["李生".normalize("NFKC").toLocaleLowerCase("zh-CN")],
    );
    expect(alias.rows[0]?.person_id).toBe(li.personId);
    const temp = await database.query<{ app_user_id: string | null; person_type: string }>(
      "SELECT app_user_id,person_type FROM business_people WHERE person_id=$1",
      [temporary.personId],
    );
    expect(temp.rows[0]).toEqual({ app_user_id: null, person_type: "temporary" });
    const correctedTemporary = await service.createPerson(masterDataActor, {
      personType: "temporary",
      displayName: "临时工乙",
      aliases: [],
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
    expect(await database.query(
      `SELECT 1 FROM operation_events
       WHERE entity_type='business_person_alias' AND entity_id=$1
         AND action='master_data.person_alias.revoke'
         AND actor_id=$2 AND authorization_capability='master_data:manage'`,
      [temporaryAliasId, adminId],
    )).toHaveProperty("rowCount", 1);
    await service.deactivatePerson(masterDataActor, correctedTemporary.personId, "临时工离场");
    expect(await database.query(
      `SELECT 1 FROM operation_events
       WHERE entity_type='business_person_alias' AND entity_id=$1
         AND action='master_data.person_alias.revoke'`,
      [correctedAlias.aliasId],
    )).toHaveProperty("rowCount", 1);
    expect((await service.listPeople()).some((person) => person.personId === correctedTemporary.personId)).toBe(false);
    expect(await service.listPeople(true)).toContainEqual(
      expect.objectContaining({ personId: correctedTemporary.personId, active: false, aliases: [] }),
    );
  });

  it("appends process and supplier versions instead of overwriting history", async () => {
    const process = await service.createProcess(masterDataActor, {
      processCode: "QC_RECHECK",
      processName: "返查",
      pricingUnit: "piece",
      active: true,
      changeReason: "建档",
    });
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

    const supplier = await service.createSupplier(masterDataActor, {
      supplierCode: "FACTORY_01",
      supplierType: "factory",
      supplierName: "加工厂一",
      active: true,
      changeReason: "建档",
    });
    await service.reviseSupplier(masterDataActor, supplier.supplierId, {
      supplierName: "加工厂一号",
      active: true,
      changeReason: "名称修订",
    });
    const supplierCurrent = await database.query<{ version: number; supplier_name: string }>(
      "SELECT version,supplier_name FROM current_supplier_catalog WHERE supplier_id=$1",
      [supplier.supplierId],
    );
    expect(supplierCurrent.rows[0]).toEqual({ version: 2, supplier_name: "加工厂一号" });
    expect(await service.listProcesses()).toEqual([
      expect.objectContaining({ processId: process.processId, processName: "成品返查", version: 2 }),
    ]);
    expect(await service.listSuppliers()).toEqual([
      expect.objectContaining({ supplierId: supplier.supplierId, supplierName: "加工厂一号", version: 2 }),
    ]);
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
    await service.createDelegation(delegationActor, {
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
    expect(await service.listDelegations({ userId: liTongshengId })).toEqual([
      expect.objectContaining({
        granteeUserId: liTongshengId,
        capability: "finance:read",
        scopeType: "rework_order",
        scopeId: "rework-001",
        revokedAt: null,
      }),
    ]);
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
    await expect(service.createDelegation(delegationActor, {
      grantorUserId: liOwnerId,
      granteeUserId: zhangId,
      capability: "own_factory:approve",
      scopeType: "rework_order",
      scopeId: "rework-exception-001",
      validFrom: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 60_000).toISOString(),
      reason: "老板离岗期间指定单据代理",
    })).resolves.toMatchObject({ delegationId: expect.any(String) });
  });

  it("serializes concurrent revocations and preserves the last usable owner", async () => {
    const usableOwners = await database.query<{ assignment_id: string; user_id: string }>(
      `SELECT assignment_id,user_id
       FROM user_role_assignments
       WHERE role_code='owner_group' AND revoked_at IS NULL AND user_id IN ($1,$2)
       ORDER BY user_id`,
      [liOwnerId, wuOwnerId],
    );
    expect(usableOwners.rows).toHaveLength(2);

    const results = await Promise.allSettled(usableOwners.rows.map((assignment) =>
      service.revokeRole(ownerActor, assignment.assignment_id, "并发撤权校验"),
    ));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({
      reason: expect.objectContaining({ code: "CONFLICT", statusCode: 409 }),
    });

    const remainingUsable = await database.query<{ assignment_id: string }>(
      `SELECT ura.assignment_id
       FROM user_role_assignments ura
       JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
       WHERE ura.role_code='owner_group' AND ura.revoked_at IS NULL
         AND EXISTS (
           SELECT 1 FROM identity_mappings i
           WHERE i.user_id=ura.user_id AND i.provider='dingtalk' AND i.active=true AND i.employed=true
         )`,
    );
    expect(remainingUsable.rows).toHaveLength(1);
    await expect(service.revokeRole(
      ownerActor,
      remainingUsable.rows[0]!.assignment_id,
      "不能只留下无有效钉钉身份的启动记录",
    )).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });
});
