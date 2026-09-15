import { createHash, randomUUID } from "node:crypto";
import { DeletePatternOrderSchema, AssignPatternOrderSchema, CancelPatternOrderSchema, CreatePatternOrderSchema, CreateMiscOrderSchema, PATTERN_ROOM_ORDERS_ENABLED, PatternRoundActionSchema, RecordPatternHoursSchema, RequestPatternReworkSchema, TransferPatternOrderSchema, UpdateMiscMaterialsSchema, UpdatePatternMaterialsSchema, type PatternOrderCapability, type PatternOrderQuery, type PatternRoundAction } from "@dx-rework/contracts/pattern-orders";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { authorizePatternOrder, isPatternRoot } from "./order-authority.js";
import { bindPatternMaterials } from "./order-attachments.js";
import { PatternOrderReader, scopedPatternOrder, type PatternOrderRow, type PatternRoundRow, type PatternSegmentRow } from "./order-reader.js";
import { PATTERN_HOURLY_PRICE_ID } from "./price-service.js";

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
  uploadActor(actor: TrustedActorContext, kind: "pattern" | "misc" = "pattern", purpose: "create" | "rework" = "create") { return authorizePatternOrder(this.db, actor, purpose === "rework" ? "pattern_room:orders:rework" : kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create", this.enabled); }
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
        AND (todo_user_has_direct_role(person.app_user_id,'pattern_room_worker','pattern_room:orders:complete') OR ($2 AND person.app_user_id=$3))
        AND ($1='' OR strpos(upper(person.display_name),upper($1))>0) ORDER BY person.display_name,person.person_id LIMIT 30`, [search.trim(), isPatternRoot(effective), effective.actorId])).rows
      .map(person => ({ personId: person.person_id, userId: person.app_user_id, name: person.display_name }));
  }
  async deleteOrder(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(DeletePatternOrderSchema, input), action = "pattern_room.order.deleted";
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效操作标识，请重试", 400);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const effective = await authorizePatternOrder(client, actor, "pattern_room:orders:delete", this.enabled);
      if (!isPatternRoot(effective)) throw new ApplicationError("FORBIDDEN", "仅 Root 可以删除板房订单", 403);
      const outcome = await this.idempotency.execute(client, { scope: action, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify({ orderId, ...parsed })).digest("hex"), expiresAt: new Date("9999-12-31T00:00:00Z") }, async () => {
        const order = await scopedPatternOrder(client, effective, orderId, true);
        if (order.version !== parsed.version) throw new ApplicationError("CONFLICT", "订单已变化，请刷新后再删除", 409);
        const eventId = await this.event(client, effective, action, orderId, order.current_round_id,
          { deleted: true }, { version: order.version, status: order.status, orderNo: order.order_no, kind: order.kind }, "Root 删除订单");
        await client.query("UPDATE pattern_room_orders SET deleted_at=CURRENT_TIMESTAMP,deleted_by=$2,deletion_event_id=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId, effective.actorId, eventId]);
        await client.query("UPDATE pattern_room_node_times SET exited_at=CURRENT_TIMESTAMP,exit_reason='cancelled' WHERE exited_at IS NULL AND round_id IN (SELECT round_id FROM pattern_room_rounds WHERE order_id=$1)", [orderId]);
        await this.todos.cancelOpenByDedupePrefix(client, effective, `pattern-room:${orderId}:`, "订单已删除");
        return { statusCode: 200, response: { deleted: true as const } };
      });
      await client.query("COMMIT");
      return outcome.response;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
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
  private async moveNode(client: PoolClient, roundId: string, next?: string, reason: "completed" | "rework" | "cancelled" = "completed") {
    await client.query("UPDATE pattern_room_node_times SET exited_at=CURRENT_TIMESTAMP,exit_reason=$2 WHERE round_id=$1 AND exited_at IS NULL", [roundId, reason]);
    if (next) await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,$3)", [randomUUID(), roundId, next]);
  }
  private async supervisor(client: PoolClient, fallback: string): Promise<string> {
    // Before release only Root may act; never route its acceptance work to real staff.
    if (!this.enabled) return fallback;
    const result = await client.query<{ user_id: string }>(`SELECT assignment.user_id FROM user_role_assignments assignment WHERE assignment.role_code='pattern_room_supervisor'
      AND assignment.revoked_at IS NULL AND todo_user_has_direct_role(assignment.user_id,'pattern_room_supervisor','pattern_room:orders:assign') LIMIT 1`);
    return result.rows[0]?.user_id ?? fallback;
  }

  create(actor: TrustedActorContext, input: unknown, key: string) { return this.createOrder(actor, "pattern", input, key); }
  createMisc(actor: TrustedActorContext, input: unknown, key: string) { return this.createOrder(actor, "misc", input, key); }
  private async createOrder(actor: TrustedActorContext, kind: "pattern" | "misc", input: unknown, key: string) {
    const parsed = kind === "pattern" ? { ...parse(CreatePatternOrderSchema, input), taskName: null }
      : { ...parse(CreateMiscOrderSchema, input), categoryId: PATTERN_HOURLY_PRICE_ID, quantity: null, customer: null, sizeColor: null, referenceStyleNo: null, variant: null };
    const action = kind === "pattern" ? "pattern_room.order.submitted" : "pattern_room.misc.submitted";
    return this.mutate(actor, kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create", action, key, parsed, async (client, effective) => {
      const price = (await client.query<{ price_id: string; version: number; name: string; unit: string; amount: string | null }>(
        "SELECT price_id,version,name,unit,amount FROM pattern_room_prices WHERE price_id=$1 AND kind=$2 AND enabled FOR SHARE", [parsed.categoryId, kind === "pattern" ? "category" : "hourly"])).rows[0];
      if (!price) throw new ApplicationError("PRICE_CHANGED", "品类已停用或不存在，请重新选择品类", 409);
      if (price.amount === null) throw new ApplicationError("PRICE_NOT_CONFIGURED", "杂事小时价尚未配置，请由老板或Root配置后提交", 409);
      if (price.version !== parsed.priceVersion) throw new ApplicationError("PRICE_CHANGED", "执行价已调整，请核对最新价格后重新提交", 409);
      const creator = (await client.query<{ display_name: string }>("SELECT display_name FROM app_users WHERE id=$1", [effective.actorId])).rows[0]!;
      const orderId = randomUUID(), roundId = randomUUID();
      const creatorRole = kind === "misc" && !effective.actorRoles.includes("sample_designer") && effective.actorRoles.includes("order_merchandiser") ? "order_merchandiser" : "sample_designer";
      await client.query(`INSERT INTO pattern_room_orders(order_id,current_round_id,status,created_by,creator_name,style_no,required_date,customer,size_color,reference_style_no,variant,note,kind,task_name,creator_role)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [orderId, roundId, effective.actorId, creator.display_name, parsed.styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note, kind, parsed.taskName, creatorRole]);
      await client.query(`INSERT INTO pattern_room_rounds(round_id,order_id,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount,requested_by)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$7::numeric*$8::integer,$9)`, [roundId, orderId, price.price_id, price.version, price.name, price.unit, price.amount, parsed.quantity, effective.actorId]);
      await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,'pending_assignment')", [randomUUID(), roundId]);
      await bindPatternMaterials(client, effective, orderId, roundId, parsed.attachmentIds, "创建制作资料", kind === "pattern");
      const eventId = await this.event(client, effective, action, orderId, roundId, parsed);
      if (this.enabled) await this.todos.actionableForUniqueDirectRole(client, effective, { ...this.projection(orderId, roundId, eventId, action, "assignment"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:assign" });
      return orderId;
    });
  }

  async assign(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(AssignPatternOrderSchema, input), action = "pattern_room.order.assigned";
    return this.mutate(actor, "pattern_room:orders:assign", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "pending_assignment");
      if (round.round_type === "rework" && parsed.amount === undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确核定本轮返工金额，零元也须填写", 400);
      if (round.round_type === "initial" && parsed.amount !== undefined) throw new ApplicationError("VALIDATION_ERROR", "首次派工沿用本单执行价，无需另填金额", 400);
      const person = (await client.query<{ person_id: string; app_user_id: string; display_name: string }>(`SELECT person_id,app_user_id,display_name FROM business_people
        WHERE person_id=$1 AND active AND person_type='internal' AND app_user_id IS NOT NULL
          AND (todo_user_has_direct_role(app_user_id,'pattern_room_worker','pattern_room:orders:complete') OR ($2 AND app_user_id=$3)) FOR SHARE`, [parsed.personId, isPatternRoot(effective), effective.actorId])).rows[0];
      if (!person) throw new ApplicationError("VALIDATION_ERROR", "请选择有有效账号的板房工人", 400);
      const segmentId = randomUUID(), supervisorId = await this.supervisor(client, effective.actorId);
      await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount)
        VALUES($1,$2,1,$3,$4,$5,'internal',$6)`, [segmentId, round.round_id, person.person_id, person.app_user_id, person.display_name, parsed.amount ?? round.agreed_amount]);
      const index = round.round_type === "rework" ? order.rework_count + 1 : 0;
      await client.query("UPDATE pattern_room_rounds SET status='in_progress',assigned_at=CURRENT_TIMESTAMP,assigned_by=$2,supervisor_user_id=$3,round_index=$4,agreed_amount=COALESCE($5::numeric,agreed_amount) WHERE round_id=$1", [round.round_id, effective.actorId, supervisorId, index, parsed.amount ?? null]);
      await client.query("UPDATE pattern_room_orders SET status='in_progress',version=version+1,updated_at=CURRENT_TIMESTAMP,rework_count=GREATEST(rework_count,$2) WHERE order_id=$1", [orderId, index]);
      await this.moveNode(client, round.round_id, "in_progress");
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId, personId: person.person_id, workerUserId: person.app_user_id, roundIndex: index, agreedAmount: parsed.amount ?? round.agreed_amount });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "assignment"), "已分配工人");
      if (this.enabled) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, `execution:${segmentId}`), category: "pattern_room_execution",
        recipientUserId: person.app_user_id, requiredRole: "pattern_room_worker", requiredCapability: "pattern_room:orders:complete" });
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
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId: segment.segment_id, awaitingDesignerHandoff: order.kind === "pattern", awaitingCreatorConfirmation: order.kind === "misc" });
      if (order.kind === "misc") await this.qualifyMisc(client, round.round_id);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, `execution:${segment.segment_id}`), "工人已完工");
      if (this.enabled) {
        // Both creator roles may handle their own misc task. Resolve today's valid
        // authority without changing the original creator/role audit snapshot.
        const creatorRole = order.kind === "misc" ? (await client.query<{ role: string }>(
          `SELECT role FROM unnest(ARRAY['sample_designer','order_merchandiser']::text[]) WITH ORDINALITY AS candidate(role,priority)
           WHERE todo_user_has_direct_role($1,role,'pattern_room:misc:confirm') ORDER BY priority LIMIT 1`, [order.created_by])).rows[0]?.role ?? order.creator_role : order.creator_role;
        await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, order.kind === "pattern" ? "handoff" : "misc-confirm"),
          category: order.kind === "pattern" ? "pattern_room_handoff" : "pattern_room_misc_confirmation", recipientUserId: order.created_by, requiredRole: creatorRole,
          requiredCapability: order.kind === "pattern" ? "pattern_room:orders:handoff" : "pattern_room:misc:confirm" });
        if (order.kind === "misc" && round.actual_hours === null) await this.todos.actionableForUniqueDirectRole(client, effective, {
          ...this.projection(orderId, round.round_id, eventId, action, "hours"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:hours" });
        const recipient = await this.supervisor(client, round.supervisor_user_id ?? round.assigned_by ?? effective.actorId);
        await this.todos.information(client, effective, { category: "pattern_room_completion_notice", sourceEventId: eventId, sourceAction: action, entityType: "pattern_room_order", entityId: orderId,
          recipientUserId: recipient, route: { routeName: "pattern_room_order", entityId: orderId, roundId: round.round_id }, dedupeKey: patternTodoKey(orderId, round.round_id, `completion-notice:${recipient}`) });
      }
      return orderId;
    });
  }

  handoff(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.confirmOrder(actor, orderId, "pattern", input, key); }
  confirmMisc(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.confirmOrder(actor, orderId, "misc", input, key); }
  private async confirmOrder(actor: TrustedActorContext, orderId: string, kind: "pattern" | "misc", input: unknown, key: string) {
    const parsed = parse(PatternRoundActionSchema, input), action = kind === "pattern" ? "pattern_room.order.handed_over" : "pattern_room.misc.confirmed";
    return this.mutate(actor, kind === "pattern" ? "pattern_room:orders:handoff" : "pattern_room:misc:confirm", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "pending_confirmation");
      if (order.kind !== kind) throw new ApplicationError("INVALID_STATE_TRANSITION", "请使用本订单类型对应的确认操作", 409);
      if (!isPatternRoot(effective) && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有原发起人可以确认本单完成", 403);
      if (kind === "pattern") {
        const pending = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE order_id=$1 AND completed_at IS NOT NULL AND handed_over_at IS NULL AND cancelled_at IS NULL ORDER BY requested_at,round_id FOR UPDATE", [orderId])).rows;
        for (const historical of pending) {
          await this.requireBalanced(client, historical.round_id, historical.agreed_amount);
          await client.query("UPDATE pattern_room_rounds SET status='completed',handed_over_at=CURRENT_TIMESTAMP,handed_over_by=$2 WHERE round_id=$1", [historical.round_id, effective.actorId]);
          await this.qualifyPattern(client, historical.round_id);
        }
      } else await client.query("UPDATE pattern_room_rounds SET status='completed',handed_over_at=CURRENT_TIMESTAMP,handed_over_by=$2 WHERE round_id=$1", [round.round_id, effective.actorId]);
      await client.query("UPDATE pattern_room_orders SET status='completed',completed_at=CURRENT_TIMESTAMP,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.moveNode(client, round.round_id);
      await this.event(client, effective, action, orderId, round.round_id, { confirmedReceived: kind === "pattern", confirmedCompleted: kind === "misc" });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, kind === "pattern" ? "handoff" : "misc-confirm"), kind === "pattern" ? "设计师确认收到样板" : "发起人确认杂事完成");
      return orderId;
    });
  }

  updateMaterials(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.changeMaterials(actor, orderId, "pattern", input, key); }
  updateMiscMaterials(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.changeMaterials(actor, orderId, "misc", input, key); }
  private async changeMaterials(actor: TrustedActorContext, orderId: string, kind: "pattern" | "misc", input: unknown, key: string) {
    const parsed = kind === "pattern" ? { ...parse(UpdatePatternMaterialsSchema, input), taskName: null }
      : { ...parse(UpdateMiscMaterialsSchema, input), customer: null, sizeColor: null, referenceStyleNo: null, variant: null };
    const action = "pattern_room.order.materials_changed";
    return this.mutate(actor, kind === "pattern" ? "pattern_room:orders:edit" : "pattern_room:misc:edit", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["pending_assignment", "in_progress"]);
      if (order.kind !== kind) throw new ApplicationError("INVALID_STATE_TRANSITION", "订单类型不匹配，请刷新本单", 409);
      if (!isPatternRoot(effective) && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有发起人可以修正制作资料", 403);
      await bindPatternMaterials(client, effective, orderId, round.round_id, parsed.attachmentIds, parsed.reason, kind === "pattern");
      await client.query(`UPDATE pattern_room_orders SET style_no=$2,required_date=$3,customer=$4,size_color=$5,reference_style_no=$6,variant=$7,note=$8,task_name=$9,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1`,
        [orderId, parsed.styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note, parsed.taskName]);
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

  private async qualifyMisc(client: PoolClient, roundId: string): Promise<void> {
    await client.query(`UPDATE pattern_room_segments segment SET wage_eligible_at=CURRENT_TIMESTAMP FROM pattern_room_rounds round
      WHERE segment.round_id=round.round_id AND round.round_id=$1 AND round.unit='小时' AND (round.completed_at IS NOT NULL OR round.stopped_at IS NOT NULL) AND round.actual_hours IS NOT NULL
        AND segment.ended_at IS NOT NULL AND segment.amount>0 AND segment.wage_eligible_at IS NULL
        AND NOT EXISTS(SELECT 1 FROM pattern_room_segments other WHERE other.round_id=round.round_id AND (other.ended_at IS NULL OR other.amount IS NULL))
        AND (SELECT sum(allocated.amount) FROM pattern_room_segments allocated WHERE allocated.round_id=round.round_id)=round.agreed_amount`, [roundId]);
  }
  async recordHours(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(RecordPatternHoursSchema, input), action = "pattern_room.misc.hours_recorded";
    return this.mutate(actor, "pattern_room:orders:hours", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["in_progress", "pending_confirmation", "completed"]);
      if (order.kind !== "misc") throw new ApplicationError("INVALID_STATE_TRANSITION", "只有杂事订单填写实际工时", 409);
      if (round.completed_at !== null && round.actual_hours !== null) throw new ApplicationError("CONFLICT", "已完工且工时已确定，不能直接覆盖工资依据", 409);
      const segment = (await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 ORDER BY segment_index DESC LIMIT 1 FOR UPDATE", [round.round_id])).rows[0];
      if (!segment) throw new ApplicationError("CONFLICT", "本轮尚无执行人员", 409);
      await this.saveMiscHours(client, effective, round, segment, parsed.hours);
      await client.query("UPDATE pattern_room_orders SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.event(client, effective, action, orderId, round.round_id, { hours: parsed.hours, unitPrice: round.unit_price, personId: segment.person_id, segmentId: segment.segment_id }, { hours: segment.actual_hours });
      await this.qualifyMisc(client, round.round_id);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "hours"), "主管已填写实际工时");
      return orderId;
    });
  }

  private async requireBalanced(client: PoolClient, roundId: string, amount: string | null): Promise<void> {
    const basis = (await client.query<{ balanced: boolean; count: number; unfinished: number }>(
      "SELECT sum(amount)=$2::numeric balanced,count(*)::int count,count(*) FILTER(WHERE ended_at IS NULL OR amount IS NULL)::int unfinished FROM pattern_room_segments WHERE round_id=$1", [roundId, amount])).rows[0]!;
    if (!basis.count || basis.unfinished || !basis.balanced) throw new ApplicationError("CONFLICT", "执行归属或金额未确定，不能放行工资", 409);
  }
  private async qualifyPattern(client: PoolClient, roundId: string): Promise<void> {
    await client.query("UPDATE pattern_room_segments SET wage_eligible_at=CURRENT_TIMESTAMP WHERE round_id=$1 AND ended_at IS NOT NULL AND amount>0 AND wage_eligible_at IS NULL", [roundId]);
  }
  private async saveMiscHours(client: PoolClient, actor: TrustedActorContext, round: PatternRoundRow, segment: PatternSegmentRow, hours: string): Promise<void> {
    await client.query("UPDATE pattern_room_segments SET actual_hours=$2,amount=$2::numeric*$3::numeric WHERE segment_id=$1", [segment.segment_id, hours, round.unit_price]);
    const total = (await client.query<{ hours: string; amount: string; complete: boolean; in_range: boolean }>(
      "SELECT sum(actual_hours)::text hours,sum(amount)::text amount,bool_and(actual_hours IS NOT NULL AND amount IS NOT NULL) complete,sum(actual_hours)<=999999.9 in_range FROM pattern_room_segments WHERE round_id=$1", [round.round_id])).rows[0]!;
    if (!total.complete || !total.in_range) throw new ApplicationError("VALIDATION_ERROR", "各执行段工时须完整，合计不能超过999,999.9小时", 400);
    await client.query("UPDATE pattern_room_rounds SET actual_hours=$2,agreed_amount=$3,hours_confirmed_by=$4,hours_confirmed_at=CURRENT_TIMESTAMP WHERE round_id=$1", [round.round_id, total.hours, total.amount, actor.actorId]);
  }

  async requestRework(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(RequestPatternReworkSchema, input), action = "pattern_room.order.rework_requested";
    return this.mutate(actor, "pattern_room:orders:rework", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["pending_confirmation", "completed"]);
      if (order.kind !== "pattern" || round.completed_at === null) throw new ApplicationError("INVALID_STATE_TRANSITION", "打板当前轮次完工后才能发起原单返工", 409);
      if (!isPatternRoot(effective) && !effective.actorRoles.includes("pattern_room_supervisor") && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有原设计师或板房主管可发起返工", 403);
      const roundId = randomUUID();
      await client.query(`INSERT INTO pattern_room_rounds(round_id,order_id,round_type,round_index,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount,requested_by,request_reason,reason_category)
        VALUES($1,$2,'rework',NULL,'pending_assignment',$3,$4,'打板返工','轮',NULL,NULL,NULL,$5,$6,$7)`, [roundId, orderId, round.category_id, round.price_version, effective.actorId, parsed.reason, parsed.reasonCategory]);
      const inherited = (await client.query<{ attachment_id: string }>("SELECT attachment_id FROM pattern_room_attachment_bindings WHERE round_id=$1 AND active", [round.round_id])).rows.map(row => row.attachment_id);
      const retained = parsed.retainedAttachmentIds ?? inherited;
      if (retained.some(id => !inherited.includes(id))) throw new ApplicationError("VALIDATION_ERROR", "只能保留当前轮次的有效制作资料，请刷新后重试", 400);
      const materials = [...new Set([...retained, ...parsed.attachmentIds])];
      if (materials.length > 20) throw new ApplicationError("VALIDATION_ERROR", "本轮制作资料合计不能超过20份，请整理后提交", 400);
      await bindPatternMaterials(client, effective, orderId, roundId, materials, parsed.reason);
      await this.moveNode(client, round.round_id, undefined, "rework");
      await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,'pending_assignment')", [randomUUID(), roundId]);
      await client.query("UPDATE pattern_room_orders SET current_round_id=$2,status='pending_assignment',completed_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId, roundId]);
      const eventId = await this.event(client, effective, action, orderId, roundId, { previousRoundId: round.round_id, reasonCategory: parsed.reasonCategory, attachments: materials }, undefined, parsed.reason);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "handoff"), "已转入原单返工，等待当前轮次交接");
      if (this.enabled) await this.todos.actionableForUniqueDirectRole(client, effective, { ...this.projection(orderId, roundId, eventId, action, "assignment"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:assign" });
      return orderId;
    });
  }

  async transfer(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(TransferPatternOrderSchema, input), action = "pattern_room.order.worker_changed";
    return this.mutate(actor, "pattern_room:orders:transfer", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "in_progress");
      const segment = (await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 AND ended_at IS NULL FOR UPDATE", [round.round_id])).rows[0];
      if (!segment || segment.segment_id !== parsed.segmentId) throw new ApplicationError("CONFLICT", "当前执行人已变化，请刷新后重新操作", 409);
      const person = (await client.query<{ person_id: string; app_user_id: string; display_name: string }>(`SELECT person_id,app_user_id,display_name FROM business_people
        WHERE person_id=$1 AND active AND person_type='internal' AND app_user_id IS NOT NULL
          AND (todo_user_has_direct_role(app_user_id,'pattern_room_worker','pattern_room:orders:complete') OR ($2 AND app_user_id=$3)) FOR SHARE`, [parsed.personId, isPatternRoot(effective), effective.actorId])).rows[0];
      if (!person || person.app_user_id === segment.worker_user_id) throw new ApplicationError("VALIDATION_ERROR", "请选择另一名有有效账号的工人", 400);
      const segmentId = randomUUID();
      if (order.kind === "pattern") {
        if (parsed.amount === undefined || parsed.hours !== undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确原工人应得部分金额，无实际制作填0", 400);
        const allocation = (await client.query<{ valid: boolean; remaining: string }>("SELECT $1::numeric<=$2::numeric valid,($2::numeric-$1::numeric)::text remaining", [parsed.amount, segment.amount])).rows[0]!;
        if (!allocation.valid) throw new ApplicationError("VALIDATION_ERROR", "原工人部分金额不能超过当前段剩余金额", 400);
        await client.query("UPDATE pattern_room_segments SET amount=$2,ended_at=CURRENT_TIMESTAMP WHERE segment_id=$1", [segment.segment_id, parsed.amount]);
        await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount)
          VALUES($1,$2,$3,$4,$5,$6,'internal',$7)`, [segmentId, round.round_id, segment.segment_index + 1, person.person_id, person.app_user_id, person.display_name, allocation.remaining]);
      } else {
        if (parsed.hours === undefined || parsed.amount !== undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确原工人已做工时，无实际制作填0", 400);
        const total = (await client.query<{ valid: boolean }>("SELECT COALESCE(sum(actual_hours),0)+$3::numeric<=999999.9 valid FROM pattern_room_segments WHERE round_id=$1 AND segment_id<>$2", [round.round_id, segment.segment_id, parsed.hours])).rows[0]!.valid;
        if (!total) throw new ApplicationError("VALIDATION_ERROR", "各执行段累计工时不能超过999,999.9小时", 400);
        await client.query("UPDATE pattern_room_segments SET actual_hours=$2,amount=$2::numeric*$3::numeric,ended_at=CURRENT_TIMESTAMP WHERE segment_id=$1", [segment.segment_id, parsed.hours, round.unit_price]);
        await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount)
          VALUES($1,$2,$3,$4,$5,$6,'internal',NULL)`, [segmentId, round.round_id, segment.segment_index + 1, person.person_id, person.app_user_id, person.display_name]);
        await client.query("UPDATE pattern_room_rounds SET actual_hours=NULL,agreed_amount=NULL,hours_confirmed_by=NULL,hours_confirmed_at=NULL WHERE round_id=$1", [round.round_id]);
      }
      await client.query("UPDATE pattern_room_orders SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { previousSegmentId: segment.segment_id, segmentId, personId: person.person_id, amount: parsed.amount, hours: parsed.hours }, undefined, parsed.reason);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, `execution:${segment.segment_id}`), "主管已原单转交其他工人");
      if (this.enabled) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, `execution:${segmentId}`), category: "pattern_room_execution", recipientUserId: person.app_user_id, requiredRole: "pattern_room_worker", requiredCapability: "pattern_room:orders:complete" });
      return orderId;
    });
  }

  async cancel(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(CancelPatternOrderSchema, input), action = "pattern_room.order.cancelled";
    return this.mutate(actor, "pattern_room:orders:cancel", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["pending_assignment", "in_progress", "pending_confirmation"]);
      const pending = order.status === "pending_assignment";
      if (!isPatternRoot(effective) && (pending ? round.requested_by !== effective.actorId : !effective.actorRoles.includes("pattern_room_supervisor"))) throw new ApplicationError("FORBIDDEN", pending ? "未派工请求由本次发起人取消" : "派工后由板房主管确认停止工作与费用", 403);
      let segment: PatternSegmentRow | undefined;
      if (pending) {
        if (parsed.amount !== undefined || parsed.hours !== undefined || parsed.segmentId !== undefined) throw new ApplicationError("VALIDATION_ERROR", "未派工请求没有本轮执行费用", 400);
      } else {
        segment = (await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 ORDER BY segment_index DESC LIMIT 1 FOR UPDATE", [round.round_id])).rows[0];
        if (!segment || segment.segment_id !== parsed.segmentId) throw new ApplicationError("CONFLICT", "当前执行段已变化，请刷新后再取消", 409);
        if (order.kind === "pattern") {
          if (parsed.amount === undefined || parsed.hours !== undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确当前工人的取消部分金额，无费用填0", 400);
          const valid = (await client.query<{ valid: boolean }>("SELECT $1::numeric<=$2::numeric valid", [parsed.amount, segment.amount])).rows[0]!.valid;
          if (!valid || segment.wage_eligible_at !== null) throw new ApplicationError("CONFLICT", "取消费用不能超过本段余额或覆盖已计薪事实", 409);
          await client.query("UPDATE pattern_room_segments SET amount=$2,ended_at=COALESCE(ended_at,CURRENT_TIMESTAMP) WHERE segment_id=$1", [segment.segment_id, parsed.amount]);
        } else {
          const fixed = round.completed_at !== null && round.actual_hours !== null;
          if (parsed.amount !== undefined || (fixed ? parsed.hours !== undefined : parsed.hours === undefined)) throw new ApplicationError("VALIDATION_ERROR", fixed ? "已具备计薪条件的工时不能通过取消修改" : "请填写当前执行段实际停止时的工时，无实际工作填0", 400);
          await client.query("UPDATE pattern_room_segments SET ended_at=COALESCE(ended_at,CURRENT_TIMESTAMP) WHERE segment_id=$1", [segment.segment_id]);
        }
      }
      const amount = pending ? "0" : (await client.query<{ amount: string }>("SELECT COALESCE(sum(amount),0)::text amount FROM pattern_room_segments WHERE round_id=$1", [round.round_id])).rows[0]!.amount;
      await client.query(`UPDATE pattern_room_rounds SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,cancel_reason=$3,cancelled_amount=$4,
        stopped_at=CASE WHEN assigned_at IS NULL THEN NULL ELSE COALESCE(completed_at,CURRENT_TIMESTAMP) END WHERE round_id=$1`, [round.round_id, effective.actorId, parsed.reason, amount]);
      if (order.kind === "misc" && segment && parsed.hours !== undefined) {
        await this.saveMiscHours(client, effective, round, segment, parsed.hours);
        await client.query("UPDATE pattern_room_rounds SET cancelled_amount=agreed_amount WHERE round_id=$1", [round.round_id]);
      }
      // A cancelled undispatched rework request must not orphan earlier completed,
      // unhanded labor. Its fees still require the original designer's separate confirmation.
      if (order.kind === "pattern") await client.query(`UPDATE pattern_room_rounds SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,cancel_reason=$3,
        cancelled_amount=agreed_amount,stopped_at=completed_at WHERE order_id=$1 AND round_id<>$4 AND completed_at IS NOT NULL AND handed_over_at IS NULL AND cancelled_at IS NULL`, [orderId, effective.actorId, parsed.reason, round.round_id]);
      await client.query("UPDATE pattern_room_orders SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,cancel_reason=$3,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId, effective.actorId, parsed.reason]);
      await this.moveNode(client, round.round_id, undefined, "cancelled");
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { stoppedSegmentId: segment?.segment_id ?? null, amount: parsed.amount, hours: parsed.hours, workStopped: !pending }, undefined, parsed.reason);
      await this.todos.cancelOpenByDedupePrefix(client, effective, `pattern-room:${orderId}:`, "任务已取消，保留实际劳动与历史记录");
      if (order.kind === "misc" && !pending) await this.qualifyMisc(client, round.round_id);
      const hasFees = order.kind === "pattern" && (await client.query<{ pending: boolean }>("SELECT EXISTS(SELECT 1 FROM pattern_room_rounds WHERE order_id=$1 AND cancelled_amount>0 AND handed_over_at IS NULL AND fee_confirmed_at IS NULL) pending", [orderId])).rows[0]!.pending;
      if (this.enabled && hasFees) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, "cancel-fees"), category: "pattern_room_cancel_fees", recipientUserId: order.created_by, requiredRole: "sample_designer", requiredCapability: "pattern_room:orders:cancel_fees" });
      return orderId;
    });
  }

  async confirmCancelledFees(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(PatternRoundActionSchema, input), action = "pattern_room.order.cancel_fees_confirmed";
    return this.mutate(actor, "pattern_room:orders:cancel_fees", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "cancelled");
      if (order.kind !== "pattern" || (!isPatternRoot(effective) && order.created_by !== effective.actorId)) throw new ApplicationError("FORBIDDEN", "只有原设计师可以确认打板取消费用", 403);
      const fees = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE order_id=$1 AND cancelled_amount>0 AND fee_confirmed_at IS NULL AND handed_over_at IS NULL ORDER BY requested_at,round_id FOR UPDATE", [orderId])).rows;
      if (!fees.length) throw new ApplicationError("INVALID_STATE_TRANSITION", "本单没有待确认取消费用", 409);
      for (const item of fees) {
        await this.requireBalanced(client, item.round_id, item.cancelled_amount);
        await client.query("UPDATE pattern_room_rounds SET fee_confirmed_at=CURRENT_TIMESTAMP,fee_confirmed_by=$2 WHERE round_id=$1", [item.round_id, effective.actorId]);
        await this.qualifyPattern(client, item.round_id);
      }
      await client.query("UPDATE pattern_room_orders SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.event(client, effective, action, orderId, round.round_id, { confirmedRoundIds: fees.map(item => item.round_id), confirmedCancellationFees: true });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "cancel-fees"), "设计师已确认取消费用，订单保留已取消状态");
      return orderId;
    });
  }
}
