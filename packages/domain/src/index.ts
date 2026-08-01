export type SourceReference = Readonly<{
  sourceSystem: string;
  sourceRecordId: string;
  externalIdempotencyKey: string;
  erpNodeId?: string;
}>;

export type AuditEventDraft = Readonly<{
  requestId: string;
  actorId?: string;
  actorRole?: string;
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
  acceptSourceRecord(input: unknown): Promise<never>;
  publishResult(input: unknown): Promise<never>;
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

export type TrustedActor = Readonly<{ actorId: string; actorRole: string }>;
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

export function sanitizeOperationalError(error: unknown): string {
  const fallback = "Operation failed; inspect protected server logs";
  if (!(error instanceof Error)) return fallback;
  const normalized = error.message.replace(/[\r\n\t\u0000-\u001f\u007f]+/g, " ").trim();
  const assignments = normalized.replace(
    /\b(password|secret|token|api[-_]?key|access[-_]?key|authorization|signature)\b\s*[=:]\s*(?:"[^"]*"|'[^']*'|Bearer\s+\S+|\S+)/gi,
    (_match, label: string) => `${label}=[REDACTED]`,
  );
  const bearer = assignments.replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]");
  const queryValues = bearer.replace(
    /([?&](?:signature|x-oss-signature|ossaccesskeyid|accesskeyid|security-token|token|secret)=)[^&\s]+/gi,
    "$1[REDACTED]",
  );
  return queryValues.slice(0, 500) || fallback;
}
