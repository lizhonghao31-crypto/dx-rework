import { randomUUID } from "node:crypto";

import { TodoRouteDescriptorSchema, type TodoRouteDescriptor } from "@dx-rework/contracts";
import { sanitizeOperationalError } from "@dx-rework/domain";
import type { Pool, PoolClient } from "pg";

import { buildTodoDeepLink } from "./deep-link.js";
import type { DingTalkTodoProvider } from "./provider.js";
import { ApplicationError } from "../platform/errors.js";
import { MessageOutboxRepository, type SqlClient } from "../tools/repositories.js";
import { TODO_DELIVERY_TOPIC, TodoService } from "./service.js";

type ClaimedDelivery = Readonly<{
  eventId: string;
  aggregateId: string;
  payload: unknown;
  claimToken: string;
  attempts: number;
}>;

type TodoDeliveryRow = Readonly<{
  todo_id: string;
  todo_type: "business_action" | "information" | "recipient_routing_exception";
  category: string;
  recipient_user_id: string;
  route_descriptor: TodoRouteDescriptor;
  status: "pending" | "blocked_recipient" | "completed" | "cancelled";
  created_operation_event_id: string;
}>;

type DeliveryPayload = Readonly<{
  todoId: string;
  recipientUserId: string;
  category: string;
  deliveryKind: "create" | "reminder" | "escalation" | "information";
  route: TodoRouteDescriptor;
  operationEventId: string;
  operationRequestId: string;
}>;

export type TodoDeliveryRunResult = Readonly<{
  claimed: number;
  sent: number;
  failed: number;
  suppressed: number;
}>;

const errorCode = (error: unknown): string =>
  error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code.slice(0, 100)
    : "DINGTALK_DELIVERY_FAILED";

const payload = (value: unknown): DeliveryPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo delivery payload is invalid", 500);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.todoId !== "string"
    || typeof record.recipientUserId !== "string"
    || typeof record.category !== "string"
    || !["create", "reminder", "escalation", "information"].includes(
      String(record.deliveryKind),
    )
    || typeof record.operationEventId !== "string"
    || typeof record.operationRequestId !== "string"
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo delivery payload is invalid", 500);
  }
  return {
    todoId: record.todoId,
    recipientUserId: record.recipientUserId,
    category: record.category,
    deliveryKind: record.deliveryKind as DeliveryPayload["deliveryKind"],
    route: TodoRouteDescriptorSchema.parse(record.route),
    operationEventId: record.operationEventId,
    operationRequestId: record.operationRequestId,
  };
};

/**
 * Claims only todo-delivery outbox rows. It deliberately leaves all existing
 * business outbox topics to their current owners and never delivers a todo
 * once it has been blocked, completed or cancelled.
 */
export class TodoDeliveryWorker {
  constructor(
    private readonly database: Pool,
    private readonly provider: DingTalkTodoProvider,
    private readonly appBasePath: string,
    private readonly outbox = new MessageOutboxRepository(),
    private readonly retryDelaySeconds = 300,
    private readonly todos = new TodoService(database),
  ) {}

  async runOnce(limit = 10): Promise<TodoDeliveryRunResult> {
    const claimed = await this.claim(limit);
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    for (const delivery of claimed) {
      const result = await this.deliver(delivery);
      if (result === "sent") sent += 1;
      if (result === "failed") failed += 1;
      if (result === "suppressed") suppressed += 1;
    }
    return { claimed: claimed.length, sent, failed, suppressed };
  }

