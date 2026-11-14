import { digitalTodoTarget } from "../production-platform/notification-policy.js";
import { randomUUID } from "node:crypto";

import {
  buildTodoPresentation,
  TodoRouteDescriptorSchema,
  type TodoRouteDescriptor,
} from "@dx-rework/contracts";
import { sanitizeOperationalError } from "@dx-rework/domain";
import type { Pool, PoolClient } from "pg";

import { buildTodoExternalDeepLink } from "./deep-link.js";
import {
  DingTalkTodoDeliveryError,
  type DingTalkTodoDeliveryKind,
  type DingTalkTodoProvider,
} from "./provider.js";
import { ApplicationError } from "../platform/errors.js";
import { MessageOutboxRepository, type SqlClient } from "../tools/repositories.js";
import { TODO_DELIVERY_TOPIC, TodoService } from "./service.js";

type ClaimedDelivery = Readonly<{
  eventId: string;
  aggregateId: string;
  payload: unknown;
  idempotencyKey: string;
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
  completed_operation_event_id: string | null;
  cancelled_operation_event_id: string | null;
  rework_no: string | null;
  order_no: string | null;
  style_no: string | null;
  wage_period_month: string | null;
}>;

type BindingRow = Readonly<{
  binding_id: string;
  todo_id: string;
  external_generation: number;
  recipient_user_id: string;
  recipient_union_id: string;
  creator_union_id: string;
  provider_todo_id: string | null;
  source_key: string;
  provider_state: "creating" | "active" | "unknown_response" | "completed" | "cancelled" | "permanent_failed";
  create_outbox_event_id: string;
  create_operation_event_id: string;
}>;

type DeliveryPayload = Readonly<{
  todoId: string;
  recipientUserId: string;
  category: string;
  deliveryKind: DingTalkTodoDeliveryKind;
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

const deliveryKinds = new Set<DingTalkTodoDeliveryKind>([
  "create",
  "complete",
  "update",
  "reminder",
  "escalation",
  "information",
]);

const parsePayload = (value: unknown): DeliveryPayload => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo delivery payload is invalid", 500);
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.todoId !== "string"
    || typeof record.recipientUserId !== "string"
    || typeof record.category !== "string"
    || typeof record.deliveryKind !== "string"
    || !deliveryKinds.has(record.deliveryKind as DingTalkTodoDeliveryKind)
    || typeof record.operationEventId !== "string"
    || typeof record.operationRequestId !== "string"
  ) {
    throw new ApplicationError("VALIDATION_ERROR", "Todo delivery payload is invalid", 500);
  }
  return {
    todoId: record.todoId,
    recipientUserId: record.recipientUserId,
    category: record.category,
    deliveryKind: record.deliveryKind as DingTalkTodoDeliveryKind,
    route: TodoRouteDescriptorSchema.parse(record.route),
    operationEventId: record.operationEventId,
    operationRequestId: record.operationRequestId,
  };
};

