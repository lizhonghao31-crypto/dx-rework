import { createHash, randomUUID } from "node:crypto";

import type {
  CloseExternalDeductionCase,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Result<T> = { value: T; reused: boolean };
type CaseReader = {
  getCase(
    actor: TrustedActorContext,
    caseId: string,
    executor: PoolClient,
  ): Promise<ExternalResponsibilityCaseResponse>;
};
type ResponsibilityType =
  | "processing_factory"
  | "embroidery_factory"
  | "washing_factory"
  | "fabric_supplier";
type CaseRow = {
  case_id: string;
  rework_order_id: string;
  responsibility_type: ResponsibilityType;
  proposed_deduction_amount: string;
  case_version: number;
  status: string;
  batch_status: "active" | "superseded";
};
type OrderRow = {
  rework_order_id: string;
  rework_no: string | null;
  status: string;
  version: number;
  style_no: string | null;
  order_no: string | null;
  merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: number | null;
};

const fail = (
  message: string,
  status = 409,
  code = "CONFLICT",
): never => {
  throw new ApplicationError(code, message, status);
};

const orderAudit = (order: OrderRow): Record<string, unknown> => ({
  reworkOrderId: order.rework_order_id,
  reworkNo: order.rework_no,
  status: order.status,
  styleNo: order.style_no,
  orderNo: order.order_no,
  merchandiserUserId: order.merchandiser_user_id,
  processingFactory: order.processing_factory_type === null
    ? null
    : order.processing_factory_type === "own_factory"
      ? { type: "own_factory" }
      : {
          type: "supplier",
          supplierId: order.processing_factory_supplier_id,
          supplierVersion: order.processing_factory_supplier_version,
        },
  problemPart: order.problem_part,
  problemDescription: order.problem_description,
  reworkQuantity: order.rework_quantity,
  version: order.version,
});

/**
 * Narrow PR-11 close path.
 *
 * The original service used `$4-$5` with two unknown protocol parameters,
 * which PostgreSQL cannot resolve. This implementation keeps the same locking,
 * authorization, audit, attachment and idempotency rules while explicitly
 * casting both amounts to numeric.
 */
export class ExternalResponsibilityCloseService {
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();

  constructor(
    private readonly database: Pool,
    private readonly reader: CaseReader,
    private readonly todos?: TodoProjectionService,
  ) {}

  async close(
    actor: TrustedActorContext,
    caseId: string,
    input: CloseExternalDeductionCase,
    key: string,
  ): Promise<Result<ExternalResponsibilityCaseResponse>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute(client, {
        scope: "rework.external_deduction.close",
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ caseId, input }))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 200,
        response: await this.performClose(client, actor, caseId, input),
      }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async performClose(
    client: PoolClient,
    actor: TrustedActorContext,
    caseId: string,
    input: CloseExternalDeductionCase,
  ): Promise<ExternalResponsibilityCaseResponse> {
    const currentResult = await client.query<CaseRow>(
      `SELECT target_case.case_id,target_case.rework_order_id,
              target_case.responsibility_type,
              target_case.proposed_deduction_amount::text,
              target_case.case_version,target_case.status,
              batch.status batch_status
       FROM rework_external_responsibility_cases target_case
       JOIN rework_external_responsibility_batches batch
         ON batch.batch_id=target_case.batch_id
       WHERE target_case.case_id=$1
       FOR UPDATE OF target_case,batch`,
      [caseId],
    );
    const current = currentResult.rows[0]
      ?? fail("外部责任台账不存在", 404, "NOT_FOUND");
    if (current.batch_status !== "active") {
      fail("责任版本已被替代，不能继续处理历史案件", 409, "INVALID_STATE_TRANSITION");
    }
    if (
      current.case_version !== input.expectedCaseVersion
      || current.status !== "deduction_follow_up"
    ) {
      fail("外部责任台账版本或状态冲突");
    }

    const permission = await client.query<{ permitted: boolean }>(
      `SELECT external_responsibility_can_payables($1,$2,$3) permitted`,
      [actor.actorId, current.rework_order_id, current.responsibility_type],
    );
    if (!permission.rows[0]?.permitted) {
      fail("当前用户无权关闭扣款台账", 403, "FORBIDDEN");
    }

    if (new Set(input.evidenceAttachmentIds).size !== input.evidenceAttachmentIds.length) {
      fail("附件不能重复", 400, "VALIDATION_ERROR");
    }
    if (input.evidenceAttachmentIds.length > 0) {
      const ready = await client.query(
        `SELECT attachment_id
         FROM attachments
         WHERE attachment_id=ANY($1::uuid[]) AND status='ready'`,
        [input.evidenceAttachmentIds],
      );
      if (ready.rowCount !== input.evidenceAttachmentIds.length) {
        fail("附件必须已完成并处于 ready 状态", 409, "ATTACHMENT_NOT_READY");
      }
    }

    const orderResult = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,
              problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       FOR UPDATE`,
      [current.rework_order_id],
    );
    const order = orderResult.rows[0]
      ?? fail("返工单不存在", 404, "NOT_FOUND");

    const ledger = await client.query<{
      actual: string;
      is_full: boolean;
    }>(
      `SELECT COALESCE(sum(entry.amount),0)::text actual,
              COALESCE(sum(entry.amount),0)=case_record.proposed_deduction_amount is_full
       FROM rework_external_responsibility_cases case_record
       LEFT JOIN rework_external_deduction_entries entry
         ON entry.case_id=case_record.case_id
       WHERE case_record.case_id=$1
       GROUP BY case_record.proposed_deduction_amount`,
      [caseId],
    );
    const totals = ledger.rows[0]
      ?? fail("扣款台账缺少服务器金额", 409, "CONFLICT");
    if (input.result !== "full" || !totals.is_full) {
      fail(
        "实际扣款未达到拟扣金额时必须转财务总监特批",
        400,
        "VALIDATION_ERROR",
      );
    }

    const eventId = await this.events.append(
      client,
      { ...actor, authorizationCapability: "external_deduction:close" },
      {
        action: "rework.external_deduction.close",
        entityType: "rework_order",
        entityId: order.rework_order_id,
        before: orderAudit(order),
        after: orderAudit(order),
      },
    );
    await client.query(
      `SELECT
         set_config('dx_rework.external_responsibility_event_id',$1,true),
         set_config('dx_rework.external_responsibility_request_id',$2,true)`,
      [eventId, actor.requestId],
    );

    if (input.evidenceAttachmentIds.length > 0) {
      const candidates = await client.query(
        `SELECT attachment_id
         FROM attachments
         WHERE attachment_id=ANY($1::uuid[])
           AND uploaded_by=$2 AND status='ready'
           AND (
             (entity_type IS NULL AND entity_id IS NULL)
             OR (
               entity_type='external_responsibility_case'
               AND entity_id=$3
             )
           )
         FOR UPDATE`,
        [input.evidenceAttachmentIds, actor.actorId, caseId],
      );
      if (candidates.rowCount !== input.evidenceAttachmentIds.length) {
        fail(
          "附件未完成、并非本人上传或已绑定其他业务",
          409,
          "ATTACHMENT_NOT_READY",
        );
      }
      await client.query(
        `UPDATE attachments
         SET entity_type='external_responsibility_case',entity_id=$2,
             updated_at=CURRENT_TIMESTAMP
         WHERE attachment_id=ANY($1::uuid[])
           AND entity_type IS NULL AND entity_id IS NULL`,
        [input.evidenceAttachmentIds, caseId],
      );
    }

    await client.query(
      `INSERT INTO rework_external_deduction_closures(
         closure_id,case_id,result,proposed_amount,
         actual_deducted_amount,remaining_amount,reason,
         evidence_attachment_ids,remaining_difference_disposition,
         closed_by,operation_event_id,request_id
       ) VALUES(
         $1,$2,$3,$4::numeric,$5::numeric,
         $4::numeric-$5::numeric,$6,$7,$8,$9,$10,$11
       )`,
      [
        randomUUID(),
        caseId,
        input.result,
        current.proposed_deduction_amount,
        totals.actual,
        input.reason ?? null,
        input.evidenceAttachmentIds,
        input.remainingDifferenceDisposition ?? null,
        actor.actorId,
        eventId,
        actor.requestId,
      ],
    );
    await client.query(
      `UPDATE rework_external_responsibility_cases
       SET status='closed',case_version=case_version+1
       WHERE case_id=$1`,
      [caseId],
    );
    await this.todos?.completeOpenByDedupePrefix(
      client,
      actor,
      `deduction-follow-up:${caseId}:`,
      "External deduction case was closed",
    );
    await this.todos?.completeOpenByDedupePrefix(
      client,
      actor,
      `deduction-overdue:${caseId}:`,
      "External deduction case was closed",
    );
    await this.todos?.completeOpenByDedupePrefix(
      client,
      actor,
      `external-deduction:${caseId}:`,
      "External deduction case was closed",
    );
    return this.reader.getCase(actor, caseId, client);
  }
}
