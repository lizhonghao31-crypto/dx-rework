import { describe, expect, it } from "vitest";

import {
  DingTalkTodoDeliveryError,
  DisabledDingTalkTodoProvider,
  FakeDingTalkTodoProvider,
  OfficialDingTalkTodoProvider,
} from "../../apps/api/src/todos/provider.js";

const createInput = {
  todoId: "00000000-0000-4000-8000-000000000013",
  recipientUserId: "00000000-0000-4000-8000-000000000014",
  recipientUnionId: "union-14",
  recipientProviderUserId: "userid-14",
  category: "process_configuration",
  deliveryKind: "create" as const,
  sourceKey: "todo-source-13",
  route: {
    routeName: "rework_detail" as const,
    entityId: "00000000-0000-4000-8000-000000000015",
    todoId: "00000000-0000-4000-8000-000000000013",
  },
  deepLink: "https://staging.example/rework/ui/tasks/00000000-0000-4000-8000-000000000015",
};

const json = (value: unknown, status = 200): Response => new Response(
  JSON.stringify(value),
  { status, headers: { "content-type": "application/json" } },
);

describe("DingTalk todo provider boundary", () => {
  it("fails closed while disabled and in test environments", async () => {
    await expect(new DisabledDingTalkTodoProvider().createTodo()).rejects.toMatchObject({
      code: "DINGTALK_TODO_NOT_CONFIGURED",
      retryable: false,
    });
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "test",
    }, async () => { throw new Error("test must not call the network"); });
    await expect(provider.createTodo(createInput)).rejects.toMatchObject({
      code: "DINGTALK_TODO_NOT_CONFIGURED",
    });
  });

  it("reconciles a lost create response with the stable source key", async () => {
    const provider = new FakeDingTalkTodoProvider(["response_lost"]);
    await expect(provider.createTodo(createInput)).rejects.toMatchObject({
      code: "DINGTALK_TODO_RESPONSE_LOST",
      retryable: true,
      unknownResponse: true,
    });
    await expect(provider.createTodo(createInput)).resolves.toMatchObject({
      providerTodoId: "fake-todo-1",
      reconciled: true,
    });
    expect(provider.calls).toHaveLength(2);
  });

  it("uses official union-id task endpoints for create, update and completion", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.endsWith("/tasks/sources/todo-source-13")) return json({}, 404);
      if (new URL(url).pathname.endsWith("/tasks") && init.method === "POST") {
        return json({ id: "task-1", requestId: "request-create" });
      }
      if (url.endsWith("/tasks/task-1") && init.method === "PUT") {
        return json({ requestId: "request-update" });
      }
      if (url.endsWith("/tasks/task-1/executorStatus") && init.method === "PUT") {
        return json({ result: true, requestId: "request-complete" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(createInput)).resolves.toMatchObject({
      providerMessageId: "request-create",
      providerTodoId: "task-1",
      state: "created",
    });
    await expect(provider.updateTodo({
      ...createInput,
      providerTodoId: "task-1",
      deliveryKind: "reminder",
    })).resolves.toMatchObject({ providerTodoId: "task-1", state: "updated" });
    await expect(provider.completeTodo({
      todoId: createInput.todoId,
      recipientUnionId: createInput.recipientUnionId,
      providerTodoId: "task-1",
      sourceKey: createInput.sourceKey,
      reason: "completed",
    })).resolves.toMatchObject({ providerTodoId: "task-1", state: "completed" });

    const createCall = calls.find((call) =>
      new URL(call.url).pathname.endsWith("/tasks") && call.init.method === "POST"
    );
    expect(createCall?.url).toContain("/v1.0/todo/users/union-14/tasks");
    expect(new URL(createCall!.url).searchParams.get("operatorId")).toBe("union-14");
    expect(new Headers(createCall?.init.headers).get("x-acs-dingtalk-access-token")).toBe("token-value");
    expect(JSON.parse(String(createCall?.init.body))).toMatchObject({
      sourceId: "todo-source-13",
      executorIds: ["union-14"],
      notifyConfigs: {
        dingNotify: "1",
        sendTodoApn: "true",
        sendAssistantChat: "true",
      },
    });
    expect(JSON.parse(String(createCall?.init.body))).not.toHaveProperty("operatorId");
    expect(calls.some((call) =>
      call.url.includes("/topapi/message/corpconversation/asyncsend_v2")
    )).toBe(false);
    const completion = calls.find((call) => call.url.endsWith("/executorStatus"));
    expect(JSON.parse(String(completion?.init.body))).toEqual({
      executorStatusList: [{ id: "union-14", isDone: true }],
      operatorId: "union-14",
    });
  });

  it("treats DingTalk's requestId-only source lookup as missing and creates the todo", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const http: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.endsWith("/tasks/sources/todo-source-13")) {
        return json({ requestId: "lookup-empty" });
      }
      if (new URL(url).pathname.endsWith("/tasks") && init.method === "POST") {
        return json({ id: "task-created", requestId: "request-create" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(createInput)).resolves.toMatchObject({
      providerTodoId: "task-created",
      providerMessageId: "request-create",
      state: "created",
    });
    expect(calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/tasks") && call.init.method === "POST"
    )).toHaveLength(1);
  });

  it("reconciles a requestId-only create response by the stable sourceId", async () => {
    let lookupCount = 0;
    const http: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.endsWith("/tasks/sources/todo-source-13")) {
        lookupCount += 1;
        return lookupCount === 1
          ? json({ requestId: "lookup-empty" })
          : json({ id: "task-reconciled", requestId: "lookup-created" });
      }
      if (new URL(url).pathname.endsWith("/tasks") && init.method === "POST") {
        return json({ requestId: "request-create" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(createInput)).resolves.toMatchObject({
      providerTodoId: "task-reconciled",
      providerMessageId: "lookup-created",
      state: "created",
      reconciled: true,
    });
  });

  it("keeps an unconfirmed requestId-only create response retryable", async () => {
    const http: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.endsWith("/tasks/sources/todo-source-13")) {
        return json({ requestId: "lookup-empty" });
      }
      if (new URL(url).pathname.endsWith("/tasks") && init.method === "POST") {
        return json({ requestId: "request-create" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(createInput)).rejects.toMatchObject({
      code: "DINGTALK_TODO_CREATE_UNCONFIRMED",
      retryable: true,
      unknownResponse: true,
    });
  });

  it("reconciles an existing native todo without sending a duplicate work notification", async () => {
    const http: typeof fetch = async (input) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.endsWith("/tasks/sources/todo-source-13")) {
        return json({ id: "task-existing", requestId: "lookup-existing" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(createInput)).resolves.toMatchObject({
      providerTodoId: "task-existing",
      providerMessageId: "lookup-existing",
      reconciled: true,
    });
  });

  it("compacts production outbox keys into a stable DingTalk sourceId", async () => {
    const productionInput = {
      ...createInput,
      sourceKey:
        "todo:00000000-0000-4000-8000-000000000013:delivery:00000000-0000-4000-8000-000000000016",
    };
    expect(Buffer.byteLength(productionInput.sourceKey, "utf8")).toBeGreaterThan(64);

    const calls: Array<{ url: string; init: RequestInit }> = [];
    let lookupCount = 0;
    const http: typeof fetch = async (input, init = {}) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "token-value", expires_in: 7200 });
      }
      if (url.includes("/tasks/sources/")) {
        lookupCount += 1;
        return lookupCount === 1
          ? json({}, 404)
          : json({ id: "task-compact", requestId: "lookup-existing" });
      }
      if (new URL(url).pathname.endsWith("/tasks") && init.method === "POST") {
        return json({ id: "task-compact", requestId: "request-create" });
      }
      throw new Error(`unexpected request ${url}`);
    };
    const provider = new OfficialDingTalkTodoProvider({
      appKey: "app-key",
      appSecret: "app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, http, () => 1_000);

    await expect(provider.createTodo(productionInput)).resolves.toMatchObject({
      providerTodoId: "task-compact",
    });
    await expect(provider.createTodo(productionInput)).resolves.toMatchObject({
      providerTodoId: "task-compact",
      reconciled: true,
    });

    const lookupCalls = calls.filter((call) => call.url.includes("/tasks/sources/"));
    expect(lookupCalls).toHaveLength(2);
    const sourceIds = lookupCalls.map((call) =>
      decodeURIComponent(call.url.slice(call.url.lastIndexOf("/") + 1))
    );
    expect(new Set(sourceIds).size).toBe(1);
    expect(Buffer.byteLength(sourceIds[0] ?? "", "utf8")).toBeLessThanOrEqual(64);
    expect(sourceIds[0]).not.toBe(productionInput.sourceKey);

    const createCalls = calls.filter((call) =>
      new URL(call.url).pathname.endsWith("/tasks") && call.init.method === "POST"
    );
    expect(createCalls).toHaveLength(1);
    expect(JSON.parse(String(createCalls[0]?.init.body))).toMatchObject({
      sourceId: sourceIds[0],
    });
    expect(calls.some((call) =>
      call.url.includes("/topapi/message/corpconversation/asyncsend_v2")
    )).toBe(false);
  });

  it("classifies retryable and permanent HTTP failures without leaking credentials", async () => {
    const makeProvider = (status: number) => new OfficialDingTalkTodoProvider({
      appKey: "sensitive-app-key",
      appSecret: "sensitive-app-secret",
      agentId: "123456",
      nodeEnv: "production",
    }, async (input) => {
      const url = String(input);
      if (url.startsWith("https://oapi.dingtalk.com/gettoken")) {
        return json({ errcode: 0, access_token: "sensitive-token", expires_in: 7200 });
      }
      if (url.includes("/tasks/sources/")) return json({}, 404);
      return json({ message: "provider raw secret sensitive-token" }, status);
    });

    await expect(makeProvider(429).createTodo(createInput)).rejects.toMatchObject({
      code: "DINGTALK_TODO_RATE_LIMIT",
      retryable: true,
    });
    await expect(makeProvider(503).createTodo(createInput)).rejects.toMatchObject({
      code: "DINGTALK_TODO_SERVER_ERROR",
      retryable: true,
      unknownResponse: true,
    });
    let failure: unknown;
    try { await makeProvider(403).createTodo(createInput); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(DingTalkTodoDeliveryError);
    expect(failure).toMatchObject({ code: "DINGTALK_TODO_CLIENT_ERROR", retryable: false });
    expect(String(failure)).not.toContain("sensitive-app-secret");
    expect(String(failure)).not.toContain("sensitive-token");
  });
});