export class TodoDeliveryWorker {
  constructor(
    private readonly database: Pool,
    private readonly provider: DingTalkTodoProvider,
    private readonly todoPublicBaseUrl: string,
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
        idempotencyKey: row.idempotencyKey,
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

  private async deliver(
    claimed: ClaimedDelivery,
  ): Promise<"sent" | "failed" | "suppressed"> {
    let input: DeliveryPayload;
    try {
      input = parsePayload(claimed.payload);
      if (input.todoId !== claimed.aggregateId) {
        throw new ApplicationError("CONFLICT", "Todo delivery aggregate is invalid", 409);
      }
      await this.assertDeliveryEvent(input);
      if (["digital_production_task", "digital_short_lead", "digital_order_time", "digital_order_quotation", "digital_bulk_washing", "digital_development"].includes(input.route.routeName) || await digitalTodoTarget(this.database, input.route)) {
        await this.markSuppressed(claimed);
        return "suppressed";
      }
    } catch (error: unknown) {
      await this.failWithoutBinding(claimed, error);
      return "failed";
    }

    if (input.deliveryKind === "complete") {
      return this.completeExternal(claimed, input);
    }
    if (["update", "reminder", "escalation"].includes(input.deliveryKind)) {
      return this.updateExternal(claimed, input);
    }
    return this.createExternal(claimed, input);
  }

  private async createExternal(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
  ): Promise<"sent" | "failed" | "suppressed"> {
    const todo = await this.todo(input.todoId);
    if (!todo || todo.status !== "pending") {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    if (!this.payloadMatchesTodo(input, todo)) {
      await this.failWithoutBinding(
        claimed,
        new ApplicationError("CONFLICT", "Todo delivery payload no longer matches its todo", 409),
      );
      return "failed";
    }
    const eligible = await this.revalidateRecipient(todo, input);
    if (!eligible) {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    const recipientIdentity = await this.recipientIdentity(input.recipientUserId);
    if (!recipientIdentity) {
      await this.failWithoutBinding(
        claimed,
        new DingTalkTodoDeliveryError(
          "DINGTALK_RECIPIENT_NOT_FOUND",
          "Todo recipient has no active primary-corporation DingTalk identity",
          true,
        ),
      );
      return "failed";
    }
    const creatorIdentity = await this.deliveryActorIdentity(input);
    if (!creatorIdentity) {
      await this.failWithoutBinding(
        claimed,
        new DingTalkTodoDeliveryError(
          "DINGTALK_TODO_CREATOR_NOT_FOUND",
          "Todo creation actor has no active primary-corporation DingTalk identity",
          true,
        ),
      );
      return "failed";
    }
    const sourceKey = claimed.idempotencyKey;
    const binding = await this.ensureBinding(
      claimed,
      input,
      recipientIdentity.unionId,
      creatorIdentity.unionId,
      sourceKey,
    );
    try {
      const createKind: "create" | "information" = input.deliveryKind === "information"
        ? "information"
        : "create";
      const presentation = buildTodoPresentation({
        category: todo.category,
        deliveryKind: createKind,
        orderContext: this.orderContext(todo),
        wagePeriodMonth: todo.wage_period_month,
      });
      const receipt = await this.provider.createTodo({
        todoId: todo.todo_id,
        recipientUserId: todo.recipient_user_id,
        recipientUnionId: recipientIdentity.unionId,
        creatorUnionId: creatorIdentity.unionId,
        recipientProviderUserId: recipientIdentity.providerUserId,
        category: todo.category,
        ...presentation,
        deliveryKind: createKind,
        sourceKey,
        route: input.route,
        deepLink: buildTodoExternalDeepLink(this.todoPublicBaseUrl, input.route),
      });
      await this.recordSuccess(claimed, input, binding, receipt.providerTodoId, receipt.providerMessageId, "active");
      return "sent";
    } catch (error: unknown) {
      await this.recordFailure(claimed, input, binding, error);
      return "failed";
    }
  }

  private async completeExternal(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
  ): Promise<"sent" | "failed" | "suppressed"> {
    const todo = await this.todo(input.todoId);
    if (!todo) {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    const binding = await this.latestBinding(input.todoId, input.recipientUserId);
    if (!binding) {
      if (await this.hasOutstandingCreationDelivery(input.todoId, input.recipientUserId)) {
        await this.failWithoutBinding(
          claimed,
          new DingTalkTodoDeliveryError(
            "DINGTALK_TODO_BINDING_PENDING",
            "DingTalk todo creation is still pending before terminal delivery",
            true,
          ),
        );
        return "failed";
      }
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    if (["completed", "cancelled", "permanent_failed"].includes(binding.provider_state)) {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    const operatorIdentity = await this.deliveryActorIdentity(input);
    if (!operatorIdentity) {
      await this.recordFailure(
        claimed,
        input,
        binding,
        new DingTalkTodoDeliveryError(
          "DINGTALK_TODO_OPERATOR_NOT_FOUND",
          "Todo completion actor has no active primary-corporation DingTalk identity",
          true,
        ),
      );
      return "failed";
    }
    try {
      const receipt = await this.provider.completeTodo({
        todoId: todo.todo_id,
        recipientUnionId: binding.recipient_union_id,
        creatorUnionId: binding.creator_union_id,
        operatorUnionId: operatorIdentity.unionId,
        ...(binding.provider_todo_id ? { providerTodoId: binding.provider_todo_id } : {}),
        sourceKey: binding.source_key,
        reason: todo.status === "cancelled" ? "Internal todo was cancelled" : "Internal todo was completed or transferred",
      });
      const finalState = todo.status === "cancelled" ? "cancelled" : "completed";
      await this.recordSuccess(
        claimed,
        input,
        binding,
        receipt.providerTodoId,
        receipt.providerMessageId,
        finalState,
      );
      return "sent";
    } catch (error: unknown) {
      await this.recordFailure(claimed, input, binding, error);
      return "failed";
    }
  }

  private async updateExternal(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
  ): Promise<"sent" | "failed" | "suppressed"> {
    const todo = await this.todo(input.todoId);
    if (!todo || todo.status !== "pending") {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    if (!this.payloadMatchesTodo(input, todo)) {
      await this.failWithoutBinding(
        claimed,
        new ApplicationError("CONFLICT", "Todo delivery payload no longer matches its todo", 409),
      );
      return "failed";
    }
    if (!(await this.revalidateRecipient(todo, input))) {
      await this.markSuppressed(claimed);
      return "suppressed";
    }
    const binding = await this.openBinding(input.todoId, input.recipientUserId);
    if (!binding) {
      await this.failWithoutBinding(
        claimed,
        new DingTalkTodoDeliveryError(
          "DINGTALK_TODO_BINDING_PENDING",
          "DingTalk todo binding is not available yet",
          true,
        ),
      );
      return "failed";
    }
    const operatorIdentity = await this.deliveryActorIdentity(input);
    if (!operatorIdentity) {
      await this.recordFailure(
        claimed,
        input,
        binding,
        new DingTalkTodoDeliveryError(
          "DINGTALK_TODO_OPERATOR_NOT_FOUND",
          "Todo update actor has no active primary-corporation DingTalk identity",
          true,
        ),
      );
      return "failed";
    }
    try {
      const updateKind: "update" | "reminder" | "escalation" = input.deliveryKind === "reminder"
        ? "reminder"
        : input.deliveryKind === "escalation"
          ? "escalation"
          : "update";
      const presentation = buildTodoPresentation({
        category: todo.category,
        deliveryKind: updateKind,
        orderContext: this.orderContext(todo),
        wagePeriodMonth: todo.wage_period_month,
      });
      const receipt = await this.provider.updateTodo({
        todoId: todo.todo_id,
        recipientUserId: todo.recipient_user_id,
        recipientUnionId: binding.recipient_union_id,
        creatorUnionId: binding.creator_union_id,
        operatorUnionId: operatorIdentity.unionId,
        ...(binding.provider_todo_id ? { providerTodoId: binding.provider_todo_id } : {}),
        category: todo.category,
        ...presentation,
        deliveryKind: updateKind,
        sourceKey: binding.source_key,
        route: input.route,
        deepLink: buildTodoExternalDeepLink(this.todoPublicBaseUrl, input.route),
      });
      await this.recordSuccess(
        claimed,
        input,
        binding,
        receipt.providerTodoId,
        receipt.providerMessageId,
        "active",
      );
      return "sent";
    } catch (error: unknown) {
      await this.recordFailure(claimed, input, binding, error);
      return "failed";
    }
  }

  private async ensureBinding(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    recipientUnionId: string,
    creatorUnionId: string,
    sourceKey: string,
  ): Promise<BindingRow> {
    return this.transaction(async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [sourceKey]);
      const existing = await client.query<BindingRow>(
        `SELECT binding_id,todo_id,external_generation,recipient_user_id,recipient_union_id,creator_union_id,
                provider_todo_id,source_key,provider_state,create_outbox_event_id,create_operation_event_id
         FROM dingtalk_todo_external_bindings
         WHERE provider='dingtalk' AND source_key=$1
         FOR UPDATE`,
        [sourceKey],
      );
      if (existing.rows[0]) return existing.rows[0];
      const generation = await client.query<{ generation: number }>(
        `SELECT COALESCE(max(external_generation),0)::int+1 generation
         FROM dingtalk_todo_external_bindings WHERE todo_id=$1`,
        [input.todoId],
      );
      const bindingId = randomUUID();
      const inserted = await client.query<BindingRow>(
        `INSERT INTO dingtalk_todo_external_bindings(
           binding_id,todo_id,external_generation,recipient_user_id,recipient_union_id,creator_union_id,
           source_key,provider_state,create_outbox_event_id,create_operation_event_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'creating',$8,$9)
         RETURNING binding_id,todo_id,external_generation,recipient_user_id,recipient_union_id,creator_union_id,
                   provider_todo_id,source_key,provider_state,create_outbox_event_id,create_operation_event_id`,
        [
          bindingId,
          input.todoId,
          generation.rows[0]?.generation ?? 1,
          input.recipientUserId,
          recipientUnionId,
          creatorUnionId,
          sourceKey,
          claimed.eventId,
          input.operationEventId,
        ],
      );
      const binding = inserted.rows[0];
      if (!binding) throw new ApplicationError("INTERNAL_ERROR", "DingTalk todo binding was not created", 500);
      await this.insertBindingEvent(client, claimed, input, binding, "creating", null, null);
      return binding;
    });
  }

  private async latestBinding(todoId: string, recipientUserId: string): Promise<BindingRow | null> {
    const result = await this.database.query<BindingRow>(
      `SELECT binding_id,todo_id,external_generation,recipient_user_id,recipient_union_id,creator_union_id,
              provider_todo_id,source_key,provider_state,create_outbox_event_id,create_operation_event_id
       FROM dingtalk_todo_external_bindings
       WHERE todo_id=$1 AND recipient_user_id=$2
       ORDER BY external_generation DESC
       LIMIT 1`,
      [todoId, recipientUserId],
    );
    return result.rows[0] ?? null;
  }

  private async openBinding(todoId: string, recipientUserId: string): Promise<BindingRow | null> {
    const binding = await this.latestBinding(todoId, recipientUserId);
    return binding && ["creating", "active", "unknown_response"].includes(binding.provider_state)
      ? binding
      : null;
  }

  private async hasOutstandingCreationDelivery(
    todoId: string,
    recipientUserId: string,
  ): Promise<boolean> {
    const result = await this.database.query<{ outstanding: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM message_outbox
         WHERE topic=$1
           AND aggregate_type='rework_todo'
           AND aggregate_id=$2
           AND payload->>'recipientUserId'=$3
           AND payload->>'deliveryKind' IN ('create','information')
           AND status IN ('pending','processing','failed')
       ) outstanding`,
      [TODO_DELIVERY_TOPIC, todoId, recipientUserId],
    );
    return result.rows[0]?.outstanding === true;
  }

  private async recordSuccess(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    binding: BindingRow,
    providerTodoId: string,
    providerMessageId: string,
    state: "active" | "completed" | "cancelled",
  ): Promise<void> {
    await this.transaction(async (client) => {
      await this.setTodoContext(client, input.operationEventId, input.operationRequestId);
      await this.insertAttempt(client, claimed, input, "sent", providerMessageId, undefined);
      await client.query(
        `UPDATE dingtalk_todo_external_bindings
         SET provider_todo_id=$2,provider_state=$3,
             terminal_outbox_event_id=CASE WHEN $3 IN ('completed','cancelled') THEN $4 ELSE terminal_outbox_event_id END,
             terminal_operation_event_id=CASE WHEN $3 IN ('completed','cancelled') THEN $5 ELSE terminal_operation_event_id END,
             version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE binding_id=$1`,
        [binding.binding_id, providerTodoId, state, claimed.eventId, input.operationEventId],
      );
      await this.insertBindingEvent(
        client,
        claimed,
        input,
        { ...binding, provider_todo_id: providerTodoId },
        state,
        providerMessageId,
        providerTodoId,
      );
      if (input.deliveryKind === "information") {
        await this.todos.completeInformationAfterSuccessfulDeliveryInTransaction(
          client,
          input.todoId,
          input.operationEventId,
          input.operationRequestId,
        );
      }
      await this.outbox.markSent(client, claimed.eventId, claimed.claimToken);
    });
  }

  private async recordFailure(
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    binding: BindingRow,
    error: unknown,
  ): Promise<void> {
    const deliveryError = error instanceof DingTalkTodoDeliveryError ? error : null;
    const retryable = deliveryError?.retryable ?? true;
    const bindingState = deliveryError?.unknownResponse
      ? "unknown_response"
      : retryable
        ? "retryable_failed"
        : "permanent_failed";
    await this.transaction(async (client) => {
      await this.setTodoContext(client, input.operationEventId, input.operationRequestId);
      await this.insertAttempt(
        client,
        claimed,
        input,
        deliveryError?.unknownResponse ? "unknown_response" : "failed",
        undefined,
        error,
      );
      await client.query(
        `UPDATE dingtalk_todo_external_bindings
         SET provider_state=CASE
               WHEN $2='unknown_response' THEN 'unknown_response'
               WHEN $2='permanent_failed' THEN 'permanent_failed'
               ELSE provider_state
             END,
             version=version+1,updated_at=CURRENT_TIMESTAMP
         WHERE binding_id=$1`,
        [binding.binding_id, bindingState],
      );
      await this.insertBindingEvent(
        client,
        claimed,
        input,
        binding,
        bindingState,
        undefined,
        binding.provider_todo_id,
        error,
      );
      if (retryable) {
        await this.outbox.markFailed(
          client,
          claimed.eventId,
          claimed.claimToken,
          error,
          this.retryDelaySeconds,
        );
      } else {
        await this.outbox.markSent(client, claimed.eventId, claimed.claimToken);
      }
    });
  }

  private async failWithoutBinding(claimed: ClaimedDelivery, error: unknown): Promise<void> {
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

  private async insertAttempt(
    client: PoolClient,
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    outcome: "sent" | "failed" | "unknown_response",
    providerMessageId: string | undefined,
    error: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO todo_delivery_attempts(
         delivery_attempt_id,todo_id,message_outbox_event_id,attempt_no,delivery_kind,
         provider,outcome,provider_message_id,error_code,error_message,
         operation_event_id,operation_request_id
       ) VALUES($1,$2,$3,$4,$5,'dingtalk',$6,$7,$8,$9,$10,$11)
       ON CONFLICT(todo_id,message_outbox_event_id,attempt_no) DO NOTHING`,
      [
        randomUUID(),
        input.todoId,
        claimed.eventId,
        claimed.attempts,
        input.deliveryKind,
        outcome,
        providerMessageId ?? null,
        outcome === "sent" ? null : errorCode(error),
        outcome === "sent" ? null : sanitizeOperationalError(error),
        input.operationEventId,
        input.operationRequestId,
      ],
    );
  }

  private async insertBindingEvent(
    client: PoolClient,
    claimed: ClaimedDelivery,
    input: DeliveryPayload,
    binding: BindingRow,
    state: "creating" | "active" | "unknown_response" | "completed" | "cancelled" | "retryable_failed" | "permanent_failed",
    providerRequestId: string | null | undefined,
    providerTodoId: string | null | undefined,
    error?: unknown,
  ): Promise<void> {
    await client.query(
      `INSERT INTO dingtalk_todo_external_binding_events(
         binding_event_id,binding_id,message_outbox_event_id,operation_event_id,request_id,
         action,provider_state,provider_request_id,provider_todo_id,detail
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT(binding_id,message_outbox_event_id,action,provider_state) DO NOTHING`,
      [
        randomUUID(),
        binding.binding_id,
        claimed.eventId,
        input.operationEventId,
        input.operationRequestId,
        input.deliveryKind,
        state,
        providerRequestId ?? null,
        providerTodoId ?? null,
        error ? { errorCode: errorCode(error), error: sanitizeOperationalError(error) } : {},
      ],
    );
  }

  private async todo(todoId: string): Promise<TodoDeliveryRow | null> {
    const result = await this.database.query<TodoDeliveryRow>(
      `SELECT todo.todo_id,todo.todo_type,todo.category,todo.recipient_user_id,
              todo.route_descriptor,todo.status,todo.completed_operation_event_id,
              todo.cancelled_operation_event_id,orders.rework_no,orders.order_no,
              COALESCE(orders.style_no,sourcing_line.style_no) AS style_no,
              period.period_month::text wage_period_month
       FROM rework_todos todo
       LEFT JOIN rework_orders orders
         ON orders.rework_order_id=COALESCE(
           NULLIF(todo.route_descriptor->>'reworkOrderId','')::uuid,
           CASE
             WHEN todo.route_descriptor->>'routeName'<>'wage_period_detail'
             THEN NULLIF(todo.route_descriptor->>'entityId','')::uuid
           END
         )
       LEFT JOIN LATERAL (
         SELECT COALESCE(NULLIF(line.style_no,''),NULLIF(line.alternate_style_no,'')) AS style_no
         FROM current_sourcing_case_lines line
         WHERE line.sourcing_case_id=CASE
           WHEN todo.category='sourcing_contract_return' AND todo.entity_type='sourcing_case'
             THEN todo.entity_id::uuid
         END
         ORDER BY line.position LIMIT 1
       ) sourcing_line ON true
       LEFT JOIN rework_wage_periods period
         ON todo.route_descriptor->>'routeName'='wage_period_detail'
        AND period.period_id=NULLIF(todo.route_descriptor->>'entityId','')::uuid
       WHERE todo.todo_id=$1`,
      [todoId],
    );
    return result.rows[0] ?? null;
  }

  private orderContext(todo: TodoDeliveryRow): Readonly<{
    reworkNo: string | null;
    orderNo: string | null;
    styleNo: string | null;
  }> | null {
    return todo.rework_no || todo.order_no || todo.style_no
      ? {
          reworkNo: todo.rework_no,
          orderNo: todo.order_no,
          styleNo: todo.style_no,
        }
      : null;
  }

  private payloadMatchesTodo(input: DeliveryPayload, todo: TodoDeliveryRow): boolean {
    const route = TodoRouteDescriptorSchema.parse(todo.route_descriptor);
    return input.todoId === todo.todo_id
      && input.recipientUserId === todo.recipient_user_id
      && input.category === todo.category
      && input.route.routeName === route.routeName
      && input.route.entityId === route.entityId
      && input.route.reworkOrderId === route.reworkOrderId
      && input.route.todoId === route.todoId
      && input.route.tab === route.tab;
  }

  private async assertDeliveryEvent(input: DeliveryPayload): Promise<void> {
    const event = await this.database.query<{
      action: string;
      entity_type: string;
      entity_id: string;
    }>(
      `SELECT action,entity_type,entity_id
       FROM operation_events WHERE event_id=$1 AND request_id=$2`,
      [input.operationEventId, input.operationRequestId],
    );
    const row = event.rows[0];
    if (!row || row.entity_type !== "rework_todo" || row.entity_id !== input.todoId) {
      throw new ApplicationError("CONFLICT", "Todo delivery audit event is invalid", 409);
    }
    const expected = input.deliveryKind === "reminder"
      ? ["todo.remind"]
      : input.deliveryKind === "escalation" || input.deliveryKind === "update"
        ? ["todo.escalate", "todo.remind"]
        : input.deliveryKind === "complete"
          ? ["todo.complete", "todo.cancel", "todo.transfer"]
          : ["todo.create", "todo.transfer"];
    if (!expected.includes(row.action)) {
      throw new ApplicationError("CONFLICT", "Todo delivery audit event is invalid", 409);
    }
  }

  private async recipientIdentity(
    userId: string,
  ): Promise<{ unionId: string; providerUserId: string } | null> {
    const result = await this.database.query<{
      union_id: string;
      provider_user_id: string;
    }>(
      `SELECT identity.union_id,identity.provider_user_id
       FROM app_users user_record
       JOIN identity_mappings identity
         ON identity.user_id=user_record.id AND identity.provider='dingtalk'
        AND identity.active=true AND identity.employed=true
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       WHERE user_record.id=$1 AND user_record.enabled=true`,
      [userId],
    );
    const identity = result.rows[0];
    return identity
      ? { unionId: identity.union_id, providerUserId: identity.provider_user_id }
      : null;
  }

  private async deliveryActorIdentity(
    input: DeliveryPayload,
  ): Promise<{ unionId: string; providerUserId: string } | null> {
    const result = await this.database.query<{
      union_id: string;
      provider_user_id: string;
    }>(
      `SELECT identity.union_id,identity.provider_user_id
       FROM operation_events event
       JOIN app_users user_record
         ON user_record.id=event.actor_id AND user_record.enabled=true
       JOIN identity_mappings identity
         ON identity.user_id=user_record.id AND identity.provider='dingtalk'
        AND identity.active=true AND identity.employed=true
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       WHERE event.event_id=$1 AND event.request_id=$2`,
      [input.operationEventId, input.operationRequestId],
    );
    const identity = result.rows[0];
    return identity
      ? { unionId: identity.union_id, providerUserId: identity.provider_user_id }
      : null;
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
         FROM operation_events WHERE event_id=$1 AND request_id=$2`,
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

  private async markSuppressed(claimed: ClaimedDelivery): Promise<void> {
    await this.transaction(async (client) => {
      await this.outbox.markSent(client, claimed.eventId, claimed.claimToken);
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
