import {businessNow,assertAcceptanceAssignee} from '../acceptance-clock/business-time.js';
import type {PatternHistoryQuery} from '@dx-rework/contracts/pattern-orders';
import {developmentAutomaticRoundDocument} from '../production-platform/development-document-format.js';
import {developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import {syncLinkedExecutionTransfer,linkedAssignmentContext} from '../production-platform/development-execution-transfer.js';
import {listMiscAssociations,resolveMiscAssociation} from "./misc-associations.js";
import {DevelopmentRoundService} from "../production-platform/development-round-service.js";
import {DigitalProductionAccessPolicy} from "../production-platform/access-policy.js";
import {DigitalProductionTaskService} from "../production-platform/task-service.js";
import {DigitalDevelopmentService} from "../production-platform/development-service.js";
import type { PatternHistorySelection } from "./order-history.js";
import { createHash, randomUUID } from "node:crypto";
import { PATTERN_ORDER_STATUS_LABELS, DeletePatternOrderSchema, AssignPatternOrderSchema, CancelPatternOrderSchema, CreatePatternOrderSchema, CreateMiscOrderSchema, PATTERN_ROOM_ORDERS_ENABLED, PatternRoundActionSchema, RecordPatternHoursSchema, RequestPatternReworkSchema, TransferPatternOrderSchema, UpdateMiscMaterialsSchema, UpdateLinkedPatternMaterialsSchema, type PatternOrderCapability, type PatternOrderQuery, type PatternRoundAction } from "@dx-rework/contracts/pattern-orders";
import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ApplicationError } from "../platform/errors.js";
import { IdempotencyService, OperationEventRepository, type TrustedActorContext } from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { authorizePatternOrder, isPatternRoot } from "./order-authority.js";
import { bindPatternMaterials } from "./order-attachments.js";
import { PatternOrderReader, scopedPatternOrder, type PatternOrderRow, type PatternRoundRow, type PatternSegmentRow } from "./order-reader.js";
import { PATTERN_HOURLY_PRICE_ID } from "./price-service.js";
import { patternReworkCutBlocked, PATTERN_REWORK_CUT_BLOCK } from "./order-rework-boundary.js";

