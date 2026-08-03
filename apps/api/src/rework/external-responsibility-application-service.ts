import type {
  AllocateExternalSuppliers,
  CloseExternalDeductionCase,
  CreateExternalDeductionEntry,
  CreateExternalDeductionFollowUp,
  CreateExternalResponsibilityRevision,
  DecideExternalResponsibilityRevision,
  PayablesAcceptExternalResponsibilityCase,
  PayablesReturnExternalResponsibilityCase,
  SubmitExternalResponsibilityCase,
} from "@dx-rework/contracts";
import type { Pool } from "pg";

import type { TrustedActorContext } from "../tools/repositories.js";
import { ExternalResponsibilityService } from "./external-responsibility-service.js";

/** HTTP-facing facade: database authorization remains the source of truth. */
export class ExternalResponsibilityApplicationService {
  private readonly service: ExternalResponsibilityService;
  constructor(database: Pool) { this.service = new ExternalResponsibilityService(database); }
  listQueue(...args: Parameters<ExternalResponsibilityService["listQueue"]>) { return this.service.listQueue(...args); }
  get(...args: Parameters<ExternalResponsibilityService["get"]>) { return this.service.get(...args); }
  getCase(...args: Parameters<ExternalResponsibilityService["getCase"]>) { return this.service.getCase(...args); }
  allocateSuppliers(actor: TrustedActorContext, batchId: string, input: AllocateExternalSuppliers, key: string) { return this.service.allocateSuppliers(actor,batchId,input,key); }
  submit(actor: TrustedActorContext, caseId: string, input: SubmitExternalResponsibilityCase, key: string) { return this.service.submit(actor,caseId,input,key); }
  payablesAccept(actor: TrustedActorContext, caseId: string, input: PayablesAcceptExternalResponsibilityCase, key: string) { return this.service.payablesAccept(actor,caseId,input,key); }
  payablesReturn(actor: TrustedActorContext, caseId: string, input: PayablesReturnExternalResponsibilityCase, key: string) { return this.service.payablesReturn(actor,caseId,input,key); }
  followUp(actor: TrustedActorContext, caseId: string, input: CreateExternalDeductionFollowUp, key: string) { return this.service.followUp(actor,caseId,input,key); }
  recordDeduction(actor: TrustedActorContext, caseId: string, input: CreateExternalDeductionEntry, key: string) { return this.service.recordDeduction(actor,caseId,input,key); }
  close(actor: TrustedActorContext, caseId: string, input: CloseExternalDeductionCase, key: string) { return this.service.close(actor,caseId,input,key); }
  requestRevision(actor: TrustedActorContext, caseId: string, input: CreateExternalResponsibilityRevision, key: string) { return this.service.requestRevision(actor,caseId,input,key); }
  approveRevision(actor: TrustedActorContext, requestId: string, input: DecideExternalResponsibilityRevision, key: string) { return this.service.decideRevision(actor,requestId,input,"approved",key); }
  rejectRevision(actor: TrustedActorContext, requestId: string, input: DecideExternalResponsibilityRevision, key: string) { return this.service.decideRevision(actor,requestId,input,"rejected",key); }
}
