import { PatternOrderDetailSchema, PatternOrderListSchema, PatternOrderQuerySchema, canUsePatternOrder, type PatternOrderCapability, type PatternOrderDetail, type PatternOrderQuery, type PatternOrderSummary } from "@dx-rework/contracts/pattern-orders";
import type { Pool, PoolClient } from "pg";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { authorizePatternOrder, canReadAllPatternOrders, canReadAllPatternTechnicalOrders, isPatternRoot, patternActorCapabilities, patternOrderScopeSql, patternOrderScopeValues } from "./order-authority.js";

export type PatternOrderRow = {
  order_id: string; order_no: string; kind: "pattern" | "misc"; task_name: string | null; creator_role: "sample_designer" | "order_merchandiser"; status: PatternOrderSummary["status"]; version: number; current_round_id: string;
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
  constructor(private readonly db: Pool, private readonly enabled: boolean) {}
  async peopleFilters(actor: TrustedActorContext) {
    return this.read(actor, async (client, effective) => {
      if (!canReadAllPatternOrders(effective)) throw new ApplicationError("FORBIDDEN", "当前账号不能筛选其他人员", 403);
      const creators = await client.query<{ id: string; name: string }>("SELECT person.id,person.display_name name FROM app_users person WHERE EXISTS(SELECT 1 FROM pattern_room_orders orders WHERE orders.created_by=person.id) ORDER BY name,id");
      const workers = await client.query<{ id: string; name: string }>("SELECT person.person_id id,person.display_name name FROM business_people person WHERE EXISTS(SELECT 1 FROM pattern_room_segments segment WHERE segment.person_id=person.person_id) ORDER BY name,id");
      return { creators: creators.rows, workers: workers.rows };
    });
  }
  private async read<T>(actor: TrustedActorContext, work: (client: PoolClient, effective: TrustedActorContext) => Promise<T>): Promise<T> {
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const effective = await authorizePatternOrder(client, actor, "pattern_room:orders:view", this.enabled);
      const result = await work(client, effective); await client.query("COMMIT"); return result;
    } catch (error) { await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async list(actor: TrustedActorContext, query: PatternOrderQuery) {
    const parsed = PatternOrderQuerySchema.safeParse(query);
    if (!parsed.success) throw new ApplicationError("VALIDATION_ERROR", "订单筛选条件无效", 400);
    return this.read(actor, async (client, effective) => {
      const input = parsed.data, broad = canReadAllPatternOrders(effective);
      if (!broad && (input.creatorId || input.workerId)) throw new ApplicationError("FORBIDDEN", "当前账号不能筛选其他人员", 403);
      const where = `${patternOrderScopeSql} AND ($5::text IS NULL OR strpos(upper(orders.style_no),upper($5))>0 OR strpos(upper(orders.order_no),upper($5))>0 OR strpos(upper(COALESCE(orders.task_name,'')),upper($5))>0)
        AND ($6::text IS NULL OR orders.status=$6) AND ($7::uuid IS NULL OR orders.created_by=$7)
        AND ($8::uuid IS NULL OR EXISTS(SELECT 1 FROM pattern_room_segments filtered_worker WHERE filtered_worker.round_id=orders.current_round_id AND filtered_worker.person_id=$8)) AND ($9::text IS NULL OR orders.kind=$9)`;
      const values = [...patternOrderScopeValues(effective), input.q || null, input.status ?? null, input.creatorId ?? null, input.workerId ?? null, input.kind ?? null];
      const count = (await client.query<{ count: number }>(`SELECT count(*)::int count FROM pattern_room_orders orders WHERE ${where}`, values)).rows[0]!.count;
      const rows = await client.query<PatternOrderRow>(`SELECT orders.*,to_char(orders.required_date,'YYYY-MM-DD') required_date,${currentWorkerSql} current_worker_name FROM pattern_room_orders orders WHERE ${where}
        ORDER BY orders.submitted_at DESC,orders.order_id DESC LIMIT $10 OFFSET $11`, [...values, input.limit, (input.page - 1) * input.limit]);
      return PatternOrderListSchema.parse({ items: rows.rows.map(patternSummary), totalCount: count, page: input.page, pageSize: input.limit,
        totalPages: Math.max(1, Math.ceil(count / input.limit)), canCreate: canUsePatternOrder(effective.actorRoles, patternActorCapabilities(effective), "pattern_room:orders:create"), canCreateMisc: canUsePatternOrder(effective.actorRoles, patternActorCapabilities(effective), "pattern_room:misc:create"), canFilterPeople: broad });
    });
  }

  async get(actor: TrustedActorContext, orderId: string): Promise<PatternOrderDetail> {
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
        `SELECT node.*,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(node.exited_at,CURRENT_TIMESTAMP)-node.entered_at)))::float8 elapsed_seconds
         FROM pattern_room_node_times node JOIN pattern_room_rounds round USING(round_id) WHERE round.order_id=$1 ORDER BY node.entered_at,node.node_id`, [orderId])).rows;
      const files = (await client.query<{ attachment_id: string; round_id: string; original_filename: string; mime_type: string; size_bytes: string; active: boolean; bound_at: Date; reason: string }>(
        `SELECT binding.*,file.original_filename,file.mime_type,file.size_bytes FROM pattern_room_attachment_bindings binding
         JOIN attachments file USING(attachment_id) WHERE binding.order_id=$1 AND file.status='ready'
           AND ($2::boolean OR ($4::boolean AND EXISTS(SELECT 1 FROM pattern_room_segments own_segment WHERE own_segment.round_id=binding.round_id
             AND own_segment.worker_user_id=$3 AND binding.bound_at<=COALESCE(own_segment.ended_at,CURRENT_TIMESTAMP))))
         ORDER BY binding.bound_at,binding.attachment_id`, [orderId, allMaterials, effective.actorId, currentWorkerAccess])).rows;
      const history = (await client.query<{ action: string; actor_name: string; created_at: Date; reason: string | null }>(
        `SELECT event.action,COALESCE(person.display_name,event.actor_id::text) actor_name,event.created_at,CASE WHEN $2 THEN event.reason END reason
         FROM operation_events event LEFT JOIN app_users person ON person.id=event.actor_id WHERE event.entity_type='pattern_room_order' AND event.entity_id=$1
         ORDER BY event.created_at,event.event_id`, [orderId, allMaterials])).rows;
      const currentRound = rounds.find(round => round.round_id === order.current_round_id);
      const available = (capability: PatternOrderCapability) => canUsePatternOrder(effective.actorRoles, patternActorCapabilities(effective), capability);
      const creator = isPatternRoot(effective) || order.created_by === effective.actorId;
      return PatternOrderDetailSchema.parse({ ...patternSummary(order), currentRoundId: order.current_round_id, customer: order.customer, sizeColor: order.size_color,
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
        actions: { assign: order.status === "pending_assignment" && available("pattern_room:orders:assign"),
          complete: order.status === "in_progress" && !!current && (isPatternRoot(effective) || current.worker_user_id === effective.actorId) && available("pattern_room:orders:complete"),
          handoff: order.status === "pending_confirmation" && creator && available(order.kind === "pattern" ? "pattern_room:orders:handoff" : "pattern_room:misc:confirm"),
          edit: ["pending_assignment", "in_progress"].includes(order.status) && creator && available(order.kind === "pattern" ? "pattern_room:orders:edit" : "pattern_room:misc:edit"),
          hours: order.kind === "misc" && ["in_progress", "pending_confirmation", "completed"].includes(order.status) && available("pattern_room:orders:hours") && !!currentRound && !(currentRound.completed_at !== null && currentRound.actual_hours !== null),
          rework: order.kind === "pattern" && ["pending_confirmation", "completed"].includes(order.status) && !!currentRound?.completed_at && available("pattern_room:orders:rework") && (creator || effective.actorRoles.includes("pattern_room_supervisor")),
          transfer: order.status === "in_progress" && available("pattern_room:orders:transfer"),
          cancel: available("pattern_room:orders:cancel") && (order.status === "pending_assignment" ? isPatternRoot(effective) || currentRound?.requested_by === effective.actorId : ["in_progress", "pending_confirmation"].includes(order.status) && (isPatternRoot(effective) || effective.actorRoles.includes("pattern_room_supervisor"))),
          cancelFees: order.kind === "pattern" && order.status === "cancelled" && creator && available("pattern_room:orders:cancel_fees") && rounds.some(round => round.cancelled_amount !== null && /[1-9]/.test(round.cancelled_amount) && round.fee_confirmed_at === null && round.handed_over_at === null) },
      });
    });
  }
}
