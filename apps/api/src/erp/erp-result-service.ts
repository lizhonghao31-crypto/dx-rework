import { ErpReworkResultV1Schema, type ErpReworkResultV1 } from "@dx-rework/contracts/erp-integration";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import {
  ERP_INTEGRATION_SERVICE_ACTOR_ID,
  ERP_INTEGRATION_SERVICE_ROLE,
} from "./erp-integration-identity.js";

type IntakeMode = "erp" | "emergency";

const databaseCode = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : undefined;

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  const code = databaseCode(error);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前身份无权读取ERP结果契约", 403);
  if (code === "22P02") throw new ApplicationError("VALIDATION_ERROR", "返工单标识无效", 400);
  throw error;
};

type ResultRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: string;
  source_system: string;
  external_id: string;
  external_idempotency_key: string;
  erp_node_id: string | null;
  intake_mode: IntakeMode;
  linked_external_id: string | null;
  linked_external_idempotency_key: string | null;
  linked_erp_node_id: string | null;
  updated_at: Date;
  completed_quantity: string;
  wage_total_amount: string;
  wage_items: unknown;
  responsibility_total_amount: string;
  own_factory_amount: string;
  responsibility_allocations: unknown;
  proposed_amount: string;
  deducted_amount: string;
  remaining_amount: string;
  approval_status: "pending" | "approved" | "rejected" | null;
  approval_decision: "approved" | "rejected" | null;
  approval_decided_at: Date | null;
  attachments: unknown;
  as_of: Date;
}>;

async function ensureIntegrationPrincipal(client: PoolClient): Promise<void> {
  const principal = await client.query(
    `SELECT 1
     FROM erp_integration_principals principal
     JOIN app_users actor ON actor.id=principal.principal_id
     WHERE principal.principal_key='erp' AND principal.active=true
       AND actor.enabled=true AND actor.id=$1`,
    [ERP_INTEGRATION_SERVICE_ACTOR_ID],
  );
  if (!principal.rows[0]) {
    throw new ApplicationError("INTEGRATION_DISABLED", "ERP集成身份未启用", 503);
  }
}

async function ensureResultActor(
  client: PoolClient,
  actor: TrustedActorContext,
): Promise<void> {
  if (
    actor.actorId === ERP_INTEGRATION_SERVICE_ACTOR_ID
    && actor.actorRoles.includes(ERP_INTEGRATION_SERVICE_ROLE)
  ) {
    await ensureIntegrationPrincipal(client);
    return;
  }
  if (
    actor.authorizationCapability !== "erp:result:read"
    || !actor.actorRoles.includes("system_admin")
  ) {
    throw new ApplicationError("FORBIDDEN", "当前身份无权读取ERP结果契约", 403);
  }
  await client.query("SELECT access_authorized_actor_roles($1,'erp:result:read')", [
    actor.actorId,
  ]);
}

