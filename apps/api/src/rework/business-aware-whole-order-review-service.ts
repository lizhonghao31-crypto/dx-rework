import type { WholeOrderReviewResponse } from "@dx-rework/contracts";
import type { Pool } from "pg";

import {
  canReadAllBusiness,
  isRootActor,
} from "../access/business-authority.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { WholeOrderReviewService } from "./whole-order-review-service.js";

/** Owner gets complete business visibility without inheriting tail/IE write flags. */
export class BusinessAwareWholeOrderReviewService extends WholeOrderReviewService {
  constructor(database: Pool, todos?: TodoProjectionService) {
    super(database, undefined, undefined, undefined, todos);
  }

  override async get(
    actor: TrustedActorContext,
    reworkOrderId: string,
    configurationItemId?: string,
  ): Promise<WholeOrderReviewResponse> {
    if (canReadAllBusiness(actor) && !isRootActor(actor)) {
      const readActor: TrustedActorContext = {
        ...actor,
        actorRoles: [...actor.actorRoles, "tail_supervisor"],
        authorizationCapability: "submission:audit",
        authorizationCapabilities: [
          ...(actor.authorizationCapabilities ?? []),
          "submission:audit",
        ],
      };
      const value = await super.get(readActor, reworkOrderId, configurationItemId);
      return {
        ...value,
        canReview: false,
        canAdjustQuantity: false,
        canConfirmQuantity: false,
        canReviewQuantityIncrease: false,
      };
    }
    return super.get(actor, reworkOrderId, configurationItemId);
  }
}
