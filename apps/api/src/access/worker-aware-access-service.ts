import type { AssignRole } from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { AccessMasterDataService } from "./service.js";

/**
 * Keeps the login-role model and the N04 business-person model synchronized.
 * A worker role is not considered successfully provisioned until its internal
 * business-person record also exists. If that second step fails, the freshly
 * granted role is immediately revoked so the final authorization state is not
 * left half-configured.
 */
export class WorkerAwareAccessMasterDataService extends AccessMasterDataService {
  constructor(database: Pool, corporationId: string) {
    super(database, corporationId);
  }

  override async assignRole(
    actor: TrustedActorContext,
    input: AssignRole,
  ): Promise<{ assignmentId: string }> {
    const assignment = await super.assignRole(actor, input);
    if (input.roleCode !== "worker") return assignment;

    try {
      const people = await this.listPeople({ includeInactive: true });
      if (people.some((person) => person.appUserId === input.userId)) {
        return assignment;
      }

      const roleAssignments = await this.listRoleAssignments({
        userId: input.userId,
        includeRevoked: false,
      });
      const workerAssignment = roleAssignments.find(
        (item) => item.assignmentId === assignment.assignmentId,
      );
      if (!workerAssignment) {
        throw new ApplicationError(
          "CONFLICT",
          "工人角色已建立，但无法读取员工身份用于作业人员建档",
          409,
        );
      }

      const masterDataActor: TrustedActorContext = {
        ...actor,
        authorizationCapability: "master_data:manage",
        authorizationCapabilities: [
          ...new Set([
            ...(actor.authorizationCapabilities ?? [actor.authorizationCapability]),
            "master_data:manage",
          ]),
        ],
      };
      await this.createPerson(masterDataActor, {
        personType: "internal",
        appUserId: input.userId,
        displayName: workerAssignment.displayName,
        aliases: [],
        reason: "授予工人角色自动建立内部作业人员档案",
      });
      return assignment;
    } catch (error: unknown) {
      try {
        await super.revokeRole(
          actor,
          assignment.assignmentId,
          "内部作业人员档案建立失败，系统自动回滚工人角色授予",
        );
      } catch {
        throw new ApplicationError(
          "CONFLICT",
          "工人角色建档失败且自动回滚未完成，请在权限管理核对该员工状态",
          409,
        );
      }
      throw error;
    }
  }
}
