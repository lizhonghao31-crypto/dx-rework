import { canReadFinanceOrders, isScopedFinanceReader } from "./finance-order-access.js";
import { createHash, randomUUID } from "node:crypto";

import type { InspectionReportDraft, ReworkOrderStatus } from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

const tailDefectMutableStatuses = new Set<ReworkOrderStatus>([
  "pending_process_configuration",
  "pending_ie_review",
  "pending_task_assignment",
  "in_progress",
  "pending_order_review",
  "pending_final_quantity_ie_review",
  "pending_quantity_adjustment_ie_review",
  "pending_responsibility_determination",
  "pending_owner_signature",
  "pending_responsibility_action",
]);

const canAddTailDefectiveQuantity = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.some((role) => ["tail_supervisor", "owner_group", "root_superuser"].includes(role));

const canRecordIePrecount = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.includes("root_superuser")
  || (
    actor.actorRoles.includes("ie_reviewer")
    && (actor.authorizationCapabilities ?? [actor.authorizationCapability]).includes("process:review")
  );

const requestHash = (scope: string, input: unknown): string => createHash("sha256")
  .update(JSON.stringify({ scope, input }))
  .digest("hex");

export type ReworkBusinessDetail = Readonly<{
  canReadBusinessDetails: boolean;
  reworkOrderId: string;
  reworkNo: string | null;
  status: ReworkOrderStatus;
  version: number;
  styleNo: string | null;
  customerSupplyCode: string | null;
  factoryStyleNo: string | null;
  orderNo: string | null;
  orderQuantity: number | null;
  sourceReceivingActualQuantity: number | null;
  iePrecounts: Readonly<{
    canRecord: boolean;
    processes: readonly Readonly<{
      configurationItemId: string;
      processName: string;
    }>[];
    entries: readonly Readonly<{
      entryId: string;
      configurationItemId: string;
      processName: string;
      quantity: number;
      note: string | null;
      recordedBy: string;
      recordedAt: string;
    }>[];
  }>;
  defectiveQuantity: Readonly<{
    receiving: number;
    receivingLinked: boolean;
    tail: number;
    total: number;
    canAddTail: boolean;
    tailEntries: readonly Readonly<{
      entryId: string;
      quantity: number;
      recordedBy: string;
      recordedAt: string;
    }>[];
  }>;
  supplyContext: Readonly<{
    washingSupplierName: string | null;
    embroiderySupplierName: string | null;
    fabricSupplierName: string | null;
    embroideryMerchandiserName: string | null;
  }>;
  merchandiser: Readonly<{ userId: string; displayName: string }> | null;
  processingFactory: Readonly<{
    type: "own_factory" | "supplier";
    supplierId: string | null;
    displayName: string;
  }> | null;
  reworkReason: string | null;
  reworkProcess: string | null;
  problemPart: string | null;
  problemDescription: string | null;
  reworkQuantity: number | null;
  tailInspectionRequired: boolean;
  singlePieceReworkTotal: number | null;
  inspectionReport: InspectionReportDraft | null;
  createdBy: Readonly<{ userId: string; displayName: string }>;
  processConfigurationCreatedBy: Readonly<{
    userId: string;
    displayName: string;
  }> | null;
  createdAt: string;
  updatedAt: string;
  submittedAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  settlementStatus: "not_required" | "in_progress" | "closed" | "revision_in_progress";
  wageSettlementStatus: "not_required" | "in_progress" | "closed";
  unsettledWagePeriods: readonly Readonly<{
    periodId: string;
    periodMonth: string;
    status: "pending_tail_review" | "pending_admin_review" | "ready_to_lock";
  }>[];
  attachments: readonly Readonly<{
    attachmentId: string;
    filename: string;
    mimeType: string;
    entityType: "rework_order" | "external_responsibility_case" | "receiving_batch";
  }>[];
  workflowHistory: readonly Readonly<{
    action: string;
    handledBy: string;
    handledAt: string;
    remark: string | null;
  }>[];
}>;

type AttachmentRow = Readonly<{
  attachment_id: string;
  original_filename: string;
  mime_type: string;
  entity_type: "rework_order" | "external_responsibility_case" | "receiving_batch";
}>;

type WorkflowHistoryRow = Readonly<{
  action: string;
  actor_name: string | null;
  actor_id: string;
  created_at: Date;
  reason: string | null;
}>;

type DetailRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderStatus;
  version: number;
  style_no: string | null;
  customer_supply_code: string | null;
  factory_style_no: string | null;
  order_no: string | null;
  order_quantity: string | null;
  source_receiving_actual_quantity: string | null;
  source_receiving_defective_quantity: string | null;
  tail_defective_quantity: string;
  tail_defective_quantity_entries: Array<{
    entryId: string;
    quantity: number;
    recordedBy: string;
    recordedAt: string;
  }>;
  ie_precount_processes: Array<{
    configurationItemId: string;
    processName: string;
  }>;
  ie_precount_entries: Array<{
    entryId: string;
    configurationItemId: string;
    processName: string;
    quantity: number;
    note: string | null;
    recordedBy: string;
    recordedAt: string;
  }>;
  washing_supplier_name: string | null;
  embroidery_supplier_name: string | null;
  fabric_supplier_name: string | null;
  embroidery_merchandiser_user_id: string | null;
  embroidery_merchandiser_name: string | null;
  merchandiser_user_id: string | null;
  merchandiser_name: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  supplier_name: string | null;
  rework_reason: string | null;
  rework_process: string | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: string | null;
  tail_inspection_required: boolean;
  single_piece_rework_total: string | null;
  inspection_report: InspectionReportDraft | null;
  created_by: string;
  creator_name: string;
  configuration_created_by: string | null;
  configuration_creator_name: string | null;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
}>;

const broadBusinessReader = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.some((role) => [
    "root_superuser",
    "owner_group",
    "production_management",
    "tail_supervisor",
    "finance_director",
    "finance_read",
  ].includes(role));

const actorCapabilities = (actor: TrustedActorContext): readonly string[] =>
  actor.authorizationCapabilities ?? [actor.authorizationCapability];

const canViewWagePeriods = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.some((role) => ["root_superuser", "owner_group"].includes(role))
  || actorCapabilities(actor).includes("wage:view");

