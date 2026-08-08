import type {
  ConfirmHighMultiplier,
  CreateResponsibilityDraft,
  FinalizeResponsibility,
  TakeoverResponsibility,
  TransferResponsibility,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { AuthorizedResponsibilityDeterminationService } from "./responsibility-determination-authorized-service.js";
import { ResponsibilityDeterminationQueueService } from "./responsibility-determination-queue-service.js";
import { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";

type TransferPermissionRow = Readonly<{
  status: string;
  handler_user_id: string | null;
  permitted: boolean;
}>;

type TransferCandidateRow = Readonly<{
  user_id: string;
  display_name: string;
}>;

/**
 * Production-facing responsibility application service.
 *
 * Draft creation stays in the exact-decimal engine and returns the response
 * persisted by the idempotency repository. All reads and subsequent commands
 * go through database-authorized services.
 */
export class ResponsibilityDeterminationApplicationService {
  private readonly draftEngine: ResponsibilityDeterminationService;
  private readonly authorized: AuthorizedResponsibilityDeterminationService;
  private readonly queue: ResponsibilityDeterminationQueueService;

  constructor(
    private readonly database: Pool,
    todos?: TodoProjectionService,
  ) {
    this.draftEngine = new ResponsibilityDeterminationService(
      database,
      undefined,
      undefined,
      todos,
    );
    this.authorized = new AuthorizedResponsibilityDeterminationService(
      database,
      todos,
    );
    this.queue = new ResponsibilityDeterminationQueueService(database);
  }

  listQueue(
    ...args: Parameters<ResponsibilityDeterminationQueueService["list"]>
  ) {
    return this.queue.list(...args);
  }

  get(...args: Parameters<AuthorizedResponsibilityDeterminationService["get"]>) {
    return this.authorized.get(...args);
  }

  async listTransferCandidates(
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<{ items: Array<{ userId: string; displayName: string }> }> {
    const permissionResult = await this.database.query<TransferPermissionRow>(
      `SELECT o.status,
              responsibility_effective_handler(o.rework_order_id) handler_user_id,
              responsibility_can_determine($1,o.rework_order_id) permitted
       FROM rework_orders o
       WHERE o.rework_order_id=$2`,
      [actor.actorId, orderId],
    );
    const permission = permissionResult.rows[0];
    if (!permission) {
      throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    }
    const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (
      permission.status !== "pending_responsibility_determination"
      || permission.permitted !== true
      || !capabilities.includes("responsibility:determine")
      || permission.handler_user_id !== actor.actorId
    ) {
      throw new ApplicationError("FORBIDDEN", "只有当前有效责任处理人可以查看转交对象", 403);
    }

    const candidates = await this.database.query<TransferCandidateRow>(
      `SELECT u.id user_id,u.display_name
       FROM app_users u
       WHERE u.id<>$1
         AND responsibility_can_determine(u.id,$2)
       ORDER BY u.display_name,u.id`,
      [actor.actorId, orderId],
    );
    return {
      items: candidates.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
      })),
    };
  }

  saveDraft(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateResponsibilityDraft,
    key: string,
  ) {
    if (
      input.processes.some((process) =>
        process.allocations.some((allocation) => allocation.shareBps <= 0),
      )
    ) {
      throw new ApplicationError(
        "VALIDATION_ERROR",
        "Responsibility shares must be greater than zero",
        400,
      );
    }
    return this.draftEngine.saveDraft(actor, orderId, input, key);
  }

  finalize(
    actor: TrustedActorContext,
    orderId: string,
    input: FinalizeResponsibility,
    key: string,
  ) {
    return this.authorized.finalize(actor, orderId, input, key);
  }

  transfer(
    actor: TrustedActorContext,
    orderId: string,
    input: TransferResponsibility,
    key: string,
  ) {
    return this.authorized.transfer(actor, orderId, input, key);
  }

  takeover(
    actor: TrustedActorContext,
    orderId: string,
    input: TakeoverResponsibility,
    key: string,
  ) {
    return this.authorized.takeover(actor, orderId, input, key);
  }

  confirmHighMultiplier(
    actor: TrustedActorContext,
    determinationId: string,
    input: ConfirmHighMultiplier,
    key: string,
  ) {
    return this.authorized.confirmHighMultiplier(
      actor,
      determinationId,
      input,
      key,
    );
  }
}
