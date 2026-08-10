import type {
  AllocateExternalSuppliers,
  CreateExternalTemporarySupplier,
  CloseExternalDeductionCase,
  CreateExternalDeductionEntry,
  CreateExternalDeductionFollowUp,
  CreateExternalResponsibilityRevision,
  DecideExternalResponsibilityRevision,
  PayablesAcceptExternalResponsibilityCase,
  PayablesReturnExternalResponsibilityCase,
  SubmitExternalResponsibilityCase,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { ProductionExternalResponsibilityService } from "./production-external-responsibility-service.js";

/** HTTP-facing facade: database authorization remains the source of truth. */
export class ExternalResponsibilityApplicationService {
  private readonly service: ProductionExternalResponsibilityService;

  constructor(database: Pool, todos?: TodoProjectionService) {
    this.service = new ProductionExternalResponsibilityService(database, todos);
  }

  listQueue(...args: Parameters<ProductionExternalResponsibilityService["listQueue"]>) {
    return this.service.listQueue(...args);
  }

  listSupplierOptions(
    ...args: Parameters<ProductionExternalResponsibilityService["listSupplierOptions"]>
  ) {
    return this.service.listSupplierOptions(...args);
  }

  createTemporarySupplier(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateExternalTemporarySupplier,
    key: string,
  ) {
    return this.service.createTemporarySupplier(actor, orderId, input, key);
  }

  get(...args: Parameters<ProductionExternalResponsibilityService["get"]>) {
    return this.service.get(...args);
  }

  getCase(...args: Parameters<ProductionExternalResponsibilityService["getCase"]>) {
    return this.service.getCase(...args);
  }

  allocateSuppliers(
    actor: TrustedActorContext,
    batchId: string,
    input: AllocateExternalSuppliers,
    key: string,
  ) {
    return this.service.allocateSuppliers(actor, batchId, input, key);
  }

  submit(
    actor: TrustedActorContext,
    caseId: string,
    input: SubmitExternalResponsibilityCase,
    key: string,
  ) {
    return this.service.submit(actor, caseId, input, key);
  }

  payablesAccept(
    actor: TrustedActorContext,
    caseId: string,
    input: PayablesAcceptExternalResponsibilityCase,
    key: string,
  ) {
    return this.service.payablesAccept(actor, caseId, input, key);
  }

  payablesReturn(
    actor: TrustedActorContext,
    caseId: string,
    input: PayablesReturnExternalResponsibilityCase,
    key: string,
  ) {
    return this.service.payablesReturn(actor, caseId, input, key);
  }

  followUp(
    actor: TrustedActorContext,
    caseId: string,
    input: CreateExternalDeductionFollowUp,
    key: string,
  ) {
    return this.service.followUp(actor, caseId, input, key);
  }

  recordDeduction(
    actor: TrustedActorContext,
    caseId: string,
    input: CreateExternalDeductionEntry,
    key: string,
  ) {
    return this.service.recordDeduction(actor, caseId, input, key);
  }

  close(
    actor: TrustedActorContext,
    caseId: string,
    input: CloseExternalDeductionCase,
    key: string,
  ) {
    return this.service.close(actor, caseId, input, key);
  }

  requestRevision(
    actor: TrustedActorContext,
    caseId: string,
    input: CreateExternalResponsibilityRevision,
    key: string,
  ) {
    return this.service.requestRevision(actor, caseId, input, key);
  }

  approveRevision(
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    key: string,
  ) {
    return this.service.approveRevision(actor, requestId, input, key);
  }

  rejectRevision(
    actor: TrustedActorContext,
    requestId: string,
    input: DecideExternalResponsibilityRevision,
    key: string,
  ) {
    return this.service.rejectRevision(actor, requestId, input, key);
  }
}