export class ReworkBusinessDetailService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  async get(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkBusinessDetail> {
    const result = await this.database.query<DetailRow>(
      `SELECT
         orders.rework_order_id,orders.rework_no,orders.status,orders.version,orders.style_no,
         to_jsonb(orders)->>'customer_supply_code' customer_supply_code,
         to_jsonb(orders)->>'factory_style_no' factory_style_no,
         orders.order_no,
         to_jsonb(orders)->>'order_quantity' order_quantity,
         CASE WHEN orders.source_receiving_batch_id IS NULL THEN NULL
           ELSE COALESCE(receiving.actual_quantity,0)::text
         END source_receiving_actual_quantity,
         CASE WHEN orders.source_receiving_batch_id IS NULL THEN NULL
           ELSE COALESCE(receiving.defective_quantity,0)::text
         END source_receiving_defective_quantity,
         COALESCE(tail_defects.defective_quantity,0)::text tail_defective_quantity,
         COALESCE(tail_defects.entries,'[]'::jsonb) tail_defective_quantity_entries,
         washing_supplier.supplier_name washing_supplier_name,
         embroidery_supplier.supplier_name embroidery_supplier_name,
         fabric_supplier.supplier_name fabric_supplier_name,
         supply_context.embroidery_merchandiser_user_id,
         embroidery_merchandiser.display_name embroidery_merchandiser_name,
         orders.merchandiser_user_id,merchandiser.display_name merchandiser_name,
         orders.processing_factory_type,orders.processing_factory_supplier_id,
         supplier.supplier_name,
         to_jsonb(orders)->>'rework_reason' rework_reason,
         COALESCE(NULLIF(latest_configuration.process_names,''),to_jsonb(orders)->>'rework_process') rework_process,
         orders.problem_part,orders.problem_description,orders.rework_quantity::text,
         orders.tail_inspection_required,
         latest_configuration.single_piece_rework_total,
         COALESCE(ie_precounts.processes,'[]'::jsonb) ie_precount_processes,
         COALESCE(ie_precounts.entries,'[]'::jsonb) ie_precount_entries,
         orders.inspection_report,
         orders.created_by,creator.display_name creator_name,
         latest_configuration.created_by configuration_created_by,
         configuration_creator.display_name configuration_creator_name,
         orders.created_at,orders.updated_at,orders.submitted_at,orders.cancelled_at,orders.cancel_reason
       FROM rework_orders orders
       JOIN app_users creator ON creator.id=orders.created_by
       LEFT JOIN app_users merchandiser ON merchandiser.id=orders.merchandiser_user_id
       LEFT JOIN rework_order_supply_context supply_context
         ON supply_context.rework_order_id=orders.rework_order_id
       LEFT JOIN supplier_catalog_versions washing_supplier
         ON washing_supplier.supplier_id=supply_context.washing_supplier_id
        AND washing_supplier.version=supply_context.washing_supplier_version
       LEFT JOIN supplier_catalog_versions embroidery_supplier
         ON embroidery_supplier.supplier_id=supply_context.embroidery_supplier_id
        AND embroidery_supplier.version=supply_context.embroidery_supplier_version
       LEFT JOIN supplier_catalog_versions fabric_supplier
         ON fabric_supplier.supplier_id=supply_context.fabric_supplier_id
        AND fabric_supplier.version=supply_context.fabric_supplier_version
       LEFT JOIN app_users embroidery_merchandiser
         ON embroidery_merchandiser.id=supply_context.embroidery_merchandiser_user_id
       LEFT JOIN supplier_catalog_versions supplier
         ON supplier.supplier_id=orders.processing_factory_supplier_id
        AND supplier.version=orders.processing_factory_supplier_version
       LEFT JOIN LATERAL (
         SELECT configuration.configuration_id,configuration.created_by,
                (
                  SELECT string_agg(item.process_name,'、' ORDER BY item.position)
                  FROM rework_process_configuration_items item
                  WHERE item.configuration_id=configuration.configuration_id
                ) process_names,
                (
                  SELECT SUM(item.unit_price)::text
                  FROM rework_process_configuration_items item
                  WHERE item.configuration_id=configuration.configuration_id
                ) single_piece_rework_total
         FROM rework_process_configurations configuration
         WHERE configuration.rework_order_id=orders.rework_order_id
         ORDER BY configuration.configuration_version DESC
         LIMIT 1
       ) latest_configuration ON true
       LEFT JOIN app_users configuration_creator
         ON configuration_creator.id=latest_configuration.created_by
       LEFT JOIN LATERAL (
         SELECT COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'configurationItemId',item.configuration_item_id,
                    'processName',item.process_name
                  ) ORDER BY item.position,item.configuration_item_id)
                  FROM rework_process_configuration_items item
                  WHERE item.configuration_id=latest_configuration.configuration_id
                    AND item.execution_kind='worker'
                ),'[]'::jsonb) processes,
                COALESCE((
                  SELECT jsonb_agg(jsonb_build_object(
                    'entryId',recent.ie_precount_entry_id,
                    'configurationItemId',recent.configuration_item_id,
                    'processName',recent.process_name,
                    'quantity',recent.quantity,
                    'note',recent.note,
                    'recordedBy',recent.recorded_by_name,
                    'recordedAt',recent.recorded_at
                  ) ORDER BY recent.recorded_at DESC,recent.ie_precount_entry_id DESC)
                  FROM (
                    SELECT entry.ie_precount_entry_id,entry.configuration_item_id,item.process_name,
                           entry.quantity,entry.note,
                           COALESCE(actor.display_name,entry.recorded_by::text) recorded_by_name,
                           entry.recorded_at
                    FROM rework_ie_precount_entries entry
                    JOIN rework_process_configuration_items item
                      ON item.configuration_item_id=entry.configuration_item_id
                    LEFT JOIN app_users actor ON actor.id=entry.recorded_by
                    WHERE entry.rework_order_id=orders.rework_order_id
                    ORDER BY entry.recorded_at DESC,entry.ie_precount_entry_id DESC
                    LIMIT 200
                  ) recent
                ),'[]'::jsonb) entries
       ) ie_precounts ON true
       LEFT JOIN LATERAL (
         SELECT (sum(receipt.actual_quantity)+batch.actual_quantity_adjustment)::bigint actual_quantity,
                (sum(receipt.defective_quantity)+batch.defective_quantity_adjustment)::bigint defective_quantity
         FROM receiving_batches batch
         JOIN receiving_receipts receipt
           ON receipt.receiving_batch_id=batch.receiving_batch_id
         WHERE batch.receiving_batch_id=orders.source_receiving_batch_id
         GROUP BY batch.receiving_batch_id
       ) receiving ON true
       LEFT JOIN LATERAL (
         SELECT COALESCE(sum(entry.quantity),0)::bigint defective_quantity,
                COALESCE(jsonb_agg(jsonb_build_object(
                  'entryId',entry.entry_id,
                  'quantity',entry.quantity,
                  'recordedBy',COALESCE(actor.display_name,entry.recorded_by::text),
                  'recordedAt',entry.recorded_at
                ) ORDER BY entry.recorded_at DESC,entry.entry_id DESC)
                FILTER (WHERE entry.entry_id IS NOT NULL),'[]'::jsonb) entries
         FROM rework_tail_defective_quantity_entries entry
         LEFT JOIN app_users actor ON actor.id=entry.recorded_by
         WHERE entry.rework_order_id=orders.rework_order_id
       ) tail_defects ON true
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!(await this.canView(actor, row))) {
      throw new ApplicationError("FORBIDDEN", "当前用户与该返工单无业务查看关系", 403);
    }

    const fullBusinessAccess=await this.canView(actor,row,false);
    const attachments = await this.database.query<AttachmentRow>(
      `SELECT attachment.attachment_id,attachment.original_filename,attachment.mime_type,attachment.entity_type
       FROM attachments attachment
       WHERE attachment.status='ready'
         AND ($3::boolean OR attachment.entity_type='external_responsibility_case' OR attachment.mime_type LIKE 'image/%')
         AND NOT (
           attachment.entity_type='receiving_batch'
           AND EXISTS(
             SELECT 1 FROM receiving_attachment_retirements retired
             WHERE retired.attachment_id=attachment.attachment_id
           )
         )
         AND (
           (attachment.entity_type='rework_order' AND attachment.entity_id=$1::text)
           OR (
             attachment.entity_type='receiving_batch'
             AND EXISTS (
               SELECT 1
               FROM rework_orders source_order
               WHERE source_order.rework_order_id=$1::uuid
                 AND source_order.source_receiving_batch_id::text=attachment.entity_id
             )
           )
           OR (
             attachment.entity_type='external_responsibility_case'
             AND EXISTS (
               SELECT 1
               FROM rework_external_responsibility_cases external_case
               WHERE external_case.case_id::text=attachment.entity_id
                 AND external_case.rework_order_id=$1::uuid
                 AND external_responsibility_can_view_case($2,external_case.rework_order_id,external_case.responsibility_type)
             )
           )
         )
       ORDER BY attachment.created_at,attachment.attachment_id`,
      [reworkOrderId, actor.actorId, fullBusinessAccess],
    );

    const workflowHistory = await this.database.query<WorkflowHistoryRow>(
      `SELECT event.action,event.actor_id,event.created_at,event.reason,
              actor.display_name actor_name
       FROM operation_events event
       LEFT JOIN app_users actor ON actor.id=event.actor_id
       WHERE $2::boolean AND ((
         event.entity_type='rework_order' AND event.entity_id=$1
       ) OR event.after_state->>'reworkOrderId'=$1)
       ORDER BY event.created_at,event.event_id
       LIMIT 200`,
      [reworkOrderId, fullBusinessAccess],
    );
    const settlement = await this.database.query<{
      external_status: "not_required" | "in_progress" | "closed" | "revision_in_progress";
      wage_status: "not_required" | "in_progress" | "closed";
      unsettled_wage_periods: Array<{
        periodId: string;
        periodMonth: string;
        status: "pending_tail_review" | "pending_admin_review" | "ready_to_lock";
      }>;
    }>(
      `WITH v2_cases AS (
         SELECT target_case.status
         FROM rework_external_responsibility_cases target_case
         JOIN rework_external_responsibility_batches batch ON batch.batch_id=target_case.batch_id
         JOIN rework_responsibility_determinations determination
           ON determination.determination_id=batch.finalized_determination_id
         WHERE target_case.rework_order_id=$1
           AND determination.settlement_schema_version=2
           AND target_case.status<>'superseded'
           AND external_responsibility_can_view_case($3,target_case.rework_order_id,target_case.responsibility_type)
       ), wage_periods AS (
         SELECT DISTINCT period.period_id,period.period_month,period.status
         FROM rework_wage_items wage
         JOIN rework_wage_periods period ON period.period_id=wage.period_id
         WHERE wage.rework_order_id=$1 AND $2::boolean
       )
       SELECT CASE
         WHEN EXISTS(SELECT 1 FROM v2_cases WHERE status='pending_responsibility_revision') THEN 'revision_in_progress'
         WHEN EXISTS(SELECT 1 FROM v2_cases WHERE status<>'closed') THEN 'in_progress'
         WHEN NOT EXISTS(SELECT 1 FROM v2_cases) THEN 'not_required'
         ELSE 'closed'
       END external_status,
       CASE
         WHEN EXISTS(SELECT 1 FROM wage_periods WHERE status<>'locked') THEN 'in_progress'
         WHEN NOT EXISTS(SELECT 1 FROM wage_periods) THEN 'not_required'
         ELSE 'closed'
       END wage_status,
       CASE WHEN $2::boolean THEN COALESCE((
         SELECT jsonb_agg(
           jsonb_build_object(
             'periodId',period_id,
             'periodMonth',period_month::text,
             'status',status
           ) ORDER BY period_month,period_id
         )
         FROM wage_periods
         WHERE status<>'locked'
       ),'[]'::jsonb) ELSE '[]'::jsonb END unsettled_wage_periods`,
      [reworkOrderId, canViewWagePeriods(actor), actor.actorId],
    );

    return {
      canReadBusinessDetails: fullBusinessAccess,
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      version: row.version,
      styleNo: row.style_no,
      customerSupplyCode: row.customer_supply_code,
      factoryStyleNo: row.factory_style_no,
      orderNo: row.order_no,
      orderQuantity: row.order_quantity === null ? null : Number(row.order_quantity),
      sourceReceivingActualQuantity: row.source_receiving_actual_quantity == null
        ? null
        : Number(row.source_receiving_actual_quantity),
      iePrecounts: {
        canRecord: fullBusinessAccess && canRecordIePrecount(actor)
          && ["in_progress", "pending_order_review"].includes(row.status),
        processes: fullBusinessAccess ? row.ie_precount_processes ?? [] : [],
        entries: fullBusinessAccess ? row.ie_precount_entries ?? [] : [],
      },
      defectiveQuantity: {
        receiving: Number(row.source_receiving_defective_quantity ?? 0),
        receivingLinked: row.source_receiving_defective_quantity !== null,
        tail: Number(row.tail_defective_quantity ?? 0),
        total: Number(row.source_receiving_defective_quantity ?? 0) + Number(row.tail_defective_quantity ?? 0),
        canAddTail: fullBusinessAccess && canAddTailDefectiveQuantity(actor) && tailDefectMutableStatuses.has(row.status),
        tailEntries: (fullBusinessAccess ? row.tail_defective_quantity_entries ?? [] : []).map((entry) => ({
          entryId: entry.entryId,
          quantity: entry.quantity,
          recordedBy: entry.recordedBy,
          recordedAt: entry.recordedAt,
        })),
      },
      supplyContext: {
        washingSupplierName: row.washing_supplier_name ?? null,
        embroiderySupplierName: row.embroidery_supplier_name ?? null,
        fabricSupplierName: row.fabric_supplier_name ?? null,
        embroideryMerchandiserName: row.embroidery_merchandiser_name ?? null,
      },
      merchandiser: row.merchandiser_user_id && row.merchandiser_name
        ? { userId: row.merchandiser_user_id, displayName: row.merchandiser_name }
        : null,
      processingFactory: row.processing_factory_type === "own_factory"
        ? { type: "own_factory", supplierId: null, displayName: "本厂" }
        : row.processing_factory_type === "supplier"
          ? {
              type: "supplier",
              supplierId: row.processing_factory_supplier_id,
              displayName: row.supplier_name ?? "加工厂资料已变更",
            }
          : null,
      reworkReason: row.rework_reason,
      reworkProcess: row.rework_process,
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity === null ? null : Number(row.rework_quantity),
      tailInspectionRequired: row.tail_inspection_required,
      singlePieceReworkTotal: !fullBusinessAccess || row.single_piece_rework_total === null ? null : Number(row.single_piece_rework_total),
      inspectionReport: fullBusinessAccess ? row.inspection_report : null,
      createdBy: { userId: row.created_by, displayName: row.creator_name },
      processConfigurationCreatedBy: fullBusinessAccess && row.configuration_created_by && row.configuration_creator_name
        ? {
            userId: row.configuration_created_by,
            displayName: row.configuration_creator_name,
          }
        : null,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cancelReason: row.cancel_reason,
      settlementStatus: settlement.rows[0]?.external_status ?? "not_required",
      wageSettlementStatus: settlement.rows[0]?.wage_status ?? "not_required",
      unsettledWagePeriods: settlement.rows[0]?.unsettled_wage_periods ?? [],
      attachments: attachments.rows.map((attachment) => ({
        attachmentId: attachment.attachment_id,
        filename: attachment.original_filename,
        mimeType: attachment.mime_type,
        entityType: attachment.entity_type,
      })),
      workflowHistory: workflowHistory.rows.map((event) => ({
        action: event.action,
        handledBy: event.actor_name ?? event.actor_id,
        handledAt: event.created_at.toISOString(),
        remark: event.reason,
      })),
    };
  }

  async addIePrecount(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: Readonly<{ configurationItemId: string; quantity: number; note?: string | undefined }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ value: ReworkBusinessDetail; reused: boolean }>> {
    if (!canRecordIePrecount(actor)) {
      throw new ApplicationError("FORBIDDEN", "只有IE或Root可以记录IE预核数", 403);
    }
    const scope = "rework.ie_precount.record";
    const client = await this.database.connect();
    let reused = false;
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { reworkOrderId, ...input }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 201,
        response: await this.addIePrecountInTransaction(client, actor, reworkOrderId, input),
      }));
      await client.query("COMMIT");
      reused = outcome.reused;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { value: await this.get(actor, reworkOrderId), reused };
  }

  private async addIePrecountInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: Readonly<{ configurationItemId: string; quantity: number; note?: string | undefined }>,
  ): Promise<Readonly<{ entryId: string }>> {
    const target = await client.query<{ status: ReworkOrderStatus; process_name: string }>(
      `SELECT target.status,item.process_name
       FROM rework_orders target
       JOIN rework_process_configurations configuration
         ON configuration.rework_order_id=target.rework_order_id
        AND configuration.status='approved'
       JOIN rework_process_configuration_items item
         ON item.configuration_id=configuration.configuration_id
        AND item.configuration_item_id=$2
        AND item.execution_kind='worker'
       WHERE target.rework_order_id=$1 AND target.status<>'deleted'
       FOR SHARE OF target,item`,
      [reworkOrderId, input.configurationItemId],
    );
    const row = target.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单工序不存在", 404);
    if (!["in_progress", "pending_order_review"].includes(row.status)) {
      throw new ApplicationError("CONFLICT", "IE预核数只允许在N04或N05记录", 409);
    }

    const entryId = randomUUID();
    const eventId = await this.events.append(client, actor, {
      action: "rework.ie_precount.record",
      entityType: "rework_order",
      entityId: reworkOrderId,
      before: { reworkOrderId, referenceOnly: true },
      after: {
        reworkOrderId,
        entryId,
        configurationItemId: input.configurationItemId,
        processName: row.process_name,
        quantity: input.quantity,
        note: input.note ?? null,
        referenceOnly: true,
      },
      ...(input.note ? { reason: input.note } : {}),
    });
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await client.query(
      `INSERT INTO rework_ie_precount_entries(
         ie_precount_entry_id,rework_order_id,configuration_item_id,quantity,note,
         recorded_by,operation_event_id,request_id
       ) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [entryId, reworkOrderId, input.configurationItemId, input.quantity,
        input.note ?? null, actor.actorId, eventId, actor.requestId],
    );
    return { entryId };
  }

  async addTailDefectiveQuantity(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: Readonly<{ expectedVersion: number; quantity: number }>,
    idempotencyKey: string,
  ): Promise<Readonly<{ value: ReworkBusinessDetail; reused: boolean }>> {
    if (!canAddTailDefectiveQuantity(actor)) {
      throw new ApplicationError("FORBIDDEN", "只有尾部主管、老板或Root可以增加尾部次品数量", 403);
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
      throw new ApplicationError("VALIDATION_ERROR", "返工单版本无效", 400);
    }
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 1_000_000) {
      throw new ApplicationError("VALIDATION_ERROR", "新增次品数量必须为正整数", 400);
    }
    const scope = "rework.tail_defective_quantity.add";
    const client = await this.database.connect();
    let reused = false;
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { reworkOrderId, ...input }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 201,
        response: await this.addTailDefectiveQuantityInTransaction(client, actor, reworkOrderId, input),
      }));
      await client.query("COMMIT");
      reused = outcome.reused;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return { value: await this.get(actor, reworkOrderId), reused };
  }

  private async addTailDefectiveQuantityInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: Readonly<{ expectedVersion: number; quantity: number }>,
  ): Promise<Readonly<{ entryId: string; reworkOrderId: string; quantity: number; version: number }>> {
    const orderResult = await client.query<{
      status: ReworkOrderStatus;
      version: number;
      source_receiving_batch_id: string | null;
      rework_quantity: string | null;
    }>(
      `SELECT status,version,source_receiving_batch_id,rework_quantity::text
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       FOR UPDATE`,
      [reworkOrderId],
    );
    const order = orderResult.rows[0];
    if (!order) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!tailDefectMutableStatuses.has(order.status)) {
      throw new ApplicationError("CONFLICT", "当前返工状态不能再增加尾部次品数量", 409);
    }
    if (order.version !== input.expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被其他人更新，请刷新后重试", 409);
    }

    let availableQuantity = Number(order.rework_quantity ?? 0);
    let receivingDefectiveQuantity = 0;
    if (order.source_receiving_batch_id) {
      const receiving = await client.query<{ actual_quantity: string; defective_quantity: string }>(
        `SELECT (COALESCE(sum(receipt.actual_quantity),0)+batch.actual_quantity_adjustment)::text actual_quantity,
                (COALESCE(sum(receipt.defective_quantity),0)+batch.defective_quantity_adjustment)::text defective_quantity
         FROM receiving_batches batch
         LEFT JOIN receiving_receipts receipt ON receipt.receiving_batch_id=batch.receiving_batch_id
         WHERE batch.receiving_batch_id=$1
         GROUP BY batch.receiving_batch_id`,
        [order.source_receiving_batch_id],
      );
      availableQuantity = Number(receiving.rows[0]?.actual_quantity ?? 0);
      receivingDefectiveQuantity = Number(receiving.rows[0]?.defective_quantity ?? 0);
    }
    const tail = await client.query<{ quantity: string }>(
      "SELECT COALESCE(sum(quantity),0)::text quantity FROM rework_tail_defective_quantity_entries WHERE rework_order_id=$1",
      [reworkOrderId],
    );
    const previousTailQuantity = Number(tail.rows[0]?.quantity ?? 0);
    const nextTotal = receivingDefectiveQuantity + previousTailQuantity + input.quantity;
    if (nextTotal > availableQuantity) {
      throw new ApplicationError("VALIDATION_ERROR", `次品总数不能超过实际数量 ${availableQuantity} 件`, 400);
    }

    const entryId = randomUUID();
    const eventId = await this.events.append(client, actor, {
      action: "rework.tail_defective_quantity.add",
      entityType: "rework_order",
      entityId: reworkOrderId,
      before: {
        reworkOrderId,
        receivingDefectiveQuantity,
        tailDefectiveQuantity: previousTailQuantity,
        totalDefectiveQuantity: receivingDefectiveQuantity + previousTailQuantity,
        version: order.version,
      },
      after: {
        reworkOrderId,
        entryId,
        addedQuantity: input.quantity,
        receivingDefectiveQuantity,
        tailDefectiveQuantity: previousTailQuantity + input.quantity,
        totalDefectiveQuantity: nextTotal,
        version: order.version + 1,
      },
    });
    await client.query(
      "SELECT set_config('dx_rework.rework_event_id',$1,true),set_config('dx_rework.rework_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await client.query(
      `INSERT INTO rework_tail_defective_quantity_entries(
         entry_id,rework_order_id,quantity,recorded_by,operation_event_id,request_id
       ) VALUES($1,$2,$3,$4,$5,$6)`,
      [entryId, reworkOrderId, input.quantity, actor.actorId, eventId, actor.requestId],
    );
    await client.query(
      `UPDATE rework_orders
       SET version=version+1,updated_by=$3,updated_at=clock_timestamp()
       WHERE rework_order_id=$1 AND version=$2`,
      [reworkOrderId, order.version, actor.actorId],
    );
    return { entryId, reworkOrderId, quantity: input.quantity, version: order.version + 1 };
  }

  async canDownloadBoundAttachment(
    actor: TrustedActorContext,
    binding: Readonly<{ entityType: string; entityId: string; mimeType?: string }>,
  ): Promise<boolean> {
    let reworkOrderIds: readonly string[] = [];
    if (binding.entityType === "rework_order") {
      reworkOrderIds = [binding.entityId];
    } else if (binding.entityType === "receiving_batch") {
      const receiving = await this.database.query<{ rework_order_id: string }>(
        `SELECT rework_order_id
         FROM rework_orders
         WHERE source_receiving_batch_id::text=$1 AND status<>'deleted'`,
        [binding.entityId],
      );
      reworkOrderIds = receiving.rows.map((row) => row.rework_order_id);
    } else if (binding.entityType === "external_responsibility_case") {
      const externalCase = await this.database.query<{ permitted: boolean }>(
        `SELECT external_responsibility_can_view_case($2,target.rework_order_id,target.responsibility_type) permitted
         FROM rework_external_responsibility_cases target
         JOIN rework_orders orders ON orders.rework_order_id=target.rework_order_id
         WHERE target.case_id::text=$1 AND orders.status<>'deleted'`,
        [binding.entityId, actor.actorId],
      );
      return externalCase.rows[0]?.permitted === true;
    }
    for (const reworkOrderId of reworkOrderIds) {
      try {
        const detail=await this.get(actor, reworkOrderId);
        if(!detail.canReadBusinessDetails && binding.mimeType?.startsWith("image/")!==true) continue;
        return true;
      } catch (error) {
        if (!(error instanceof ApplicationError) || ![403, 404].includes(error.statusCode)) throw error;
      }
    }
    return false;
  }

  private async canView(actor: TrustedActorContext, row: DetailRow, includeFinance = true): Promise<boolean> {
    if(includeFinance) {
      if (await canReadFinanceOrders(this.database,actor)) return true;
      if (actorCapabilities(actor).includes("rework:finance_orders:read")) return false;
    } else if(isScopedFinanceReader(actor)) return false;
    if (broadBusinessReader(actor)) return true;
    if (
      row.created_by === actor.actorId
      || row.merchandiser_user_id === actor.actorId
      || row.embroidery_merchandiser_user_id === actor.actorId
    ) return true;

    if (actorCapabilities(actor).includes("responsibility:determine")) {
      const responsibility = await this.database.query<{ permitted: boolean }>(
        "SELECT responsibility_can_determine($1,$2) permitted",
        [actor.actorId, row.rework_order_id],
      );
      if (responsibility.rows[0]?.permitted === true) return true;
    }

    if (actor.actorRoles.includes("ie_reviewer")) {
      const configuration = await this.database.query(
        "SELECT 1 FROM rework_process_configurations WHERE rework_order_id=$1 LIMIT 1",
        [row.rework_order_id],
      );
      if (configuration.rows[0]) return true;
    }

    if (actor.actorRoles.includes("worker")) {
      const assignment = await this.database.query(
        `SELECT 1
         FROM business_people person
         JOIN rework_work_task_members member ON member.person_id=person.person_id
         JOIN rework_work_tasks task ON task.work_task_id=member.work_task_id
         WHERE person.app_user_id=$1 AND task.rework_order_id=$2
         LIMIT 1`,
        [actor.actorId, row.rework_order_id],
      );
      if (assignment.rows[0]) return true;
    }

    if (
      actor.actorRoles.includes("tail_inspector")
      && actorCapabilities(actor).includes("tail_inspection:report")
    ) {
      const assignment = await this.database.query(
        `SELECT 1
         FROM rework_work_tasks task
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=task.configuration_item_id
          AND item.execution_kind='tail_inspection'
         JOIN rework_work_task_members member ON member.work_task_id=task.work_task_id
         JOIN business_people person ON person.person_id=member.person_id
         WHERE task.rework_order_id=$2 AND task.status='active' AND person.app_user_id=$1
         UNION ALL
         SELECT 1
         FROM rework_tail_inspection_assignments assignment
         WHERE assignment.rework_order_id=$2
           AND assignment.tail_inspector_user_id=$1
           AND assignment.revoked_at IS NULL
         LIMIT 1`,
        [actor.actorId, row.rework_order_id],
      );
      if (assignment.rows[0]) return true;
    }

    if (actor.actorRoles.some((role) => [
      "embroidery_washing_merchandiser",
      ...(includeFinance ? ["factory_payables","embroidery_washing_payables","fabric_payables"] : []),
    ].includes(role))) {
      const external = await this.database.query(
        `SELECT 1
         FROM rework_external_responsibility_cases target_case
         WHERE target_case.rework_order_id=$2
           AND external_responsibility_can_view_case(
             $1,target_case.rework_order_id,target_case.responsibility_type
           )
         LIMIT 1`,
        [actor.actorId, row.rework_order_id],
      );
      if (external.rows[0]) return true;
    }

    if (actor.actorRoles.some((role) => [
      "administrative_clerk",
      ...(includeFinance ? ["wage_month_close_accountant","finance_read"] : []),
    ].includes(role))) {
      const wage = await this.database.query(
        "SELECT 1 FROM rework_wage_items WHERE rework_order_id=$1 LIMIT 1",
        [row.rework_order_id],
      );
      if (wage.rows[0]) return true;
    }

    return false;
  }
}
