import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";

const PROTECTED_ROLE_CODES = new Set(["owner_group", "system_admin"]);

type BootstrapRoot = Readonly<{
  user_id: string;
  provider_user_id: string;
  corp_id: string;
}>;
type DatabaseError = Readonly<{ code?: string }>;

export class RootAuthority {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly rootDingtalkUserId: string | undefined,
  ) {}

  isProtectedRole(roleCode: string): boolean {
    return PROTECTED_ROLE_CODES.has(roleCode);
  }

  async assertConfigurationConsistency(): Promise<void> {
    const bootstrap = await this.bootstrapRoot();
    if (
      bootstrap
      && this.rootDingtalkUserId
      && bootstrap.provider_user_id !== this.rootDingtalkUserId
    ) {
      throw new ApplicationError(
        "ROOT_IDENTITY_CONFLICT",
        "服务器配置的超级用户与已锁定的首位超级用户身份不一致",
        500,
      );
    }
  }

  async isRootUser(userId: string): Promise<boolean> {
    const bootstrap = await this.bootstrapRoot();
    if (bootstrap) {
      if (bootstrap.user_id !== userId) return false;
      return this.isEligibleDingTalkIdentity(userId, bootstrap.provider_user_id);
    }

    if (!this.rootDingtalkUserId) return false;
    return this.isEligibleDingTalkIdentity(userId, this.rootDingtalkUserId);
  }

  async assertProtectedRoleMutation(actorUserId: string, roleCode: string): Promise<void> {
    if (!this.isProtectedRole(roleCode)) return;
    if (await this.isRootUser(actorUserId)) return;
    throw new ApplicationError("FORBIDDEN", "老板和系统管理员角色仅可由超级用户维护", 403);
  }

  async assertAssignmentMutation(actorUserId: string, assignmentId: string): Promise<void> {
    const result = await this.database.query<{ user_id: string; role_code: string }>(
      `SELECT user_id,role_code
       FROM user_role_assignments
       WHERE assignment_id=$1 AND revoked_at IS NULL
       LIMIT 1`,
      [assignmentId],
    );
    const assignment = result.rows[0];
    if (!assignment) return;
    const actorIsRoot = await this.isRootUser(actorUserId);
    if (actorIsRoot && assignment.user_id === actorUserId && this.isProtectedRole(assignment.role_code)) {
      throw new ApplicationError("FORBIDDEN", "超级用户不能撤销自己的受保护角色", 403);
    }
    await this.assertProtectedRoleMutation(actorUserId, assignment.role_code);
  }

  async assertTargetAccessMutation(actorUserId: string, targetUserId: string): Promise<void> {
    const actorIsRoot = await this.isRootUser(actorUserId);
    if (actorIsRoot && actorUserId === targetUserId) {
      throw new ApplicationError("FORBIDDEN", "超级用户不能停用自己的系统访问", 403);
    }

    const [protectedRole, targetIsRoot] = await Promise.all([
      this.database.query(
        `SELECT 1
         FROM user_role_assignments
         WHERE user_id=$1
           AND revoked_at IS NULL
           AND role_code IN ('owner_group','system_admin')
         LIMIT 1`,
        [targetUserId],
      ),
      this.isRootUser(targetUserId),
    ]);
    if (!protectedRole.rows[0] && !targetIsRoot) return;
    if (actorIsRoot) return;
    throw new ApplicationError(
      "FORBIDDEN",
      "老板、系统管理员和超级用户账号仅可由超级用户停用或恢复",
      403,
    );
  }

  async filterAssignableRoles<T extends { roleCode: string }>(
    actorUserId: string,
    roles: readonly T[],
  ): Promise<T[]> {
    if (await this.isRootUser(actorUserId)) return [...roles];
    return roles.filter((role) => !this.isProtectedRole(role.roleCode));
  }

  private async bootstrapRoot(): Promise<BootstrapRoot | null> {
    try {
      const result = await this.database.query<BootstrapRoot>(
        `SELECT user_id,provider_user_id,corp_id
         FROM owner_bootstrap_consumptions
         WHERE singleton=true AND corp_id=$1
         LIMIT 1`,
        [this.corporationId],
      );
      return result.rows[0] ?? null;
    } catch (error: unknown) {
      if ((error as DatabaseError | null)?.code === "42P01") return null;
      throw error;
    }
  }

  private async isEligibleDingTalkIdentity(userId: string, providerUserId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1
       FROM app_users u
       JOIN identity_mappings i
         ON i.user_id=u.id
        AND i.provider='dingtalk'
       WHERE u.id=$1
         AND u.enabled=true
         AND i.corp_id=$2
         AND i.provider_user_id=$3
         AND i.active=true
         AND i.employed=true
       LIMIT 1`,
      [userId, this.corporationId, providerUserId],
    );
    return Boolean(result.rows[0]);
  }
}
