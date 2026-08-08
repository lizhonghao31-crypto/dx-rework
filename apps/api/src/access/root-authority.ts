import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";

const PROTECTED_ROLE_CODES = new Set(["owner_group", "system_admin"]);

export class RootAuthority {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly rootDingtalkUserId: string | undefined,
  ) {}

  isProtectedRole(roleCode: string): boolean {
    return PROTECTED_ROLE_CODES.has(roleCode);
  }

  async isRootUser(userId: string): Promise<boolean> {
    const result = await this.database.query(
      `SELECT 1
       FROM app_users u
       WHERE u.id=$1
         AND (
           EXISTS (
             SELECT 1
             FROM identity_mappings i
             WHERE i.user_id=u.id
               AND i.provider='dingtalk'
               AND i.corp_id=$2
               AND $3::text IS NOT NULL
               AND i.provider_user_id=$3
           )
           OR EXISTS (
             SELECT 1
             FROM owner_bootstrap_consumptions c
             JOIN identity_mappings i
               ON i.user_id=c.user_id
              AND i.provider='dingtalk'
              AND i.corp_id=c.corp_id
              AND i.provider_user_id=c.provider_user_id
             WHERE c.singleton=true
               AND c.user_id=u.id
               AND c.corp_id=$2
           )
         )
       LIMIT 1`,
      [userId, this.corporationId, this.rootDingtalkUserId ?? null],
    );
    return Boolean(result.rows[0]);
  }

  async assertProtectedRoleMutation(actorUserId: string, roleCode: string): Promise<void> {
    if (!this.isProtectedRole(roleCode)) return;
    if (await this.isRootUser(actorUserId)) return;
    throw new ApplicationError(
      "FORBIDDEN",
      "老板和系统管理员角色仅可由超级用户维护",
      403,
    );
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
    if (
      actorIsRoot
      && assignment.user_id === actorUserId
      && this.isProtectedRole(assignment.role_code)
    ) {
      throw new ApplicationError(
        "FORBIDDEN",
        "超级用户不能撤销自己的受保护角色",
        403,
      );
    }
    await this.assertProtectedRoleMutation(actorUserId, assignment.role_code);
  }

  async assertTargetAccessMutation(actorUserId: string, targetUserId: string): Promise<void> {
    const actorIsRoot = await this.isRootUser(actorUserId);
    if (actorIsRoot && actorUserId === targetUserId) {
      throw new ApplicationError(
        "FORBIDDEN",
        "超级用户不能停用自己的系统访问",
        403,
      );
    }
    const result = await this.database.query(
      `SELECT 1
       FROM app_users u
       WHERE u.id=$1
         AND (
           EXISTS (
             SELECT 1
             FROM user_role_assignments ura
             WHERE ura.user_id=u.id
               AND ura.revoked_at IS NULL
               AND ura.role_code IN ('owner_group','system_admin')
           )
           OR EXISTS (
             SELECT 1
             FROM identity_mappings i
             WHERE i.user_id=u.id
               AND i.provider='dingtalk'
               AND i.corp_id=$2
               AND $3::text IS NOT NULL
               AND i.provider_user_id=$3
           )
           OR EXISTS (
             SELECT 1
             FROM owner_bootstrap_consumptions c
             WHERE c.singleton=true
               AND c.user_id=u.id
               AND c.corp_id=$2
           )
         )
       LIMIT 1`,
      [targetUserId, this.corporationId, this.rootDingtalkUserId ?? null],
    );
    if (!result.rows[0]) return;
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
}
