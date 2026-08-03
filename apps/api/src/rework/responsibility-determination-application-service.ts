import type {
  ConfirmHighMultiplier,
  CreateResponsibilityDraft,
  FinalizeResponsibility,
  TakeoverResponsibility,
  TransferResponsibility,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { AuthorizedResponsibilityDeterminationService } from "./responsibility-determination-authorized-service.js";
import { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";

/**
 * Production-facing responsibility application service.
 *
 * Draft creation stays in the exact-decimal engine and returns the response
 * persisted by the idempotency repository. All reads and subsequent commands
 * go through the database-authorized service.
 */
export class ResponsibilityDeterminationApplicationService {
  private readonly draftEngine: ResponsibilityDeterminationService;
  private readonly authorized: AuthorizedResponsibilityDeterminationService;

  constructor(database: Pool) {
    this.draftEngine = new ResponsibilityDeterminationService(database);
    this.authorized = new AuthorizedResponsibilityDeterminationService(database);
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
