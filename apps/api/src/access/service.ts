import { randomUUID } from "node:crypto";

import type {
  AssignRole,
  CreateBusinessPerson,
  CreateDelegation,
  CreateProcess,
  CreateSupplier,
  ReviseProcess,
  ReviseSupplier,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";

type DatabaseError = Readonly<{ code?: string }>;

const normalizeAlias = (value: string): string => value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");

const translateDatabaseError = (error: unknown): never => {
  const code = (error as DatabaseError | null)?.code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "记录已存在或别名已绑定给其他人员", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的用户、角色或基础资料不存在", 404);
  if (code === "23514" || code === "22P02") throw new ApplicationError("VALIDATION_ERROR", "数据不符合业务约束", 400);
  throw error;
};

const ensureProtectedRoleAuthority = (actor: TrustedActorContext, roleCode: string): void => {
  if (roleCode === "owner_group" && !actor.actorRoles.includes("owner_group")) {
    throw new ApplicationError("FORBIDDEN", "老板权限组只能由现有老板权限组成员维护", 403);
  }
};

const ensureActiveOrganizationUser = async (
  client: PoolClient,
  userId: string,
  message: string,
): Promise<void> => {
  const result = await client.query(
    `SELECT 1
     FROM app_users u
     WHERE u.id=$1 AND u.enabled=true
       AND EXISTS (
         SELECT 1 FROM identity_mappings i
         WHERE i.user_id=u.id AND i.provider='dingtalk' AND i.active=true AND i.employed=true
       )`,
    [userId],
  );
  if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", message, 404);
};

export class AccessMasterDataService {
  constructor(
    private readonly database: Pool,
    private readonly events = new OperationEventRepository(),
  ) {}

  async listRoles(): Promise<Array<{
    roleCode: string;
    displayName: string;
    description: string;
    capabilities: string[];
  }>> {
    const result = await this.database.query<{
      role_code: string;
      display_name: string;
      description: string;
      capabilities: string[];
    }>(
      `SELECT br.role_code,br.display_name,br.description,
              COALESCE(array_agg(rc.capability ORDER BY rc.capability)
                FILTER (WHERE rc.capability IS NOT NULL),'{}') capabilities
       FROM business_roles br
       LEFT JOIN role_capabilities rc ON rc.role_code=br.role_code
       WHERE br.enabled=true
       GROUP BY br.role_code
       ORDER BY br.role_code`,
    );
    return result.rows.map((row) => ({
      roleCode: row.role_code,
      displayName: row.display_name,
      description: row.description,
      capabilities: row.capabilities,
    }));
  }

  async listPeople(includeInactive = false): Promise<Array<{
    personId: string;
    personType: string;
    appUserId: string | null;
    displayName: string;
    active: boolean;
    aliases: string[];
  }>> {
    const result = await this.database.query<{
      person_id: string;
      person_type: string;
      app_user_id: string | null;
      display_name: string;
      active: boolean;
      aliases: string[];
    }>(
      `SELECT p.person_id,p.person_type,p.app_user_id,p.display_name,p.active,
              COALESCE(array_agg(a.alias ORDER BY a.alias)
                FILTER (WHERE a.alias IS NOT NULL),'{}') aliases
       FROM business_people p
       LEFT JOIN business_person_aliases a ON a.person_id=p.person_id AND a.revoked_at IS NULL
       WHERE ($1::boolean OR p.active=true)
       GROUP BY p.person_id
       ORDER BY p.display_name,p.person_id`,
      [includeInactive],
    );
    return result.rows.map((row) => ({
      personId: row.person_id,
      personType: row.person_type,
      appUserId: row.app_user_id,
      displayName: row.display_name,
      active: row.active,
      aliases: row.aliases,
    }));
  }

  async listProcesses(includeInactive = false): Promise<Array<{
    processId: string;
    processCode: string;
    version: number;
    processName: string;
    pricingUnit: string;
    active: boolean;
  }>> {
    const result = await this.database.query<{
      process_id: string;
      process_code: string;
      version: number;
      process_name: string;
      pricing_unit: string;
      active: boolean;
    }>(
      `SELECT process_id,process_code,version,process_name,pricing_unit,active
       FROM current_process_catalog
       WHERE ($1::boolean OR active=true)
       ORDER BY process_name,process_code`,
      [includeInactive],
    );
    return result.rows.map((row) => ({
      processId: row.process_id,
      processCode: row.process_code,
      version: row.version,
      processName: row.process_name,
      pricingUnit: row.pricing_unit,
      active: row.active,
    }));
  }

  async listSuppliers(includeInactive = false): Promise<Array<{
    supplierId: string;
    supplierCode: string;
    supplierType: string;
    version: number;
    supplierName: string;
    active: boolean;
  }>> {
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_type: string;
      version: number;
      supplier_name: string;
      active: boolean;
    }>(
      `SELECT supplier_id,supplier_code,supplier_type,version,supplier_name,active
       FROM current_supplier_catalog
       WHERE ($1::boolean OR active=true)
       ORDER BY supplier_name,supplier_code`,
      [includeInactive],
    );
    return result.rows.map((row) => ({
      supplierId: row.supplier_id,
      supplierCode: row.supplier_code,
      supplierType: row.supplier_type,
      version: row.version,
      supplierName: row.supplier_name,
      active: row.active,
    }));
  }

  async assignRole(actor: TrustedActorContext, input: AssignRole): Promise<{ assignmentId: string }> {
    ensureProtectedRoleAuthority(actor, input.roleCode);
    if (input.userId === actor.actorId) {
      throw new ApplicationError("FORBIDDEN", "不能给自己授予业务角色", 403);
    }
    return this.transaction(async (client) => {
      await ensureActiveOrganizationUser(client, input.userId, "目标用户不存在、不在职或已停用");
      const role = await client.query<{ enabled: boolean }>("SELECT enabled FROM business_roles WHERE role_code=$1 FOR SHARE", [input.roleCode]);
      if (!role.rows[0]?.enabled) throw new ApplicationError("NOT_FOUND", "业务角色不存在或已停用", 404);
      const assignmentId = randomUUID();
      await client.query(
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,$5)",
        [assignmentId, input.userId, input.roleCode, actor.actorId, input.reason],
      );
      await this.events.append(client, actor, {
        action: "access.role.assign",
        entityType: "user_role_assignment",
        entityId: assignmentId,
        after: { userId: input.userId, roleCode: input.roleCode },
        reason: input.reason,
      });
      return { assignmentId };
    });
  }

  async revokeRole(actor: TrustedActorContext, assignmentId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const current = await client.query<{ user_id: string; role_code: string }>(
        "SELECT user_id,role_code FROM user_role_assignments WHERE assignment_id=$1 AND revoked_at IS NULL FOR UPDATE",
        [assignmentId],
      );
      const assignment = current.rows[0];
      if (!assignment) throw new ApplicationError("NOT_FOUND", "有效角色绑定不存在", 404);
      ensureProtectedRoleAuthority(actor, assignment.role_code);
      if (assignment.role_code === "owner_group") {
        const owners = await client.query<{ count: string }>(
          "SELECT count(*)::text count FROM user_role_assignments WHERE role_code='owner_group' AND revoked_at IS NULL",
        );
        if (Number(owners.rows[0]?.count ?? 0) <= 1) {
          throw new ApplicationError("CONFLICT", "不能撤销最后一名老板权限组成员", 409);
        }
      }
      await client.query(
        "UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3 WHERE assignment_id=$1",
        [assignmentId, actor.actorId, reason],
      );
      await this.events.append(client, actor, {
        action: "access.role.revoke",
        entityType: "user_role_assignment",
        entityId: assignmentId,
        before: { userId: assignment.user_id, roleCode: assignment.role_code },
        reason,
      });
    });
  }

  async createPerson(actor: TrustedActorContext, input: CreateBusinessPerson): Promise<{ personId: string }> {
    const normalizedAliases = input.aliases.map(normalizeAlias);
    if (new Set(normalizedAliases).size !== normalizedAliases.length) {
      throw new ApplicationError("VALIDATION_ERROR", "同一人员的别名不能重复", 400);
    }
    return this.transaction(async (client) => {
      const personId = randomUUID();
      const appUserId = input.personType === "internal" ? input.appUserId : null;
      if (appUserId) {
        await ensureActiveOrganizationUser(client, appUserId, "内部人员对应的登录用户不存在、不在职或已停用");
      }
      await client.query(
        "INSERT INTO business_people(person_id,person_type,app_user_id,display_name,created_by) VALUES($1,$2,$3,$4,$5)",
        [personId, input.personType, appUserId, input.displayName, actor.actorId],
      );
      for (const [index, alias] of input.aliases.entries()) {
        await client.query(
          "INSERT INTO business_person_aliases(alias_id,person_id,alias,normalized_alias,created_by) VALUES($1,$2,$3,$4,$5)",
          [randomUUID(), personId, alias, normalizedAliases[index], actor.actorId],
        );
      }
      await this.events.append(client, actor, {
        action: "master_data.person.create",
        entityType: "business_person",
        entityId: personId,
        after: { personType: input.personType, appUserId, displayName: input.displayName, aliases: input.aliases },
      });
      return { personId };
    });
  }

  async revokePersonAlias(actor: TrustedActorContext, aliasId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<{ person_id: string; alias: string; normalized_alias: string }>(
        "SELECT person_id,alias,normalized_alias FROM business_person_aliases WHERE alias_id=$1 AND revoked_at IS NULL FOR UPDATE",
        [aliasId],
      );
      const alias = existing.rows[0];
      if (!alias) throw new ApplicationError("NOT_FOUND", "有效人员别名不存在", 404);
      await client.query(
        "UPDATE business_person_aliases SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3 WHERE alias_id=$1",
        [aliasId, actor.actorId, reason],
      );
      await this.events.append(client, actor, {
        action: "master_data.person_alias.revoke",
        entityType: "business_person_alias",
        entityId: aliasId,
        before: { personId: alias.person_id, alias: alias.alias, normalizedAlias: alias.normalized_alias },
        reason,
      });
    });
  }

  async createProcess(actor: TrustedActorContext, input: CreateProcess): Promise<{ processId: string; version: number }> {
    return this.transaction(async (client) => {
      const processId = randomUUID();
      await client.query("INSERT INTO process_catalog_items(process_id,process_code) VALUES($1,$2)", [processId, input.processCode]);
      await this.insertProcessVersion(client, actor, processId, 1, input);
      return { processId, version: 1 };
    });
  }

  async reviseProcess(actor: TrustedActorContext, processId: string, input: ReviseProcess): Promise<{ processId: string; version: number }> {
    return this.transaction(async (client) => {
      const item = await client.query("SELECT process_id FROM process_catalog_items WHERE process_id=$1 FOR UPDATE", [processId]);
      if (!item.rows[0]) throw new ApplicationError("NOT_FOUND", "工序不存在", 404);
      const next = await client.query<{ version: number }>(
        "SELECT COALESCE(max(version),0)+1 version FROM process_catalog_versions WHERE process_id=$1",
        [processId],
      );
      const version = next.rows[0]?.version ?? 1;
      await this.insertProcessVersion(client, actor, processId, version, input);
      return { processId, version };
    });
  }

  async createSupplier(actor: TrustedActorContext, input: CreateSupplier): Promise<{ supplierId: string; version: number }> {
    return this.transaction(async (client) => {
      const supplierId = randomUUID();
      await client.query(
        "INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type) VALUES($1,$2,$3)",
        [supplierId, input.supplierCode, input.supplierType],
      );
      await this.insertSupplierVersion(client, actor, supplierId, 1, input);
      return { supplierId, version: 1 };
    });
  }

  async reviseSupplier(actor: TrustedActorContext, supplierId: string, input: ReviseSupplier): Promise<{ supplierId: string; version: number }> {
    return this.transaction(async (client) => {
      const item = await client.query("SELECT supplier_id FROM supplier_catalog_items WHERE supplier_id=$1 FOR UPDATE", [supplierId]);
      if (!item.rows[0]) throw new ApplicationError("NOT_FOUND", "供应商不存在", 404);
      const next = await client.query<{ version: number }>(
        "SELECT COALESCE(max(version),0)+1 version FROM supplier_catalog_versions WHERE supplier_id=$1",
        [supplierId],
      );
      const version = next.rows[0]?.version ?? 1;
      await this.insertSupplierVersion(client, actor, supplierId, version, input);
      return { supplierId, version };
    });
  }

  async createDelegation(actor: TrustedActorContext, input: CreateDelegation): Promise<{ delegationId: string }> {
    if (input.capability === "own_factory:approve" && input.scopeType !== "rework_order") {
      throw new ApplicationError("FORBIDDEN", "本厂承担审批只能按指定返工单临时代理", 403);
    }
    if (input.granteeUserId === actor.actorId) {
      throw new ApplicationError("FORBIDDEN", "不能给自己创建临时授权", 403);
    }
    return this.transaction(async (client) => {
      await ensureActiveOrganizationUser(client, input.grantorUserId, "授权人不存在、不在职或已停用");
      await ensureActiveOrganizationUser(client, input.granteeUserId, "被授权用户不存在、不在职或已停用");
      const grantorCapability = await client.query(
        `SELECT 1
         FROM (
           SELECT capability FROM user_capabilities WHERE user_id=$1
           UNION
           SELECT rc.capability FROM user_role_assignments ura
             JOIN role_capabilities rc ON rc.role_code=ura.role_code
             JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
           WHERE ura.user_id=$1 AND ura.revoked_at IS NULL
         ) effective
         WHERE capability=$2`,
        [input.grantorUserId, input.capability],
      );
      if (!grantorCapability.rows[0]) throw new ApplicationError("FORBIDDEN", "授权人本身不具备该能力", 403);
      if (input.capability === "own_factory:approve") {
        const owner = await client.query(
          "SELECT 1 FROM user_role_assignments WHERE user_id=$1 AND role_code='owner_group' AND revoked_at IS NULL",
          [input.grantorUserId],
        );
        if (!owner.rows[0]) {
          throw new ApplicationError("FORBIDDEN", "本厂承担审批代理的授权人必须是老板权限组成员", 403);
        }
      }
      const delegationId = randomUUID();
      await client.query(
        `INSERT INTO delegated_authorizations(
           delegation_id,grantor_user_id,grantee_user_id,capability,scope_type,scope_id,
           valid_from,valid_until,granted_by,grant_reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [delegationId, input.grantorUserId, input.granteeUserId, input.capability, input.scopeType, input.scopeId ?? null, input.validFrom, input.validUntil, actor.actorId, input.reason],
      );
      await this.events.append(client, actor, {
        action: "access.delegation.create",
        entityType: "delegated_authorization",
        entityId: delegationId,
        after: {
          grantorUserId: input.grantorUserId,
          granteeUserId: input.granteeUserId,
          capability: input.capability,
          scopeType: input.scopeType,
          scopeId: input.scopeId ?? null,
          validFrom: input.validFrom,
          validUntil: input.validUntil,
        },
        reason: input.reason,
      });
      return { delegationId };
    });
  }

  async revokeDelegation(actor: TrustedActorContext, delegationId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<{
        grantor_user_id: string;
        grantee_user_id: string;
        capability: string;
        scope_type: string;
        scope_id: string | null;
      }>(
        "SELECT grantor_user_id,grantee_user_id,capability,scope_type,scope_id FROM delegated_authorizations WHERE delegation_id=$1 AND revoked_at IS NULL FOR UPDATE",
        [delegationId],
      );
      const delegation = existing.rows[0];
      if (!delegation) throw new ApplicationError("NOT_FOUND", "有效授权不存在", 404);
      await client.query(
        "UPDATE delegated_authorizations SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3 WHERE delegation_id=$1",
        [delegationId, actor.actorId, reason],
      );
      await this.events.append(client, actor, {
        action: "access.delegation.revoke",
        entityType: "delegated_authorization",
        entityId: delegationId,
        before: delegation,
        reason,
      });
    });
  }

  private async insertProcessVersion(
    client: PoolClient,
    actor: TrustedActorContext,
    processId: string,
    version: number,
    input: ReviseProcess,
  ): Promise<void> {
    await client.query(
      "INSERT INTO process_catalog_versions(process_id,version,process_name,pricing_unit,active,change_reason,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [processId, version, input.processName, input.pricingUnit, input.active, input.changeReason, actor.actorId],
    );
    await this.events.append(client, actor, {
      action: version === 1 ? "master_data.process.create" : "master_data.process.revise",
      entityType: "process_catalog",
      entityId: processId,
      after: { version, processName: input.processName, pricingUnit: input.pricingUnit, active: input.active },
      reason: input.changeReason,
    });
  }

  private async insertSupplierVersion(
    client: PoolClient,
    actor: TrustedActorContext,
    supplierId: string,
    version: number,
    input: ReviseSupplier,
  ): Promise<void> {
    await client.query(
      "INSERT INTO supplier_catalog_versions(supplier_id,version,supplier_name,active,change_reason,changed_by) VALUES($1,$2,$3,$4,$5,$6)",
      [supplierId, version, input.supplierName, input.active, input.changeReason, actor.actorId],
    );
    await this.events.append(client, actor, {
      action: version === 1 ? "master_data.supplier.create" : "master_data.supplier.revise",
      entityType: "supplier_catalog",
      entityId: supplierId,
      after: { version, supplierName: input.supplierName, active: input.active },
      reason: input.changeReason,
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }
}
