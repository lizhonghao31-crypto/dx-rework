import { createHash, randomUUID, timingSafeEqual } from "node:crypto";

import type {
  EmployeeAccessBootstrapResponse,
  EmployeeAccessDirectory,
  EmployeeAccessSyncResponse,
} from "@dx-rework/contracts/employee-access";
import type { Pool, PoolClient } from "pg";

import type { OfficialDingTalkProvider } from "../auth/provider.js";
import type { PostgresAuthStore } from "../auth/postgres-store.js";
import type { AuthUser } from "../auth/service.js";
import { ApplicationError } from "../platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import type { AccessMasterDataService } from "./service.js";

type OwnerBootstrapConfig = Readonly<{
  enabled: boolean;
  dingtalkUserId: string | undefined;
  secret: string | undefined;
}>;

type EmployeeRow = Readonly<{
  user_id: string;
  provider_user_id: string;
  display_name: string;
  department_names: string[];
  active: boolean;
  employed: boolean;
  enabled: boolean;
  manual_access_disabled: boolean;
  last_verified_at: Date;
  has_logged_in: boolean;
  is_root: boolean;
  business_roles: string[];
}>;

type RoleHistoryRow = Readonly<{
  assignment_id: string;
  user_id: string;
  role_code: string;
  granted_at: Date;
  granted_by: string;
  grant_reason: string;
  revoked_at: Date | null;
  revoked_by: string | null;
  revoke_reason: string | null;
}>;

type AccessStateRow = Readonly<{
  user_id: string;
  enabled: boolean;
  manual_access_disabled: boolean;
  active: boolean;
  employed: boolean;
  provider_user_id: string;
  corp_id: string;
  usable_owner: boolean;
}>;

type DirectoryAuditRow = Readonly<{
  user_id: string;
  provider_user_id: string;
  union_id: string;
  display_name: string;
  department_names: string[];
  active: boolean;
  employed: boolean;
  enabled: boolean;
  manual_access_disabled: boolean;
}>;

const translateDatabaseError = (error: unknown): never => {
  const code = (error as { code?: string } | null)?.code;
  if (code === "23505" || code === "23514" || code === "55000") {
    throw new ApplicationError("CONFLICT", "员工权限状态与当前安全约束冲突", 409);
  }
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "员工或角色不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前操作不符合权限或组织准入要求", 403);
  throw error;
};

const secureEqual = (left: string, right: string): boolean => {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
};

const sameStrings = (left: readonly string[], right: readonly string[]): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const directoryAuditState = (row: DirectoryAuditRow) => ({
  userId: row.user_id,
  providerUserId: row.provider_user_id,
  unionId: row.union_id,
  displayName: row.display_name,
  departments: row.department_names,
  active: row.active,
  employed: row.employed,
  enabled: row.enabled,
  manualAccessDisabled: row.manual_access_disabled,
});

const sameDirectoryState = (left: DirectoryAuditRow, right: DirectoryAuditRow): boolean =>
  left.user_id === right.user_id
  && left.provider_user_id === right.provider_user_id
  && left.union_id === right.union_id
  && left.display_name === right.display_name
  && left.active === right.active
  && left.employed === right.employed
  && left.enabled === right.enabled
  && left.manual_access_disabled === right.manual_access_disabled
  && sameStrings(left.department_names, right.department_names);

