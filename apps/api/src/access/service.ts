import { createHash, randomUUID } from "node:crypto";
import { CreateSupplierSchema, ReviseSupplierSchema, SUPPLIER_BATCH_COLUMNS, type SupplierBatchApply, type SupplierBatchCell, type SupplierBatchRow } from "@dx-rework/contracts";
import { flagSupplierBatchDuplicates, planSupplierBatchRow, supplierBatchPayload, type SupplierBatchProfile } from "./supplier-batch-model.js";

import type {
  AssignRole,
  CreateBusinessPerson,
  CreateDelegation,
  EnsureCrafts,
  CreatePersonAlias,
  CreateProcess,
  CreateSupplier,
  ReplaceProcessDefaultWorkers,
  ReviseCraft,
  ReviseProcess,
  ReviseSupplier,
  UpdateTemporaryWorkerProfile,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type SqlClient, type TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "./business-authority.js";

type DatabaseError = Readonly<{ code?: string }>;
type CraftCatalogRow = Readonly<{
  craft_id: string;
  craft_code: string;
  version: number;
  craft_name: string;
  active: boolean;
  created_at: Date;
}>;
const craftCatalogItem = (row: CraftCatalogRow) => ({
  craftId: row.craft_id,
  craftCode: row.craft_code,
  version: row.version,
  craftName: row.craft_name,
  active: row.active,
  createdAt: row.created_at.toISOString(),
});

type PersonAliasRow = Readonly<{ alias_id: string; person_id: string; alias: string; normalized_alias: string }>;
type TemporaryWorkerProfileRow = Readonly<{
  person_id: string;
  display_name: string;
  temporary_remark: string | null;
  temporary_phone_number: string | null;
  temporary_identity_number: string | null;
}>;
type TemporaryWorkerProfile = Readonly<{
  personId: string;
  displayName: string;
  temporaryRemark: string | null;
  temporaryPhoneNumber: string | null;
  temporaryIdentityNumber: string | null;
}>;

const temporaryWorkerProfile = (row: TemporaryWorkerProfileRow): TemporaryWorkerProfile => ({
  personId: row.person_id,
  displayName: row.display_name,
  temporaryRemark: row.temporary_remark,
  temporaryPhoneNumber: row.temporary_phone_number,
  temporaryIdentityNumber: row.temporary_identity_number,
});

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
  if (code === "23505") throw new ApplicationError("CONFLICT", "记录已存在或别名已有绑定；请当前维护岗位在原主资料搜索已有记录，人员关联由Root核对，不要重复创建", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的用户、角色或基础资料不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前用户无权执行该操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "该记录不允许绕过受控流程修改", 409);
  if (code === "23514" || code === "22P02") throw new ApplicationError("VALIDATION_ERROR", "主资料提交未通过业务校验，具体字段或状态原因尚未确认；请当前维护岗位核对原资料，仍失败时提供记录链接与请求编号给Root核查", 400);
  throw error;
};

const ensureProtectedRoleAuthority = (actor: TrustedActorContext, roleCode: string): void => {
  if (roleCode === "owner_group" && !actor.actorRoles.includes("owner_group")) {
    throw new ApplicationError("FORBIDDEN", "老板权限组只能由现有老板权限组成员维护", 403);
  }
};

const canMaintainSuppliers = (actor: TrustedActorContext): boolean => isRootActor(actor)
  || (actor.actorRoles.some(role => role === "owner_group" || role === "production_management")
    && (actor.authorizationCapability === "supplier_profile:write"
      || actor.authorizationCapabilities?.includes("supplier_profile:write") === true));

const canReadTemporaryWorkerPrivateProfile = (actor?: TrustedActorContext): boolean =>
  actor !== undefined && (
    isRootActor(actor)
    || actor.authorizationCapabilities?.includes("temporary_worker_private:read") === true
  );

const maskPhoneNumber = (value: string | null): string | null => {
  if (!value) return null;
  if (value.length <= 7) return `${value.slice(0, 2)}***${value.slice(-2)}`;
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
};

