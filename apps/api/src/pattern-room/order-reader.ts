import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import {readPatternHistory} from './pattern-history-reader.js';
import {PatternHistoryQuerySchema,type PatternHistoryQuery} from '@dx-rework/contracts/pattern-orders';
import {developmentMakingBasis} from '@dx-rework/contracts/digital-development';
import {developmentDocumentRow} from '../production-platform/development-round-repository.js';
import { patternOrderAtNode, type PatternHistorySelection, type PatternHistoryEvent } from "./order-history.js";
import { PatternOrderDetailSchema, PatternOrderListSchema, PatternOrderQuerySchema, canUsePatternOrder, type MiscAssociationSnapshot, type PatternOrderCapability, type PatternOrderDetail, type PatternOrderQuery, type PatternOrderSummary } from "@dx-rework/contracts/pattern-orders";
import type { Pool, PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { authorizePatternOrder, canReadAllPatternOrders, canReadAllPatternTechnicalOrders, isPatternRoot, patternActorCapabilities, patternOrderScopeSql, patternOrderScopeValues } from "./order-authority.js";
import { patternReworkCutBlocked, PATTERN_REWORK_CUT_BLOCK } from "./order-rework-boundary.js";
import {DigitalProductionAccessPolicy,digitalNotFound} from "../production-platform/access-policy.js";

export type PatternOrderRow = {
  order_id: string; order_no: string; kind: "pattern" | "misc"; task_name: string | null; creator_role: "sample_designer" | "order_merchandiser"; status: PatternOrderSummary["status"]; version: number; current_round_id: string;
  misc_association?:MiscAssociationSnapshot|null;
  created_by: string; creator_name: string; style_no: string; required_date: string | null; customer: string | null; size_color: string | null;
  reference_style_no: string | null; variant: string | null; note: string | null; submitted_at: Date; updated_at: Date; rework_count: number; current_worker_name?: string | null;
};
export type PatternRoundRow = { round_id: string; order_id: string; round_index: number | null; round_type: "initial" | "rework"; requested_by: string; request_reason: string | null; status: PatternOrderSummary["status"]; category_id: string; price_version: number; category_name: string; unit: string;
  quantity: number | null; unit_price: string | null; agreed_amount: string | null; actual_hours: string | null; assigned_at: Date | null; assigned_by: string | null; supervisor_user_id: string | null; completed_at: Date | null; handed_over_at: Date | null;
  stopped_at: Date | null; cancelled_at: Date | null; cancelled_amount: string | null; fee_confirmed_at: Date | null };
export type PatternSegmentRow = { segment_id: string; round_id: string; segment_index: number; person_id: string; worker_user_id: string; worker_name: string;
  amount: string | null; actual_hours: string | null; started_at: Date; ended_at: Date | null; worker_completed_at: Date | null; wage_eligible_at: Date | null };
export const patternIso = (value: Date | null) => value?.toISOString() ?? null;
export const patternSummary = (row: PatternOrderRow): PatternOrderSummary => ({ orderId: row.order_id, orderNo: row.order_no, kind: row.kind, taskName: row.task_name, status: row.status,
  version: row.version, styleNo: row.style_no, creatorId: row.created_by, creatorName: row.creator_name, currentWorkerName: row.current_worker_name ?? null,
  requiredDate: row.required_date, reworkCount: row.rework_count, submittedAt: row.submitted_at.toISOString(), updatedAt: row.updated_at.toISOString() });
const currentWorkerSql = `(SELECT worker.worker_name FROM pattern_room_segments worker WHERE worker.round_id=orders.current_round_id ORDER BY worker.segment_index DESC LIMIT 1)`;
export async function scopedPatternOrder(client: PoolClient, actor: TrustedActorContext, orderId: string, lock = false): Promise<PatternOrderRow> {
  const row = (await client.query<PatternOrderRow>(`SELECT orders.*,to_char(orders.required_date,'YYYY-MM-DD') required_date,${currentWorkerSql} current_worker_name FROM pattern_room_orders orders
    WHERE ${patternOrderScopeSql} AND orders.order_id=$5 ${lock ? "FOR UPDATE OF orders" : ""}`, [...patternOrderScopeValues(actor), orderId])).rows[0];
  if (!row) throw new ApplicationError("NOT_FOUND", "订单不存在或不在当前账号的业务范围内", 404);
  return row;
}

export class PatternOrderReader {
  constructor(private readonly db: Pool, private readonly enabled: boolean, private readonly transactionClient?: PoolClient) {}
  /** Explicit source/PO relationships only, inside the original persisted pattern read scope. */
  async related(actor:TrustedActorContext,input:{sourceId?:string|undefined;orderId?:string|undefined;page:number}){
    return this.read(actor,async(client,effective)=>{
      const policy=new DigitalProductionAccessPolicy(client);
      if(input.sourceId)await policy.assert(effective,"source",input.sourceId,"technical");
      if(input.orderId){await policy.assert(effective,"order",input.orderId,"technical");if(input.sourceId&&!(await client.query("SELECT 1 FROM digital_production_orders WHERE production_order_id=$1 AND source_id=$2",[input.orderId,input.sourceId])).rowCount)digitalNotFound();}
      const rows=(await client.query(`SELECT orders.order_id AS "orderId",orders.order_no AS "orderNo",orders.kind,orders.submitted_at AS "createdAt",person.display_name AS "createdBy",
        COALESCE((SELECT jsonb_agg(jsonb_build_object('roundId',r.round_id,'roundIndex',r.round_index,'roundType',r.round_type,'requestedAt',r.requested_at) ORDER BY r.requested_at,r.round_id) FROM pattern_room_rounds r WHERE r.order_id=orders.order_id
          AND ($2::boolean OR (orders.created_by=$1::uuid AND ('sample_designer'=ANY($3::text[]) OR orders.kind='misc' AND 'order_merchandiser'=ANY($3::text[])))
            OR r.round_id=orders.current_round_id OR EXISTS(SELECT 1 FROM pattern_room_segments own_segment WHERE own_segment.round_id=r.round_id AND own_segment.worker_user_id=$1::uuid))),'[]') AS rounds
        FROM pattern_room_orders orders LEFT JOIN app_users person ON person.id=orders.created_by
        WHERE ${patternOrderScopeSql} AND (
          orders.kind='pattern' AND EXISTS(SELECT 1 FROM digital_development_pattern_links l WHERE l.order_id=orders.order_id AND l.source_id=$5::uuid)
          OR orders.kind='misc' AND (orders.misc_association->>'kind'='source' AND orders.misc_association->>'id'=$5::text
            OR orders.misc_association->>'kind'='po' AND EXISTS(SELECT 1 FROM digital_production_po_lines po WHERE po.production_order_id=$6::uuid AND po.line_id::text=orders.misc_association->>'id')))
        ORDER BY orders.submitted_at DESC,orders.order_id LIMIT 21 OFFSET $7`,[...patternOrderScopeValues(effective),input.sourceId??null,input.orderId??null,(input.page-1)*20])).rows;
      return {items:rows.slice(0,20),nextPage:rows.length>20?input.page+1:null};
    });
  }
  async peopleFilters(actor: TrustedActorContext) {
    return this.read(actor, async (client, effective) => {
      if (!canReadAllPatternOrders(effective)) throw new ApplicationError("FORBIDDEN", "当前账号不能筛选其他人员", 403);
      const creators = await client.query<{ id: string; name: string }>("SELECT person.id,person.display_name AS name FROM app_users person WHERE EXISTS(SELECT 1 FROM pattern_room_orders orders WHERE orders.created_by=person.id AND orders.deleted_at IS NULL) ORDER BY name,id");
      const workers = await client.query<{ id: string; name: string }>("SELECT person.person_id id,person.display_name AS name FROM business_people person WHERE EXISTS(SELECT 1 FROM pattern_room_segments segment JOIN pattern_room_rounds round ON round.round_id=segment.round_id JOIN pattern_room_orders orders ON orders.order_id=round.order_id WHERE segment.person_id=person.person_id AND orders.deleted_at IS NULL) ORDER BY name,id");
      return { creators: creators.rows, workers: workers.rows };
    });
  }
  private async read<T>(actor: TrustedActorContext, work: (client: PoolClient, effective: TrustedActorContext) => Promise<T>): Promise<T> {
    if (this.transactionClient) return work(this.transactionClient, await authorizePatternOrder(this.transactionClient, actor, "pattern_room:orders:view", this.enabled));
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const effective = await authorizePatternOrder(client, actor, "pattern_room:orders:view", this.enabled);
      const result = await work(client, effective); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async history(actor:TrustedActorContext,input:PatternHistoryQuery){
    const parsed=PatternHistoryQuerySchema.safeParse(input);if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR','历史筛选条件无效',400);
    return this.read(actor,(db,effective)=>readPatternHistory(db,effective,parsed.data));
  }

  async list(actor: TrustedActorContext, query: PatternOrderQuery) {
    const parsed = PatternOrderQuerySchema.safeParse(query);
    if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "订单筛选条件无效", 400);
    return this.read(actor, async (client, effective) => {
      const input = parsed.data, broad = canReadAllPatternOrders(effective);
      if (!broad && (input.creatorId || input.workerId)) throw new ApplicationError("FORBIDDEN", "当前账号不能筛选其他人员", 403);
      const standalone = input.origin === 'standalone';
      const linksExist = standalone && (await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation;
      const originScope = standalone ? `AND orders.kind='pattern' ${linksExist ? 'AND NOT EXISTS(SELECT 1 FROM digital_development_pattern_links linked WHERE linked.order_id=orders.order_id)' : ''}` : '';
      const where = `${patternOrderScopeSql} ${originScope} AND ($5::text IS NULL OR strpos(upper(orders.style_no),upper($5))>0 OR strpos(upper(orders.order_no),upper($5))>0 OR strpos(upper(COALESCE(orders.task_name,'')),upper($5))>0)
        AND ($6::text IS NULL OR orders.status=$6) AND ($7::uuid IS NULL OR orders.created_by=$7)
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM pattern_room_segments filtered_worker WHERE filtered_worker.round_id=orders.current_round_id AND filtered_worker.person_id=$8)) AND ($9::text IS NULL OR orders.kind=$9)`;
      const values = [...patternOrderScopeValues(effective), input.q || null, input.status ?? null, input.creatorId ?? null, input.workerId ?? null, input.kind ?? null];
      const count = (await client.query<{ count: number }>(`SELECT count(*)::int count FROM pattern_room_orders orders WHERE ${where}`, values)).rows[0]!.count;
      const rows = await client.query<PatternOrderRow>(`SELECT orders.*,to_char(orders.required_date,'YYYY-MM-DD') required_date,${currentWorkerSql} current_worker_name FROM pattern_room_orders orders WHERE ${where}
        ORDER BY orders.submitted_at DESC,orders.order_id DESC LIMIT $10 OFFSET $11`, [...values, input.limit, (input.page - 1) * input.limit]);
      return PatternOrderListSchema.parse({ items: rows.rows.map(patternSummary), totalCount: count, page: input.page, pageSize: input.limit,
        totalPages: Math.max(1, Math.ceil(count / input.limit)), canCreate: false, canCreateMisc: canUsePatternOrder(effective.actorRoles, patternActorCapabilities(effective), "pattern_room:misc:create"), canFilterPeople: broad, canDelete: isPatternRoot(effective) });
    });
  }

  async get(actor: TrustedActorContext, orderId: string, selection: PatternHistorySelection = {}): Promise<PatternOrderDetail> {
    return this.read(actor, async (client, effective) => {
      const order = await scopedPatternOrder(client, effective, orderId);
      const allCosts = canReadAllPatternOrders(effective) || (order.created_by === effective.actorId && (effective.actorRoles.includes("sample_designer") || (order.kind === "misc" && effective.actorRoles.includes("order_merchandiser"))));
      const allMaterials = canReadAllPatternTechnicalOrders(effective) || (order.created_by === effective.actorId && (effective.actorRoles.includes("sample_designer") || (order.kind === "misc" && effective.actorRoles.includes("order_merchandiser"))));
      const rounds = (await client.query<PatternRoundRow>("SELECT * FROM pattern_room_rounds WHERE order_id=$1 ORDER BY requested_at,round_id", [orderId])).rows;
      const segments = (await client.query<PatternSegmentRow>(`SELECT segment.* FROM pattern_room_segments segment JOIN pattern_room_rounds round USING(round_id)
        WHERE round.order_id=$1 ORDER BY round.round_index,segment.segment_index`, [orderId])).rows;
      const current = segments.filter(segment => segment.round_id === order.current_round_id).at(-1);
      // Finance reads do not widen the worker's original current-assignment scope.
      const currentWorkerAccess = effective.actorRoles.includes("pattern_room_worker") && current?.worker_user_id === effective.actorId;
      const canReadRoundMaterials = (roundId:string) => allMaterials || (currentWorkerAccess && (roundId === order.current_round_id || segments.some(segment => segment.round_id === roundId && segment.worker_user_id === effective.actorId)));
      const nodes = (await client.query<{ round_id: string; stage: string; entered_at: Date; exited_at: Date | null; exit_reason: string | null; elapsed_seconds: number }>(
        `SELECT node.*,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(node.exited_at,$2::timestamptz,CURRENT_TIMESTAMP)-node.entered_at)))::float8 elapsed_seconds
         FROM pattern_room_node_times node JOIN pattern_room_rounds round USING(round_id) WHERE round.order_id=$1 ORDER BY node.entered_at,node.node_id`, [orderId,acceptanceBusinessContext()?.time.now??null])).rows;
      const files = (await client.query<{ attachment_id: string; round_id: string; original_filename: string; mime_type: string; size_bytes: string; active: boolean; bound_at: Date; reason: string }>(
        `SELECT binding.*,file.original_filename,file.mime_type,file.size_bytes FROM pattern_room_attachment_bindings binding
         JOIN attachments file USING(attachment_id) WHERE binding.order_id=$1 AND file.status='ready'
           AND ($2::boolean OR ($4::boolean AND EXISTS(SELECT 1 FROM pattern_room_segments own_segment WHERE own_segment.round_id=binding.round_id
             AND own_segment.worker_user_id=$3 AND binding.bound_at<=COALESCE((SELECT min(ended.created_at) FROM operation_events ended
               WHERE ended.entity_type='pattern_room_order' AND ended.entity_id=$1::text AND ended.after_state->'acceptanceClock' IS NOT NULL
                AND (ended.action='pattern_room.order.work_completed' AND ended.after_state->'value'->>'segmentId'=own_segment.segment_id::text
                 OR ended.action='pattern_room.order.worker_changed' AND ended.after_state->'value'->>'previousSegmentId'=own_segment.segment_id::text
                 OR ended.action='pattern_room.order.cancelled' AND ended.after_state->>'roundId'=own_segment.round_id::text)),own_segment.ended_at,CURRENT_TIMESTAMP))))
         ORDER BY binding.bound_at,binding.attachment_id`, [orderId, allMaterials, effective.actorId, currentWorkerAccess])).rows;
      const history = (await client.query<PatternHistoryEvent>(
        `SELECT event.after_state,event.action,COALESCE(person.display_name,event.actor_id::text) actor_name,event.created_at,CASE WHEN $2 THEN event.reason END reason
         FROM operation_events event LEFT JOIN app_users person ON person.id=event.actor_id WHERE event.entity_type='pattern_room_order' AND event.entity_id=$1
         ORDER BY event.created_at,event.event_id`, [orderId, allMaterials])).rows;
      const currentRound = rounds.find(round => round.round_id === order.current_round_id);
      const available = (capability: PatternOrderCapability) => canUsePatternOrder(effective.actorRoles, patternActorCapabilities(effective), capability);
      const creator = isPatternRoot(effective) || order.created_by === effective.actorId;
      const mayRework = order.kind === "pattern" && ["pending_confirmation", "completed"].includes(order.status) && !!currentRound?.completed_at && available("pattern_room:orders:rework") && (creator || effective.actorRoles.includes("pattern_room_supervisor"));
      const reworkCutBlocked = mayRework && await patternReworkCutBlocked(client, orderId);
      const developmentSource=allMaterials&&(await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation?(await client.query("SELECT source_id FROM digital_development_pattern_links WHERE order_id=$1",[orderId])).rows[0]:null;
      const makingDocument=developmentSource&&mayRework&&!reworkCutBlocked&&(!selection.round||selection.round===order.current_round_id)&&(!selection.node||selection.node===order.status)&&await new DigitalProductionAccessPolicy(client).allowed(effective,'source',developmentSource.source_id,'technical')?await developmentDocumentRow(client,developmentSource.source_id):null;
      const detail = PatternOrderDetailSchema.parse({ ...patternSummary(order),...(makingDocument?{developmentMakingBasis:developmentMakingBasis(makingDocument.document,makingDocument.version)}:{}), association:order.misc_association??null,...(developmentSource?{developmentSourceId:developmentSource.source_id}:{}), currentRoundId: order.current_round_id, customer: order.customer, sizeColor: order.size_color,
        reworkBlockedReason: reworkCutBlocked ? PATTERN_REWORK_CUT_BLOCK : null,
        referenceStyleNo: order.reference_style_no, variant: order.variant, note: allMaterials || currentWorkerAccess ? order.note : null,
        rounds: rounds.filter(round => allCosts || round.round_id === order.current_round_id || segments.some(segment => segment.round_id === round.round_id && segment.worker_user_id === effective.actorId)).map(round => ({
          roundId: round.round_id, index: round.round_index, roundType: round.round_type, requestedBy: round.requested_by, requestReason: canReadRoundMaterials(round.round_id) ? round.request_reason : null, status: round.status, categoryName: round.category_name, unit: round.unit, quantity: round.quantity,
          ...(allCosts ? { ...(round.unit_price !== null ? { unitPrice: round.unit_price } : {}), agreedAmount: round.agreed_amount, actualHours: round.actual_hours, cancelledAmount: round.cancelled_amount } : {}), assignedAt: patternIso(round.assigned_at), completedAt: patternIso(round.completed_at), handedOverAt: patternIso(round.handed_over_at),
          stoppedAt: patternIso(round.stopped_at), cancelledAt: patternIso(round.cancelled_at), feeConfirmedAt: patternIso(round.fee_confirmed_at),
          segments: segments.filter(segment => segment.round_id === round.round_id && (allCosts || segment.worker_user_id === effective.actorId)).map(segment => ({
            segmentId: segment.segment_id, personId: segment.person_id, workerUserId: segment.worker_user_id, workerName: segment.worker_name, amount: segment.amount, actualHours: segment.actual_hours,
            startedAt: segment.started_at.toISOString(), endedAt: patternIso(segment.ended_at), wageEligible: segment.wage_eligible_at !== null,
          })),
          nodes: nodes.filter(node => node.round_id === round.round_id).map(node => ({ stage: node.stage, enteredAt: node.entered_at.toISOString(), exitedAt: patternIso(node.exited_at), exitReason: node.exit_reason, elapsedSeconds: node.elapsed_seconds })),
        })),
        canReadMaterials: allMaterials || files.length>0,
        attachments: files.map(file => ({ attachmentId: file.attachment_id, roundId: file.round_id, filename: file.original_filename, mimeType: file.mime_type, sizeBytes: Number(file.size_bytes), active: file.active, addedAt: file.bound_at.toISOString(), reason: file.reason })),
        history: history.map(event => ({ action: event.action, actorName: event.actor_name, at: event.created_at.toISOString(), reason: event.reason })),
        actions: { delete: isPatternRoot(effective), assign: order.status === "pending_assignment" && available("pattern_room:orders:assign"),
          complete: order.status === "in_progress" && !!current && (isPatternRoot(effective) || current.worker_user_id === effective.actorId) && available("pattern_room:orders:complete"),
          handoff: order.status === "pending_confirmation" && creator && available(order.kind === "pattern" ? "pattern_room:orders:handoff" : "pattern_room:misc:confirm"),
          edit: ["pending_assignment", "in_progress"].includes(order.status) && creator && available(order.kind === "pattern" ? "pattern_room:orders:edit" : "pattern_room:misc:edit"),
          hours: order.kind === "misc" && ["in_progress", "pending_confirmation", "completed"].includes(order.status) && available("pattern_room:orders:hours") && !!currentRound && !(currentRound.completed_at !== null && currentRound.actual_hours !== null),
          rework: mayRework && !reworkCutBlocked,
          transfer: order.status === "in_progress" && available("pattern_room:orders:transfer"),
          cancel: available("pattern_room:orders:cancel") && (order.status === "pending_assignment" ? isPatternRoot(effective) || currentRound?.requested_by === effective.actorId : ["in_progress", "pending_confirmation"].includes(order.status) && (isPatternRoot(effective) || effective.actorRoles.includes("pattern_room_supervisor"))),
          cancelFees: order.kind === "pattern" && order.status === "cancelled" && creator && available("pattern_room:orders:cancel_fees") && rounds.some(round => round.cancelled_amount !== null && /[1-9]/.test(round.cancelled_amount) && round.fee_confirmed_at === null && round.handed_over_at === null) },
      });
      return patternOrderAtNode(detail, selection, history, { technical: canReadRoundMaterials(selection.round ?? order.current_round_id), allCosts, unitPrices: new Map(rounds.map(round => [round.round_id, round.unit_price])), wageEligibleAt: new Map(segments.map(segment => [segment.segment_id, patternIso(segment.wage_eligible_at)])) });
    });
  }
}
