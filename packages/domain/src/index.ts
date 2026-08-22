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

export type ErpAdapterStatus = Readonly<{
  enabled: boolean;
  mode: "disabled" | "mock" | "connected";
}>;

export interface ErpAdapter {
  status(): Promise<ErpAdapterStatus>;
  acceptSourceRecord(input: unknown): Promise<void>;
  publishResult(input: unknown): Promise<void>;
}

export class IntegrationDisabledError extends Error {
  constructor(integration: string) {
    super(`${integration} integration is disabled`);
    this.name = "IntegrationDisabledError";
  }
}

export class DisabledErpAdapter implements ErpAdapter {
  async status(): Promise<ErpAdapterStatus> {
    return { enabled: false, mode: "disabled" };
  }

  async acceptSourceRecord(input: unknown): Promise<never> {
    void input;
    throw new IntegrationDisabledError("ERP");
  }

  async publishResult(input: unknown): Promise<never> {
    void input;
    throw new IntegrationDisabledError("ERP");
  }
}

export class MockErpAdapter implements ErpAdapter {
  readonly acceptedSourceRecords: unknown[] = [];
  readonly publishedResults: unknown[] = [];

  async status(): Promise<ErpAdapterStatus> {
    return { enabled: true, mode: "mock" };
  }

  async acceptSourceRecord(input: unknown): Promise<void> {
    this.acceptedSourceRecords.push(input);
  }

  async publishResult(input: unknown): Promise<void> {
    this.publishedResults.push(input);
  }
}

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

export function sanitizeOperationalError(error: unknown): string {
  void error;
  // Worker errors are persisted in retry tables. Never attempt to enumerate
  // every vendor credential label here: persist only a fixed public
  // classification and keep diagnostics in access-controlled server telemetry.
  return "Operation failed; inspect protected server logs";
}