export async function loadErpReworkResult(
  database: Pool,
  actor: TrustedActorContext,
  reworkOrderId: string,
): Promise<ErpReworkResultV1> {
  const client = await database.connect();
  try {
    await client.query("BEGIN TRANSACTION READ ONLY");
    await ensureResultActor(client, actor);
    const result = await client.query<ResultRow>(
      `WITH valid_reports AS (
         SELECT COALESCE(sum(report.actual_quantity),0)::numeric(14,2)::text completed_quantity
         FROM rework_work_reports report
         LEFT JOIN rework_work_report_rejections rejection
           ON rejection.work_report_id=report.work_report_id
         WHERE report.rework_order_id=$1 AND rejection.work_report_id IS NULL
       ), approved_adjustments AS (
         SELECT original_wage_item_id,sum(adjustment_amount) adjustment_amount
         FROM rework_wage_adjustments
         WHERE status='approved'
         GROUP BY original_wage_item_id
       ), wage_items AS (
         SELECT wage.person_id,wage.person_name_snapshot,
           sum(wage.payable_amount+COALESCE(adjustment.adjustment_amount,0))::numeric(18,2)::text amount
         FROM rework_wage_items wage
         LEFT JOIN approved_adjustments adjustment
           ON adjustment.original_wage_item_id=wage.wage_item_id
         WHERE wage.rework_order_id=$1
         GROUP BY wage.person_id,wage.person_name_snapshot
       ), wage_summary AS (
         SELECT
           COALESCE(sum(items.amount::numeric),0)::numeric(18,2)::text total_amount,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'personId',items.person_id,
                 'personName',items.person_name_snapshot,
                 'amount',items.amount
               )
               ORDER BY items.person_name_snapshot,items.person_id
             ),
             '[]'::jsonb
           ) items
         FROM wage_items items
       ), current_determination AS (
         SELECT determination.*
         FROM rework_responsibility_determinations determination
         WHERE determination.rework_order_id=$1
           AND determination.stage='finalized'
           AND NOT EXISTS(
             SELECT 1
             FROM rework_responsibility_determinations successor
             WHERE successor.replaces_determination_id=determination.determination_id
           )
         ORDER BY determination.determination_version DESC
         LIMIT 1
       ), responsibility_by_type AS (
         SELECT allocation.responsibility_type,
           sum(allocation.rounded_amount)::numeric(18,2)::text amount
         FROM current_determination determination
         JOIN rework_responsibility_allocations allocation
           ON allocation.determination_id=determination.determination_id
         GROUP BY allocation.responsibility_type
       ), responsibility_summary AS (
         SELECT
           COALESCE(sum(allocation.amount::numeric),0)::numeric(18,2)::text total_amount,
           COALESCE(
             sum(allocation.amount::numeric)
               FILTER(WHERE allocation.responsibility_type='own_factory'),
             0
           )::numeric(18,2)::text own_factory_amount,
           COALESCE(
             jsonb_agg(
               jsonb_build_object(
                 'responsibilityType',allocation.responsibility_type,
                 'amount',allocation.amount
               )
               ORDER BY allocation.responsibility_type
             ),
             '[]'::jsonb
           ) allocations
         FROM responsibility_by_type allocation
       ), active_cases AS (
         SELECT case_record.*
         FROM current_determination determination
         JOIN rework_external_responsibility_batches batch
           ON batch.finalized_determination_id=determination.determination_id
          AND batch.status='active'
         JOIN rework_external_responsibility_cases case_record USING(batch_id)
         WHERE case_record.status<>'superseded'
       ), entry_totals AS (
         SELECT case_id,COALESCE(sum(amount),0) actual
         FROM rework_external_deduction_entries
         GROUP BY case_id
       ), deduction_summary AS (
         SELECT
           COALESCE(sum(case_record.proposed_deduction_amount),0)::numeric(18,2)::text proposed_amount,
           COALESCE(
             sum(COALESCE(closure.actual_deducted_amount,entry.actual,0)),
             0
           )::numeric(18,2)::text deducted_amount,
           COALESCE(
             sum(
               COALESCE(
                 closure.remaining_amount,
                 case_record.proposed_deduction_amount-COALESCE(entry.actual,0)
               )
             ),
             0
           )::numeric(18,2)::text remaining_amount
         FROM active_cases case_record
         LEFT JOIN entry_totals entry USING(case_id)
         LEFT JOIN rework_external_deduction_closures closure USING(case_id)
       ), approval_summary AS (
         SELECT approval.status,decision.decision,decision.decided_at
         FROM current_determination determination
         JOIN rework_own_factory_approvals approval
           ON approval.finalized_determination_id=determination.determination_id
         LEFT JOIN rework_own_factory_approval_decisions decision
           ON decision.approval_id=approval.approval_id
         LIMIT 1
       ), attachment_summary AS (
         SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'attachmentId',attachment.attachment_id,
               'filename',attachment.original_filename,
               'mimeType',attachment.mime_type,
               'sizeBytes',attachment.size_bytes,
               'sha256',attachment.sha256,
               'createdAt',to_char(
                 attachment.created_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
               )
             )
             ORDER BY attachment.created_at,attachment.attachment_id
           ),
           '[]'::jsonb
         ) attachments
         FROM attachments attachment
         WHERE attachment.entity_type='rework_order'
           AND attachment.entity_id=$1::text
           AND attachment.status='ready'
       )
       SELECT
         orders.rework_order_id,orders.rework_no,orders.status,
         orders.source_system,orders.external_id,orders.external_idempotency_key,
         orders.erp_node_id,intake.intake_mode,
         link.external_id linked_external_id,
         link.external_idempotency_key linked_external_idempotency_key,
         link.erp_node_id linked_erp_node_id,
         orders.updated_at,
         reports.completed_quantity,
         wages.total_amount wage_total_amount,
         wages.items wage_items,
         responsibility.total_amount responsibility_total_amount,
         responsibility.own_factory_amount,
         responsibility.allocations responsibility_allocations,
         deduction.proposed_amount,deduction.deducted_amount,deduction.remaining_amount,
         approval.status approval_status,
         approval.decision approval_decision,
         approval.decided_at approval_decided_at,
         attachments.attachments,
         CURRENT_TIMESTAMP as_of
       FROM rework_orders orders
       JOIN erp_rework_intakes intake USING(rework_order_id)
       LEFT JOIN erp_rework_links link USING(rework_order_id)
       CROSS JOIN valid_reports reports
       CROSS JOIN wage_summary wages
       CROSS JOIN responsibility_summary responsibility
       CROSS JOIN deduction_summary deduction
       CROSS JOIN attachment_summary attachments
       LEFT JOIN approval_summary approval ON true
       WHERE orders.rework_order_id=$1
         AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在或不是ERP接入记录", 404);

    const original = {
      sourceSystem: row.source_system,
      externalId: row.external_id,
      externalIdempotencyKey: row.external_idempotency_key,
      erpNodeId: row.erp_node_id,
    };
    const linkedErp = row.intake_mode === "erp"
      ? {
          sourceSystem: "erp" as const,
          externalId: row.external_id,
          externalIdempotencyKey: row.external_idempotency_key,
          erpNodeId: row.erp_node_id,
        }
      : row.linked_external_id && row.linked_external_idempotency_key && row.linked_erp_node_id
        ? {
            sourceSystem: "erp" as const,
            externalId: row.linked_external_id,
            externalIdempotencyKey: row.linked_external_idempotency_key,
            erpNodeId: row.linked_erp_node_id,
          }
        : null;
    const response = ErpReworkResultV1Schema.parse({
      contractVersion: "1",
      source: {
        original,
        linkedErp,
        linkageStatus: linkedErp ? "linked" : "pending",
      },
      reworkOrder: {
        reworkOrderId: row.rework_order_id,
        reworkNo: row.rework_no,
        status: row.status,
        completedQuantity: row.completed_quantity,
        updatedAt: row.updated_at.toISOString(),
      },
      workerWages: {
        totalAmount: row.wage_total_amount,
        items: row.wage_items,
      },
      responsibility: {
        totalAmount: row.responsibility_total_amount,
        ownFactoryAmount: row.own_factory_amount,
        allocations: row.responsibility_allocations,
      },
      deduction: {
        proposedAmount: row.proposed_amount,
        deductedAmount: row.deducted_amount,
        remainingAmount: row.remaining_amount,
      },
      approval: {
        ownFactory: row.approval_status
          ? {
              status: row.approval_status,
              decision: row.approval_decision,
              decidedAt: row.approval_decided_at?.toISOString() ?? null,
            }
          : null,
      },
      attachments: row.attachments,
      asOf: row.as_of.toISOString(),
    });
    await client.query("COMMIT");
    return response;
  } catch (error: unknown) {
    await client.query("ROLLBACK").catch(() => undefined);
    return translateDatabaseError(error);
  } finally {
    client.release();
  }
}
