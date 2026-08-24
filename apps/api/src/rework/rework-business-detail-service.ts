import type { InspectionReportDraft, ReworkOrderStatus } from "@dx-rework/contracts";
import type { Pool } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";

export type ReworkBusinessDetail = Readonly<{
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
  washing_supplier_name: string | null;
  embroidery_supplier_name: string | null;
  fabric_supplier_name: string | null;
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
  ].includes(role));

const actorCapabilities = (actor: TrustedActorContext): readonly string[] =>
  actor.authorizationCapabilities ?? [actor.authorizationCapability];

const canViewWagePeriods = (actor: TrustedActorContext): boolean =>
  actor.actorRoles.some((role) => ["root_superuser", "owner_group"].includes(role))
  || actorCapabilities(actor).includes("wage:view");

export class ReworkBusinessDetailService {
  constructor(private readonly database: Pool) {}

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
         washing_supplier.supplier_name washing_supplier_name,
         embroidery_supplier.supplier_name embroidery_supplier_name,
         fabric_supplier.supplier_name fabric_supplier_name,
         embroidery_merchandiser.display_name embroidery_merchandiser_name,
         orders.merchandiser_user_id,merchandiser.display_name merchandiser_name,
         orders.processing_factory_type,orders.processing_factory_supplier_id,
         supplier.supplier_name,
         to_jsonb(orders)->>'rework_reason' rework_reason,
         COALESCE(NULLIF(latest_configuration.process_names,''),to_jsonb(orders)->>'rework_process') rework_process,
         orders.problem_part,orders.problem_description,orders.rework_quantity::text,
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
         SELECT configuration.created_by,
                (
                  SELECT string_agg(item.process_name,'、' ORDER BY item.position)
                  FROM rework_process_configuration_items item
                  WHERE item.configuration_id=configuration.configuration_id
                ) process_names
         FROM rework_process_configurations configuration
         WHERE configuration.rework_order_id=orders.rework_order_id
         ORDER BY configuration.configuration_version DESC
         LIMIT 1
       ) latest_configuration ON true
       LEFT JOIN app_users configuration_creator
         ON configuration_creator.id=latest_configuration.created_by
       LEFT JOIN LATERAL (
         SELECT sum(receipt.actual_quantity)::bigint actual_quantity
         FROM receiving_receipts receipt
         WHERE receipt.receiving_batch_id=orders.source_receiving_batch_id
       ) receiving ON true
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!(await this.canView(actor, row))) {
      throw new ApplicationError("FORBIDDEN", "当前用户与该返工单无业务查看关系", 403);
    }

    const attachments = await this.database.query<AttachmentRow>(
      `SELECT attachment.attachment_id,attachment.original_filename,attachment.mime_type,attachment.entity_type
       FROM attachments attachment
       WHERE attachment.status='ready'
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
             )
           )
         )
       ORDER BY attachment.created_at,attachment.attachment_id`,
      [reworkOrderId],
    );

    const workflowHistory = await this.database.query<WorkflowHistoryRow>(
      `SELECT event.action,event.actor_id,event.created_at,event.reason,
              actor.display_name actor_name
       FROM operation_events event
       LEFT JOIN app_users actor ON actor.id=event.actor_id
       WHERE (
         event.entity_type='rework_order' AND event.entity_id=$1
       ) OR event.after_state->>'reworkOrderId'=$1
       ORDER BY event.created_at,event.event_id
       LIMIT 200`,
      [reworkOrderId],
    );
    const settlement = await this.database.query<{
      external_status: "not_required" | "in_progress" | "closed" | "revision_in_progress";
      wage_status: "not_required" | "in_progress" | "closed";
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
       ), wage_periods AS (
         SELECT DISTINCT period.status
         FROM rework_wage_items wage
         JOIN rework_wage_periods period ON period.period_id=wage.period_id
         WHERE wage.rework_order_id=$1
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
       END wage_status`,
      [reworkOrderId],
    );
    const unsettledWagePeriods = canViewWagePeriods(actor)
      ? await this.database.query<{
          period_id: string;
          period_month: string;
          status: "pending_tail_review" | "pending_admin_review" | "ready_to_lock";
        }>(
        `SELECT unsettled.period_id,unsettled.period_month::text period_month,unsettled.status
         FROM (
           SELECT DISTINCT period.period_id,period.period_month,period.status
           FROM rework_wage_items wage
           JOIN rework_wage_periods period ON period.period_id=wage.period_id
           WHERE wage.rework_order_id=$1 AND period.status<>'locked'
         ) unsettled
         ORDER BY unsettled.period_month,unsettled.period_id`,
        [reworkOrderId],
      )
      : { rows: [] as {
          period_id: string;
          period_month: string;
          status: "pending_tail_review" | "pending_admin_review" | "ready_to_lock";
        }[] };

    return {
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
      inspectionReport: row.inspection_report,
      createdBy: { userId: row.created_by, displayName: row.creator_name },
      processConfigurationCreatedBy: row.configuration_created_by && row.configuration_creator_name
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
      unsettledWagePeriods: unsettledWagePeriods.rows.map((period) => ({
        periodId: period.period_id,
        periodMonth: period.period_month,
        status: period.status,
      })),
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

  async canDownloadBoundAttachment(
    actor: TrustedActorContext,
    binding: Readonly<{ entityType: string; entityId: string }>,
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
      const externalCase = await this.database.query<{ rework_order_id: string }>(
        "SELECT rework_order_id FROM rework_external_responsibility_cases WHERE case_id::text=$1",
        [binding.entityId],
      );
      reworkOrderIds = externalCase.rows[0] ? [externalCase.rows[0].rework_order_id] : [];
    }
    for (const reworkOrderId of reworkOrderIds) {
      try {
        await this.get(actor, reworkOrderId);
        return true;
      } catch (error) {
        if (!(error instanceof ApplicationError) || ![403, 404].includes(error.statusCode)) throw error;
      }
    }
    return false;
  }

  private async canView(actor: TrustedActorContext, row: DetailRow): Promise<boolean> {
    if (broadBusinessReader(actor)) return true;
    if (row.created_by === actor.actorId || row.merchandiser_user_id === actor.actorId) return true;

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
      "factory_payables",
      "embroidery_washing_payables",
      "fabric_payables",
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
      "wage_month_close_accountant",
      "finance_read",
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
