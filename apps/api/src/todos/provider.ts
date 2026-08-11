import type { TodoRouteDescriptor } from "@dx-rework/contracts";

export type DingTalkTodoDeliveryKind =
  | "create"
  | "complete"
  | "update"
  | "reminder"
  | "escalation"
  | "information";

export type DingTalkTodoCreateInput = Readonly<{
  todoId: string;
  recipientUserId: string;
  recipientUnionId: string;
  recipientProviderUserId: string;
  category: string;
  deliveryKind: "create" | "information";
  sourceKey: string;
  route: TodoRouteDescriptor;
  deepLink: string;
}>;

export type DingTalkTodoCompleteInput = Readonly<{
  todoId: string;
  recipientUnionId: string;
  providerTodoId?: string;
  sourceKey: string;
  reason: string;
}>;

export type DingTalkTodoUpdateInput = Readonly<{
  todoId: string;
  recipientUserId: string;
  recipientUnionId: string;
  providerTodoId?: string;
  category: string;
  deliveryKind: "update" | "reminder" | "escalation";
  sourceKey: string;
  route: TodoRouteDescriptor;
  deepLink: string;
}>;

export type DingTalkTodoDeliveryReceipt = Readonly<{
  providerMessageId: string;
  providerTodoId: string;
  state: "created" | "completed" | "updated";
  reconciled?: boolean;
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
    readonly retryable: boolean,
    readonly unknownResponse = false,
  ) {
    super(message);
    this.name = "DingTalkTodoDeliveryError";
  }
}

const notConfigured = (): DingTalkTodoDeliveryError => new DingTalkTodoDeliveryError(
  "DINGTALK_TODO_NOT_CONFIGURED",
  "DingTalk todo delivery is not configured",
  false,
);

export class DisabledDingTalkTodoProvider implements DingTalkTodoProvider {
  async createTodo(): Promise<DingTalkTodoDeliveryReceipt> { throw notConfigured(); }
  async completeTodo(): Promise<DingTalkTodoDeliveryReceipt> { throw notConfigured(); }
  async updateTodo(): Promise<DingTalkTodoDeliveryReceipt> { throw notConfigured(); }
}

export class FakeDingTalkTodoProvider implements DingTalkTodoProvider {
  readonly calls: Array<Readonly<{
    method: "create" | "complete" | "update";
    input: DingTalkTodoCreateInput | DingTalkTodoCompleteInput | DingTalkTodoUpdateInput;
  }>> = [];
  private readonly createdBySourceKey = new Map<string, string>();

  constructor(private readonly script: FakeDingTalkTodoProviderStep[] = ["success"]) {}

  async createTodo(input: DingTalkTodoCreateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "create", input });
    const existing = this.createdBySourceKey.get(input.sourceKey);
    if (existing) {
      return {
        providerMessageId: `fake-message-${this.calls.length}`,
        providerTodoId: existing,
        state: "created",
        reconciled: true,
      };
    }
    const step = this.next();
    const providerTodoId = `fake-todo-${this.createdBySourceKey.size + 1}`;
    if (step === "response_lost") {
      this.createdBySourceKey.set(input.sourceKey, providerTodoId);
      throw this.error(step);
    }
    if (step !== "success") throw this.error(step);
    this.createdBySourceKey.set(input.sourceKey, providerTodoId);
    return {
      providerMessageId: `fake-message-${this.calls.length}`,
      providerTodoId,
      state: "created",
    };
  }

  async completeTodo(input: DingTalkTodoCompleteInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "complete", input });
    const step = this.next();
    if (step !== "success") throw this.error(step);
    const providerTodoId = input.providerTodoId ?? this.createdBySourceKey.get(input.sourceKey);
    if (!providerTodoId) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_BINDING_NOT_FOUND",
        "DingTalk todo binding was not found",
        true,
      );
    }
    return {
      providerMessageId: `fake-message-${this.calls.length}`,
      providerTodoId,
      state: "completed",
    };
  }

  async updateTodo(input: DingTalkTodoUpdateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.calls.push({ method: "update", input });
    const step = this.next();
    if (step !== "success") throw this.error(step);
    const providerTodoId = input.providerTodoId ?? this.createdBySourceKey.get(input.sourceKey);
    if (!providerTodoId) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_BINDING_NOT_FOUND",
        "DingTalk todo binding was not found",
        true,
      );
    }
    return {
      providerMessageId: `fake-message-${this.calls.length}`,
      providerTodoId,
      state: "updated",
    };
  }

  private next(): FakeDingTalkTodoProviderStep {
    return this.script.shift() ?? "success";
  }

  private error(step: Exclude<FakeDingTalkTodoProviderStep, "success">): DingTalkTodoDeliveryError {
    if (step === "timeout") {
      return new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TIMEOUT",
        "DingTalk todo request timed out",
        true,
        true,
      );
    }
    if (step === "rate_limit") {
      return new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_RATE_LIMIT",
        "DingTalk todo request was rate limited",
        true,
      );
    }
    if (step === "server_error") {
      return new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_SERVER_ERROR",
        "DingTalk todo server error",
        true,
      );
    }
    if (step === "response_lost") {
      return new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_RESPONSE_LOST",
        "DingTalk todo response was lost",
        true,
        true,
      );
    }
    return new DingTalkTodoDeliveryError(
      "DINGTALK_TODO_CLIENT_ERROR",
      "DingTalk todo protocol or permission error",
      false,
    );
  }
}