const maskIdentityNumber = (value: string | null): string | null => {
  if (!value) return null;
  return `${value.slice(0, 3)}${"*".repeat(Math.max(4, value.length - 7))}${value.slice(-4)}`;
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


type ProcessCatalogPageRow = Readonly<{
  process_id: string;
  process_code: string;
  version: number;
  process_name: string;
  process_name_sort: string;
  pricing_unit: string;
  active: boolean;
  default_worker_person_ids: string[];
  total_count: string;
}>;

const PROCESS_CATALOG_PAGE_SIZE = 15;

const processCatalogItem = (row: ProcessCatalogPageRow) => ({
  processId: row.process_id,
  processCode: row.process_code,
  version: row.version,
  processName: row.process_name,
  pricingUnit: row.pricing_unit,
  active: row.active,
  defaultWorkerPersonIds: row.default_worker_person_ids,
});

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
       WHERE br.enabled=true AND br.role_code<>'tail_inspector'
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

  async listPeople(
    input: { includeInactive?: boolean; includeRevokedAliases?: boolean } = {},
    actor?: TrustedActorContext,
  ): Promise<Array<{
    personId: string;
    personType: string;
    appUserId: string | null;
    displayName: string;
    temporaryCode: string | null;
    temporaryRemark: string | null;
    temporaryPhoneNumber: string | null;
    temporaryIdentityNumber: string | null;
    privateProfileMasked: boolean;
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
      temporary_phone_number: string | null;
      temporary_identity_number: string | null;
      active: boolean;
      aliases: Array<{ aliasId: string; alias: string; revokedAt: string | null; revokeReason: string | null }>;
    }>(
      `SELECT p.person_id,p.person_type,p.app_user_id,p.display_name,p.temporary_code,p.temporary_remark,
              p.temporary_phone_number,p.temporary_identity_number,p.active,
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
    const canReadPrivateProfile = canReadTemporaryWorkerPrivateProfile(actor);
    return result.rows.map((row) => ({
      personId: row.person_id,
      personType: row.person_type,
      appUserId: row.app_user_id,
      displayName: row.display_name,
      temporaryCode: row.temporary_code,
      temporaryRemark: row.temporary_remark,
      temporaryPhoneNumber: canReadPrivateProfile ? row.temporary_phone_number : maskPhoneNumber(row.temporary_phone_number),
      temporaryIdentityNumber: canReadPrivateProfile ? row.temporary_identity_number : maskIdentityNumber(row.temporary_identity_number),
      privateProfileMasked: !canReadPrivateProfile
        && (row.temporary_phone_number !== null || row.temporary_identity_number !== null),
      active: row.active,
      aliases: row.aliases,
    }));
  }

  async listCrafts(query = "", includeInactive = false): Promise<ReturnType<typeof craftCatalogItem>[]> {
    const normalizedQuery = query.trim();
    if (normalizedQuery.length > 100) {
      throw new ApplicationError("VALIDATION_ERROR", "搜索内容不能超过100个字符", 400);
    }
    const result = await this.database.query<CraftCatalogRow>(
      `SELECT craft_id,craft_code,version,craft_name,active,created_at
       FROM current_craft_catalog
       WHERE ($1::boolean OR active=true)
         AND ($2::text='' OR strpos(upper(craft_name || ' ' || craft_code),upper($2))>0)
       ORDER BY normalized_name,craft_code
       LIMIT 200`,
      [includeInactive, normalizedQuery],
    );
    return result.rows.map(craftCatalogItem);
  }

  async ensureCrafts(
    actor: TrustedActorContext,
    input: EnsureCrafts,
  ): Promise<ReturnType<typeof craftCatalogItem>[]> {
    return this.transaction(async (client) => {
      const craftNames = input.craftNames.map((name) => name.trim());
      const normalized = await client.query<{ normalized_name: string }>(
        `SELECT lower(btrim(input.craft_name)) AS normalized_name
         FROM unnest($1::text[]) WITH ORDINALITY AS input(craft_name,position)
         ORDER BY input.position`,
        [craftNames],
      );
      const normalizedNames = normalized.rows.map((row) => row.normalized_name);
      if (new Set(normalizedNames).size !== normalizedNames.length) {
        throw new ApplicationError("VALIDATION_ERROR", "工艺不能重复", 400);
      }
      for (const normalizedName of [...normalizedNames].sort()) {
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`dx_rework:craft:${normalizedName}`]);
      }

      const items: ReturnType<typeof craftCatalogItem>[] = [];
      for (const craftName of craftNames) {
        const current = await client.query<CraftCatalogRow>(
          `SELECT craft_id,craft_code,version,craft_name,active,created_at
           FROM current_craft_catalog
           WHERE normalized_name=lower(btrim($1))`,
          [craftName],
        );
        if (current.rows[0]) {
          if (!current.rows[0].active) {
            throw new ApplicationError("CONFLICT", `工艺“${current.rows[0].craft_name}”已停用`, 409);
          }
          items.push(craftCatalogItem(current.rows[0]));
          continue;
        }

        const archivedIdentity = await client.query<{ craft_id: string; craft_code: string }>(
          `SELECT craft_id,craft_code
           FROM craft_catalog_items
           WHERE normalized_name=lower(btrim($1))
           FOR SHARE`,
          [craftName],
        );
        const craftId = archivedIdentity.rows[0]?.craft_id ?? randomUUID();
        const craftCode = archivedIdentity.rows[0]?.craft_code
          ?? `CRAFT_${randomUUID().replaceAll("-", "").slice(0, 24).toUpperCase()}`;
        const changeReason = "外发订单业务页新增工艺";
        const craftCreationEventId = await this.events.append(client, actor, {
          action: "master_data.craft.create",
          entityType: "craft_catalog",
          entityId: craftId,
          after: { craftId, craftCode, version: 1, craftName, active: true },
          reason: changeReason,
        });
        if (!archivedIdentity.rows[0]) {
          await client.query(
            `INSERT INTO craft_catalog_items(
               craft_id,craft_code,craft_name,created_by,operation_event_id,request_id
             ) VALUES($1,$2,$3,$4,$5,$6)`,
            [craftId, craftCode, craftName, actor.actorId, craftCreationEventId, actor.requestId],
          );
        }
        await client.query(
          `INSERT INTO craft_catalog_versions(
             craft_id,version,craft_name,active,change_reason,changed_by,operation_event_id,request_id
           ) VALUES($1,1,$2,true,$3,$4,$5,$6)`,
          [craftId, craftName, changeReason, actor.actorId, craftCreationEventId, actor.requestId],
        );
        const inserted = await client.query<CraftCatalogRow>(
          `SELECT craft_id,craft_code,version,craft_name,active,created_at
           FROM current_craft_catalog WHERE craft_id=$1`,
          [craftId],
        );
        items.push(craftCatalogItem(inserted.rows[0]!));
      }
      return items;
    });
  }

  async reviseCraft(
    actor: TrustedActorContext,
    craftId: string,
    input: ReviseCraft,
  ): Promise<{ craftId: string; version: number }> {
    return this.transaction(async (client) => {
      const normalized = await client.query<{ normalized_name: string }>(
        "SELECT lower(btrim($1)) AS normalized_name",
        [input.craftName],
      );
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        `dx_rework:craft:${normalized.rows[0]!.normalized_name}`,
      ]);
      const item = await client.query<CraftCatalogRow>(
        `SELECT current.craft_id,current.craft_code,current.version,current.craft_name,current.active,current.created_at
         FROM craft_catalog_items item
         JOIN current_craft_catalog current ON current.craft_id=item.craft_id
         WHERE item.craft_id=$1
         FOR UPDATE OF item`,
        [craftId],
      );
      const previous = item.rows[0];
      if (!previous) throw new ApplicationError("NOT_FOUND", "工艺不存在", 404);
      const duplicate = await client.query(
        `SELECT 1 FROM current_craft_catalog
         WHERE normalized_name=lower(btrim($1)) AND craft_id<>$2`,
        [input.craftName, craftId],
      );
      if (duplicate.rows[0]) throw new ApplicationError("CONFLICT", "工艺名称已存在", 409);
      const version = previous.version + 1;
      const before = {
        craftId,
        craftCode: previous.craft_code,
        version: previous.version,
        craftName: previous.craft_name,
        active: previous.active,
      };
      const after = {
        craftId,
        craftCode: previous.craft_code,
        version,
        craftName: input.craftName,
        active: input.active,
      };
      const craftRevisionEventId = await this.events.append(client, actor, {
        action: "master_data.craft.revise",
        entityType: "craft_catalog",
        entityId: craftId,
        before,
        after,
        reason: input.changeReason,
      });
      await client.query(
        `INSERT INTO craft_catalog_versions(
           craft_id,version,craft_name,active,change_reason,changed_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
        [craftId, version, input.craftName, input.active, input.changeReason, actor.actorId, craftRevisionEventId, actor.requestId],
      );
      return { craftId, version };
    });
  }

  async listCraftHistory(craftId: string): Promise<Array<ReturnType<typeof craftCatalogItem> & {
    changeReason: string;
    changedBy: string;
  }>> {
    const result = await this.database.query<CraftCatalogRow & {
      change_reason: string;
      changed_by: string;
    }>(
      `SELECT item.craft_id,item.craft_code,version.version,version.craft_name,version.active,
              version.change_reason,version.changed_by,version.created_at
       FROM craft_catalog_items item
       JOIN craft_catalog_versions version ON version.craft_id=item.craft_id
       WHERE item.craft_id=$1
       ORDER BY version.version DESC`,
      [craftId],
    );
    if (result.rows.length === 0) throw new ApplicationError("NOT_FOUND", "工艺不存在", 404);
    return result.rows.map((row) => ({
      ...craftCatalogItem(row),
      changeReason: row.change_reason,
      changedBy: row.changed_by,
    }));
  }

  async listProcesses(includeInactive = false): Promise<Array<{
    processId: string;
    processCode: string;
    version: number;
    processName: string;
    pricingUnit: string;
    active: boolean;
    defaultWorkerPersonIds: string[];
  }>> {
    const result = await this.database.query<{
      process_id: string;
      process_code: string;
      version: number;
      process_name: string;
      pricing_unit: string;
      active: boolean;
      default_worker_person_ids: string[];
    }>(
      `SELECT catalog.process_id,catalog.process_code,catalog.version,catalog.process_name,catalog.pricing_unit,catalog.active,
              COALESCE(roster.person_ids,'{}'::uuid[]) AS default_worker_person_ids
       FROM current_process_catalog catalog
       LEFT JOIN LATERAL (
         SELECT person_ids FROM process_default_worker_roster_versions roster_version
         WHERE roster_version.process_id=catalog.process_id
         ORDER BY roster_version.roster_version DESC LIMIT 1
       ) roster ON true
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
      defaultWorkerPersonIds: row.default_worker_person_ids,
    }));
  }


  async listProcessPage(input: {
    includeInactive?: boolean;
    query?: string;
    page?: number;
  } = {}): Promise<{
    items: Array<{
      processId: string;
      processCode: string;
      version: number;
      processName: string;
      pricingUnit: string;
      active: boolean;
      defaultWorkerPersonIds: string[];
    }>;
    page: number;
    pageSize: 15;
    totalCount: number;
    totalPages: number;
  }> {
    const includeInactive = input.includeInactive ?? false;
    const query = (input.query ?? "").trim();
    if (query.length > 100) throw new ApplicationError("VALIDATION_ERROR", "搜索内容不能超过100个字符", 400);
    const page = input.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 100_000) {
      throw new ApplicationError("VALIDATION_ERROR", "分页页码无效", 400);
    }
    const offset = (page - 1) * PROCESS_CATALOG_PAGE_SIZE;
    const result = await this.database.query<ProcessCatalogPageRow>(
      `SELECT catalog.process_id,catalog.process_code,catalog.version,catalog.process_name,
              lower(catalog.process_name) AS process_name_sort,
              catalog.pricing_unit,catalog.active,
              COALESCE(roster.person_ids,'{}'::uuid[]) AS default_worker_person_ids,
              count(*) OVER()::text AS total_count
       FROM current_process_catalog catalog
       LEFT JOIN LATERAL (
         SELECT person_ids FROM process_default_worker_roster_versions roster_version
         WHERE roster_version.process_id=catalog.process_id
         ORDER BY roster_version.roster_version DESC LIMIT 1
       ) roster ON true
       WHERE ($1::boolean OR catalog.active=true)
         AND ($2::text='' OR strpos(upper(catalog.process_name || ' ' || catalog.process_code),upper($2))>0)
       ORDER BY lower(catalog.process_name),catalog.process_code,catalog.process_id
       LIMIT 15 OFFSET $3`,
      [
        includeInactive,
        query,
        offset,
      ],
    );
    const rows = result.rows;
    const totalCount = Number(rows[0]?.total_count ?? "0");
    return {
      items: rows.map(processCatalogItem),
      page,
      pageSize: PROCESS_CATALOG_PAGE_SIZE,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / PROCESS_CATALOG_PAGE_SIZE)),
    };
  }

  async listProcessDefaultWorkerCandidates(): Promise<Array<{
    personId: string;
    personType: "internal" | "temporary";
    displayName: string;
    temporaryRemark: string | null;
  }>> {
    const result = await this.database.query<{
      person_id: string;
      person_type: "internal" | "temporary";
      display_name: string;
      temporary_remark: string | null;
    }>(
      `SELECT p.person_id,p.person_type,p.display_name,p.temporary_remark
       FROM business_people p
       WHERE p.active=true AND (
         p.person_type='temporary'
         OR EXISTS (
           SELECT 1 FROM user_role_assignments assignment
           WHERE assignment.user_id=p.app_user_id
             AND assignment.role_code='worker'
             AND assignment.revoked_at IS NULL
         )
       )
       ORDER BY p.person_type,p.display_name,p.person_id`,
    );
    return result.rows.map((row) => ({
      personId: row.person_id,
      personType: row.person_type,
      displayName: row.display_name,
      temporaryRemark: row.temporary_remark,
    }));
  }

  async listSuppliers(includeInactive = false): Promise<Array<{
    supplierId: string;
    supplierCode: string;
    supplierType: string;
    version: number;
    supplierName: string;
    active: boolean;
    supportedCrafts: string[];
    dailyCapacity: number | null;
    contractDataMissing: string[];
    changedAt: string;
  }>> {
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_type: string;
      version: number;
      supplier_name: string;
      active: boolean;
      address: string | null;
      supported_crafts: string[];
      daily_capacity: number | null;
      contract_entity_name: string | null;
      party_b_representative: string | null;
      payee_name: string | null;
      bank_account: string | null;
      bank_name: string | null;
      created_at: Date;
    }>(
      `SELECT supplier_id,supplier_code,supplier_type,version,supplier_name,active,address,
              supported_crafts,daily_capacity,contract_entity_name,party_b_representative,
              payee_name,bank_account,bank_name,created_at
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
      supportedCrafts: row.supported_crafts,
      dailyCapacity: row.daily_capacity,
      contractDataMissing: this.contractDataMissing(row),
      changedAt: row.created_at.toISOString(),
    }));
  }

  async getSupplier(supplierId: string, includeContractData = false): Promise<Record<string, unknown>> {
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_type: string;
      version: number;
      supplier_name: string;
      active: boolean;
      notes: string;
      contact_person: string | null;
      contact_phone: string | null;
      address: string | null;
      contract_entity_name: string | null;
      party_b_representative: string | null;
      payee_name: string | null;
      bank_account: string | null;
      bank_name: string | null;
      supported_crafts: string[];
      daily_capacity: number | null;
      change_reason: string;
      changed_by: string;
      created_at: Date;
    }>(
      `SELECT supplier_id,supplier_code,supplier_type,version,supplier_name,active,
              notes,contact_person,contact_phone,address,contract_entity_name,
              party_b_representative,payee_name,bank_account,bank_name,
              supported_crafts,daily_capacity,change_reason,changed_by,created_at
       FROM current_supplier_catalog
       WHERE supplier_id=$1`,
      [supplierId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "供应商不存在", 404);
    return this.serializeSupplierProfile(row, includeContractData);
  }

  async listSupplierHistory(supplierId: string, includeContractData = false): Promise<Array<Record<string, unknown>>> {
    const result = await this.database.query<{
      supplier_id: string;
      supplier_code: string;
      supplier_type: string;
      version: number;
      supplier_name: string;
      active: boolean;
      notes: string;
      contact_person: string | null;
      contact_phone: string | null;
      address: string | null;
      contract_entity_name: string | null;
      party_b_representative: string | null;
      payee_name: string | null;
      bank_account: string | null;
      bank_name: string | null;
      supported_crafts: string[];
      daily_capacity: number | null;
      change_reason: string;
      changed_by: string;
      created_at: Date;
    }>(
      `SELECT item.supplier_id,item.supplier_code,item.supplier_type,
              version.version,version.supplier_name,version.active,version.notes,
              version.contact_person,version.contact_phone,version.address,
              version.contract_entity_name,version.party_b_representative,
              version.payee_name,version.bank_account,version.bank_name,
              version.supported_crafts,version.daily_capacity,version.change_reason,
              version.changed_by,version.created_at
       FROM supplier_catalog_items item
       JOIN supplier_catalog_versions version ON version.supplier_id=item.supplier_id
       WHERE item.supplier_id=$1
       ORDER BY version.version DESC`,
      [supplierId],
    );
    if (result.rows.length === 0) throw new ApplicationError("NOT_FOUND", "供应商不存在", 404);
    return result.rows.map((row) => this.serializeSupplierProfile(row, includeContractData));
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
      await this.autoEnableForAuthorization(client, actor, input.userId, input.reason);
      const role = await client.query<{ enabled: boolean }>("SELECT enabled FROM business_roles WHERE role_code=$1 FOR SHARE", [input.roleCode]);
      if (!role.rows[0]?.enabled) throw new ApplicationError("NOT_FOUND", "业务角色不存在或已停用；请Root在员工权限页核对可用岗位，不能继续提交旧页面中的失效角色", 404);
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
      await this.autoDisableWithoutAuthorization(client, actor, assignment.user_id, reason);
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
      const temporaryPhoneNumber = input.personType === "temporary" ? input.temporaryPhoneNumber ?? null : null;
      const temporaryIdentityNumber = input.personType === "temporary" ? input.temporaryIdentityNumber ?? null : null;
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
        after: { personType: input.personType, appUserId, displayName: input.displayName, temporaryCode, temporaryRemark,
          hasTemporaryPhoneNumber: temporaryPhoneNumber !== null,
          hasTemporaryIdentityNumber: temporaryIdentityNumber !== null,
          active: true, aliases },
        reason: input.reason,
      });
      await client.query(
        `SELECT
           set_config('dx_rework.person_create_event_id',$1,true),
           set_config('dx_rework.person_create_request_id',$2,true)`,
        [personEventId, actor.requestId],
      );
      await client.query(
        `INSERT INTO business_people(
           person_id,person_type,app_user_id,display_name,temporary_code,temporary_remark,
           temporary_phone_number,temporary_identity_number,created_by
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [personId, input.personType, appUserId, input.displayName, temporaryCode, temporaryRemark,
          temporaryPhoneNumber, temporaryIdentityNumber, actor.actorId],
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

  async getTemporaryWorkerProfile(
    actor: TrustedActorContext,
    personId: string,
  ): Promise<TemporaryWorkerProfile> {
    if (!canReadTemporaryWorkerPrivateProfile(actor)) {
      throw new ApplicationError("FORBIDDEN", "无权查看临时工隐私资料", 403);
    }
    const result = await this.database.query<TemporaryWorkerProfileRow>(
      `SELECT person_id,display_name,temporary_remark,temporary_phone_number,temporary_identity_number
       FROM business_people
       WHERE person_id=$1 AND person_type='temporary' AND active=true`,
      [personId],
    );
    const profile = result.rows[0];
    if (!profile) throw new ApplicationError("NOT_FOUND", "有效临时工档案不存在", 404);
    return temporaryWorkerProfile(profile);
  }

  async updateTemporaryWorkerProfile(
    actor: TrustedActorContext,
    personId: string,
    input: UpdateTemporaryWorkerProfile,
  ): Promise<TemporaryWorkerProfile> {
    if (!canReadTemporaryWorkerPrivateProfile(actor)) {
      throw new ApplicationError("FORBIDDEN", "无权修改临时工隐私资料", 403);
    }
    return this.transaction(async (client) => {
      const result = await client.query<TemporaryWorkerProfileRow>(
        `SELECT person_id,display_name,temporary_remark,temporary_phone_number,temporary_identity_number
         FROM business_people
         WHERE person_id=$1 AND person_type='temporary' AND active=true
         FOR UPDATE`,
        [personId],
      );
      const current = result.rows[0];
      if (!current) throw new ApplicationError("NOT_FOUND", "有效临时工档案不存在", 404);

      const next: TemporaryWorkerProfileRow = {
        ...current,
        temporary_remark: input.temporaryRemark,
        temporary_phone_number: input.temporaryPhoneNumber,
        temporary_identity_number: input.temporaryIdentityNumber,
      };
      if (
        current.temporary_remark === next.temporary_remark
        && current.temporary_phone_number === next.temporary_phone_number
        && current.temporary_identity_number === next.temporary_identity_number
      ) return temporaryWorkerProfile(current);

      const operationEventId = await this.events.append(client, actor, {
        action: "master_data.temporary_worker_profile.update",
        entityType: "business_person",
        entityId: personId,
        before: {
          hasTemporaryRemark: current.temporary_remark !== null,
          hasTemporaryPhoneNumber: current.temporary_phone_number !== null,
          hasTemporaryIdentityNumber: current.temporary_identity_number !== null,
        },
        after: {
          hasTemporaryRemark: next.temporary_remark !== null,
          hasTemporaryPhoneNumber: next.temporary_phone_number !== null,
          hasTemporaryIdentityNumber: next.temporary_identity_number !== null,
        },
        reason: input.reason,
      });
      await client.query(
        `SELECT
           set_config('dx_rework.temporary_worker_profile_event_id',$1,true),
           set_config('dx_rework.temporary_worker_profile_request_id',$2,true)`,
        [operationEventId, actor.requestId],
      );
      await client.query(
        `UPDATE business_people
         SET temporary_remark=$2,temporary_phone_number=$3,temporary_identity_number=$4
         WHERE person_id=$1`,
        [personId, next.temporary_remark, next.temporary_phone_number, next.temporary_identity_number],
      );
      return temporaryWorkerProfile(next);
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

  async replaceProcessDefaultWorkers(
    actor: TrustedActorContext,
    processId: string,
    input: ReplaceProcessDefaultWorkers,
  ): Promise<{ processId: string; rosterVersion: number; personIds: string[] }> {
    return this.transaction(async (client) => {
      const process = await client.query(
        "SELECT process_id FROM process_catalog_items WHERE process_id=$1 FOR UPDATE",
        [processId],
      );
      if (!process.rows[0]) throw new ApplicationError("NOT_FOUND", "工序不存在", 404);
      const personIds = [...input.personIds].sort();
      if (personIds.length > 0) {
        const eligible = await client.query<{ person_id: string }>(
          `SELECT p.person_id
           FROM business_people p
           WHERE p.person_id=ANY($1::uuid[]) AND p.active=true AND (
             p.person_type='temporary'
             OR EXISTS (
               SELECT 1 FROM user_role_assignments assignment
               WHERE assignment.user_id=p.app_user_id
                 AND assignment.role_code='worker'
                 AND assignment.revoked_at IS NULL
             )
           )`,
          [personIds],
        );
        if (eligible.rowCount !== personIds.length) {
          throw new ApplicationError("VALIDATION_ERROR", "默认名单只能包含当前有效的正式工或临时工", 400);
        }
      }
      const latest = await client.query<{ roster_version: number }>(
        `SELECT roster_version FROM process_default_worker_roster_versions
         WHERE process_id=$1 ORDER BY roster_version DESC LIMIT 1`,
        [processId],
      );
      const rosterVersion = (latest.rows[0]?.roster_version ?? 0) + 1;
      const operationEventId = await this.events.append(client, actor, {
        action: "master_data.process_default_workers.replace",
        entityType: "process_default_worker_roster",
        entityId: processId,
        after: { processId, rosterVersion, personIds },
        reason: input.changeReason,
      });
      await client.query(
        `INSERT INTO process_default_worker_roster_versions(
           process_id,roster_version,person_ids,change_reason,changed_by,operation_event_id
         ) VALUES($1,$2,$3,$4,$5,$6)`,
        [processId, rosterVersion, personIds, input.changeReason, actor.actorId, operationEventId],
      );
      return { processId, rosterVersion, personIds };
    });
  }

  async replaceTailInspectionDefaultWorkers(
    actor: TrustedActorContext,
    input: ReplaceProcessDefaultWorkers,
  ): Promise<{ executionKind: "tail_inspection"; rosterVersion: number; personIds: string[] }> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:tail_default_worker_roster'))");
      const personIds = [...input.personIds].sort();
      if (personIds.length > 0) {
        const eligible = await client.query<{ person_id: string }>(
          `SELECT person.person_id
           FROM business_people person
           WHERE person.person_id=ANY($1::uuid[])
             AND person.active=true
             AND (
               person.person_type='temporary'
               OR (
                 person.person_type='internal'
                 AND EXISTS (
                   SELECT 1
                   FROM app_users app_user
                   JOIN identity_mappings identity
                     ON identity.user_id=app_user.id
                    AND identity.provider='dingtalk'
                    AND identity.active=true
                    AND identity.employed=true
                   JOIN access_security_policy policy
                     ON policy.policy_key='primary'
                    AND policy.dingtalk_corp_id=identity.corp_id
                   JOIN user_role_assignments assignment
                     ON assignment.user_id=app_user.id
                    AND assignment.role_code IN ('worker','tail_inspector')
                    AND assignment.revoked_at IS NULL
                   JOIN business_roles role
                     ON role.role_code=assignment.role_code
                    AND role.enabled=true
                   JOIN role_capabilities capability
                     ON capability.role_code=assignment.role_code
                    AND capability.capability='tail_inspection:report'
                   WHERE app_user.id=person.app_user_id
                     AND app_user.enabled=true
                 )
               )
             )`,
          [personIds],
        );
        if (eligible.rowCount !== personIds.length) {
          throw new ApplicationError("VALIDATION_ERROR", "整查默认名单只能包含当前有效的正式工或临时工", 400);
        }
      }
      const latest = await client.query<{ roster_version: number }>(
        `SELECT roster_version FROM tail_inspection_default_worker_roster_versions
         ORDER BY roster_version DESC LIMIT 1`,
      );
      const rosterVersion = (latest.rows[0]?.roster_version ?? 0) + 1;
      const operationEventId = await this.events.append(client, actor, {
        action: "master_data.tail_default_workers.replace",
        entityType: "tail_inspection_default_worker_roster",
        entityId: "tail_inspection",
        after: { executionKind: "tail_inspection", rosterVersion, personIds },
        reason: input.changeReason,
      });
      await client.query(
        `INSERT INTO tail_inspection_default_worker_roster_versions(
           roster_version,person_ids,change_reason,changed_by,operation_event_id
         ) VALUES($1,$2,$3,$4,$5)`,
        [rosterVersion, personIds, input.changeReason, actor.actorId, operationEventId],
      );
      return { executionKind: "tail_inspection", rosterVersion, personIds };
    });
  }

  private async supplierBatchCatalog(client: SqlClient = this.database): Promise<SupplierBatchProfile[]> {
    const result = await client.query<Parameters<AccessMasterDataService["serializeSupplierProfile"]>[0]>("SELECT * FROM current_supplier_catalog");
    return result.rows.map(row => this.serializeSupplierProfile(row, true) as unknown as SupplierBatchProfile);
  }

  async previewSupplierBatch(actor: TrustedActorContext, rows: SupplierBatchCell[][]): Promise<SupplierBatchRow[]> {
    if (!canMaintainSuppliers(actor)) throw new ApplicationError("FORBIDDEN", "无供应商维护权限", 403);
    if (JSON.stringify(rows[0]) !== JSON.stringify(SUPPLIER_BATCH_COLUMNS.map(([, label]) => label))) {
      throw new ApplicationError("VALIDATION_ERROR", "列名或顺序与模板不一致，请使用标准模板", 400);
    }
    const catalog = await this.supplierBatchCatalog();
    const planned = rows.slice(1).flatMap((cells, index) => cells.every(cell => cell === null || String(cell).trim() === "") ? []
      : [planSupplierBatchRow(cells, catalog, `SUP_${randomUUID().replaceAll("-", "").slice(0,24).toUpperCase()}`, index + 2)]);
    return flagSupplierBatchDuplicates(planned);
  }

  async applySupplierBatchRow(actor: TrustedActorContext, input: SupplierBatchApply, key: string) {
    if (!canMaintainSuppliers(actor)) throw new ApplicationError("FORBIDDEN", "无供应商维护权限", 403);
    return this.transaction(async client => new IdempotencyService().execute(client, {
      scope: "supplier-batch-row", actorKey: actor.actorId, key,
      requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
      expiresAt: new Date(Date.now() + 30 * 86400_000),
    }, async () => {
      // Serialize batch identity checks so two uploads cannot create the same new supplier.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('supplier-batch-identity',0))");
      if (input.expectedSupplierId) await client.query("SELECT supplier_id FROM supplier_catalog_items WHERE supplier_id=$1 FOR UPDATE", [input.expectedSupplierId]);
      const row = planSupplierBatchRow(input.cells, await this.supplierBatchCatalog(client), input.supplierCode);
      if (["conflict", "error"].includes(row.status)) throw new ApplicationError("VALIDATION_ERROR", row.message, 400);
      if (row.status === "create" && !/^SUP_[A-F0-9]{24}$/.test(input.supplierCode)) throw new ApplicationError("VALIDATION_ERROR", "新增编码无效，请重新预检生成系统编码", 400);
      if (row.supplierId !== input.expectedSupplierId || row.version !== input.expectedVersion || row.supplierCode !== input.supplierCode) {
        throw new ApplicationError("CONFLICT", "供应商资料或匹配对象已变化，请重新预检", 409);
      }
      if (input.confirmedFields.some(field => !row.changes.some(change => change.field === field && change.needsConfirmation))) {
        throw new ApplicationError("CONFLICT", "确认字段与预检差异不一致，请重新预检", 409);
      }
      const selected = row.changes.filter(change => !change.needsConfirmation || input.confirmedFields.includes(change.field));
      if (row.supplierId && !selected.length) return { statusCode: 200, response: { supplierId: row.supplierId, version: row.version!, unchanged: true } };
      const payload = supplierBatchPayload(row, input);
      const result = row.supplierId
        ? await this.reviseSupplierWithClient(client, actor, row.supplierId, ReviseSupplierSchema.parse(payload))
        : await this.createSupplierWithClient(client, actor, CreateSupplierSchema.parse(payload));
      return { statusCode: 200, response: { ...result, unchanged: false } };
    }));
  }

  async createSupplier(actor: TrustedActorContext, input: CreateSupplier): Promise<{ supplierId: string; version: number }> {
    return this.transaction(client => this.createSupplierWithClient(client, actor, input));
  }

  async createSupplierWithClient(client: PoolClient, actor: TrustedActorContext, input: CreateSupplier) {
      const supplierId = randomUUID();
      await client.query(
        "INSERT INTO supplier_catalog_items(supplier_id,supplier_code,supplier_type) VALUES($1,$2,$3)",
        [supplierId, input.supplierCode, input.supplierType],
      );
      await this.insertSupplierVersion(client, actor, supplierId, 1, input);
      return { supplierId, version: 1 };
  }

  async reviseSupplier(actor: TrustedActorContext, supplierId: string, input: ReviseSupplier): Promise<{ supplierId: string; version: number }> {
    return this.transaction(client => this.reviseSupplierWithClient(client, actor, supplierId, input));
  }

  private async reviseSupplierWithClient(client: PoolClient, actor: TrustedActorContext, supplierId: string, input: ReviseSupplier) {
      const item = await client.query("SELECT supplier_id FROM supplier_catalog_items WHERE supplier_id=$1 FOR UPDATE", [supplierId]);
      if (!item.rows[0]) throw new ApplicationError("NOT_FOUND", "供应商不存在", 404);
      const current = await client.query<{
        version: number;
        supplier_name: string;
        active: boolean;
        notes: string;
        contact_person: string | null;
        contact_phone: string | null;
        address: string | null;
        contract_entity_name: string | null;
        party_b_representative: string | null;
        payee_name: string | null;
        bank_account: string | null;
        bank_name: string | null;
        supported_crafts: string[];
        daily_capacity: number | null;
      }>(
        `SELECT version,supplier_name,active,notes,contact_person,contact_phone,address,
                contract_entity_name,party_b_representative,payee_name,bank_account,
                bank_name,supported_crafts,daily_capacity
         FROM current_supplier_catalog WHERE supplier_id=$1`,
        [supplierId],
      );
      const previous = current.rows[0];
      if (!previous) throw new ApplicationError("CONFLICT", "供应商缺少可修订的当前版本", 409);
      if (input.expectedVersion !== previous.version) {
        throw new ApplicationError("CONFLICT", "供应商资料已更新，请刷新后重试", 409);
      }
      const version = previous.version + 1;
      await this.insertSupplierVersion(client, actor, supplierId, version, {
        supplierName: input.supplierName ?? previous.supplier_name,
        active: input.active ?? previous.active,
        notes: input.notes ?? previous.notes,
        contactPerson: input.contactPerson === undefined ? previous.contact_person : input.contactPerson,
        contactPhone: input.contactPhone === undefined ? previous.contact_phone : input.contactPhone,
        address: input.address === undefined ? previous.address : input.address,
        contractEntityName: input.contractEntityName === undefined
          ? previous.contract_entity_name
          : input.contractEntityName,
        partyBRepresentative: input.partyBRepresentative === undefined
          ? previous.party_b_representative
          : input.partyBRepresentative,
        payeeName: input.payeeName === undefined ? previous.payee_name : input.payeeName,
        bankAccount: input.bankAccount === undefined ? previous.bank_account : input.bankAccount,
        bankName: input.bankName === undefined ? previous.bank_name : input.bankName,
        supportedCrafts: input.supportedCrafts ?? previous.supported_crafts,
        dailyCapacity: input.dailyCapacity === undefined ? previous.daily_capacity : input.dailyCapacity,
        changeReason: input.changeReason,
      });
      return { supplierId, version };
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
      await this.autoEnableForAuthorization(client, actor, input.granteeUserId, input.reason);
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
      await this.autoDisableWithoutAuthorization(
        client,
        actor,
        input.granteeUserId,
        input.reason,
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
      await this.autoDisableWithoutAuthorization(
        client,
        actor,
        existing.rows[0].grantee_user_id,
        reason,
      );
    });
  }

  private async autoEnableForAuthorization(
    client: PoolClient,
    actor: TrustedActorContext,
    userId: string,
    reason: string,
  ): Promise<void> {
    const target = await client.query<{
      enabled: boolean;
      manual_access_disabled: boolean;
    }>(
      `SELECT app_user.enabled,app_user.manual_access_disabled
       FROM app_users app_user
       WHERE app_user.id=$1
         AND EXISTS (
           SELECT 1
           FROM identity_mappings identity
           WHERE identity.user_id=app_user.id
             AND identity.provider='dingtalk'
             AND identity.corp_id=$2
             AND identity.active=true
             AND identity.employed=true
         )
       FOR UPDATE OF app_user`,
      [userId, this.corporationId],
    );
    const current = target.rows[0];
    if (!current) {
      throw new ApplicationError("NOT_FOUND", "目标用户不存在或不属于当前在职企业成员", 404);
    }
    if (current.enabled) return;
    if (current.manual_access_disabled) {
      throw new ApplicationError("CONFLICT", "目标员工已被人工停用，请先恢复访问", 409);
    }

    await client.query(
      "UPDATE app_users SET enabled=true,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [userId],
    );
    await this.events.append(client, actor, {
      action: "access.employee.auto_enable",
      entityType: "app_user",
      entityId: userId,
      before: { enabled: false },
      after: { enabled: true },
      reason,
    });
  }

  private async autoDisableWithoutAuthorization(
    client: PoolClient,
    actor: TrustedActorContext,
    userId: string,
    reason: string,
  ): Promise<void> {
    const target = await client.query<{
      enabled: boolean;
      manual_access_disabled: boolean;
      is_root: boolean;
      has_authorization: boolean;
    }>(
      `SELECT
         app_user.enabled,
         app_user.manual_access_disabled,
         EXISTS(
           SELECT 1
           FROM owner_bootstrap_consumptions root
           WHERE root.singleton=true AND root.user_id=app_user.id
         ) is_root,
         access_user_has_effective_authorization(app_user.id) has_authorization
       FROM app_users app_user
       WHERE app_user.id=$1
       FOR UPDATE OF app_user`,
      [userId],
    );
    const current = target.rows[0];
    if (!current || current.is_root || current.has_authorization) return;

    if (!current.enabled) {
      if (!current.manual_access_disabled) return;
      await client.query(
        `UPDATE app_users
         SET manual_access_disabled=false,updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [userId],
      );
      await this.events.append(client, actor, {
        action: "access.employee.auto_disable",
        entityType: "app_user",
        entityId: userId,
        before: { enabled: false, manualAccessDisabled: true },
        after: { enabled: false, manualAccessDisabled: false, sessionsRevoked: true },
        reason,
      });
      return;
    }

    await client.query(
      "UPDATE app_users SET enabled=false,updated_at=CURRENT_TIMESTAMP WHERE id=$1",
      [userId],
    );
    await client.query(
      "UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL",
      [userId],
    );
    await this.events.append(client, actor, {
      action: "access.employee.auto_disable",
      entityType: "app_user",
      entityId: userId,
      before: { enabled: true },
      after: { enabled: false, sessionsRevoked: true },
      reason,
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
    input: Omit<ReviseSupplier, "expectedVersion">,
  ): Promise<void> {
    const authorizationCapability = actor.authorizationCapability === "supplier_profile:write"
      || actor.authorizationCapabilities?.includes("supplier_profile:write") === true
      ? "supplier_profile:write"
      : "master_data:manage";
    await client.query(
      `SELECT
         set_config('dx_rework.supplier_version_event_id',$1,true),
         set_config('dx_rework.supplier_version_request_id',$2,true),
         set_config('dx_rework.supplier_version_authorization_capability',$3,true)`,
      [randomUUID(), actor.requestId, authorizationCapability],
    );
    await client.query(
      `INSERT INTO supplier_catalog_versions(
         supplier_id,version,supplier_name,active,notes,contact_person,contact_phone,address,
         contract_entity_name,party_b_representative,payee_name,bank_account,bank_name,
         supported_crafts,daily_capacity,change_reason,changed_by
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
      [
        supplierId,
        version,
        input.supplierName,
        input.active,
        input.notes ?? "",
        input.contactPerson ?? null,
        input.contactPhone ?? null,
        input.address ?? null,
        input.contractEntityName ?? null,
        input.partyBRepresentative ?? null,
        input.payeeName ?? null,
        input.bankAccount ?? null,
        input.bankName ?? null,
        input.supportedCrafts ?? [],
        input.dailyCapacity ?? null,
        input.changeReason,
        actor.actorId,
      ],
    );
  }

  private contractDataMissing(row: {
    address: string | null;
    contract_entity_name: string | null;
    party_b_representative: string | null;
    payee_name: string | null;
    bank_account: string | null;
    bank_name: string | null;
  }): string[] {
    return [
      ["address", row.address],
      ["contractEntityName", row.contract_entity_name],
      ["partyBRepresentative", row.party_b_representative],
      ["payeeName", row.payee_name],
      ["bankAccount", row.bank_account],
      ["bankName", row.bank_name],
    ].filter((entry) => !entry[1]).map((entry) => entry[0] as string);
  }

  private serializeSupplierProfile(row: {
    supplier_id: string;
    supplier_code: string;
    supplier_type: string;
    version: number;
    supplier_name: string;
    active: boolean;
    notes: string;
    contact_person: string | null;
    contact_phone: string | null;
    address: string | null;
    contract_entity_name: string | null;
    party_b_representative: string | null;
    payee_name: string | null;
    bank_account: string | null;
    bank_name: string | null;
    supported_crafts: string[];
    daily_capacity: number | null;
    change_reason: string;
    changed_by: string;
    created_at: Date;
  }, includeContractData: boolean): Record<string, unknown> {
    const profile: Record<string, unknown> = {
      supplierId: row.supplier_id,
      supplierCode: row.supplier_code,
      supplierType: row.supplier_type,
      version: row.version,
      supplierName: row.supplier_name,
      active: row.active,
      notes: row.notes,
      contactPerson: row.contact_person,
      contactPhone: row.contact_phone,
      address: row.address,
      supportedCrafts: row.supported_crafts,
      dailyCapacity: row.daily_capacity,
      contractDataMissing: this.contractDataMissing(row),
      changeReason: row.change_reason,
      changedBy: row.changed_by,
      changedAt: row.created_at.toISOString(),
    };
    if (includeContractData) {
      Object.assign(profile, {
        contractEntityName: row.contract_entity_name,
        partyBRepresentative: row.party_b_representative,
        payeeName: row.payee_name,
        bankAccount: row.bank_account,
        bankName: row.bank_name,
      });
    }
    return profile;
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
