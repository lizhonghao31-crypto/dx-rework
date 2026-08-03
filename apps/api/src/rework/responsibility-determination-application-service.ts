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
import { AuthorizedResponsibilityDeterminationService } from "./responsibility-determination-authorized-service.js";
import { ResponsibilityDeterminationQueueService } from "./responsibility-determination-queue-service.js";
import { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";

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

  constructor(database: Pool) {
    this.draftEngine = new ResponsibilityDeterminationService(database);
    this.authorized = new AuthorizedResponsibilityDeterminationService(database);
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
