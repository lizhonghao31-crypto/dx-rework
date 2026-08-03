import type { CloseExternalDeductionCase } from "@dx-rework/contracts/external-responsibility";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { ExternalResponsibilityCloseService } from "./external-responsibility-close-service.js";
import { FinalExternalResponsibilityService } from "./final-external-responsibility-service.js";

/**
 * Single production PR-11 service used by both HTTP wiring and PostgreSQL
 * workflow tests. The inherited N08-B/N10-B operations remain unchanged;
 * only close is replaced with the explicit-numeric transaction path.
 */
export class ProductionExternalResponsibilityService
  extends FinalExternalResponsibilityService {
  private readonly closeService: ExternalResponsibilityCloseService;

  constructor(database: Pool) {
    super(database);
    this.closeService = new ExternalResponsibilityCloseService(database, this);
  }

  override close(
    actor: TrustedActorContext,
    caseId: string,
    input: CloseExternalDeductionCase,
    key: string,
  ) {
    return this.closeService.close(actor, caseId, input, key);
  }
}
