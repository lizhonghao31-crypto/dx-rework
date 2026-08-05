import type { TodoRouteDescriptor } from "@dx-rework/contracts";

export type DingTalkTodoDeliveryKind = "create" | "complete" | "update" | "transfer" | "reminder" | "escalation" | "information";

export type DingTalkTodoCreateInput = Readonly<{
  todoId: string;
  recipientUserId: string;
  recipientUnionId?: string;
  category: string;
  deliveryKind: DingTalkTodoDeliveryKind;
  sourceKey: string;
  route: TodoRouteDescriptor;
  deepLink: string;
}>;

export type DingTalkTodoCompleteInput = Readonly<{
  todoId: string;
  providerTodoId: string;
  sourceKey: string;
  reason: string;
}>;

export type DingTalkTodoUpdateInput = Readonly<{
  todoId: string;
  providerTodoId: string;
  recipientUserId: string;
  recipientUnionId?: string;
  category: string;
  sourceKey: string;
  route: TodoRouteDescriptor;
  deepLink: string;
}>;

export type DingTalkTodoDeliveryReceipt = Readonly<{
  providerMessageId: string;
  providerTodoId?: string;
  state?: "created" | "completed" | "updated" | "unknown";
}>;

export type FakeDingTalkTodoProviderStep =
  | "success"
  | "timeout"
  | "rate_limit"
  | "server_error"
  | "client_error"
  | "response_lost";

export interface DingTalkTodoProvider {
  createTodo(input: DingTalkTodoCreateInput): Promise<DingTalkTodoDeliveryReceipt>;
  completeTodo(input: DingTalkTodoCompleteInput): Promise<DingTalkTodoDeliveryReceipt>;
  updateTodo(input: DingTalkTodoUpdateInput): Promise<DingTalkTodoDeliveryReceipt>;
}

export class DingTalkTodoDeliveryError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly unknownResponse = false,
  ) {
    super(message);
    this.name = "DingTalkTodoDeliveryError";
  }
}

export class DisabledDingTalkTodoProvider implements DingTalkTodoProvider {
  async createTodo(): Promise<DingTalkTodoDeliveryReceipt> {
    throw new DingTalkTodoDeliveryError("DINGTALK_TODO_NOT_CONFIGURED", "DingTalk todo delivery is not configured", false);
  }
  async completeTodo(): Promise<DingTalkTodoDeliveryReceipt> {
    throw new DingTalkTodoDeliveryError("DINGTALK_TODO_NOT_CONFIGURED", "DingTalk todo delivery is not configured", false);
  }
  async updateTodo(): Promise<DingTalkTodoDeliveryReceipt> {
    throw new DingTalkTodoDeliveryError("DINGTALK_TODO_NOT_CONFIGURED", "DingTalk todo delivery is not configured", false);
  }
}

export class FakeDingTalkTodoProvider implements DingTalkTodoProvider {
  readonly calls: Array<Readonly<{ method: "create" | "complete" | "update"; input: unknown }>> = [];
  private readonly createdBySourceKey = new Map<string, string>();

  constructor(private readonly script: FakeDingTalkTodoProviderStep[] = ["success"]) {}

  async createTodo(input: DingTalkTodoCreateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "create", input });
    const step = this.next();
    if (step !== "success") this.throwStep(step);
    const existing = this.createdBySourceKey.get(input.sourceKey);
    const providerTodoId = existing ?? `fake-todo-${this.createdBySourceKey.size + 1}`;
    this.createdBySourceKey.set(input.sourceKey, providerTodoId);
    return { providerMessageId: `fake-message-${this.calls.length}`, providerTodoId, state: "created" };
  }

  async completeTodo(input: DingTalkTodoCompleteInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "complete", input });
    const step = this.next();
    if (step !== "success") this.throwStep(step);
    return { providerMessageId: `fake-message-${this.calls.length}`, providerTodoId: input.providerTodoId, state: "completed" };
  }

  async updateTodo(input: DingTalkTodoUpdateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "update", input });
    const step = this.next();
    if (step !== "success") this.throwStep(step);
    return { providerMessageId: `fake-message-${this.calls.length}`, providerTodoId: input.providerTodoId, state: "updated" };
  }

  private next(): FakeDingTalkTodoProviderStep {
    return this.script.shift() ?? "success";
  }

  private throwStep(step: FakeDingTalkTodoProviderStep): never {
    if (step === "timeout") throw new DingTalkTodoDeliveryError("DINGTALK_TODO_TIMEOUT", "DingTalk todo request timed out", true, true);
    if (step === "rate_limit") throw new DingTalkTodoDeliveryError("DINGTALK_TODO_RATE_LIMIT", "DingTalk todo request was rate limited", true);
    if (step === "server_error") throw new DingTalkTodoDeliveryError("DINGTALK_TODO_SERVER_ERROR", "DingTalk todo server error", true);
    if (step === "response_lost") throw new DingTalkTodoDeliveryError("DINGTALK_TODO_RESPONSE_LOST", "DingTalk todo response was lost", true, true);
    throw new DingTalkTodoDeliveryError("DINGTALK_TODO_CLIENT_ERROR", "DingTalk todo protocol or permission error", false);
  }
}

export class ServerDingTalkTodoProvider extends DisabledDingTalkTodoProvider {
  constructor(readonly configured = false) { super(); }
}