const parse = <T>(schema: z.ZodType<T>, input: unknown): T => {
  const value = schema.safeParse(input);
  if (!value.success) throw new ApplicationError("VALIDATION_ERROR", value.error.issues[0]?.message ?? "请检查必填资料", 400);
  return value.data;
};
export const patternTodoKey = (orderId: string, roundId: string, action: string) => `pattern-room:${orderId}:${roundId}:${action}`;
export class PatternRoomOrderService {
  private readonly enabled: boolean;
  private readonly reader: PatternOrderReader;
  constructor(private readonly db: Pool, private readonly todos: TodoProjectionService, private readonly options: { ordersEnabled?: boolean; transactionClient?: PoolClient } = {},
    private readonly idempotency = new IdempotencyService(), private readonly events = new OperationEventRepository()) {
    this.enabled = options.ordersEnabled ?? PATTERN_ROOM_ORDERS_ENABLED;
    this.reader = new PatternOrderReader(db, this.enabled, options.transactionClient);
  }
  list(actor: TrustedActorContext, query: PatternOrderQuery) { return this.reader.list(actor, query); }
  history(actor:TrustedActorContext,input:PatternHistoryQuery){return this.reader.history(actor,input);}
  related(actor:TrustedActorContext,input:{sourceId?:string|undefined;orderId?:string|undefined;page:number}) {return this.reader.related(actor,input);}
  peopleFilters(actor: TrustedActorContext) { return this.reader.peopleFilters(actor); }
  get(actor: TrustedActorContext, orderId: string, selection?: PatternHistorySelection) { return this.reader.get(actor, orderId, selection); }
  uploadActor(actor: TrustedActorContext, kind: "pattern" | "misc" = "pattern", purpose: "create" | "rework" = "create") { return authorizePatternOrder(this.db, actor, purpose === "rework" ? "pattern_room:orders:rework" : kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create", this.enabled); }
  downloadActor(actor: TrustedActorContext) { return authorizePatternOrder(this.db, actor, "pattern_room:orders:view", this.enabled); }
  async canDownload(actor: TrustedActorContext, binding: { entityType: string; entityId: string; attachmentId?:string }): Promise<boolean> {
    if (binding.entityType !== "pattern_room_attachment" && binding.entityType !== "digital_development") return false;
    const attachmentId=binding.entityType==='digital_development'?binding.attachmentId:binding.entityId;
    if(!attachmentId)return false;
    const reference = (await this.db.query<{ order_id: string }>("SELECT order_id FROM pattern_room_attachment_bindings WHERE attachment_id=$1 LIMIT 1", [attachmentId])).rows[0];
    if (!reference) return false;
    try { return (await this.get(actor, reference.order_id)).attachments.some(file => file.attachmentId === attachmentId); }
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
    work: (client: PoolClient, effective: TrustedActorContext) => Promise<string>, lockDigitalLifecycle = false) {
    if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new ApplicationError("VALIDATION_ERROR", "缺少有效操作标识，请重试", 400);
    const client = this.options.transactionClient ?? await this.db.connect(); let orderId: string;
    try {
      if (!this.options.transactionClient) await client.query("BEGIN");
      if (lockDigitalLifecycle) await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const effective = await authorizePatternOrder(client, actor, capability, this.enabled);
      const outcome = await this.idempotency.execute(client, { scope: action, actorKey: actor.actorId, key,
        requestHash: createHash("sha256").update(JSON.stringify(input)).digest("hex"), expiresAt: new Date("9999-12-31T00:00:00Z") }, async () => ({ statusCode: 200, response: { orderId: await work(client, effective) } }));
      orderId = outcome.response.orderId;
      if (!this.options.transactionClient) await client.query("COMMIT");
    } catch (error) { if (!this.options.transactionClient) await client.query("ROLLBACK"); throw error; }
    finally { if (!this.options.transactionClient) client.release(); }
    return this.get(actor, orderId);
  }
  private async target(client: PoolClient, actor: TrustedActorContext, orderId: string, input: PatternRoundAction, status: PatternOrderRow["status"] | readonly PatternOrderRow["status"][]) {
    const order = await scopedPatternOrder(client, actor, orderId, true);
    if (order.version !== input.version || order.current_round_id !== input.roundId) throw new ApplicationError("CONFLICT", "订单或轮次已变化，请刷新当前订单后再操作", 409);
    if (!(Array.isArray(status) ? status : [status]).includes(order.status)) throw new ApplicationError("INVALID_STATE_TRANSITION", `本轮当前为「${PATTERN_ORDER_STATUS_LABELS[order.status]}」，此操作仅适用于${(Array.isArray(status)?status:[status]).map(value=>`「${PATTERN_ORDER_STATUS_LABELS[value as PatternOrderRow["status"]]}」`).join("或")}。请返回本单当前办理页核对轮次及负责岗位，不要重复提交旧页面操作。`, 409);
    const round = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE round_id=$1 FOR UPDATE", [input.roundId])).rows[0]!;
    if (round.status !== order.status) throw new ApplicationError("CONFLICT", "订单与当前轮次的状态不一致，本次未提交；请重新读取本单，仍不一致时将订单链接交给管理员核查", 409);
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
    await client.query("UPDATE pattern_room_node_times SET exited_at=$3,exit_reason=$2 WHERE round_id=$1 AND exited_at IS NULL", [roundId, reason,businessNow().toISOString()]);
    if (next) await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage,entered_at) VALUES($1,$2,$3,$4)", [randomUUID(), roundId, next,businessNow().toISOString()]);
  }
  private async supervisor(client: PoolClient, fallback: string): Promise<string> {
    // Before release only Root may act; never route its acceptance work to real staff.
    if (!this.enabled) return fallback;
    const result = await client.query<{ user_id: string }>(`SELECT assignment.user_id FROM user_role_assignments assignment WHERE assignment.role_code='pattern_room_supervisor'
      AND assignment.revoked_at IS NULL AND todo_user_has_direct_role(assignment.user_id,'pattern_room_supervisor','pattern_room:orders:assign') LIMIT 1`);
    return result.rows[0]?.user_id ?? fallback;
  }

  // Fixed adapters reuse the original authorization, pricing and wage logic atomically.
  inTransaction(client: PoolClient) { return new PatternRoomOrderService(this.db,this.todos,{...this.options,transactionClient:client},this.idempotency,this.events); }
  async createDevelopment(actor: TrustedActorContext, sourceId:string, categoryId:string, priceVersion:number, key:string) {
    const client=this.options.transactionClient;
    if(!client) throw new ApplicationError("CONFLICT","开发打板衔接须在业务事务内执行",409);
    await client.query("SELECT source_id FROM digital_production_sources WHERE source_id=$1 FOR UPDATE",[sourceId]);
    const sheet=await new DigitalDevelopmentService(this.db,true).read(actor,sourceId,client);
    if(sheet.status!=="published"||!sheet.canEdit) throw new ApplicationError("FORBIDDEN","仅原设计师可提交本开发单的打板执行",403);
    const prior=(await client.query("SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1",[sourceId])).rows[0];
    if(prior)return this.get(actor,prior.order_id);
    const doc=sheet.document!;
    return this.createOrder(actor,"pattern",{categoryId,priceVersion,styleNo:sheet.designStyleNo??sheet.temporaryStyleNo,quantity:doc.quantity,attachmentIds:doc.files.map(file=>file.attachmentId),requiredDate:doc.returnDate,customer:sheet.customerCode,sizeColor:developmentMakingSizes(doc),referenceStyleNo:null,variant:"初版",note:doc.instructions||null},key,sourceId);
  }
  async create(actor: TrustedActorContext, _input: unknown, _key: string) {
    void _input;void _key;
    await authorizePatternOrder(this.db,actor,"pattern_room:orders:create",this.enabled);
    throw new ApplicationError("FORBIDDEN","已停止无来源独立打板新建；请从开发单发布生成打板执行单",403);
  }
  async miscAssociations(actor:TrustedActorContext,search:string){
    const client=await this.db.connect();try{
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const effective=await authorizePatternOrder(client,actor,"pattern_room:misc:create",this.enabled);
      const result=await listMiscAssociations(client,effective,search);await client.query("COMMIT");return result;
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  createMisc(actor: TrustedActorContext, input: unknown, key: string) { return this.createOrder(actor, "misc", input, key); }
  private async createOrder(actor: TrustedActorContext, kind: "pattern" | "misc", input: unknown, key: string, developmentSourceId?:string) {
    // Only the private, already-authorized development adapter carries up to 20 full size names.
    // The public legacy free-text editor retains its original 200-character limit.
    const parsed = kind === "pattern" ? { ...parse(developmentSourceId?CreatePatternOrderSchema.extend({sizeColor:z.string().max(2400).nullable()}):CreatePatternOrderSchema, input), taskName: null }
      : { ...parse(CreateMiscOrderSchema, input), categoryId: PATTERN_HOURLY_PRICE_ID, quantity: null, customer: null, sizeColor: null, referenceStyleNo: null, variant: null };
    const action = kind === "pattern" ? "pattern_room.order.submitted" : "pattern_room.misc.submitted";
    return this.mutate(actor, kind === "pattern" ? "pattern_room:orders:create" : "pattern_room:misc:create", action, key, developmentSourceId?{parsed,developmentSourceId}:parsed, async (client, effective) => {
      const association=kind==="misc"?await resolveMiscAssociation(client,effective,parsed):null;
      const styleNo=association?.styleNo??parsed.styleNo;
      const price = (await client.query<{ price_id: string; version: number; name: string; unit: string; amount: string | null }>(
        "SELECT price_id,version,name,unit,amount FROM pattern_room_prices WHERE price_id=$1 AND kind=$2 AND enabled FOR SHARE", [parsed.categoryId, kind === "pattern" ? "category" : "hourly"])).rows[0];
      if (!price) throw new ApplicationError("PRICE_CHANGED", "品类已停用或不存在，请重新选择品类", 409);
      if (price.amount === null) throw new ApplicationError("PRICE_NOT_CONFIGURED", "杂事小时价尚未配置，请由老板或Root配置后提交", 409);
      if (price.version !== parsed.priceVersion) throw new ApplicationError("PRICE_CHANGED", "执行价已调整，请核对最新价格后重新提交", 409);
      const creatorId=developmentSourceId?(await client.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[developmentSourceId])).rows[0].created_by:effective.actorId;
      const creator = (await client.query<{ display_name: string }>("SELECT display_name FROM app_users WHERE id=$1", [creatorId])).rows[0]!;
      const orderId = randomUUID(), roundId = randomUUID();
      const creatorRole = kind === "misc" && !effective.actorRoles.includes("sample_designer") && effective.actorRoles.includes("order_merchandiser") ? "order_merchandiser" : "sample_designer";
      await client.query(`INSERT INTO pattern_room_orders(order_id,current_round_id,status,created_by,creator_name,style_no,required_date,customer,size_color,reference_style_no,variant,note,kind,task_name,creator_role)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`, [orderId, roundId, creatorId, creator.display_name, styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note, kind, parsed.taskName, creatorRole]);
      if(association)await client.query("UPDATE pattern_room_orders SET misc_association=$2 WHERE order_id=$1",[orderId,JSON.stringify(association)]);
      await client.query(`INSERT INTO pattern_room_rounds(round_id,order_id,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount,requested_by)
        VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,$8,$7::numeric*$8::integer,$9)`, [roundId, orderId, price.price_id, price.version, price.name, price.unit, price.amount, parsed.quantity, effective.actorId]);
      await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage,entered_at) VALUES($1,$2,'pending_assignment',$3)", [randomUUID(), roundId,businessNow().toISOString()]);
      if(developmentSourceId)await client.query("INSERT INTO digital_development_pattern_links(source_id,order_id,linked_by) VALUES($1,$2,$3)",[developmentSourceId,orderId,effective.actorId]);
      await bindPatternMaterials(client, effective, orderId, roundId, parsed.attachmentIds, "创建制作资料", kind === "pattern");
      const eventId = await this.event(client, effective, action, orderId, roundId, {...parsed,styleNo,...(kind==="misc"?{association}: {})});
      if (this.enabled) await this.todos.actionableForUniqueDirectRole(client, effective, { ...this.projection(orderId, roundId, eventId, action, "assignment"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:assign" });
      return orderId;
    });
  }

  async assign(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(AssignPatternOrderSchema, input), action = "pattern_room.order.assigned";
    return this.mutate(actor, "pattern_room:orders:assign", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "pending_assignment");
      if(round.round_type==="initial"&&!isPatternRoot(effective)&&(await client.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation&&
        (await client.query("SELECT 1 FROM digital_development_pattern_links WHERE order_id=$1",[orderId])).rowCount)
        throw new ApplicationError("DEVELOPMENT_ARRANGEMENT_REQUIRED","本单首次车板由总委派安排后按真实前置自动衔接，请从我的待办打开本单总委派。",409);
      if (round.round_type === "rework" && parsed.amount === undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确核定本轮返工金额，零元也须填写", 400);
      if (round.round_type === "initial" && parsed.amount !== undefined) throw new ApplicationError("VALIDATION_ERROR", "首次派工沿用本单执行价，无需另填金额", 400);
      const person = (await client.query<{ person_id: string; app_user_id: string; display_name: string }>(`SELECT person_id,app_user_id,display_name FROM business_people
        WHERE person_id=$1 AND active AND person_type='internal' AND app_user_id IS NOT NULL
          AND (todo_user_has_direct_role(app_user_id,'pattern_room_worker','pattern_room:orders:complete') OR ($2 AND app_user_id=$3)) FOR SHARE`, [parsed.personId, isPatternRoot(effective), effective.actorId])).rows[0];
      if (!person) throw new ApplicationError("VALIDATION_ERROR", "请选择有有效账号的板房工人", 400);
      await assertAcceptanceAssignee(person.app_user_id);
      const linkedAssignment=round.round_type==='rework'?await linkedAssignmentContext(client,effective,orderId,person.app_user_id,isPatternRoot(effective)):null;
      const segmentId = randomUUID(), supervisorId = await this.supervisor(client, effective.actorId);
      await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount,started_at)
        VALUES($1,$2,1,$3,$4,$5,'internal',$6,$7)`, [segmentId, round.round_id, person.person_id, person.app_user_id, person.display_name, parsed.amount ?? round.agreed_amount,businessNow().toISOString()]);
      const index = round.round_type === "rework" ? order.rework_count + 1 : 0;
      await client.query("UPDATE pattern_room_rounds SET status='in_progress',assigned_at=$6,assigned_by=$2,supervisor_user_id=$3,round_index=$4,agreed_amount=COALESCE($5::numeric,agreed_amount) WHERE round_id=$1", [round.round_id, effective.actorId, supervisorId, index, parsed.amount ?? null,businessNow().toISOString()]);
      await client.query("UPDATE pattern_room_orders SET status='in_progress',version=version+1,updated_at=CURRENT_TIMESTAMP,rework_count=GREATEST(rework_count,$2) WHERE order_id=$1", [orderId, index]);
      await this.moveNode(client, round.round_id, "in_progress");
      const integratedAssignment=linkedAssignment?linkedAssignment.workerId===person.app_user_id?linkedAssignment.plan.readyToArrange:await syncLinkedExecutionTransfer(client,this.db,effective,orderId,linkedAssignment.workerId??person.app_user_id,person.app_user_id,'主管核定本轮返工执行归属','assign'):false;
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId, personId: person.person_id, workerUserId: person.app_user_id, roundIndex: index, agreedAmount: parsed.amount ?? round.agreed_amount });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "assignment"), "已分配工人");
      if (this.enabled&&!integratedAssignment) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, `execution:${segmentId}`), category: "pattern_room_execution",
        recipientUserId: person.app_user_id, requiredRole: "pattern_room_worker", requiredCapability: "pattern_room:orders:complete" });
      if((await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation){
        const waiting=(await client.query(`SELECT t.task_id FROM digital_development_pattern_links l
          JOIN digital_production_task_access a ON a.source_id=l.source_id
          JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_conditions c USING(task_id)
          WHERE l.order_id=$1 AND a.task_kind='development_sewing' AND t.state IN ('pending','blocked')
            AND c.condition_key='pattern_assignment_ready' AND NOT c.satisfied
            AND t.route_version=(SELECT max(route_version) FROM digital_production_tasks p JOIN digital_production_task_access pa USING(task_id) WHERE pa.source_id=l.source_id)
          ORDER BY t.task_id`,[orderId])).rows;
        const tasks=new DigitalProductionTaskService(this.db);
        for(const task of waiting)await tasks.setConditionWithClient(client,effective,task.task_id,'pattern_assignment_ready',true,undefined,'主管确认原打板执行归属');
      }
      return orderId;
    },true);
  }

  async complete(actor: TrustedActorContext, orderId: string, input: unknown, key: string) {
    const parsed = parse(PatternRoundActionSchema, input), action = "pattern_room.order.work_completed";
    return this.mutate(actor, "pattern_room:orders:complete", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, "in_progress");
      const segment = (await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 AND ended_at IS NULL FOR UPDATE", [round.round_id])).rows[0];
      if (!segment || (!isPatternRoot(effective) && segment.worker_user_id !== effective.actorId)) throw new ApplicationError("FORBIDDEN", "只有当前执行工人可以报完工", 403);
      await this.recordWorkCompletion(client,effective,order,round,segment);
      return orderId;
    });
  }


  // Completion facts may come from the assigned development task without moving wage ownership.
  async completeDevelopment(actor: TrustedActorContext, sourceId: string, taskId: string, orderId: string, input: unknown) {
    const client=this.options.transactionClient;
    if(!client) throw new ApplicationError("CONFLICT","开发车板完工须在业务事务内执行",409);
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
    await new DigitalProductionAccessPolicy(client).assert(actor,"task",taskId,"execute");
    const effective=await authorizePatternOrder(client,actor,"pattern_room:orders:complete",this.enabled);
    const linked=(await client.query(`SELECT 1 FROM digital_production_tasks t
      JOIN digital_production_task_access a USING(task_id)
      JOIN digital_development_pattern_links l ON l.source_id=a.source_id
      JOIN digital_development_route_facts f ON f.task_id=t.task_id AND f.source_id=a.source_id AND f.route_version=t.route_version
      WHERE t.task_id=$1 AND a.source_id=$2 AND l.order_id=$3 AND a.task_kind='development_sewing'
        AND t.state='ready' AND f.kind='车板完成' AND f.actor_id=$4`,[taskId,sourceId,orderId,effective.actorId])).rowCount;
    if(!linked) throw new ApplicationError("FORBIDDEN","仅本开发单当前车板任务的有效完工可衔接原打板",403);
    const parsed=parse(PatternRoundActionSchema,input);
    const order=(await client.query<PatternOrderRow>("SELECT * FROM pattern_room_orders WHERE order_id=$1 AND deleted_at IS NULL FOR UPDATE",[orderId])).rows[0];
    if(!order||order.kind!=="pattern"||order.version!==parsed.version||order.current_round_id!==parsed.roundId||order.status!=="in_progress")
      throw new ApplicationError("CONFLICT","原打板订单或轮次已变化，请刷新",409);
    const round=(await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE round_id=$1 AND order_id=$2 FOR UPDATE",[parsed.roundId,orderId])).rows[0];
    const segment=(await client.query<PatternSegmentRow>("SELECT * FROM pattern_room_segments WHERE round_id=$1 AND ended_at IS NULL FOR UPDATE",[parsed.roundId])).rows[0];
    if(!round||round.status!=="in_progress"||!segment) throw new ApplicationError("CONFLICT","原打板执行段尚不可完工",409);
    await this.recordWorkCompletion(client,effective,order,round,segment,taskId);
    return {orderId};
  }
  private async recordWorkCompletion(client: PoolClient, effective: TrustedActorContext, order: PatternOrderRow, round: PatternRoundRow, segment: PatternSegmentRow, developmentTaskId?: string) {
    const orderId=order.order_id,action="pattern_room.order.work_completed";
      const linked=order.kind==='pattern'&&Boolean((await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation)&&Boolean((await client.query("SELECT 1 FROM digital_development_pattern_links WHERE order_id=$1",[orderId])).rowCount);
      await client.query("UPDATE pattern_room_segments SET ended_at=$2,worker_completed_at=$2 WHERE segment_id=$1", [segment.segment_id,businessNow().toISOString()]);
      await client.query("UPDATE pattern_room_rounds SET status='pending_confirmation',completed_at=$2 WHERE round_id=$1", [round.round_id,businessNow().toISOString()]);
      await client.query("UPDATE pattern_room_orders SET status='pending_confirmation',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      await this.moveNode(client, round.round_id, "pending_confirmation");
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { segmentId: segment.segment_id, awaitingDesignerHandoff: order.kind === "pattern"&&!linked, awaitingDigitalFinalConfirmation:linked, awaitingCreatorConfirmation: order.kind === "misc", ...(developmentTaskId ? {developmentTaskId,executorUserId:effective.actorId,wageWorkerUserId:segment.worker_user_id} : {}) });
      if (order.kind === "misc") await this.qualifyMisc(client, round.round_id);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, `execution:${segment.segment_id}`), "工人已完工");
      if (this.enabled) {
        // Both creator roles may handle their own misc task. Resolve today's valid
        // authority without changing the original creator/role audit snapshot.
        const creatorRole = order.kind === "misc" ? (await client.query<{ role: string }>(
          `SELECT role FROM unnest(ARRAY['sample_designer','order_merchandiser']::text[]) WITH ORDINALITY AS candidate(role,priority)
           WHERE todo_user_has_direct_role($1,role,'pattern_room:misc:confirm') ORDER BY priority LIMIT 1`, [order.created_by])).rows[0]?.role ?? order.creator_role : order.creator_role;
        if(!linked)await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, order.kind === "pattern" ? "handoff" : "misc-confirm"),
          category: order.kind === "pattern" ? "pattern_room_handoff" : "pattern_room_misc_confirmation", recipientUserId: order.created_by, requiredRole: creatorRole,
          requiredCapability: order.kind === "pattern" ? "pattern_room:orders:handoff" : "pattern_room:misc:confirm" });
        if (order.kind === "misc" && round.actual_hours === null) await this.todos.actionableForUniqueDirectRole(client, effective, {
          ...this.projection(orderId, round.round_id, eventId, action, "hours"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:hours" });
        const recipient = await this.supervisor(client, round.supervisor_user_id ?? round.assigned_by ?? effective.actorId);
        await this.todos.information(client, effective, { category: "pattern_room_completion_notice", sourceEventId: eventId, sourceAction: action, entityType: "pattern_room_order", entityId: orderId,
          recipientUserId: recipient, route: { routeName: "pattern_room_order", entityId: orderId, roundId: round.round_id }, dedupeKey: patternTodoKey(orderId, round.round_id, `completion-notice:${recipient}`) });
      }
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
        if((await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation){
          const linked=(await client.query("SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1",[orderId])).rows[0];
          if(linked&&!(await client.query(`SELECT 1 FROM digital_development_route_facts f
            WHERE f.source_id=$1 AND f.kind='最终设计确认' AND f.payload->>'nativeRoundId'=$2::text
              AND f.route_version=COALESCE((SELECT max(t.route_version) FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1),1)`,[linked.source_id,round.round_id])).rowCount)throw new ApplicationError("CONFLICT","请在开发单当前轮次尾查通过后完成本打板轮次的最终设计确认",409);
        }
        const pending = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE order_id=$1 AND completed_at IS NOT NULL AND handed_over_at IS NULL AND cancelled_at IS NULL ORDER BY requested_at,round_id FOR UPDATE", [orderId])).rows;
        for (const historical of pending) {
          await this.requireBalanced(client, historical.round_id, historical.agreed_amount);
          await client.query("UPDATE pattern_room_rounds SET status='completed',handed_over_at=$3,handed_over_by=$2 WHERE round_id=$1", [historical.round_id, effective.actorId,businessNow().toISOString()]);
          await this.qualifyPattern(client, historical.round_id);
        }
      } else await client.query("UPDATE pattern_room_rounds SET status='completed',handed_over_at=$3,handed_over_by=$2 WHERE round_id=$1", [round.round_id, effective.actorId,businessNow().toISOString()]);
      await client.query("UPDATE pattern_room_orders SET status='completed',completed_at=$2,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId,businessNow().toISOString()]);
      await this.moveNode(client, round.round_id);
      await this.event(client, effective, action, orderId, round.round_id, { confirmedReceived: kind === "pattern", confirmedCompleted: kind === "misc" });
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, kind === "pattern" ? "handoff" : "misc-confirm"), kind === "pattern" ? "设计师确认收到样板" : "发起人确认杂事完成");
      return orderId;
    });
  }

  updateMaterials(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.changeMaterials(actor, orderId, "pattern", input, key); }
  updateMiscMaterials(actor: TrustedActorContext, orderId: string, input: unknown, key: string) { return this.changeMaterials(actor, orderId, "misc", input, key); }
  private async changeMaterials(actor: TrustedActorContext, orderId: string, kind: "pattern" | "misc", input: unknown, key: string) {
    const parsed = kind === "pattern" ? { ...parse(UpdateLinkedPatternMaterialsSchema, input), taskName: null }
      : { ...parse(UpdateMiscMaterialsSchema, input), customer: null, sizeColor: null, referenceStyleNo: null, variant: null };
    const action = "pattern_room.order.materials_changed";
    return this.mutate(actor, kind === "pattern" ? "pattern_room:orders:edit" : "pattern_room:misc:edit", action, key, { orderId, ...parsed }, async (client, effective) => {
      const { order, round } = await this.target(client, effective, orderId, parsed, ["pending_assignment", "in_progress"]);
      if (order.kind !== kind) throw new ApplicationError("INVALID_STATE_TRANSITION", "订单类型不匹配，请刷新本单", 409);
      if (!isPatternRoot(effective) && order.created_by !== effective.actorId) throw new ApplicationError("FORBIDDEN", "只有发起人可以修正制作资料", 403);
      if(kind==='pattern'&&((parsed.sizeColor?.length??0)>200||(order.size_color?.length??0)>200)){
        const linked=(await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation&&(await client.query('SELECT 1 FROM digital_development_pattern_links WHERE order_id=$1',[orderId])).rowCount;
        if(!linked||parsed.sizeColor!==order.size_color)throw new ApplicationError('VALIDATION_ERROR','长制作摘要由开发尺寸表生成，本次资料更新须保留原摘要；独立自由文本仍限200字',400);
      }
      const association=kind==="misc"?await resolveMiscAssociation(client,effective,parsed,order):null;
      const styleNo=association?.styleNo??parsed.styleNo;
      await bindPatternMaterials(client, effective, orderId, round.round_id, parsed.attachmentIds, parsed.reason, kind === "pattern");
      await client.query(`UPDATE pattern_room_orders SET style_no=$2,required_date=$3,customer=$4,size_color=$5,reference_style_no=$6,variant=$7,note=$8,task_name=$9,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1`,
        [orderId, styleNo, parsed.requiredDate, parsed.customer, parsed.sizeColor, parsed.referenceStyleNo, parsed.variant, parsed.note, parsed.taskName]);
      if(kind==="misc")await client.query("UPDATE pattern_room_orders SET misc_association=$2 WHERE order_id=$1",[orderId,association?JSON.stringify(association):null]);
      const eventId = await this.event(client, effective, action, orderId, round.round_id, {...parsed,styleNo,...(kind==="misc"?{association}: {})}, order, parsed.reason);
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
      if (await patternReworkCutBlocked(client, orderId)) throw new ApplicationError("CONFLICT", PATTERN_REWORK_CUT_BLOCK, 409);
      const linked=(await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation?(await client.query("SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1",[orderId])).rows[0]:null;
      if(linked&&(!parsed.developmentNodes||!parsed.developmentProblems))throw new ApplicationError("VALIDATION_ERROR","请明确本轮受影响工序与问题分类，同步数字开发复版",400);
      if(!linked&&(parsed.developmentNodes||parsed.developmentProblems||parsed.developmentMaking))throw new ApplicationError("VALIDATION_ERROR","独立原打板单不使用数字开发复版参数",400);
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
      await client.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage,entered_at) VALUES($1,$2,'pending_assignment',$3)", [randomUUID(), roundId,businessNow().toISOString()]);
      await client.query("UPDATE pattern_room_orders SET current_round_id=$2,status='pending_assignment',completed_at=NULL,version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId, roundId]);
      if(linked){
        const sheet=await new DigitalDevelopmentService(this.db,true).read(effective,linked.source_id,client);
        await new DevelopmentRoundService(this.db,true).publishWithClient(client,effective,linked.source_id,{
          basedOnRound:sheet.roundNumber??1,document:developmentAutomaticRoundDocument(sheet.document!,sheet.version,parsed.developmentMaking),origin:parsed.reasonCategory==='customer_change'?'客户新增要求':parsed.reasonCategory==='workmanship'?'未达原要求':'内部发现',
          customerComment:parsed.reasonCategory==='other'?'':parsed.reason,internalProblem:parsed.reasonCategory==='other'?parsed.reason:'',explanation:parsed.reason,
          affectedNodes:parsed.developmentNodes!,categories:parsed.developmentProblems!,outputKind:'整件样板'
        },undefined,roundId);
      }
      const eventId = await this.event(client, effective, action, orderId, roundId, { previousRoundId: round.round_id, reasonCategory: parsed.reasonCategory, attachments: materials }, undefined, parsed.reason);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, "handoff"), "已转入原单返工，等待当前轮次交接");
      if (this.enabled) await this.todos.actionableForUniqueDirectRole(client, effective, { ...this.projection(orderId, roundId, eventId, action, "assignment"), requiredRole: "pattern_room_supervisor", requiredCapability: "pattern_room:orders:assign" });
      return orderId;
    }, true);
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
      await assertAcceptanceAssignee(person.app_user_id);
      const segmentId = randomUUID();
      if (order.kind === "pattern") {
        if (parsed.amount === undefined || parsed.hours !== undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确原工人应得部分金额，无实际制作填0", 400);
        const allocation = (await client.query<{ valid: boolean; remaining: string }>("SELECT $1::numeric<=$2::numeric AS valid,($2::numeric-$1::numeric)::text remaining", [parsed.amount, segment.amount])).rows[0]!;
        if (!allocation.valid) throw new ApplicationError("VALIDATION_ERROR", "原工人部分金额不能超过当前段剩余金额", 400);
        await client.query("UPDATE pattern_room_segments SET amount=$2,ended_at=$3 WHERE segment_id=$1", [segment.segment_id, parsed.amount,businessNow().toISOString()]);
        await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount,started_at)
          VALUES($1,$2,$3,$4,$5,$6,'internal',$7,$8)`, [segmentId, round.round_id, segment.segment_index + 1, person.person_id, person.app_user_id, person.display_name, allocation.remaining,businessNow().toISOString()]);
      } else {
        if (parsed.hours === undefined || parsed.amount !== undefined) throw new ApplicationError("VALIDATION_ERROR", "请明确原工人已做工时，无实际制作填0", 400);
        const total = (await client.query<{ valid: boolean }>("SELECT COALESCE(sum(actual_hours),0)+$3::numeric<=999999.9 AS valid FROM pattern_room_segments WHERE round_id=$1 AND segment_id<>$2", [round.round_id, segment.segment_id, parsed.hours])).rows[0]!.valid;
        if (!total) throw new ApplicationError("VALIDATION_ERROR", "各执行段累计工时不能超过999,999.9小时", 400);
        await client.query("UPDATE pattern_room_segments SET actual_hours=$2,amount=$2::numeric*$3::numeric,ended_at=$4 WHERE segment_id=$1", [segment.segment_id, parsed.hours, round.unit_price,businessNow().toISOString()]);
        await client.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount,started_at)
          VALUES($1,$2,$3,$4,$5,$6,'internal',NULL,$7)`, [segmentId, round.round_id, segment.segment_index + 1, person.person_id, person.app_user_id, person.display_name,businessNow().toISOString()]);
        await client.query("UPDATE pattern_room_rounds SET actual_hours=NULL,agreed_amount=NULL,hours_confirmed_by=NULL,hours_confirmed_at=NULL WHERE round_id=$1", [round.round_id]);
      }
      await client.query("UPDATE pattern_room_orders SET version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1", [orderId]);
      const integrated=await syncLinkedExecutionTransfer(client,this.db,effective,orderId,segment.worker_user_id,person.app_user_id,parsed.reason);
      const eventId = await this.event(client, effective, action, orderId, round.round_id, { previousSegmentId: segment.segment_id, segmentId, personId: person.person_id, amount: parsed.amount, hours: parsed.hours }, undefined, parsed.reason);
      await this.todos.completeOpenByDedupeKey(client, effective, patternTodoKey(orderId, round.round_id, `execution:${segment.segment_id}`), "主管已原单转交其他工人");
      if (this.enabled&&!integrated) await this.todos.actionableForRecipient(client, effective, { ...this.projection(orderId, round.round_id, eventId, action, `execution:${segmentId}`), category: "pattern_room_execution", recipientUserId: person.app_user_id, requiredRole: "pattern_room_worker", requiredCapability: "pattern_room:orders:complete" });
      return orderId;
    },true);
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
          const valid = (await client.query<{ valid: boolean }>("SELECT $1::numeric<=$2::numeric AS valid", [parsed.amount, segment.amount])).rows[0]!.valid;
          if (!valid || segment.wage_eligible_at !== null) throw new ApplicationError("CONFLICT", "取消费用不能超过本段余额或覆盖已计薪事实", 409);
          await client.query("UPDATE pattern_room_segments SET amount=$2,ended_at=COALESCE(ended_at,$3::timestamptz) WHERE segment_id=$1", [segment.segment_id, parsed.amount,businessNow().toISOString()]);
        } else {
          const fixed = round.completed_at !== null && round.actual_hours !== null;
          if (parsed.amount !== undefined || (fixed ? parsed.hours !== undefined : parsed.hours === undefined)) throw new ApplicationError("VALIDATION_ERROR", fixed ? "已具备计薪条件的工时不能通过取消修改" : "请填写当前执行段实际停止时的工时，无实际工作填0", 400);
          await client.query("UPDATE pattern_room_segments SET ended_at=COALESCE(ended_at,$2::timestamptz) WHERE segment_id=$1", [segment.segment_id,businessNow().toISOString()]);
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
