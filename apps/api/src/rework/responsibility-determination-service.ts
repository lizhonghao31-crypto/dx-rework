import { createHash, randomUUID } from "node:crypto";
import type {
  CreateResponsibilityDraft,
  FinalizeResponsibility,
  ResponsibilityDeterminationResponse,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};

export const decimalToScaled = (value: string, scale: number): bigint => {
  if (!/^\d+(?:\.\d+)?$/.test(value)) {
    fail("Invalid decimal", 400, "VALIDATION_ERROR");
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > scale) {
    fail("Decimal precision exceeded", 400, "VALIDATION_ERROR");
  }
  return (
    BigInt(whole!) * 10n ** BigInt(scale) +
    BigInt(fraction.padEnd(scale, "0"))
  );
};

export const halfUp2 = (numerator: bigint, denominator: bigint): bigint =>
  ((numerator * 100n * 2n) / denominator + 1n) / 2n;

export const cents = (value: bigint): string =>
  `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;

export const validateBps = (
  rows: readonly { shareBps: number }[],
): void => {
  if (
    rows.length === 0
    || rows.some((row) => !Number.isInteger(row.shareBps) || row.shareBps <= 0)
    || rows.reduce((sum, row) => sum + row.shareBps, 0) !== 10000
  ) {
    fail(
      "Each process must have one or more positive responsibility shares totaling 100%",
      400,
      "VALIDATION_ERROR",
    );
  }
};

export const applyBatchMultiplier = <
  T extends { configurationItemId: string },
>(
  rows: readonly T[],
  ids: readonly string[],
  multiplier: string,
): (T & { multiplier: string })[] =>
  rows.map((row) => ({
    ...row,
    multiplier: ids.includes(row.configurationItemId)
      ? multiplier
      : "multiplier" in row
        ? String(row.multiplier)
        : "1",
  }));

type Result<T> = { value: T; reused: boolean };
type ReworkStatus = ResponsibilityDeterminationResponse["reworkStatus"];
type PricingUnit =
  ResponsibilityDeterminationResponse["sourceProcesses"][number]["pricingUnit"];
type DeterminationView = NonNullable<
  ResponsibilityDeterminationResponse["determination"]
>;
type DeterminationStage = DeterminationView["stage"];
type AllocationView =
  DeterminationView["processes"][number]["allocations"][number];

type OrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkStatus;
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
}>;

type DeterminationRow = Readonly<{
  determination_id: string;
  rework_order_id: string;
  determination_version: number;
  replaces_determination_id: string | null;
  source_order_review_id: string;
  stage: DeterminationStage;
  handler_user_id: string;
  created_by: string;
  reason: string | null;
  calculation_total: string;
  confirmed: boolean;
  settlement_schema_version: 1 | 2;
}>;

type ProcessViewRow = Readonly<{
  configuration_item_id: string;
  process_name_snapshot: string;
  pricing_unit_snapshot: PricingUnit;
  multiplier: string;
  high_multiplier_reason: string | null;
  base_amount: string;
  responsibility_amount: string;
  allocations: AllocationView[];
}>;

type SourceProcessRow = Readonly<{
  configuration_item_id: string;
  process_name: string;
  pricing_unit: PricingUnit;
  base_amount: string;
}>;

type ApprovedProcessRow = Readonly<{
  configuration_item_id: string;
  process_name: string;
  pricing_unit: PricingUnit;
}>;

type WorkReportShareRow = Readonly<{
  work_report_id: string;
  person_id: string;
  amount: string;
  display_name_snapshot: string;
  assignment_mode: "individual" | "collective";
}>;

type ResponsibilityProcessInput =
  CreateResponsibilityDraft["processes"][number];
type ResponsibilityAllocationInput =
  ResponsibilityProcessInput["allocations"][number];

type ResponsibilityAmountLine = Readonly<{
  share: WorkReportShareRow;
  allocation: ResponsibilityAllocationInput;
  rounded: bigint;
  unrounded: string;
}>;

type ResponsibilityProcessCalculation = Readonly<{
  input: ResponsibilityProcessInput;
  approved: ApprovedProcessRow;
  shares: WorkReportShareRow[];
  lines: ResponsibilityAmountLine[];
  processTotal: bigint;
}>;

/**
 * Exact-decimal responsibility draft engine.
 *
 * Production HTTP routes are wired through
 * ResponsibilityDeterminationApplicationService. This class owns the amount
 * engine and the S1 snapshot-finalization primitive used by database closure
 * tests; authorization for production commands is enforced by the application
 * and authorized services plus database guards.
 */
export class ResponsibilityDeterminationService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Pool | PoolClient = this.database,
  ): Promise<ResponsibilityDeterminationResponse> {
    const orderResult = await executor.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'`, [
      orderId,
    ]);
    const order =
      orderResult.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");

    const roundingAdjustmentsAvailable =
      await this.roundingAdjustmentsAvailable(executor);
    const determinationResult = await executor.query<DeterminationRow>(
      roundingAdjustmentsAvailable
        ? `SELECT d.*,
              (
                d.calculation_total + COALESCE((
                  SELECT sum(adjustment.adjustment_amount)
                  FROM rework_responsibility_rounding_adjustments adjustment
                  WHERE adjustment.determination_id=d.determination_id
                ),0)
              )::text calculation_total,
              EXISTS(
                SELECT 1
                FROM rework_responsibility_high_multiplier_confirmations confirmation
                WHERE confirmation.determination_id=d.determination_id
              ) confirmed
       FROM rework_responsibility_determinations d
       WHERE d.rework_order_id=$1
         AND NOT EXISTS(
           SELECT 1
           FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=d.determination_id
         )`
        : `SELECT d.*,
              EXISTS(
                SELECT 1
                FROM rework_responsibility_high_multiplier_confirmations confirmation
                WHERE confirmation.determination_id=d.determination_id
              ) confirmed
       FROM rework_responsibility_determinations d
       WHERE d.rework_order_id=$1
         AND NOT EXISTS(
           SELECT 1
           FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=d.determination_id
         )`,
      [orderId],
    );
    const determination = determinationResult.rows[0] ?? null;

    const processRows: ProcessViewRow[] = determination
      ? (
          await executor.query<ProcessViewRow>(
            roundingAdjustmentsAvailable
              ? `SELECT
                    process.configuration_item_id,
                    process.process_name_snapshot,
                    process.pricing_unit_snapshot,
                    process.multiplier::text,
                    process.high_multiplier_reason,
                    process.base_amount::text,
                    (
                      process.responsibility_amount +
                      COALESCE(adjustment.adjustment_amount,0)
                    )::text responsibility_amount,
                    COALESCE(
                      json_agg(
                        json_build_object(
                          'responsibilityType',allocation.responsibility_type,
                          'shareBps',allocation.share_bps,
                          'roundedAmount',(
                            allocation.rounded_amount +
                            CASE
                              WHEN allocation.responsibility_type =
                                adjustment.responsibility_type
                              THEN COALESCE(adjustment.adjustment_amount,0)
                              ELSE 0
                            END
                          )::text,
                          'multiplier',COALESCE(allocation.multiplier,process.multiplier)::text,
                          'supplier',CASE WHEN allocation.supplier_id IS NULL THEN NULL ELSE
                            json_build_object(
                              'supplierId',allocation.supplier_id,
                              'version',allocation.supplier_version,
                              'code',allocation.supplier_code_snapshot,
                              'name',allocation.supplier_name_snapshot,
                              'type',allocation.supplier_type_snapshot
                            ) END
                        )
                        ORDER BY allocation.responsibility_type
                      ) FILTER (WHERE allocation.responsibility_type IS NOT NULL),
                      '[]'
                    ) allocations
             FROM rework_responsibility_processes process
             LEFT JOIN rework_responsibility_allocations allocation
               USING(determination_id,configuration_item_id)
             LEFT JOIN rework_responsibility_rounding_adjustments adjustment
               USING(determination_id,configuration_item_id)
             WHERE process.determination_id=$1
             GROUP BY
               process.determination_id,
               process.configuration_item_id,
               adjustment.adjustment_amount,
               adjustment.responsibility_type`
              : `SELECT process.*,
                    COALESCE(
                      json_agg(
                        json_build_object(
                          'responsibilityType',allocation.responsibility_type,
                          'shareBps',allocation.share_bps,
                          'roundedAmount',allocation.rounded_amount::text,
                          'multiplier',COALESCE(allocation.multiplier,process.multiplier)::text,
                          'supplier',CASE WHEN allocation.supplier_id IS NULL THEN NULL ELSE
                            json_build_object(
                              'supplierId',allocation.supplier_id,
                              'version',allocation.supplier_version,
                              'code',allocation.supplier_code_snapshot,
                              'name',allocation.supplier_name_snapshot,
                              'type',allocation.supplier_type_snapshot
                            ) END
                        )
                        ORDER BY allocation.responsibility_type
                      ) FILTER (WHERE allocation.responsibility_type IS NOT NULL),
                      '[]'
                    ) allocations
             FROM rework_responsibility_processes process
             LEFT JOIN rework_responsibility_allocations allocation
               USING(determination_id,configuration_item_id)
             WHERE process.determination_id=$1
             GROUP BY process.determination_id,process.configuration_item_id`,
            [determination.determination_id],
          )
        ).rows
      : [];

    // Responsibility uses the reviewed process price and final quantity, not
    // the temporary-worker wage uplift. Wage items remain the immutable member
    // roster, while the unadjusted share is derived from their source snapshots.
    // The fallback keeps historical migration-replay tests usable before the
    // wage tables existed.
    const settledWageItemsAvailable = await this.settledWageItemsAvailable(executor);
    const sourceRows = await executor.query<SourceProcessRow>(
      settledWageItemsAvailable
        ? `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,
                  COALESCE(sum(round(
                    wage.actual_quantity_snapshot*wage.unit_price_snapshot*
                    CASE WHEN wage.assignment_mode='collective'
                      THEN 1::numeric/NULLIF(wage.member_count,0)
                      ELSE 1
                    END,
                    8
                  )),0)::text base_amount
           FROM rework_process_configurations configuration
           JOIN rework_process_configuration_items item USING(configuration_id)
           LEFT JOIN rework_wage_items wage
             ON wage.rework_order_id=configuration.rework_order_id
            AND wage.configuration_item_id=item.configuration_item_id
            AND wage.invalidated_at IS NULL
           WHERE configuration.rework_order_id=$1
             AND configuration.status='approved'
             AND item.execution_kind='worker'
           GROUP BY item.configuration_item_id,item.process_name,item.pricing_unit
           ORDER BY item.configuration_item_id`
        : `SELECT item.configuration_item_id,item.process_name,item.pricing_unit,
                  COALESCE(sum(share.amount),0)::text base_amount
           FROM rework_process_configurations configuration
           JOIN rework_process_configuration_items item USING(configuration_id)
           LEFT JOIN rework_work_reports report
             ON report.rework_order_id=configuration.rework_order_id
            AND report.configuration_item_id=item.configuration_item_id
            AND report.status='submitted'
            AND NOT EXISTS(
              SELECT 1 FROM rework_work_report_rejections rejection
              WHERE rejection.work_report_id=report.work_report_id
            )
           LEFT JOIN rework_work_report_member_shares share USING(work_report_id)
           WHERE configuration.rework_order_id=$1
             AND configuration.status='approved'
             AND item.execution_kind='worker'
           GROUP BY item.configuration_item_id,item.process_name,item.pricing_unit
           ORDER BY item.configuration_item_id`,
      [orderId],
    );

    const actorCapabilities = actor.authorizationCapabilities ?? [];
    return {
      reworkOrderId: orderId,
      reworkStatus: order.status,
      orderVersion: order.version,
      processingFactory: order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : order.processing_factory_type === "supplier"
          && order.processing_factory_supplier_id
          && order.processing_factory_supplier_version
          ? {
              type: "supplier",
              supplierId: order.processing_factory_supplier_id,
            }
          : null,
      handlerUserId: determination?.handler_user_id ?? null,
      canDetermine: actorCapabilities.includes("responsibility:determine"),
      canTakeover: actorCapabilities.includes("responsibility:takeover"),
      canConfirmHighMultiplier: actorCapabilities.includes(
        "responsibility:confirm_high_multiplier",
      ),
      canOwnerSign: actorCapabilities.includes("responsibility:owner_sign"),
      ownerSignature: null,
      sourceProcesses: sourceRows.rows.map((row) => ({
        configurationItemId: row.configuration_item_id,
        processName: row.process_name,
        pricingUnit: row.pricing_unit,
        baseAmount: row.base_amount,
      })),
      determination: determination
        ? {
            determinationId: determination.determination_id,
            version: determination.determination_version,
            stage: determination.stage,
            reason: determination.reason,
            calculationTotal: determination.calculation_total,
            highMultiplierConfirmed: determination.confirmed,
            processes: processRows.map((row) => ({
              configurationItemId: row.configuration_item_id,
              processName: row.process_name_snapshot,
              pricingUnit: row.pricing_unit_snapshot,
              multiplier: row.multiplier,
              highMultiplierReason: row.high_multiplier_reason,
              baseAmount: row.base_amount,
              responsibilityAmount: row.responsibility_amount,
              allocations: row.allocations,
            })),
          }
        : null,
    };
  }

  saveDraft(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateResponsibilityDraft,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(
      actor,
      "rework.responsibility.draft",
      key,
      { orderId, input },
      201,
      async (client) => this.create(client, actor, orderId, input),
    );
  }

  finalize(
    actor: TrustedActorContext,
    orderId: string,
    input: FinalizeResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(
      actor,
      "rework.responsibility.finalize",
      key,
      { orderId, input },
      200,
      async (client) => {
        this.requireCapability(actor, "responsibility:determine");
        const order = await this.lockOrder(
          client,
          orderId,
          input.expectedOrderVersion,
        );
        if (order.status !== "pending_responsibility_determination") {
          fail("返工单不在待判责状态");
        }

        const determinationResult = await client.query<DeterminationRow>(
          `SELECT d.*,
                  EXISTS(
                    SELECT 1
                    FROM rework_responsibility_high_multiplier_confirmations confirmation
                    WHERE confirmation.determination_id=d.determination_id
                  ) confirmed
           FROM rework_responsibility_determinations d
           WHERE d.rework_order_id=$1
             AND NOT EXISTS(
               SELECT 1
               FROM rework_responsibility_determinations successor
               WHERE successor.replaces_determination_id=d.determination_id
             )
           FOR UPDATE`,
          [orderId],
        );
        const draft =
          determinationResult.rows[0] ?? fail("判责版本冲突");
        if (
          draft.stage !== "draft" ||
          draft.determination_version !==
            input.expectedCurrentDeterminationVersion
        ) {
          fail("判责版本冲突");
        }

        const confirmation = await client.query<{
          confirmation_id: string;
        }>(
          `SELECT confirmation_id
           FROM rework_responsibility_high_multiplier_confirmations
           WHERE determination_id=$1`,
          [draft.determination_id],
        );
        const highMultiplier = await client.query(
          `SELECT 1
           FROM rework_responsibility_processes
           WHERE determination_id=$1 AND multiplier>2
           LIMIT 1`,
          [draft.determination_id],
        );
        if (draft.settlement_schema_version === 1 && highMultiplier.rowCount && !confirmation.rows[0]) {
          fail("高倍率尚未完成独立确认");
        }

        const hasOwnFactory = ((await client.query(
          `SELECT 1
           FROM rework_responsibility_allocations
           WHERE determination_id=$1
             AND responsibility_type='own_factory'
             AND share_bps>0
           LIMIT 1`,
          [draft.determination_id],
        )).rowCount ?? 0) > 0;
        const finalizedId = randomUUID();
        const nextStatus: ReworkStatus = draft.settlement_schema_version === 2 && hasOwnFactory
          ? "pending_owner_signature"
          : "pending_responsibility_action";
        const eventId = await this.appendEvent(
          client,
          actor,
          draft.settlement_schema_version === 2 && hasOwnFactory
            ? "rework.responsibility.submit_owner_signature"
            : "rework.responsibility.finalize",
          orderId,
          undefined,
          order,
          nextStatus,
        );
        await client.query(
          `INSERT INTO rework_responsibility_determinations(
             determination_id,rework_order_id,determination_version,
             replaces_determination_id,source_order_review_id,stage,
             handler_user_id,created_by,reason,
             source_high_multiplier_confirmation_id,input_snapshot,
             calculation_total,operation_event_id,request_id,settlement_schema_version
           )
           SELECT $1,rework_order_id,determination_version+1,determination_id,
                  source_order_review_id,'finalized',handler_user_id,$2,reason,
                  $3,input_snapshot,calculation_total,$4,$5,settlement_schema_version
           FROM rework_responsibility_determinations
           WHERE determination_id=$6`,
          [
            finalizedId,
            actor.actorId,
            confirmation.rows[0]?.confirmation_id ?? null,
            eventId,
            actor.requestId,
            draft.determination_id,
          ],
        );
        await client.query(
          `INSERT INTO rework_responsibility_processes
           SELECT $1,configuration_item_id,process_name_snapshot,
                  pricing_unit_snapshot,multiplier,high_multiplier_reason,
                  base_amount,responsibility_amount,$2,$3
           FROM rework_responsibility_processes
           WHERE determination_id=$4`,
          [finalizedId, eventId, actor.requestId, draft.determination_id],
        );
        await client.query(
          `INSERT INTO rework_responsibility_allocations(
             determination_id,configuration_item_id,responsibility_type,share_bps,
             rounded_amount,operation_event_id,request_id,multiplier,supplier_id,
             supplier_version,supplier_code_snapshot,supplier_name_snapshot,
             supplier_type_snapshot
           )
           SELECT $1,configuration_item_id,responsibility_type,share_bps,
                  rounded_amount,$2,$3,multiplier,supplier_id,supplier_version,
                  supplier_code_snapshot,supplier_name_snapshot,supplier_type_snapshot
           FROM rework_responsibility_allocations
           WHERE determination_id=$4`,
          [finalizedId, eventId, actor.requestId, draft.determination_id],
        );
        await client.query(
          `INSERT INTO rework_responsibility_amount_lines
           SELECT $1,configuration_item_id,work_report_id,person_id,
                  responsibility_type,base_member_share_amount,multiplier,
                  share_bps,unrounded_amount,rounded_amount,rounding_rule,
                  worker_display_name_snapshot,task_mode_snapshot,
                  member_snapshot,report_snapshot,$2,$3
           FROM rework_responsibility_amount_lines
           WHERE determination_id=$4`,
          [finalizedId, eventId, actor.requestId, draft.determination_id],
        );
        await client.query(
          `UPDATE rework_orders
           SET status=$3,version=version+1,
               updated_by=$2,updated_at=CURRENT_TIMESTAMP
           WHERE rework_order_id=$1`,
          [orderId, actor.actorId, nextStatus],
        );
        return this.get(actor, orderId, client);
      },
    );
  }

  private async roundingAdjustmentsAvailable(
    client: Pick<Pool, "query"> | PoolClient,
  ): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_responsibility_rounding_adjustments') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  private async settledWageItemsAvailable(
    client: Pick<Pool, "query"> | PoolClient,
  ): Promise<boolean> {
    const result = await client.query<{ available: boolean }>(
      "SELECT to_regclass('rework_wage_items') IS NOT NULL AS available",
    );
    return result.rows[0]?.available === true;
  }

  private async create(
    client: PoolClient,
    actor: TrustedActorContext,
    orderId: string,
    input: CreateResponsibilityDraft,
  ): Promise<ResponsibilityDeterminationResponse> {
    this.requireCapability(actor, "responsibility:determine");
    const order = await this.lockOrder(
      client,
      orderId,
      input.expectedOrderVersion,
    );
    if (order.status !== "pending_responsibility_determination") {
      fail("只有整单审核后的返工单可判责");
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
      `responsibility:${orderId}`,
    ]);
    const currentResult = await client.query<DeterminationRow>(
      `SELECT d.*,
              EXISTS(
                SELECT 1
                FROM rework_responsibility_high_multiplier_confirmations confirmation
                WHERE confirmation.determination_id=d.determination_id
              ) confirmed
       FROM rework_responsibility_determinations d
       WHERE d.rework_order_id=$1
         AND NOT EXISTS(
           SELECT 1
           FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=d.determination_id
         )`,
      [orderId],
    );
    const previous = currentResult.rows[0] ?? null;
    if (
      (previous?.determination_version ?? null) !==
      input.expectedCurrentDeterminationVersion
    ) {
      fail("判责版本冲突");
    }
    // A boss rejection is itself an immutable audit fact.  Do not force the
    // production handler to invent a second reason merely to make the revised
    // N07 draft writable again.

    const approvedResult = await client.query<ApprovedProcessRow>(
      `SELECT item.configuration_item_id,item.process_name,item.pricing_unit
       FROM rework_process_configurations configuration
       JOIN rework_process_configuration_items item USING(configuration_id)
       WHERE configuration.rework_order_id=$1
         AND configuration.status='approved'
         AND item.execution_kind='worker'`,
      [orderId],
    );
    if (
      new Set(input.processes.map((row) => row.configurationItemId)).size !==
        approvedResult.rows.length ||
      approvedResult.rows.some(
        (approved) =>
          !input.processes.some(
            (row) =>
              row.configurationItemId === approved.configuration_item_id,
          ),
      )
    ) {
      fail("必须提交全部 approved 工序", 400, "VALIDATION_ERROR");
    }
    input.processes.forEach((row) => {
      validateBps(row.allocations);
      if (new Set(row.allocations.map((allocation) => allocation.responsibilityType)).size !== row.allocations.length) {
        fail("同一道工序不能重复选择相同责任类型", 400, "VALIDATION_ERROR");
      }
    });
    if (input.processes.some((row) => decimalToScaled(row.multiplier, 3) !== 1_000n || row.highMultiplierReason != null)) {
      fail("责任系数已停用；请在责任方明细中设置比例和倍率", 400, "VALIDATION_ERROR");
    }
    // Every determination created after migration 0054 is N07–N11 V2.  The
    // client must never be able to opt back into the retired V1 settlement
    // path by omitting optional wire fields; those fields remain optional only
    // so immutable historical snapshots can still be read.
    const settlementSchemaVersion = 2 as const;

    const reviewResult = await client.query<{ order_review_id: string }>(
      `SELECT order_review_id
       FROM rework_order_reviews
       WHERE rework_order_id=$1`,
      [orderId],
    );
    const review = reviewResult.rows[0] ?? fail("整单审核不存在");

    const eventId = await this.appendEvent(
      client,
      actor,
      "rework.responsibility.draft",
      orderId,
      input.reason,
      order,
      order.status,
    );
    const settledWageItemsAvailable = await this.settledWageItemsAvailable(client);
    const determinationId = randomUUID();
    const version = (previous?.determination_version ?? 0) + 1;
    let total = 0n;
    const calculations: ResponsibilityProcessCalculation[] = [];

    for (const processInput of input.processes) {
      const approved =
        approvedResult.rows.find(
          (row) =>
            row.configuration_item_id === processInput.configurationItemId,
        ) ?? fail("工序不属于 approved 配置", 400, "VALIDATION_ERROR");
      const shareResult = await client.query<WorkReportShareRow>(
        settledWageItemsAvailable
          ? `SELECT report.work_report_id,wage.person_id,
                    round(
                      wage.actual_quantity_snapshot*wage.unit_price_snapshot*
                      CASE WHEN wage.assignment_mode='collective'
                        THEN 1::numeric/NULLIF(wage.member_count,0)
                        ELSE 1
                      END,
                      8
                    )::text amount,
                    wage.person_name_snapshot display_name_snapshot,wage.assignment_mode
             FROM rework_work_reports report
             JOIN rework_wage_items wage
               ON wage.rework_order_id=report.rework_order_id
              AND wage.configuration_item_id=report.configuration_item_id
              AND wage.work_report_id=report.work_report_id
             LEFT JOIN rework_work_report_rejections rejection
               ON rejection.work_report_id=report.work_report_id
             WHERE report.rework_order_id=$1
              AND report.configuration_item_id=$2
              AND report.status='submitted'
              AND wage.invalidated_at IS NULL
               AND rejection.work_report_id IS NULL`
          : `SELECT report.work_report_id,share.person_id,share.amount::text amount,
                    member.display_name_snapshot,task.assignment_mode
             FROM rework_work_reports report
             JOIN rework_work_report_member_shares share USING(work_report_id)
             JOIN rework_work_tasks task USING(work_task_id)
             JOIN rework_work_task_members member
               ON member.work_task_id=task.work_task_id
              AND member.person_id=share.person_id
             LEFT JOIN rework_work_report_rejections rejection USING(work_report_id)
             WHERE report.rework_order_id=$1
               AND report.configuration_item_id=$2
               AND report.status='submitted'
               AND rejection.work_report_id IS NULL`,
        [orderId, processInput.configurationItemId],
      );
      let processTotal = 0n;
      const lines: ResponsibilityAmountLine[] = [];

      for (const share of shareResult.rows) {
        for (const allocation of processInput.allocations) {
          const multiplier = decimalToScaled(
            allocation.multiplier
              ?? (allocation.responsibilityType === "own_factory" ? "1.000" : "1.200"),
            3,
          );
          const base = decimalToScaled(share.amount, 8);
          const unroundedScaled =
            base * multiplier * BigInt(allocation.shareBps);
          const rounded = halfUp2(unroundedScaled, 10n ** 15n);
          processTotal += rounded;
          lines.push({
            share,
            allocation,
            rounded,
            unrounded: `${unroundedScaled / 1_000_000_000_000_000n}.${(
              unroundedScaled % 1_000_000_000_000_000n
            )
              .toString()
              .padStart(15, "0")}`,
          });
        }
      }
      calculations.push({
        input: processInput,
        approved,
        shares: shareResult.rows,
        lines,
        processTotal,
      });
      total += processTotal;
    }

    await client.query(
      `INSERT INTO rework_responsibility_determinations(
         determination_id,rework_order_id,determination_version,
         replaces_determination_id,source_order_review_id,stage,
         handler_user_id,created_by,reason,
         source_high_multiplier_confirmation_id,input_snapshot,
         calculation_total,operation_event_id,request_id,settlement_schema_version
       ) VALUES($1,$2,$3,$4,$5,'draft',$6,$7,$8,NULL,$9,$10,$11,$12,$13)`,
      [
        determinationId,
        orderId,
        version,
        previous?.determination_id ?? null,
        review.order_review_id,
        input.handlerUserId,
        actor.actorId,
        input.reason ?? null,
        input,
        cents(total),
        eventId,
        actor.requestId,
        settlementSchemaVersion,
      ],
    );

    for (const calculation of calculations) {
      const baseAmount = calculation.shares.reduce(
        (sum, share) => sum + decimalToScaled(share.amount, 8),
        0n,
      );
      await client.query(
        `INSERT INTO rework_responsibility_processes(
           determination_id,configuration_item_id,process_name_snapshot,
           pricing_unit_snapshot,multiplier,high_multiplier_reason,
           base_amount,responsibility_amount,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          determinationId,
          calculation.input.configurationItemId,
          calculation.approved.process_name,
          calculation.approved.pricing_unit,
          "1.000",
          null,
          `${baseAmount / 100_000_000n}.${(baseAmount % 100_000_000n)
            .toString()
            .padStart(8, "0")}`,
          cents(calculation.processTotal),
          eventId,
          actor.requestId,
        ],
      );

      for (const allocation of calculation.input.allocations) {
        const partyMultiplier = allocation.multiplier
          ?? (allocation.responsibilityType === "own_factory" ? "1.000" : "1.200");
        if (decimalToScaled(partyMultiplier, 3) < 1_000n) {
          fail("责任方倍率不能低于 1", 400, "VALIDATION_ERROR");
        }
        let supplier: {
          supplierId: string;
          version: number;
          code: string;
          name: string;
          type: "factory" | "embroidery_washing" | "fabric";
        } | null = null;
        if (settlementSchemaVersion === 2 && allocation.responsibilityType !== "own_factory") {
          if (!allocation.supplierId) {
            fail("外部责任方必须填写实际供应商", 400, "VALIDATION_ERROR");
          }
          if (decimalToScaled(partyMultiplier, 3) < 1_200n) {
            fail("外部供应商倍率不能低于 1.2", 400, "VALIDATION_ERROR");
          }
          const expectedType = allocation.responsibilityType === "processing_factory"
            ? "factory"
            : allocation.responsibilityType === "fabric_supplier"
              ? "fabric"
              : "embroidery_washing";
          const selected = await client.query<{
            supplier_id: string;
            version: number;
            supplier_code: string;
            supplier_name: string;
            supplier_type: "factory" | "embroidery_washing" | "fabric";
          }>(
            `SELECT supplier_id,version,supplier_code,supplier_name,supplier_type
             FROM current_supplier_catalog
             WHERE supplier_id=$1 AND active=true`,
            [allocation.supplierId],
          );
          const verified = selected.rows[0] ?? fail(
            "供应商不存在、已停用或与责任类型不匹配",
            400,
            "VALIDATION_ERROR",
          );
          if (verified.supplier_type !== expectedType) {
            fail("供应商不存在、已停用或与责任类型不匹配", 400, "VALIDATION_ERROR");
          }
          supplier = {
            supplierId: verified.supplier_id,
            version: verified.version,
            code: verified.supplier_code,
            name: verified.supplier_name,
            type: verified.supplier_type,
          };
        }
        const allocationAmount = calculation.lines
          .filter(
            (line) =>
              line.allocation.responsibilityType ===
              allocation.responsibilityType,
          )
          .reduce((sum, line) => sum + line.rounded, 0n);
        await client.query(
          `INSERT INTO rework_responsibility_allocations(
             determination_id,configuration_item_id,responsibility_type,
             share_bps,rounded_amount,operation_event_id,request_id,multiplier,
             supplier_id,supplier_version,supplier_code_snapshot,
             supplier_name_snapshot,supplier_type_snapshot
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            determinationId,
            calculation.input.configurationItemId,
            allocation.responsibilityType,
            allocation.shareBps,
            cents(allocationAmount),
            eventId,
            actor.requestId,
            partyMultiplier,
            supplier?.supplierId ?? null,
            supplier?.version ?? null,
            supplier?.code ?? null,
            supplier?.name ?? null,
            supplier?.type ?? null,
          ],
        );
      }

      for (const line of calculation.lines) {
        await client.query(
          `INSERT INTO rework_responsibility_amount_lines(
             determination_id,configuration_item_id,work_report_id,person_id,
             responsibility_type,base_member_share_amount,multiplier,share_bps,
             unrounded_amount,rounded_amount,rounding_rule,
             worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
             report_snapshot,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'half_up_2',$11,$12,$13,$14,$15,$16)`,
          [
            determinationId,
            calculation.input.configurationItemId,
            line.share.work_report_id,
            line.share.person_id,
            line.allocation.responsibilityType,
            line.share.amount,
            line.allocation.multiplier
              ?? (line.allocation.responsibilityType === "own_factory" ? "1.000" : "1.200"),
            line.allocation.shareBps,
            line.unrounded,
            cents(line.rounded),
            line.share.display_name_snapshot,
            line.share.assignment_mode,
            {
              personId: line.share.person_id,
              amount: line.share.amount,
            },
            { workReportId: line.share.work_report_id },
            eventId,
            actor.requestId,
          ],
        );
      }
    }

    await client.query(
      `UPDATE rework_orders
       SET version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
       WHERE rework_order_id=$1`,
      [orderId, actor.actorId],
    );
    if (previous) {
      await this.todos?.cancelOpenByDedupeKey(
        client,
        actor,
        `responsibility:${orderId}:${previous.determination_version}`,
        "A newer responsibility draft superseded this version",
      );
      await this.todos?.cancelOpenByDedupePrefix(
        client,
        actor,
        `high-multiplier:${previous.determination_id}:${previous.determination_version}:`,
        "A newer responsibility draft superseded this version",
      );
    }
    await this.todos?.actionableForResponsibilityHandler(client, actor, {
      category: "responsibility_determination",
      sourceEventId: eventId,
      sourceAction: "rework.responsibility.draft",
      entityType: "rework_order",
      entityId: orderId,
      recipientUserId: input.handlerUserId,
      route: { routeName: "responsibility_detail", entityId: orderId },
      dedupeKey: `responsibility:${orderId}:${version}`,
    });
    return this.get(actor, orderId, client);
  }

  private requireCapability(
    actor: TrustedActorContext,
    capability: string,
  ): void {
    if (!(actor.authorizationCapabilities ?? []).includes(capability)) {
      fail("当前用户无权执行该操作", 403, "FORBIDDEN");
    }
  }

  private async lockOrder(
    client: PoolClient,
    orderId: string,
    expectedVersion: number,
  ): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,
              problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       FOR UPDATE`,
      [orderId],
    );
    const order = result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
    if (order.version !== expectedVersion) {
      fail("返工单版本冲突");
    }
    return order;
  }

  private orderAudit(
    order: OrderRow,
    status: ReworkStatus = order.status,
    version = order.version,
  ): Record<string, unknown> {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory:
        order.processing_factory_type === null
          ? null
          : order.processing_factory_type === "own_factory"
            ? { type: "own_factory" }
            : {
                type: "supplier",
                supplierId: order.processing_factory_supplier_id,
                supplierVersion:
                  order.processing_factory_supplier_version,
              },
      problemPart: order.problem_part,
      problemDescription: order.problem_description,
      reworkQuantity: order.rework_quantity,
      version,
    };
  }

  private async appendEvent(
    client: PoolClient,
    actor: TrustedActorContext,
    action: string,
    orderId: string,
    reason: string | undefined,
    order: OrderRow,
    status: ReworkStatus,
  ): Promise<string> {
    const eventId = await this.events.append(
      client,
      { ...actor, authorizationCapability: "responsibility:determine" },
      {
        action,
        entityType: "rework_order",
        entityId: orderId,
        before: this.orderAudit(order),
        after: this.orderAudit(order, status, order.version + 1),
        ...(reason ? { reason } : {}),
      },
    );
    await client.query(
      `SELECT
         set_config('dx_rework.responsibility_event_id',$1,true),
         set_config('dx_rework.responsibility_request_id',$2,true),
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, actor.requestId],
    );
    return eventId;
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    key: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<Result<T>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute(
        client,
        {
          scope,
          actorKey: actor.actorId,
          key,
          requestHash: createHash("sha256")
            .update(JSON.stringify(payload))
            .digest("hex"),
          expiresAt: new Date(Date.now() + 2_592_000_000),
        },
        async () => ({ statusCode, response: await work(client) }),
      );
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