export class EmployeeAccessService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly access: AccessMasterDataService,
    private readonly authStore: PostgresAuthStore,
    private readonly provider: OfficialDingTalkProvider,
    private readonly bootstrap: OwnerBootstrapConfig,
    private readonly rootDingtalkUserId: string | undefined,
    private readonly events = new OperationEventRepository(),
  ) {}

  async listDirectory(): Promise<EmployeeAccessDirectory> {
    const [employees, history, sync] = await Promise.all([
      this.database.query<EmployeeRow>(
        `SELECT
           u.id user_id,
           i.provider_user_id,
           u.display_name,
           COALESCE(p.department_names,'{}'::text[]) department_names,
           i.active,
           i.employed,
           u.enabled,
           u.manual_access_disabled,
           i.last_verified_at,
           EXISTS(SELECT 1 FROM auth_sessions s WHERE s.user_id=u.id) has_logged_in,
           COALESCE(i.provider_user_id=$2,false) is_root,
           COALESCE(
             ARRAY(
               SELECT ura.role_code
               FROM user_role_assignments ura
               JOIN business_roles br ON br.role_code=ura.role_code AND br.enabled=true
               WHERE ura.user_id=u.id AND ura.revoked_at IS NULL
               ORDER BY ura.role_code
             ),
             '{}'::text[]
           ) business_roles
         FROM app_users u
         JOIN identity_mappings i
           ON i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=$1
         LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
         ORDER BY u.display_name,u.id`,
        [this.corporationId, this.rootDingtalkUserId ?? null],
      ),
      this.database.query<RoleHistoryRow>(
        `SELECT
           ura.assignment_id,
           ura.user_id,
           ura.role_code,
           ura.granted_at,
           ura.granted_by,
           ura.grant_reason,
           ura.revoked_at,
           ura.revoked_by,
           ura.revoke_reason
         FROM user_role_assignments ura
         JOIN identity_mappings i
           ON i.user_id=ura.user_id AND i.provider='dingtalk' AND i.corp_id=$1
         ORDER BY ura.user_id,ura.granted_at DESC,ura.assignment_id`,
        [this.corporationId],
      ),
      this.database.query<{ synced_at: Date | null }>(
        "SELECT max(last_directory_synced_at) synced_at FROM employee_directory_profiles",
      ),
    ]);

    const historyByUser = new Map<string, RoleHistoryRow[]>();
    for (const row of history.rows) {
      const rows = historyByUser.get(row.user_id) ?? [];
      rows.push(row);
      historyByUser.set(row.user_id, rows);
    }

    return {
      lastDirectorySyncedAt: sync.rows[0]?.synced_at?.toISOString() ?? null,
      employees: employees.rows.map((row) => ({
        userId: row.user_id,
        providerUserId: row.provider_user_id,
        displayName: row.display_name,
        departments: row.department_names,
        active: row.active,
        employed: row.employed,
        enabled: row.enabled,
        manualAccessDisabled: row.manual_access_disabled,
        lastVerifiedAt: row.last_verified_at.toISOString(),
        hasLoggedIn: row.has_logged_in,
        isRoot: row.is_root,
        businessRoles: row.business_roles,
        roleHistory: (historyByUser.get(row.user_id) ?? []).map((item) => ({
          assignmentId: item.assignment_id,
          roleCode: item.role_code,
          grantedAt: item.granted_at.toISOString(),
          grantedBy: item.granted_by,
          grantReason: item.grant_reason,
          revokedAt: item.revoked_at?.toISOString() ?? null,
          revokedBy: item.revoked_by,
          revokeReason: item.revoke_reason,
        })),
      })),
    };
  }

  async grantRole(
    actor: TrustedActorContext,
    input: { userId: string; roleCode: string; reason: string },
  ): Promise<{ assignmentId: string }> {
    return this.access.assignRole(actor, input);
  }

  async revokeRole(actor: TrustedActorContext, assignmentId: string, reason: string): Promise<void> {
    await this.access.revokeRole(actor, assignmentId, reason);
  }

  async disableAccess(actor: TrustedActorContext, userId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext('dx_rework:owner_group_guard'))");
      const target = await this.loadAccessState(client, userId, true);
      if (!target.enabled) throw new ApplicationError("CONFLICT", "目标员工已经停用", 409);

      if (target.usable_owner) {
        const owners = await client.query<{ count: string }>(
          `SELECT count(*)::text count
           FROM user_role_assignments ura
           JOIN app_users u ON u.id=ura.user_id AND u.enabled=true
           WHERE ura.role_code='owner_group' AND ura.revoked_at IS NULL
             AND EXISTS (
               SELECT 1
               FROM identity_mappings i
               WHERE i.user_id=ura.user_id AND i.provider='dingtalk' AND i.corp_id=$1
                 AND i.active=true AND i.employed=true
             )`,
          [this.corporationId],
        );
        if (Number(owners.rows[0]?.count ?? "0") <= 1) {
          throw new ApplicationError("CONFLICT", "不能停用最后一名有效老板", 409);
        }
      }

      await client.query(
        `UPDATE app_users
         SET enabled=false,manual_access_disabled=true,updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [userId],
      );
      await client.query(
        "UPDATE auth_sessions SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND revoked_at IS NULL",
        [userId],
      );
      await this.events.append(client, actor, {
        action: "access.employee.disable",
        entityType: "app_user",
        entityId: userId,
        before: { enabled: true, manualAccessDisabled: false },
        after: { enabled: false, manualAccessDisabled: true, sessionsRevoked: true },
        reason,
      });
    });
  }

  async restoreAccess(actor: TrustedActorContext, userId: string, reason: string): Promise<void> {
    await this.transaction(async (client) => {
      const target = await this.loadAccessState(client, userId, false);
      if (target.enabled) throw new ApplicationError("CONFLICT", "目标员工已经启用", 409);
      if (!target.active || !target.employed || target.corp_id !== this.corporationId) {
        throw new ApplicationError("FORBIDDEN", "仅可恢复当前仍在本企业组织且在职的员工", 403);
      }
      const authorization = await client.query<{ allowed: boolean }>(
        `SELECT
           access_user_has_effective_authorization($1)
           OR EXISTS(
             SELECT 1
             FROM owner_bootstrap_consumptions root
             WHERE root.singleton=true AND root.user_id=$1
           ) allowed`,
        [userId],
      );
      if (authorization.rows[0]?.allowed !== true) {
        throw new ApplicationError("CONFLICT", "请先为员工授予有效角色或临时授权", 409);
      }

      await client.query(
        `UPDATE app_users
         SET enabled=true,manual_access_disabled=false,updated_at=CURRENT_TIMESTAMP
         WHERE id=$1`,
        [userId],
      );
      await this.events.append(client, actor, {
        action: "access.employee.restore",
        entityType: "app_user",
        entityId: userId,
        before: { enabled: false, manualAccessDisabled: target.manual_access_disabled },
        after: { enabled: true, manualAccessDisabled: false },
        reason,
      });
    });
  }

  async syncDirectory(actor: TrustedActorContext): Promise<EmployeeAccessSyncResponse> {
    const members = await this.provider.listOrganizationMembers(this.corporationId);
    const syncedAt = new Date();

    return this.transaction(async (client) => {
      let changed = 0;
      for (const member of members) {
        const normalizedDepartments = [...new Set(member.departmentNames)].sort((left, right) =>
          left.localeCompare(right, "zh-CN"));
        const beforeResult = await client.query<DirectoryAuditRow>(
          `SELECT
             u.id user_id,
             i.provider_user_id,
             i.union_id,
             u.display_name,
             COALESCE(p.department_names,'{}'::text[]) department_names,
             i.active,
             i.employed,
             u.enabled,
             u.manual_access_disabled
           FROM identity_mappings i
           JOIN app_users u ON u.id=i.user_id
           LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
           WHERE i.provider='dingtalk' AND i.corp_id=$1
             AND (i.provider_user_id=$2 OR i.union_id=$3)
           FOR UPDATE OF i,u`,
          [this.corporationId, member.userId, member.unionId],
        );
        const before = beforeResult.rows[0];
        const user = await this.authStore.upsertDirectoryIdentity(client, member);
        await client.query(
          `INSERT INTO employee_directory_profiles(user_id,department_names,last_directory_synced_at)
           VALUES($1,$2,$3)
           ON CONFLICT(user_id) DO UPDATE
           SET department_names=EXCLUDED.department_names,
               last_directory_synced_at=EXCLUDED.last_directory_synced_at,
               updated_at=CURRENT_TIMESTAMP`,
          [user.id, normalizedDepartments, syncedAt],
        );
        const afterResult = await client.query<DirectoryAuditRow>(
          `SELECT
             u.id user_id,
             i.provider_user_id,
             i.union_id,
             u.display_name,
             COALESCE(p.department_names,'{}'::text[]) department_names,
             i.active,
             i.employed,
             u.enabled,
             u.manual_access_disabled
           FROM identity_mappings i
           JOIN app_users u ON u.id=i.user_id
           LEFT JOIN employee_directory_profiles p ON p.user_id=u.id
           WHERE i.provider='dingtalk' AND i.corp_id=$1 AND i.user_id=$2`,
          [this.corporationId, user.id],
        );
        const after = afterResult.rows[0];
        if (!after) {
          throw new ApplicationError("INVALID_STATE_TRANSITION", "钉钉目录同步后无法读取员工身份状态", 409);
        }
        if (!before || !sameDirectoryState(before, after)) {
          changed += 1;
          await this.events.append(client, actor, {
            action: "access.directory.employee.sync",
            entityType: "app_user",
            entityId: user.id,
            before: before ? directoryAuditState(before) : undefined,
            after: directoryAuditState(after),
            reason: "老板手动同步钉钉通讯录",
          });
        }
      }

      const response = {
        scanned: members.length,
        upserted: members.length,
        changed,
        syncedAt: syncedAt.toISOString(),
      };
      await this.events.append(client, actor, {
        action: "access.directory.sync",
        entityType: "dingtalk_corporation",
        entityId: this.corporationId,
        after: response,
        reason: "老板手动同步钉钉通讯录",
      });
      return response;
    });
  }

  async bootstrapFirstOwner(
    user: AuthUser,
    requestId: string,
    input: { secret: string; reason: string },
  ): Promise<EmployeeAccessBootstrapResponse> {
    if (!this.bootstrap.enabled || !this.bootstrap.dingtalkUserId || !this.bootstrap.secret) {
      throw new ApplicationError("FORBIDDEN", "首位老板初始化能力未启用", 403);
    }
    if (!secureEqual(input.secret, this.bootstrap.secret)) {
      throw new ApplicationError("FORBIDDEN", "首位老板初始化凭据无效", 403);
    }

    const identity = await this.database.query<{
      provider_user_id: string;
      corp_id: string;
      active: boolean;
      employed: boolean;
      enabled: boolean;
    }>(
      `SELECT i.provider_user_id,i.corp_id,i.active,i.employed,u.enabled
       FROM identity_mappings i
       JOIN app_users u ON u.id=i.user_id
       WHERE i.user_id=$1 AND i.provider='dingtalk' AND i.corp_id=$2`,
      [user.id, this.corporationId],
    );
    const row = identity.rows[0];
    if (!row || row.provider_user_id !== this.bootstrap.dingtalkUserId) {
      throw new ApplicationError("FORBIDDEN", "当前钉钉身份不在首位老板初始化允许范围", 403);
    }
    if (!row.enabled || !row.active || !row.employed) {
      throw new ApplicationError("FORBIDDEN", "首位老板必须是当前启用且在职的企业成员", 403);
    }

    const assignmentId = randomUUID();
    const eventId = randomUUID();
    try {
      const result = await this.database.query<{ assignment_id: string }>(
        `SELECT bootstrap_first_owner($1,$2,$3,$4,$5,$6,$7) assignment_id`,
        [
          assignmentId,
          user.id,
          row.provider_user_id,
          row.corp_id,
          eventId,
          requestId,
          input.reason,
        ],
      );
      return { assignmentId: result.rows[0]?.assignment_id ?? assignmentId };
    } catch (error) {
      return translateDatabaseError(error);
    }
  }

  private async loadAccessState(
    client: PoolClient,
    userId: string,
    forUpdate: boolean,
  ): Promise<AccessStateRow> {
    const result = await client.query<AccessStateRow>(
      `SELECT
         u.id user_id,
         u.enabled,
         u.manual_access_disabled,
         i.active,
         i.employed,
         i.provider_user_id,
         i.corp_id,
         EXISTS(
           SELECT 1
           FROM user_role_assignments ura
           WHERE ura.user_id=u.id AND ura.role_code='owner_group' AND ura.revoked_at IS NULL
         ) AND u.enabled AND i.active AND i.employed usable_owner
       FROM app_users u
       JOIN identity_mappings i
         ON i.user_id=u.id AND i.provider='dingtalk' AND i.corp_id=$2
       WHERE u.id=$1
       ${forUpdate ? "FOR UPDATE OF u" : ""}`,
      [userId, this.corporationId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "目标员工不存在或不属于本企业组织", 404);
    return row;
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if (error instanceof ApplicationError) throw error;
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }
}
