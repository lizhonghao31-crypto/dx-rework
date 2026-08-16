import { randomUUID } from "node:crypto";

import type {
  AssignRole,
  CreateBusinessPerson,
  CreateDelegation,
  CreatePersonAlias,
  CreateProcess,
  CreateSupplier,
  ReviseProcess,
  ReviseSupplier,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "./business-authority.js";

type DatabaseError = Readonly<{ code?: string }>;
type PersonAliasRow = Readonly<{ alias_id: string; person_id: string; alias: string; normalized_alias: string }>;

const normalizeAliases = async (client: PoolClient, aliases: readonly string[]): Promise<string[]> => {
  if (aliases.length === 0) return [];
  const result = await client.query<{ normalized_alias: string }>(
    `SELECT normalize_business_person_alias(input.alias) AS normalized_alias
     FROM unnest($1::text[]) WITH ORDINALITY AS input(alias, position)
     ORDER BY input.position`,
    [aliases],
  );
  return result.rows.map((row) => row.normalized_alias);
};

const translateDatabaseError = (error: unknown): never => {
  const code = (error as DatabaseError | null)?.code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "记录已存在或别名已绑定给其他人员", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的用户、角色或基础资料不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前用户无权执行该操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "该记录不允许绕过受控流程修改", 409);
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
  corporationId: string,
  message: string,
): Promise<void> => {
  const result = await client.query(
    `SELECT 1
     FROM app_users u
     WHERE u.id=$1 AND u.enabled=true
       AND EXISTS (
         SELECT 1 FROM identity_mappings i
         WHERE i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=$2
           AND i.active=true AND i.employed=true
       )`,
    [userId, corporationId],
  );
  if (!result.rows[0]) throw new ApplicationError("NOT_FOUND", message, 404);
};

