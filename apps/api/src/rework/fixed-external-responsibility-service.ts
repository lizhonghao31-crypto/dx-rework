import type {
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ExternalResponsibilityService } from "./external-responsibility-service.js";

type Queryable = Pool | PoolClient;
type ResponsibilityType =
  | "processing_factory"
  | "embroidery_factory"
  | "washing_factory"
  | "fabric_supplier";

const fail = (
  message: string,
  status = 409,
  code = "CONFLICT",
): never => {
  throw new ApplicationError(code, message, status);
};

/**
 * Narrow SQL repair for the original PR-11 service.
 *
 * The original joined case query used unqualified `rework_order_id` and
 * `responsibility_type`, which PostgreSQL correctly rejects because both joined
 * relations expose the order column. Inherited commands call `this.get()`, so
 * this override repairs reads for every mutation without duplicating the
 * existing transaction, amount, idempotency, or authorization code.
 */
export class FixedExternalResponsibilityService
  extends ExternalResponsibilityService {
  constructor(private readonly reviewedDatabase: Pool) {
    super(reviewedDatabase);
  }

  override async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Queryable = this.reviewedDatabase,
  ): Promise<ExternalResponsibilityBatchResponse> {
    const allowed = await executor.query<{ permitted: boolean }>(
      "SELECT external_responsibility_can_view($1,$2) permitted",
      [actor.actorId, orderId],
    );
    if (!allowed.rows[0]?.permitted) {
      fail("当前用户无权查看外部责任台账", 403, "FORBIDDEN");
    }
    const batch = await executor.query<{
      batch_id: string;
      rework_order_id: string;
      finalized_determination_id: string;
      finalized_determination_version: number;
      batch_version: number;
      status: "active" | "superseded";
      source_snapshot: Record<string, unknown>;
    }>(
      `SELECT batch_id,rework_order_id,finalized_determination_id,
              finalized_determination_version,batch_version,status,
              source_snapshot
       FROM rework_external_responsibility_batches
       WHERE rework_order_id=$1 AND status='active'
       ORDER BY created_at DESC
       LIMIT 1`,
      [orderId],
    );
    const head = batch.rows[0];
    if (!head) return null;

    const items = await executor.query<{
      external_item_id: string;
      configuration_item_id: string;
      responsibility_type: ResponsibilityType;
      process_snapshot: Record<string, unknown>;
      multiplier_snapshot: string;
      share_bps_snapshot: number;
      proposed_amount: string;
      amount_line_snapshot: Record<string, unknown>;
    }>(
      `SELECT item.external_item_id,item.configuration_item_id,
              item.responsibility_type,item.process_snapshot,
              item.multiplier_snapshot::text,item.share_bps_snapshot,
              item.proposed_amount::text,item.amount_line_snapshot
       FROM rework_external_responsibility_items item
       WHERE item.batch_id=$1 AND (
         external_responsibility_can_view_all($2)
         OR external_responsibility_can_sign(
           $2,$3,item.responsibility_type
         )
         OR EXISTS(
           SELECT 1
           FROM rework_external_responsibility_case_items mapping
           JOIN rework_external_responsibility_cases target_case
             ON target_case.case_id=mapping.case_id
           WHERE mapping.external_item_id=item.external_item_id
             AND external_responsibility_can_view_case(
               $2,target_case.rework_order_id,
               target_case.responsibility_type
             )
         )
       )
       ORDER BY item.configuration_item_id,item.responsibility_type`,
      [head.batch_id, actor.actorId, orderId],
    );
    const cases = await executor.query<{ case_id: string }>(
      `SELECT target_case.case_id
       FROM rework_external_responsibility_cases target_case
       JOIN rework_external_responsibility_batches batch
         ON batch.batch_id=target_case.batch_id
       WHERE target_case.batch_id=$1
         AND external_responsibility_can_view_case(
           $2,target_case.rework_order_id,
           target_case.responsibility_type
         )
       ORDER BY target_case.created_at,target_case.case_id`,
      [head.batch_id, actor.actorId],
    );
    const caseValues = await Promise.all(
      cases.rows.map(async (item) => {
        const value = await super.getCase(actor, item.case_id, executor);
        return value as ExternalResponsibilityCaseResponse;
      }),
    );
    return {
      batchId: head.batch_id,
      reworkOrderId: head.rework_order_id,
      finalizedDeterminationId: head.finalized_determination_id,
      finalizedDeterminationVersion: head.finalized_determination_version,
      batchVersion: head.batch_version,
      status: head.status,
      sourceSnapshot: head.source_snapshot,
      items: items.rows.map((item) => ({
        externalItemId: item.external_item_id,
        configurationItemId: item.configuration_item_id,
        responsibilityType: item.responsibility_type,
        processSnapshot: item.process_snapshot,
        multiplierSnapshot: item.multiplier_snapshot,
        shareBpsSnapshot: item.share_bps_snapshot,
        proposedAmount: item.proposed_amount,
        amountLineSnapshot: item.amount_line_snapshot,
      })),
      cases: caseValues,
    };
  }
}