export type OfficialDingTalkTodoProviderConfig = Readonly<{
  appKey: string;
  appSecret: string;
  agentId: string;
  nodeEnv: "development" | "test" | "production";
  requestTimeoutMs?: number;
}>;

type Fetch = typeof fetch;
type JsonRecord = Record<string, unknown>;
const API = "https://api.dingtalk.com";
const OAPI = "https://oapi.dingtalk.com";

export class OfficialDingTalkTodoProvider implements DingTalkTodoProvider {
  private cachedToken?: { token: string; refreshAt: number };
  private tokenRequest: Promise<string> | undefined;

  constructor(
    private readonly config: OfficialDingTalkTodoProviderConfig,
    private readonly http: Fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  async createTodo(input: DingTalkTodoCreateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.assertEnabled();
    let task = await this.getBySourceId(input.recipientUnionId, input.sourceKey, true);
    const reconciled = task !== null;
    if (!task) {
      const body = {
        subject: input.category,
        description: `返工待办：${input.category}`,
        executorIds: [input.recipientUnionId],
        participantIds: [],
        operatorId: input.recipientUnionId,
        sourceId: input.sourceKey,
        detailUrl: { appUrl: input.deepLink, pcUrl: input.deepLink },
        isOnlyShowExecutor: true,
        priority: 20,
      };
      try {
        task = await this.request(
          `/v1.0/todo/users/${encodeURIComponent(input.recipientUnionId)}/tasks`,
          { method: "POST", body: JSON.stringify(body) },
          "create",
        );
      } catch (error: unknown) {
        if (error instanceof DingTalkTodoDeliveryError && error.unknownResponse) {
          task = await this.getBySourceId(input.recipientUnionId, input.sourceKey, true);
        }
        if (!task) throw error;
      }
    }
    const notificationId = await this.sendWorkNotification(input);
    return {
      providerMessageId: notificationId,
      providerTodoId: this.taskId(task),
      state: "created",
      ...(reconciled ? { reconciled: true } : {}),
    };
  }

  async completeTodo(input: DingTalkTodoCompleteInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.assertEnabled();
    const providerTodoId = input.providerTodoId
      ?? await this.resolveTaskId(input.recipientUnionId, input.sourceKey);
    const result = await this.request(
      `/v1.0/todo/users/${encodeURIComponent(input.recipientUnionId)}/tasks/${encodeURIComponent(providerTodoId)}/executorStatus`,
      {
        method: "PUT",
        body: JSON.stringify({
          executorStatusList: [{ id: input.recipientUnionId, isDone: true }],
          operatorId: input.recipientUnionId,
        }),
      },
      "complete",
    );
    return {
      providerMessageId: this.requestId(result),
      providerTodoId,
      state: "completed",
    };
  }

  async updateTodo(input: DingTalkTodoUpdateInput): Promise<DingTalkTodoDeliveryReceipt> {
    this.assertEnabled();
    const providerTodoId = input.providerTodoId
      ?? await this.resolveTaskId(input.recipientUnionId, input.sourceKey);
    const result = await this.request(
      `/v1.0/todo/users/${encodeURIComponent(input.recipientUnionId)}/tasks/${encodeURIComponent(providerTodoId)}`,
      {
        method: "PUT",
        body: JSON.stringify({
          subject: input.category,
          description: `返工待办更新：${input.category}`,
          executorIds: [input.recipientUnionId],
          operatorId: input.recipientUnionId,
          detailUrl: { appUrl: input.deepLink, pcUrl: input.deepLink },
        }),
      },
      "update",
    );
    return {
      providerMessageId: this.requestId(result),
      providerTodoId,
      state: "updated",
    };
  }

  private async sendWorkNotification(input: DingTalkTodoCreateInput): Promise<string> {
    const token = await this.getAppToken();
    const url = new URL(`${OAPI}/topapi/message/corpconversation/asyncsend_v2`);
    url.searchParams.set("access_token", token);
    let response: Response;
    try {
      response = await this.http(url.toString(), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          agent_id: Number(this.config.agentId),
          userid_list: input.recipientProviderUserId,
          msg: {
            msgtype: "link",
            link: {
              messageUrl: input.deepLink,
              picUrl: "",
              title: `待处理：${input.category}`,
              text: `请进入返工系统处理。任务编号：${input.sourceKey}`,
            },
          },
        }),
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 5_000),
      });
    } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_TIMEOUT",
        "DingTalk work notification request failed or timed out",
        true,
        true,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_RETRYABLE",
        `DingTalk work notification returned HTTP ${response.status}`,
        true,
        response.status >= 500,
      );
    }
    if (!response.ok) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_REJECTED",
        `DingTalk work notification was rejected with HTTP ${response.status}`,
        false,
      );
    }
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_INVALID_RESPONSE",
        "DingTalk work notification returned invalid JSON",
        true,
        true,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_INVALID_RESPONSE",
        "DingTalk work notification returned an invalid response",
        false,
      );
    }
    const record = value as JsonRecord;
    if (record.errcode === 143106) return `dingtalk-duplicate-${input.sourceKey}`;
    if (record.errcode !== 0) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_REJECTED",
        `DingTalk work notification was rejected (${String(record.errcode)})`,
        false,
      );
    }
    const taskId = typeof record.task_id === "number" || typeof record.task_id === "string"
      ? String(record.task_id)
      : "";
    if (!taskId) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_WORK_NOTIFICATION_INVALID_RESPONSE",
        "DingTalk work notification did not return a task ID",
        false,
      );
    }
    return taskId;
  }

  private assertEnabled(): void {
    if (
      this.config.nodeEnv === "test"
      || !this.config.appKey.trim()
      || !this.config.appSecret.trim()
      || !/^\d+$/.test(this.config.agentId.trim())
    ) throw notConfigured();
  }

  private async resolveTaskId(unionId: string, sourceKey: string): Promise<string> {
    try {
      return this.taskId(await this.getBySourceId(unionId, sourceKey, false));
    } catch (error: unknown) {
      if (
        error instanceof DingTalkTodoDeliveryError
        && error.code === "DINGTALK_TODO_NOT_FOUND"
      ) {
        throw new DingTalkTodoDeliveryError(
          "DINGTALK_TODO_BINDING_PENDING",
          "DingTalk todo task is not available yet",
          true,
        );
      }
      throw error;
    }
  }

  private async getBySourceId(
    unionId: string,
    sourceKey: string,
    missingIsNull: boolean,
  ): Promise<JsonRecord | null> {
    try {
      return await this.request(
        `/v1.0/todo/users/${encodeURIComponent(unionId)}/tasks/sources/${encodeURIComponent(sourceKey)}`,
        { method: "GET" },
        "lookup",
      );
    } catch (error: unknown) {
      if (
        missingIsNull
        && error instanceof DingTalkTodoDeliveryError
        && error.code === "DINGTALK_TODO_NOT_FOUND"
      ) return null;
      throw error;
    }
  }

  private async request(
    path: string,
    init: RequestInit,
    operation: "create" | "complete" | "update" | "lookup",
  ): Promise<JsonRecord> {
    const token = await this.getAppToken();
    let response: Response;
    try {
      response = await this.http(`${API}${path}`, {
        ...init,
        headers: {
          "content-type": "application/json",
          "x-acs-dingtalk-access-token": token,
          ...(init.headers ?? {}),
        },
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 5_000),
      });
    } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TIMEOUT",
        `DingTalk todo ${operation} request failed or timed out`,
        true,
        operation === "create",
      );
    }
    if (response.status === 404) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_NOT_FOUND",
        "DingTalk todo task was not found",
        false,
      );
    }
    if (response.status === 429) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_RATE_LIMIT",
        "DingTalk todo request was rate limited",
        true,
      );
    }
    if (response.status >= 500) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_SERVER_ERROR",
        `DingTalk todo server returned HTTP ${response.status}`,
        true,
        operation === "create",
      );
    }
    if (!response.ok) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_CLIENT_ERROR",
        `DingTalk todo request was rejected with HTTP ${response.status}`,
        false,
      );
    }
    if (response.status === 204) return {};
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_INVALID_RESPONSE",
        "DingTalk todo returned invalid JSON",
        operation === "lookup" || operation === "create",
        operation === "create",
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_INVALID_RESPONSE",
        "DingTalk todo returned an invalid response",
        false,
      );
    }
    return value as JsonRecord;
  }

  private async getAppToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.refreshAt > this.now()) {
      return this.cachedToken.token;
    }
    if (this.tokenRequest) return this.tokenRequest;
    this.tokenRequest = this.fetchAppToken();
    try { return await this.tokenRequest; } finally { this.tokenRequest = undefined; }
  }

  private async fetchAppToken(): Promise<string> {
    const url = new URL(`${OAPI}/gettoken`);
    url.searchParams.set("appkey", this.config.appKey);
    url.searchParams.set("appsecret", this.config.appSecret);
    let response: Response;
    try {
      response = await this.http(url.toString(), {
        signal: AbortSignal.timeout(this.config.requestTimeoutMs ?? 5_000),
      });
    } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_TIMEOUT",
        "DingTalk access-token request failed or timed out",
        true,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_RETRYABLE",
        `DingTalk access-token endpoint returned HTTP ${response.status}`,
        true,
      );
    }
    if (!response.ok) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_REJECTED",
        `DingTalk access-token endpoint rejected the request with HTTP ${response.status}`,
        false,
      );
    }
    let value: unknown;
    try { value = await response.json(); } catch {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_INVALID_RESPONSE",
        "DingTalk access-token endpoint returned invalid JSON",
        false,
      );
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_INVALID_RESPONSE",
        "DingTalk access-token endpoint returned an invalid response",
        false,
      );
    }
    const record = value as JsonRecord;
    if (record.errcode !== undefined && record.errcode !== 0) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_REJECTED",
        `DingTalk access-token endpoint rejected the request (${String(record.errcode)})`,
        false,
      );
    }
    const token = typeof record.access_token === "string" ? record.access_token : "";
    const expiresIn = typeof record.expires_in === "number" ? record.expires_in : 7_200;
    if (!token) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_TOKEN_INVALID_RESPONSE",
        "DingTalk access-token endpoint did not return a token",
        false,
      );
    }
    this.cachedToken = {
      token,
      refreshAt: this.now() + Math.max(60, expiresIn - 60) * 1_000,
    };
    return token;
  }

  private receipt(value: JsonRecord, state: "created", reconciled = false): DingTalkTodoDeliveryReceipt {
    return {
      providerMessageId: this.requestId(value),
      providerTodoId: this.taskId(value),
      state,
      ...(reconciled ? { reconciled: true } : {}),
    };
  }

  private taskId(value: JsonRecord | null): string {
    const taskId = value && typeof value.taskId === "string"
      ? value.taskId
      : value && typeof value.result === "object" && value.result !== null
        && !Array.isArray(value.result) && typeof (value.result as JsonRecord).taskId === "string"
        ? String((value.result as JsonRecord).taskId)
        : "";
    if (!taskId) {
      throw new DingTalkTodoDeliveryError(
        "DINGTALK_TODO_INVALID_RESPONSE",
        "DingTalk todo response did not include a task ID",
        false,
      );
    }
    return taskId;
  }

  private requestId(value: JsonRecord): string {
    return typeof value.requestId === "string" && value.requestId
      ? value.requestId
      : `dingtalk-${this.now()}`;
  }
}