  private async claim(limit: number): Promise<ClaimedDelivery[]> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const rows = await this.outbox.claim(client, limit, 300, TODO_DELIVERY_TOPIC);
      await client.query("COMMIT");
      return rows.map((row) => ({
        eventId: row.eventId,
        aggregateId: row.aggregateId,
        payload: row.payload,
        claimToken: row.claimToken,
        attempts: row.attempts,
      }));
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async deliver(claimed: ClaimedDelivery): Promise<"sent" | "failed" | "suppressed"> {
    const todo = await this.todo(claimed.aggregateId);
    if (!todo || todo.status !== "pending") {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    let input: DeliveryPayload;
    try {
      input = payload(claimed.payload);
      this.assertPayloadMatchesTodo(claimed, input, todo);
      await this.assertDeliveryEvent(todo, input);
      if (!(await this.revalidateRecipient(todo, input))) {
        await this.markSuppressed(claimed);
        return "suppressed";
      }
    } catch (error: unknown) {
      await this.markFailedWithoutAttempt(claimed, error);
      return "failed";
    }

    try {
      const receipt = await this.provider.deliver({
        todoId: todo.todo_id,
        recipientUserId: todo.recipient_user_id,
        category: todo.category,
        deliveryKind: input.deliveryKind,
        route: input.route,
        deepLink: buildTodoDeepLink(this.appBasePath, input.route),
      });
      await this.recordAttempt(claimed, input, "sent", receipt.providerMessageId, undefined);
      return "sent";
    } catch (error: unknown) {
      await this.recordAttempt(claimed, input, "failed", undefined, error);
      return "failed";
    }
  }

  private async todo(todoId: string): Promise<TodoDeliveryRow | null> {
    const result = await this.database.query<TodoDeliveryRow>(
      `SELECT todo_id,todo_type,category,recipient_user_id,route_descriptor,status,
              created_operation_event_id
       FROM rework_todos WHERE todo_id=$1`,
      [todoId],
    );
    return result.rows[0] ?? null;
  }

  private assertPayloadMatchesTodo(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    todo: TodoDeliveryRow,
  ): void {
    const route = TodoRouteDescriptorSchema.parse(todo.route_descriptor);
    if (
      input.todoId !== todo.todo_id
      || input.todoId !== claimed.aggregateId
      || input.recipientUserId !== todo.recipient_user_id
      || input.category !== todo.category
      || input.route.routeName !== route.routeName
      || input.route.entityId !== route.entityId
      || input.route.reworkOrderId !== route.reworkOrderId
      || input.route.todoId !== route.todoId
      || input.route.tab !== route.tab
    ) {
      throw new ApplicationError("CONFLICT", "Todo delivery payload no longer matches its immutable todo", 409);
    }
  }

  private async assertDeliveryEvent(todo: TodoDeliveryRow, input: DeliveryPayload): Promise<void> {
    const event = await this.database.query<{
      action: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT event.action,event.entity_type,event.entity_id
       FROM operation_events event
       WHERE event.event_id=$1 AND event.request_id=$2`,
      [input.operationEventId, input.operationRequestId],
    );
    const row = event.rows[0];
    if (!row || row.entity_type !== "rework_todo" || row.entity_id !== todo.todo_id) {
      throw new ApplicationError("CONFLICT", "Todo delivery audit event is invalid", 409);
    }
    const expectedActions = input.deliveryKind === "reminder"
      ? ["todo.remind"]
      : input.deliveryKind === "escalation"
        ? ["todo.escalate"]
        : ["todo.create", "todo.transfer"];
    if (!expectedActions.includes(row.action)) {
      throw new ApplicationError("CONFLICT", "Todo delivery audit event is invalid", 409);
    }
  }

  private async markSuppressed(claimed: ClaimedDelivery): Promise<void> {
    await this.transaction(async (client) => {
      await this.outbox.markSent(client, claimed.eventId, claimed.claimToken);
    });
  }

  private async markFailedWithoutAttempt(claimed: ClaimedDelivery, error: unknown): Promise<void> {
    await this.transaction(async (client) => {
      await this.outbox.markFailed(
        client,
        claimed.eventId,
        claimed.claimToken,
        error,
        this.retryDelaySeconds,
      );
    });
  }

  private async recordAttempt(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    outcome: "sent" | "failed",
    providerMessageId: string | undefined,
    error: unknown,
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.setTodoContext(client, input.operationEventId, input.operationRequestId);
      await client.query(
        `INSERT INTO todo_delivery_attempts(
           delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
           provider,outcome,provider_message_id,error_code,error_message,
           operation_event_id,operation_request_id
         ) VALUES($1,$2,$3,$4,$5,'dingtalk',$6,$7,$8,$9,$10,$11)`,
        [
          randomUUID(), input.todoId, claimed.eventId, claimed.attempts,
          input.deliveryKind, outcome, providerMessageId ?? null,
          outcome === "failed" ? errorCode(error) : null,
          outcome === "failed" ? sanitizeOperationalError(error) : null,
          input.operationEventId, input.operationRequestId,
        ],
      );
      if (outcome === "sent") {
        if (input.deliveryKind === "information") {
          await this.todos.completeInformationAfterSuccessfulDeliveryInTransaction(
            client,
            input.todoId,
            input.operationEventId,
            input.operationRequestId,
          );
        }
        await this.outbox.markSent(client, claimed.eventId, claimed.claimToken);
      } else {
        await this.outbox.markFailed(
          client,
          claimed.eventId,
          claimed.claimToken,
          error,
          this.retryDelaySeconds,
        );
      }
    });
  }

  private async revalidateRecipient(
    todo: TodoDeliveryRow,
    input: DeliveryPayload,
  ): Promise<boolean> {
    return this.transaction(async (client) => {
      const source = await client.query<{
        actor_id: string;
        actor_roles: string[];
        authorization_capability: string;
      }>(
        `SELECT actor_id,actor_roles,authorization_capability
         FROM operation_events
         WHERE event_id=$1 AND request_id=$2`,
        [input.operationEventId, input.operationRequestId],
      );
      const actor = source.rows[0];
      if (!actor) {
        throw new ApplicationError("CONFLICT", "Todo delivery event is missing its trusted actor", 409);
      }
      return this.todos.ensureOpenRecipientEligibleInTransaction(client, {
        actorId: actor.actor_id,
        actorRoles: actor.actor_roles,
        authorizationCapability: actor.authorization_capability,
        requestId: input.operationRequestId,
      }, todo.todo_id);
    });
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async setTodoContext(
    client: SqlClient,
    operationEventId: string,
    operationRequestId: string,
  ): Promise<void> {
    await client.query(
      "SELECT set_config('dx_rework.todo_event_id',$1,true),set_config('dx_rework.todo_request_id',$2,true)",
      [operationEventId, operationRequestId],
    );
  }
}