export class AccessMasterDataService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly events = new OperationEventRepository(),
  ) {}

  async ensureOrganizationPolicy(): Promise<void> {
    await this.database.query(
      `INSERT INTO access_security_policy(policy_key,dingtalk_corp_id)
       VALUES('primary',$1)
       ON CONFLICT (policy_key) DO NOTHING`,
      [this.corporationId],
    );
    const policy = await this.database.query<{ dingtalk_corp_id: string }>(
      "SELECT dingtalk_corp_id FROM access_security_policy WHERE policy_key='primary'",
    );
    if (policy.rows[0]?.dingtalk_corp_id !== this.corporationId) {
      throw new ApplicationError("CONFLICT", "数据库绑定的钉钉组织与当前系统配置不一致", 409);
    }
  }

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

  async listRoleAssignments(input: { userId?: string; includeRevoked?: boolean } = {}): Promise<Array<{
    assignmentId: string;
    userId: string;
    displayName: string;
    roleCode: string;
    grantedAt: Date;
    revokedAt: Date | null;
  }>> {
    const result = await this.database.query<{
      assignment_id: string;
      user_id: string;
      display_name: string;
      role_code: string;
      granted_at: Date;
      revoked_at: Date | null;
    }>(
      `SELECT ura.assignment_id,ura.user_id,u.display_name,ura.role_code,ura.granted_at,ura.revoked_at
       FROM user_role_assignments ura
       JOIN app_users u ON u.id=ura.user_id
       WHERE ($1::uuid IS NULL OR ura.user_id=$1)
         AND ($2::boolean OR ura.revoked_at IS NULL)
       ORDER BY u.display_name,ura.role_code,ura.granted_at DESC`,
      [input.userId ?? null, input.includeRevoked ?? false],
    );
    return result.rows.map((row) => ({
      assignmentId: row.assignment_id,
      userId: row.user_id,
      displayName: row.display_name,
      roleCode: row.role_code,
      grantedAt: row.granted_at,
      revokedAt: row.revoked_at,
    }));
  }

  async listDelegations(input: { userId?: string; includeRevoked?: boolean } = {}): Promise<Array<{
    delegationId: string;
    grantorUserId: string;
    grantorDisplayName: string;
    granteeUserId: string;
    granteeDisplayName: string;
    capability: string;
    scopeType: string;
    scopeId: string | null;
    validFrom: Date;
    validUntil: Date;
    revokedAt: Date | null;
  }>> {
    const result = await this.database.query<{
      delegation_id: string;
      grantor_user_id: string;
      grantor_display_name: string;
      grantee_user_id: string;
      grantee_display_name: string;
      capability: string;
      scope_type: string;
      scope_id: string | null;
      valid_from: Date;
      valid_until: Date;
      revoked_at: Date | null;
    }>(
      `SELECT da.delegation_id,da.grantor_user_id,grantor.display_name grantor_display_name,
              da.grantee_user_id,grantee.display_name grantee_display_name,
              da.capability,da.scope_type,da.scope_id,da.valid_from,da.valid_until,da.revoked_at
       FROM delegated_authorizations da
       JOIN app_users grantor ON grantor.id=da.grantor_user_id
       JOIN app_users grantee ON grantee.id=da.grantee_user_id
       WHERE ($1::uuid IS NULL OR da.grantor_user_id=$1 OR da.grantee_user_id=$1)
         AND ($2::boolean OR da.revoked_at IS NULL)
       ORDER BY da.created_at DESC,da.delegation_id`,
      [input.userId ?? null, input.includeRevoked ?? false],
    );
    return result.rows.map((row) => ({
      delegationId: row.delegation_id,
      grantorUserId: row.grantor_user_id,
      grantorDisplayName: row.grantor_display_name,
      granteeUserId: row.grantee_user_id,
      granteeDisplayName: row.grantee_display_name,
      capability: row.capability,
      scopeType: row.scope_type,
      scopeId: row.scope_id,
      validFrom: row.valid_from,
      validUntil: row.valid_until,
      revokedAt: row.revoked_at,
    }));
  }

  async listPeople(input: { includeInactive?: boolean; includeRevokedAliases?: boolean } = {}): Promise<Array<{
    personId: string;
    personType: string;
    appUserId: string | null;
    displayName: string;
    temporaryCode: string | null;
    temporaryRemark: string | null;
    active: boolean;
    aliases: Array<{ aliasId: string; alias: string; revokedAt: string | null; revokeReason: string | null }>;
  }>> {
    const result = await this.database.query<{
      person_id: string;
      person_type: string;
      app_user_id: string | null;
      display_name: string;
      temporary_code: string | null;
      temporary_remark: string | null;
      active: boolean;
      aliases: Array<{ aliasId: string; alias: string; revokedAt: string | null; revokeReason: string | null }>;
    }>(
      `SELECT p.person_id,p.person_type,p.app_user_id,p.display_name,p.temporary_code,p.temporary_remark,p.active,
              COALESCE(
                jsonb_agg(
                  jsonb_build_object(
                    'aliasId',a.alias_id,
                    'alias',a.alias,
                    'revokedAt',a.revoked_at,
                    'revokeReason',a.revoke_reason
                  )
                  ORDER BY a.created_at,a.alias
                )
                  FILTER (WHERE a.alias_id IS NOT NULL),
                '[]'::jsonb
              ) aliases
       FROM business_people p
       LEFT JOIN business_person_aliases a
         ON a.person_id=p.person_id AND ($2::boolean OR a.revoked_at IS NULL)
       WHERE ($1::boolean OR p.active=true)
       GROUP BY p.person_id
       ORDER BY p.display_name,p.person_id`,
      [input.includeInactive ?? false, input.includeRevokedAliases ?? false],
    );
    return result.rows.map((row) => ({
      personId: row.person_id,
      personType: row.person_type,
      appUserId: row.app_user_id,
      displayName: row.display_name,
      temporaryCode: row.temporary_code,
      temporaryRemark: row.temporary_remark,
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
    const rootSelfSystemAdmin = input.userId === actor.actorId
      && input.roleCode === "system_admin"
      && isRootActor(actor);
    if (input.userId === actor.actorId && !rootSelfSystemAdmin) {
      throw new ApplicationError(
        "FORBIDDEN",
        "不能给自己授予业务角色；唯一超级用户仅可自授系统管理员",
        403,
      );
    }
    return this.transaction(async (client) => {
      if (input.roleCode === "owner_group") {
        await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'))");
      }
      await ensureActiveOrganizationUser(client, input.userId, this.corporationId, "目标用户不存在、不在职或已停用");
      const role = await client.query<{ enabled: boolean }>("SELECT enabled FROM business_roles WHERE role_code=$1 FOR SHARE", [input.roleCode]);
      if (!role.rows[0]?.enabled) throw new ApplicationError("NOT_FOUND", "业务角色不存在或已停用", 404);
      await client.query(
        "SELECT pg_advisory_xact_lock(hashtext($1))",
        [`dx_rework:role_assignment:${input.userId}:${input.roleCode}`],
      );
      const existing = await client.query<{ assignment_id: string }>(
        `SELECT assignment_id
         FROM user_role_assignments
         WHERE user_id=$1 AND role_code=$2 AND revoked_at IS NULL`,
        [input.userId, input.roleCode],
      );
      if (existing.rows[0]) return { assignmentId: existing.rows[0].assignment_id };

      const assignmentId = randomUUID();
      await client.query(
        `SELECT
           set_config('dx_rework.role_assign_event_id',$1,true),
           set_config('dx_rework.role_assign_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,$5)",
        [assignmentId, input.userId, input.roleCode, actor.actorId, input.reason],
      );
      return { assignmentId };
    });
  }

  async revokeRole(actor: TrustedActorContext, assignmentId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'))");
      const current = await client.query<{ user_id: string; role_code: string }>(
        "SELECT user_id,role_code FROM user_role_assignments WHERE assignment_id=$1 AND revoked_at IS NULL FOR UPDATE",
        [assignmentId],
      );
      const assignment = current.rows[0];
      if (!assignment) throw new ApplicationError("NOT_FOUND", "有效角色绑定不存在", 404);
      ensureProtectedRoleAuthority(actor, assignment.role_code);
      if (assignment.role_code === "owner_group") {
        const owners = await client.query<{ count: string; target_usable: boolean | null }>(
          `SELECT count(*)::text count,
                  bool_or(ura.user_id=$1) target_usable
           FROM user_role_assignments ura
           JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
           WHERE ura.role_code='owner_group' AND ura.revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM identity_mappings i
               WHERE i.user_id=ura.user_id AND i.provider='dingtalk' AND i.corp_id=$2
                 AND i.active=true AND i.employed=true
             )`,
          [assignment.user_id, this.corporationId],
        );
        if (owners.rows[0]?.target_usable === true && Number(owners.rows[0].count) <= 1) {
          throw new ApplicationError("CONFLICT", "不能撤销最后一名老板权限组成员", 409);
        }
      }
      await client.query(
        `SELECT
           set_config('dx_rework.role_revoke_event_id',$1,true),
           set_config('dx_rework.role_revoke_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        `UPDATE user_role_assignments
         SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3
         WHERE assignment_id=$1`,
        [assignmentId, actor.actorId, reason],
      );
    });
  }

  async createPerson(actor: TrustedActorContext, input: CreateBusinessPerson): Promise<{ personId: string }> {
    return this.transaction(async (client) => {
      const normalizedAliases = await normalizeAliases(client, input.aliases);
      if (new Set(normalizedAliases).size !== normalizedAliases.length) {
        throw new ApplicationError("VALIDATION_ERROR", "同一人员的别名不能重复", 400);
      }
      const personId = randomUUID();
      const appUserId = input.personType === "internal" ? input.appUserId : null;
      const temporaryCode = input.personType === "temporary"
        ? `TMP-${personId.replace(/-/g, "").slice(0, 8).toUpperCase()}`
        : null;
      const temporaryRemark = input.personType === "temporary" ? input.temporaryRemark ?? null : null;
      const aliases = input.aliases.map((alias, index) => ({
        aliasId: randomUUID(),
        alias,
        normalizedAlias: normalizedAliases[index]!,
        reason: input.reason,
      }));
      if (appUserId) {
        await ensureActiveOrganizationUser(client, appUserId, this.corporationId, "内部人员对应的登录用户不存在、不在职或已停用");
      }
      const personEventId = await this.events.append(client, actor, {
        action: "master_data.person.create",
        entityType: "business_person",
        entityId: personId,
        after: { personType: input.personType, appUserId, displayName: input.displayName, temporaryCode, temporaryRemark, active: true, aliases },
        reason: input.reason,
      });
      await client.query(
        `SELECT
           set_config('dx_rework.person_create_event_id',$1,true),
           set_config('dx_rework.person_create_request_id',$2,true)`,
        [personEventId, actor.requestId],
      );
      await client.query(
        "INSERT INTO business_people(person_id,person_type,app_user_id,display_name,temporary_code,temporary_remark,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [personId, input.personType, appUserId, input.displayName, temporaryCode, temporaryRemark, actor.actorId],
      );
      for (const alias of aliases) {
        await client.query(
          `SELECT
             set_config('dx_rework.alias_create_event_id',$1,true),
             set_config('dx_rework.alias_create_request_id',$2,true)`,
          [randomUUID(), actor.requestId],
        );
        await client.query(
          "INSERT INTO business_person_aliases(alias_id,person_id,alias,normalized_alias,created_by,create_reason) VALUES($1,$2,$3,$4,$5,$6)",
          [alias.aliasId, personId, alias.alias, alias.normalizedAlias, actor.actorId, input.reason],
        );
      }
      return { personId };
    });
  }

  async addPersonAlias(
    actor: TrustedActorContext,
    personId: string,
    input: CreatePersonAlias,
  ): Promise<{ aliasId: string }> {
    return this.transaction(async (client) => {
      const person = await client.query(
        "SELECT person_id FROM business_people WHERE person_id=$1 AND active=true FOR UPDATE",
        [personId],
      );
      if (!person.rows[0]) throw new ApplicationError("NOT_FOUND", "有效人员档案不存在", 404);
      const aliasId = randomUUID();
      const [normalizedAlias] = await normalizeAliases(client, [input.alias]);
      await client.query(
        `SELECT
           set_config('dx_rework.alias_create_event_id',$1,true),
           set_config('dx_rework.alias_create_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        "INSERT INTO business_person_aliases(alias_id,person_id,alias,normalized_alias,created_by,create_reason) VALUES($1,$2,$3,$4,$5,$6)",
        [aliasId, personId, input.alias, normalizedAlias!, actor.actorId, input.reason],
      );
      return { aliasId };
    });
  }

  async revokePersonAlias(actor: TrustedActorContext, aliasId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<PersonAliasRow>(
        "SELECT alias_id,person_id,alias,normalized_alias FROM business_person_aliases WHERE alias_id=$1 AND revoked_at IS NULL FOR UPDATE",
        [aliasId],
      );
      const alias = existing.rows[0];
      if (!alias) throw new ApplicationError("NOT_FOUND", "有效人员别名不存在", 404);
      await this.revokePersonAliasRow(client, actor, alias, reason);
    });
  }

  async deactivatePerson(actor: TrustedActorContext, personId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const existing = await client.query<{ person_type: string; app_user_id: string | null; display_name: string }>(
        "SELECT person_type,app_user_id,display_name FROM business_people WHERE person_id=$1 AND active=true FOR UPDATE",
        [personId],
      );
      const person = existing.rows[0];
      if (!person) throw new ApplicationError("NOT_FOUND", "有效人员档案不存在", 404);
      if (person.person_type !== "temporary") {
        throw new ApplicationError("VALIDATION_ERROR", "内部人员状态必须由钉钉组织在职状态驱动", 400);
      }
      const aliases = await client.query<PersonAliasRow>(
        `SELECT alias_id,person_id,alias,normalized_alias
         FROM business_person_aliases
         WHERE person_id=$1 AND revoked_at IS NULL
         ORDER BY alias_id
         FOR UPDATE`,
        [personId],
      );
      for (const alias of aliases.rows) await this.revokePersonAliasRow(client, actor, alias, reason);
      await client.query(
        `SELECT
           set_config('dx_rework.person_deactivate_event_id',$1,true),
           set_config('dx_rework.person_deactivate_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        `UPDATE business_people
         SET active=false,deactivated_at=CURRENT_TIMESTAMP,deactivated_by=$2,deactivate_reason=$3
         WHERE person_id=$1`,
        [personId, actor.actorId, reason],
      );
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
      const current = await client.query<{ version: number }>(
        "SELECT version FROM current_process_catalog WHERE process_id=$1",
        [processId],
      );
      const previous = current.rows[0];
      if (!previous) throw new ApplicationError("CONFLICT", "工序缺少可修订的当前版本", 409);
      const version = previous.version + 1;
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
      const current = await client.query<{ version: number }>(
        "SELECT version FROM current_supplier_catalog WHERE supplier_id=$1",
        [supplierId],
      );
      const previous = current.rows[0];
      if (!previous) throw new ApplicationError("CONFLICT", "供应商缺少可修订的当前版本", 409);
      const version = previous.version + 1;
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
    if (input.capability === "own_factory:approve"
      && (input.grantorUserId !== actor.actorId || !actor.actorRoles.includes("owner_group"))) {
      throw new ApplicationError("FORBIDDEN", "本厂承担审批代理必须由实际操作的老板本人授权", 403);
    }
    return this.transaction(async (client) => {
      await ensureActiveOrganizationUser(client, input.grantorUserId, this.corporationId, "授权人不存在、不在职或已停用");
      await ensureActiveOrganizationUser(client, input.granteeUserId, this.corporationId, "被授权用户不存在、不在职或已停用");
      const grantorCapability = await client.query(
        `SELECT 1
         FROM user_role_assignments ura
         JOIN role_capabilities rc ON rc.role_code=ura.role_code
         JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
         WHERE ura.user_id=$1 AND ura.revoked_at IS NULL AND rc.capability=$2`,
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
        `SELECT
           set_config('dx_rework.delegation_create_event_id',$1,true),
           set_config('dx_rework.delegation_create_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        `INSERT INTO delegated_authorizations(
           delegation_id,grantor_user_id,grantee_user_id,capability,scope_type,scope_id,
           valid_from,valid_until,granted_by,grant_reason
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [delegationId, input.grantorUserId, input.granteeUserId, input.capability, input.scopeType, input.scopeId ?? null, input.validFrom, input.validUntil, actor.actorId, input.reason],
      );
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
      if (!existing.rows[0]) throw new ApplicationError("NOT_FOUND", "有效授权不存在", 404);
      await client.query(
        `SELECT
           set_config('dx_rework.delegation_revoke_event_id',$1,true),
           set_config('dx_rework.delegation_revoke_request_id',$2,true)`,
        [randomUUID(), actor.requestId],
      );
      await client.query(
        `UPDATE delegated_authorizations
         SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3
         WHERE delegation_id=$1`,
        [delegationId, actor.actorId, reason],
      );
    });
  }

  private async revokePersonAliasRow(
    client: PoolClient,
    actor: TrustedActorContext,
    alias: PersonAliasRow,
    reason: string,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.alias_revoke_event_id',$1,true),
         set_config('dx_rework.alias_revoke_request_id',$2,true)`,
      [randomUUID(), actor.requestId],
    );
    await client.query(
      "UPDATE business_person_aliases SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3 WHERE alias_id=$1",
      [alias.alias_id, actor.actorId, reason],
    );
  }

  private async insertProcessVersion(
    client: PoolClient,
    actor: TrustedActorContext,
    processId: string,
    version: number,
    input: ReviseProcess,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.process_version_event_id',$1,true),
         set_config('dx_rework.process_version_request_id',$2,true)`,
      [randomUUID(), actor.requestId],
    );
    await client.query(
      "INSERT INTO process_catalog_versions(process_id,version,process_name,pricing_unit,active,change_reason,changed_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [processId, version, input.processName, input.pricingUnit, input.active, input.changeReason, actor.actorId],
    );
  }

  private async insertSupplierVersion(
    client: PoolClient,
    actor: TrustedActorContext,
    supplierId: string,
    version: number,
    input: ReviseSupplier,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.supplier_version_event_id',$1,true),
         set_config('dx_rework.supplier_version_request_id',$2,true)`,
      [randomUUID(), actor.requestId],
    );
    await client.query(
      "INSERT INTO supplier_catalog_versions(supplier_id,version,supplier_name,active,change_reason,changed_by) VALUES($1,$2,$3,$4,$5,$6)",
      [supplierId, version, input.supplierName, input.active, input.changeReason, actor.actorId],
    );
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
