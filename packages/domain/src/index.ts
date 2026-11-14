export type SourceReference = Readonly<{
  sourceSystem: string;
  sourceRecordId: string;
  externalIdempotencyKey: string;
  erpNodeId?: string;
}>;

export type AuditEventDraft = Readonly<{
  requestId: string;
  actorId?: string;
  actorRoles?: readonly string[];
  authorizationCapability?: string;
  action: string;
  entityType: string;
  entityId: string;
  beforeState?: Readonly<Record<string, unknown>>;
  afterState?: Readonly<Record<string, unknown>>;
  reason?: string;
}>;

export type OutboxEventDraft = Readonly<{
  topic: string;
  aggregateType: string;
  aggregateId: string;
  payload: Readonly<Record<string, unknown>>;
  idempotencyKey: string;
}>;

export type TrustedActor = Readonly<{ actorId: string; actorRoles: readonly string[]; authorizationCapability: string }>;
export type IdempotencyStatus = "in_progress" | "completed";
export type AttachmentStatus = "pending" | "ready" | "rejected";
export type OutboxStatus = "pending" | "processing" | "sent" | "failed";
export type ExportJobStatus = "pending" | "running" | "succeeded" | "failed";

export class DomainRuleError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "DomainRuleError";
  }
}

const transitions = <T extends string>(rules: Readonly<Record<T, readonly T[]>>, from: T, to: T): T => {
  if (!rules[from].includes(to)) throw new DomainRuleError("INVALID_STATE_TRANSITION", `Cannot transition from ${from} to ${to}`);
  return to;
};

export const transitionAttachment = (from: AttachmentStatus, to: AttachmentStatus): AttachmentStatus =>
  transitions<AttachmentStatus>({ pending: ["ready", "rejected"], ready: [], rejected: [] }, from, to);

export const transitionOutbox = (from: OutboxStatus, to: OutboxStatus): OutboxStatus =>
  transitions<OutboxStatus>({ pending: ["processing"], processing: ["sent", "failed"], failed: ["processing"], sent: [] }, from, to);

export const transitionExportJob = (from: ExportJobStatus, to: ExportJobStatus): ExportJobStatus =>
  transitions<ExportJobStatus>({ pending: ["running"], running: ["succeeded", "failed"], succeeded: [], failed: [] }, from, to);

export type ReworkOrderStatus =
  | "draft"
  | "pending_process_configuration"
  | "pending_ie_review"
  | "pending_task_assignment"
  | "in_progress"
  | "pending_order_review"
  | "pending_final_quantity_ie_review"
  | "pending_quantity_adjustment_ie_review"
  | "pending_responsibility_determination"
  | "pending_owner_signature"
  | "pending_responsibility_action"
  | "completed"
  | "cancelled"
  | "deleted";

export const transitionReworkOrder = (
  from: ReworkOrderStatus,
  to: ReworkOrderStatus,
): ReworkOrderStatus =>
  transitions<ReworkOrderStatus>({
    draft: ["draft", "pending_process_configuration", "cancelled"],
    pending_process_configuration: ["draft", "pending_ie_review", "cancelled"],
    pending_ie_review: ["pending_process_configuration", "pending_task_assignment"],
    pending_task_assignment: ["pending_ie_review", "in_progress"],
    in_progress: ["in_progress", "pending_order_review"],
    pending_order_review: ["in_progress", "pending_order_review", "pending_quantity_adjustment_ie_review", "pending_final_quantity_ie_review"],
    pending_final_quantity_ie_review: ["pending_order_review", "pending_responsibility_determination"],
    pending_quantity_adjustment_ie_review: ["in_progress", "pending_order_review"],
    pending_responsibility_determination: ["pending_owner_signature", "pending_responsibility_action"],
    pending_owner_signature: ["pending_responsibility_determination", "completed"],
    pending_responsibility_action: ["pending_responsibility_determination", "completed"],
    completed: ["pending_responsibility_determination"],
    cancelled: [],
    deleted: [],
  }, from, to);

export type SourcingCaseStatus =
  | "pending_ie_quote"
  | "pending_management_decision"
  | "pending_owner_approval"
  | "pending_contract"
  | "pending_finance_reconciliation"
  | "pending_factory_change_verification"
  | "pending_exception_verification"
  | "closed";

export type SourcingBusinessAction =
  | "created"
  | "ie_price_quoted"
  | "management_decision_recorded"
  | "owner_approved"
  | "owner_rejected"
  | "contract_recorded"
  | "factory_change_requested"
  | "factory_change_approved"
  | "factory_change_rejected"
  | "finance_matched"
  | "finance_difference"
  | "exception_reopened_for_contract"
  | "exception_reopened_for_reconciliation"
  | "exception_closed";

type SourcingTransitionRule = Readonly<{
  from: SourcingCaseStatus | null;
  to: SourcingCaseStatus;
}>;

export const SOURCING_ACTION_TRANSITIONS: Readonly<Record<SourcingBusinessAction, SourcingTransitionRule>> = {
  created: { from: null, to: "pending_ie_quote" },
  ie_price_quoted: { from: "pending_ie_quote", to: "pending_management_decision" },
  management_decision_recorded: {
    from: "pending_management_decision",
    to: "pending_owner_approval",
  },
  owner_approved: { from: "pending_owner_approval", to: "pending_contract" },
  owner_rejected: { from: "pending_owner_approval", to: "pending_management_decision" },
  contract_recorded: { from: "pending_contract", to: "pending_finance_reconciliation" },
  factory_change_requested: {
    from: "pending_finance_reconciliation",
    to: "pending_factory_change_verification",
  },
  factory_change_approved: {
    from: "pending_factory_change_verification",
    to: "pending_contract",
  },
  factory_change_rejected: {
    from: "pending_factory_change_verification",
    to: "pending_finance_reconciliation",
  },
  finance_matched: { from: "pending_finance_reconciliation", to: "closed" },
  finance_difference: {
    from: "pending_finance_reconciliation",
    to: "pending_exception_verification",
  },
  exception_reopened_for_contract: {
    from: "pending_exception_verification",
    to: "pending_contract",
  },
  exception_reopened_for_reconciliation: {
    from: "pending_exception_verification",
    to: "pending_finance_reconciliation",
  },
  exception_closed: { from: "pending_exception_verification", to: "closed" },
};

export function transitionSourcingCase(
  from: SourcingCaseStatus | null,
  action: SourcingBusinessAction,
): SourcingCaseStatus {
  const rule = SOURCING_ACTION_TRANSITIONS[action];
  if (rule.from !== from) {
    throw new DomainRuleError(
      "INVALID_STATE_TRANSITION",
      `Cannot apply sourcing action ${action} from ${from ?? "uncreated"}`,
    );
  }
  return rule.to;
}

export function sanitizeOperationalError(error: unknown): string {
  void error;
  // Worker errors are persisted in retry tables. Never attempt to enumerate
  // every vendor credential label here: persist only a fixed public
  // classification and keep diagnostics in access-controlled server telemetry.
  return "Operation failed; inspect protected server logs";
}

export * from "./production-progress.js";
export * from "./production-node-clock.js";

export {naturalTimeRatio} from './journey-time-ratio.js';
