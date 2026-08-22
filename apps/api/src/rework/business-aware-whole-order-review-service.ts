import type { WholeOrderReviewResponse } from "@dx-rework/contracts";
import type {
  CreateCompletionConfirmation,
  ReviewCompletionIe,
} from "@dx-rework/contracts/completion-review";
import type { Pool } from "pg";

import {
  canReadAllBusiness,
  isRootActor,
} from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { CompletionReviewService } from "./completion-review-service.js";
import { WholeOrderReviewService } from "./whole-order-review-service.js";

/** Owner gets complete business visibility without inheriting tail/IE write flags. */
export class BusinessAwareWholeOrderReviewService extends WholeOrderReviewService {
  private readonly completion: CompletionReviewService;

  constructor(database: Pool, todos?: TodoProjectionService) {
    super(database, undefined, undefined, undefined, todos);
    this.completion = new CompletionReviewService(database);
  }

  override async get(
    actor: TrustedActorContext,
    reworkOrderId: string,
    configurationItemId?: string,
  ): Promise<WholeOrderReviewResponse> {
    const capabilities = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    const ieReader = !isRootActor(actor)
      && actor.actorRoles.includes("ie_reviewer")
      && capabilities.includes("process:review");
    const businessReader = canReadAllBusiness(actor) && !isRootActor(actor);
    const readActor: TrustedActorContext = ieReader || businessReader
      ? {
          ...actor,
          actorRoles: [...new Set([...actor.actorRoles, "tail_supervisor"])],
          authorizationCapability: "submission:audit",
          authorizationCapabilities: [...new Set([...capabilities, "submission:audit"])],
        }
      : actor;
    const value = await super.get(readActor, reworkOrderId, configurationItemId);
    const completionConfirmation = await this.completion.summary(reworkOrderId);
    const status = value.reworkStatus as string;
    return {
      ...value,
      canReview: businessReader ? false : value.canReview && status === "pending_order_review",
      canAdjustQuantity: businessReader ? false : value.canAdjustQuantity,
      canConfirmQuantity: businessReader ? false : value.canConfirmQuantity,
      canReviewQuantityIncrease: businessReader ? false : value.canReviewQuantityIncrease,
      canCompletionIeReview: status === "pending_completion_ie_review" && this.completion.canIeReview(actor),
      completionConfirmation,
    } as WholeOrderReviewResponse;
  }

  async confirmCompletion(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: CreateCompletionConfirmation,
    key: string,
  ) {
    return this.completion.confirm(actor, reworkOrderId, input, key);
  }

  async reviewCompletion(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: ReviewCompletionIe,
    key: string,
  ) {
    return this.completion.review(actor, reworkOrderId, input, key);
  }
}
