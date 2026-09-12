import { createHash, randomUUID } from "node:crypto";
import { AssignPatternOrderSchema, CreatePatternOrderSchema, PATTERN_ROOM_ORDERS_ENABLED, PatternRoundActionSchema, UpdatePatternMaterialsSchema, type PatternOrderCapability, type PatternOrderQuery, type PatternRoundAction } from "@dx-rework/contracts/pattern-orders";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { authorizePatternOrder, isPatternRoot } from "./order-authority.js";
import { bindPatternMaterials } from "./order-attachments.js";
import { PatternOrderReader, scopedPatternOrder, type PatternOrderRow, type PatternRoundRow, type PatternSegmentRow } from "./order-reader.js";

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const value = schema.safeParse(input);
  if (!value.success) throw new ApplicationError("VALIDATION_ERROR", value.error.issues[0]?.message ?? "请检查必填资料", 400);
  return value.data;
};
export const patternTodoKey = (orderId: string, roundId: string, action: string) => `pattern-room:${orderId}:${roundId}:${action}`;
export class PatternRoomOrderService {
  private readonly enabled: boolean;
  private readonly reader: PatternOrderReader;
  constructor(private readonly db: Pool, private readonly todos: TodoProjectionService, options: { ordersEnabled?: boolean } = {},
    private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository()) {
    this.enabled = options.ordersEnabled ?? PATTERN_ROOM_ORDERS_ENABLED;
    this.reader = new PatternOrderReader(db, this.enabled);
  }
  list(actor: TrustedActorContext, query: PatternOrderQuery) { return this.reader.list(actor, query); }
  peopleFilters(actor: TrustedActorContext) { return this.reader.peopleFilters(actor); }
  get(actor: TrustedActorContext, orderId: string) { return this.reader.get(actor, orderId); }
  uploadActor(actor: TrustedActorContext) { return authorizePatternOrder(this.db, actor, "pattern_room:orders:create", this.enabled); }
  downloadActor(actor: TrustedActorContext) { return authorizePatternOrder(this.db, actor, "pattern_room:orders:view", this.enabled); }
  async canDownload(actor: TrustedActorContext, binding: { entityType: string; entityId: string }): Promise<boolean> {
    if (binding.entityType !== "pattern_room_attachment") return false;
    const reference = (await this.db.query<{ order_id: string }>("SELECT order_id FROM pattern_room_attachment_bindings WHERE attachment_id=$1 LIMIT 1", [binding.entityId])).rows[0];
    if (!reference) return false;
    try { return (await this.get(actor, reference.order_id)).attachments.some(file => file.attachmentId === binding.entityId); }
    catch (error) { if (error instanceof ApplicationError && [403, 404, 503].includes(error.statusCode)) return false; throw error; }
  }
  async workers(actor: TrustedActorContext, search: string) {
    const effective = await authorizePatternOrder(this.db, actor, "pattern_room:orders:assign", this.enabled);
    return (await this.db.query<{ person_id: string; app_user_id: string; display_name: string }>(`SELECT person.person_id,person.app_user_id,person.display_name
      FROM business_people person WHERE person.active AND person.person_type='internal' AND person.app_user_id IS NOT NULL
        AND (todo_user_has_direct_role(person.app_user_id,'worker','pattern_room:orders:complete') OR ($2 AND person.app_user_id=$3))
        AND ($1='' OR strpos(upper(person.display_name),upper($1))>0) ORDER BY person.display_name,person.person_id LIMIT 30`, [search.trim(), isPatternRoot(effective), effective.actorId])).rows
      .map(person => ({ personId: person.person_id, userId: person.app_user_id, name: person.display_name }));
  }
  private async mutate(actor: TrustedActorContext, capability: PatternOrderCapability, action: string, key: string, input: unknown,
    work: (client: PoolClient, effective: TrustedActorContext) => Promise<string>) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效操作标识，请重试", 400);
    const client = await this.db.connect(); let orderId: string;
    try {
      await client.query("BEGIN");
      const effective = await authorizePatternOrder(client, actor, capability, this.enabled);
      const outcome = await this.idempotency.execute(client, { scope: action, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), expiresAt: new Date("9999-12-31T00:00:00Z") }, async () => ({ statusCode: 200, response: { orderId: await work(client, effective) } }));
      orderId = outcome.response.orderId;
      await client.query("COMMIT");
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
    return this.get(actor, orderId);
  }
  private async target(client: PoolClient, actor: TrustedActorContext, orderId: string, input: PatternRoundAction, status: PatternOrderRow["status"] | readonly PatternOrderRow["status"][]) {
    const order = await scopedPatternOrder(client, actor, orderId, true);
    if (order.version !== input.version || order.current_round_id !== input.roundId) throw new ApplicationError("CONFLICT", "订单或轮次已变化，请刷新当前订单后再操作", 409);
    if (!(Array.isArray(status) ? status : [status]).includes(order.status)) throw new ApplicationError("INVALID_STATE_TRANSITION", "当前状态不能执行此操作", 409);
    const round = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE round_id=$1 FOR UPDATE", [input.roundId])).rows[0]!;
    if (round.status !== order.status) throw new ApplicationError("CONFLICT", "当前轮次状态不一致，请刷新后重试", 409);
    return { order, round };
  }
  private projection(orderId: string, roundId: string, eventId: string, action: string, task: string) {
    return { category: `pattern_room_${task}`, sourceEventId: eventId, sourceAction: action, entityType: "pattern_room_order", entityId: orderId,
      route: { routeName: "pattern_room_order" as const, entityId: orderId, roundId }, policyKey: "general" as const, dedupeKey: patternTodoKey(orderId, roundId, task) };
  }
  private async event(client: PoolClient, actor: TrustedActorContext, action: string, orderId: string, roundId: string, after: unknown, before?: unknown, reason?: string) {
    return this.events.append(client, actor, { action, entityType: "pattern_room_order", entityId: orderId, after: { orderId, roundId, value: after },
      ...(before === undefined ? {} : { before }), ...(reason ? { reason } : {}) });
  }
  private async moveNode(client: PoolClient, roundId: string, next?: string) {
    await client.query("UPDATE pattern_room_node_times SET exited_at=CURRENT_TIMESTAMP,exit_reason='completed' WHERE round_id=$1 AND exited_at IS NULL", [roundId]);
    if (next) await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,$3)", [randomUUID(), roundId, next]);
  }
  private async supervisor(client: PoolClient, fallback: string): Promise<string> {
    // Before release only Root may act; never route its acceptance work to real staff.
    if (!this.enabled) return fallback;
    const result = await client.query<{ user_id: string }>(`SELECT assignment.user_id FROM user_role_assignments assignment WHERE assignment.role_code='pattern_room_supervisor'
      AND assignment.revoked_at IS NULL AND todo_user_has_direct_role(assignment.user_id,'pattern_room_supervisor','pattern_room:orders:assign') LIMIT 1`);
    return result.rows[0]?.user_id ?? fallback;
  }

  async create(actor: TrustedActorContext, input: unknown, key: string) {
    const parsed = parse(CreatePatternOrderSchema, input), action = "pattern_room.order.submitted";
    return this.mutate(actor, "pattern_room:orders:create", action, key, parsed, async (client, effective) => {
      const price = (await client.query<{ price_id: string; version: number; name: string; unit: string; amount: string }>(
        "SELECT price_id,version,name,unit,amount FROM pattern_room_prices WHERE price_id=$1 AND kind='category' AND enabled FOR SHARE", [parsed.categoryId])).rows[0];
      if (!price) throw new ApplicationError("PRICE_CHANGED", "品类已停用或不存在，请重新选择品类", 409);
      if (price.version !== parsed.priceVersion) throw new ApplicationError("PRICE_CHANGED", "执行价已调整，请核对最新价格后重新提交", 409);
      const creator = (await client.query<{ display_name: string }>("SELECT display_name FROM app_users WHERE id=$1", [effective.actorId])).rows[0]!;
      const orderId = randomUUID(), roundId = randomUUID();
      await client.query(`INSERT INTO pattern_room_orders(order_id,current_round_id,status,created_by,creator_name,style_no,required_date,customer,size_color,reference_style_no,variant,note)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$9,$10,$11)`, [orderId, roundId, effective.actorId, creator.display_name, parsed.styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note]);
      await client.query(`INSERT INTO pattern_room_rounds(round_id,order_id,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$7::numeric*$8::integer)`, [roundId, orderId, price.price_id, price.version, price.name, price.unit, price.amount, parsed.quantity]);
      await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,'pending_assignment')", [randomUUID(), roundId]);
      await bindPatternMaterials(client, effective, orderId, roundId, parsed.attachmentIds, "创建制作资料");
      const eventId = await this.event(client, effective, action, orderId, roundId, parsed);
      if (this.enabled) await this.todos.actionableForUniqueDirectRole(client, effective, { ...this.projection(orderId, roundId, eventId, action, "assignment"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:assign" });
      return orderId;
    });
  }

  async assign(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(AssignPatternOrderSchema, input), action = "pattern_room.order.assigned";
    return this.mutate(actor, "pattern_room:orders:assign", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { round } = await this.target(client, effective, orderId, parsed, "pending_assignment");
      const person = (await client.query<{ person_id: string; app_user_id: string; display_name: string }>(`SELECT person_id,app_user_id,display_name FROM business_people
        WHERE person_id=$1 AND active AND person_type='internal' AND app_user_id IS NOT NULL
          AND (todo_user_has_direct_role(app_user_id,'worker','pattern_room:orders:complete') OR ($2 AND app_user_id=$3)) FOR SHARE`, [parsed.personId, isPatternRoot(effective), effective.actorId])).rows[0];
      if (!person) throw new ApplicationError("VALIDATION_ERROR", "请选择有有效账号的板房工人", 400);
      const segmentId = randomUUID(), supervisorId = await this.supervisor(client, effective.actorId);
      await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount)
        VALUES($1,$2,1,$3,$4,$5,'internal',$6)`, [segmentId, round.round_id, person.person_id, person.app_user_id, person.display_name, round.agreed_amount]);
      await client.query("UPDATE pattern_room_rounds SET status='in_progress',assigned_at=CURRENT_TIMESTAMP,assigned_by=$2,supervisor_user_id=$3 WHERE round_id=$1", [round.round_id, effective.actorId, supervisorId]);
      await client.query("UPDATE pattern_room_orders SET status='in_progress',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.moveNode(client, round.round_id, "in_progress");
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId, personId: person.person_id, workerUserId: person.app_user_id });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "assignment"), "已分配工人");
      if (this.enabled) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, `execution:${segmentId}`), category: "pattern_room_execution",
        recipientUserId: person.app_user_id, requiredRole: "worker", requiredCapability: "pattern_room:orders:complete" });
      return orderId;
    });
  }

  async complete(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(PatternRoundActionSchema, input), action = "pattern_room.order.work_completed";
    return this.mutate(actor, "pattern_room:orders:complete", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "in_progress");
      const segment = (await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 AND ended_at IS NULL FOR UPDATE", [round.round_id])).rows[0];
      if (!segment || (!isPatternRoot(effective) && segment.worker_user_id !== effective.actorId)) throw new ApplicationError("FORBIDDEN", "只有当前执行工人可以报完工", 403);
      await client.query("UPDATE pattern_room_segments SET ended_at=CURRENT_TIMESTAMP,worker_completed_at=CURRENT_TIMESTAMP WHERE segment_id=$1", [segment.segment_id]);
      await client.query("UPDATE pattern_room_rounds SET status='pending_confirmation',completed_at=CURRENT_TIMESTAMP WHERE round_id=$1", [round.round_id]);
      await client.query("UPDATE pattern_room_orders SET status='pending_confirmation',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.moveNode(client, round.round_id, "pending_confirmation");
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId: segment.segment_id, awaitingDesignerHandoff: true });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, `execution:${segment.segment_id}`), "工人已完工");
      if (this.enabled) {
        await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, "handoff"), recipientUserId: order.created_by, requiredRole: "sample_designer", requiredCapability: "pattern_room:orders:handoff" });
        const recipient = await this.supervisor(client, round.supervisor_user_id ?? round.assigned_by ?? effective.actorId);
        await this.todos.information(client, effective, { category: "pattern_room_completion_notice", sourceEventId: eventId, sourceAction: action, entityType: "pattern_room_order", entityId: orderId,
          recipientUserId: recipient, route: { routeName: "pattern_room_order", entityId: orderId, roundId: round.round_id }, dedupeKey: patternTodoKey(orderId, round.round_id, `completion-notice:${recipient}`) });
      }
      return orderId;
    });
  }

  async handoff(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(PatternRoundActionSchema, input), action = "pattern_room.order.handed_over";
    return this.mutate(actor, "pattern_room:orders:handoff", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "pending_confirmation");
      if (!isPatternRoot(effective) && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有原设计师可以确认收到样板", 403);
      const amounts = (await client.query<{ balanced: boolean; segment_count: number; unfinished: number }>(
        "SELECT COALESCE(sum(amount),0)=$2::numeric balanced,count(*)::int segment_count,count(*) FILTER(WHERE ended_at IS NULL)::int unfinished FROM pattern_room_segments WHERE round_id=$1",
        [round.round_id, round.agreed_amount])).rows[0]!;
      if (amounts.segment_count === 0 || amounts.unfinished > 0 || !amounts.balanced) throw new ApplicationError("CONFLICT", "执行归属或金额未确定，不能确认交接", 409);
      await client.query("UPDATE pattern_room_rounds SET status='completed',handed_over_at=CURRENT_TIMESTAMP,handed_over_by=$2 WHERE round_id=$1", [round.round_id, effective.actorId]);
      await client.query("UPDATE pattern_room_segments SET wage_eligible_at=CURRENT_TIMESTAMP WHERE round_id=$1 AND ended_at IS NOT NULL AND amount>0 AND wage_eligible_at IS NULL", [round.round_id]);
      await client.query("UPDATE pattern_room_orders SET status='completed',completed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.moveNode(client, round.round_id);
      await this.event(client, effective, action, orderId, round.round_id, { confirmedReceived: true });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "handoff"), "设计师确认收到样板");
      return orderId;
    });
  }

  async updateMaterials(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(UpdatePatternMaterialsSchema, input), action = "pattern_room.order.materials_changed";
    return this.mutate(actor, "pattern_room:orders:edit", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["pending_assignment", "in_progress"]);
      if (!isPatternRoot(effective) && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有发起人可以修正制作资料", 403);
      await bindPatternMaterials(client, effective, orderId, round.round_id, parsed.attachmentIds, parsed.reason);
      await client.query(`UPDATE pattern_room_orders SET style_no=$2,required_date=$3,customer=$4,size_color=$5,reference_style_no=$6,variant=$7,note=$8,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1`,
        [orderId, parsed.styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note]);
      const eventId = await this.event(client, effective, action, orderId, round.round_id, parsed, order, parsed.reason);
      if (this.enabled && order.status === "in_progress") {
        const worker = (await client.query<{ worker_user_id: string }>("SELECT worker_user_id FROM pattern_room_segments WHERE round_id=$1 AND ended_at IS NULL", [round.round_id])).rows[0];
        const supervisor = await this.supervisor(client, round.supervisor_user_id ?? round.assigned_by ?? effective.actorId);
        for (const recipient of new Set([supervisor, ...(worker ? [worker.worker_user_id] : [])])) await this.todos.information(client, effective, {
          category: "pattern_room_material_notice", sourceEventId: eventId, sourceAction: action, entityType: "pattern_room_order", entityId: orderId, recipientUserId: recipient,
          route: { routeName: "pattern_room_order", entityId: orderId, roundId: round.round_id }, dedupeKey: patternTodoKey(orderId, round.round_id, `materials:${eventId}:${recipient}`) });
      }
      return orderId;
    });
  }
}
