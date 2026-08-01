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
