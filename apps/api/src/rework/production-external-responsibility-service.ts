import { createHash, randomUUID } from "node:crypto";

import type {
  AllocateExternalSuppliers,
  CreateExternalTemporarySupplier,
  CloseExternalDeductionCase,
  CreateExternalDeductionEntry,
  CreateExternalDeductionFollowUp,
  ExternalResponsibilityBatchResponse,
  ExternalResponsibilityCaseResponse,
  ExternalResponsibilityQueueResponse,
  PayablesAcceptExternalResponsibilityCase,
  PayablesReturnExternalResponsibilityCase,
  RequestExternalDeductionSpecialApproval,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { ExternalResponsibilityAllocationService } from "./external-responsibility-allocation-service.js";
import { ExternalResponsibilityCloseService } from "./external-responsibility-close-service.js";
import { FinalExternalResponsibilityService } from "./final-external-responsibility-service.js";

type PayablesCapability =
  | "external_responsibility:payables_confirm"
  | "external_deduction:follow_up"
  | "external_deduction:record"
  | "external_deduction:close";
type SupplierOption = {
  supplierId: string;
  supplierType: "factory" | "embroidery_washing" | "fabric";
  supplierName: string;
};
type ExternalItem = NonNullable<ExternalResponsibilityBatchResponse>["items"][number];
type Result<T> = { value: T; reused: boolean };

type PermissionRow = {
  can_sign: boolean;
  can_payables_confirm: boolean;
  can_payables_follow_up: boolean;
  can_record: boolean;
  can_close: boolean;
};

type DatabaseError = Readonly<{ code?: unknown; message?: unknown }>;

const databaseError = (error: unknown): DatabaseError | null =>
  typeof error === "object" && error !== null ? error as DatabaseError : null;

const deductionLedgerValidationMessage = (error: unknown): string | null => {
  const candidate = databaseError(error);
  if (candidate?.code !== "23514" || typeof candidate.message !== "string") return null;
  if (candidate.message.includes("deduction entry would make actual amount invalid")) {
    return "累计实扣金额不能低于 0，也不能超过当前拟扣金额。";
  }
  if (candidate.message.includes("deduction adjustment or reversal must reference its own case ledger entry")) {
    return "扣款调整或冲销只能引用当前这笔扣款台账中的原流水，冲销金额必须与原流水相反。";
  }
  return null;
};

/**
 * Single production PR-11 service used by HTTP wiring and PostgreSQL workflow
 * tests. Action-specific permissions are re-evaluated from the database so an
 * order-scoped proxy receives only the capability explicitly delegated.
 */
export class ProductionExternalResponsibilityService
  extends FinalExternalResponsibilityService {
  private readonly closeService: ExternalResponsibilityCloseService;
  private readonly allocationService: ExternalResponsibilityAllocationService;
  private readonly temporarySupplierIdempotency = new IdempotencyService();

  constructor(
    private readonly productionDatabase: Pool,
    todos?: TodoProjectionService,
  ) {
    super(productionDatabase, todos);
    this.closeService = new ExternalResponsibilityCloseService(
      productionDatabase,
      this,
      todos,
    );
    this.allocationService = new ExternalResponsibilityAllocationService(
      productionDatabase,
      this,
      todos,
    );
  }

  override async listQueue(
    actor: TrustedActorContext,
  ): Promise<ExternalResponsibilityQueueResponse> {
    const value = await super.listQueue(actor);
    if (value.items.length === 0) return value;
    const latestDeadlines = await this.productionDatabase.query<{
      case_id: string;
      overdue: boolean;
    }>(
      `SELECT requested.case_id,
              COALESCE((
                SELECT follow.next_follow_up_at<CURRENT_TIMESTAMP
                FROM rework_external_deduction_follow_ups follow
                WHERE follow.case_id=requested.case_id
                ORDER BY follow.created_at DESC,follow.follow_up_id DESC
                LIMIT 1
              ),false) overdue
       FROM unnest($1::uuid[]) requested(case_id)`,
      [value.items.map((item) => item.caseId)],
    );
    const overdueByCase = new Map(
      latestDeadlines.rows.map((item) => [item.case_id, item.overdue]),
    );
    return {
      items: value.items.map((item) => ({
        ...item,
        overdue:
          item.status === "deduction_follow_up"
          && (overdueByCase.get(item.caseId) ?? false),
      })),
    };
  }

  override allocateSuppliers(
    actor: TrustedActorContext,
    batchId: string,
    input: AllocateExternalSuppliers,
    key: string,
  ) {
    return this.allocationService.allocateSuppliers(
      actor,
      batchId,
      input,
      key,
    );
  }

  override async payablesAccept(
    actor: TrustedActorContext,
    caseId: string,
    input: PayablesAcceptExternalResponsibilityCase,
    key: string,
  ) {
    await this.requirePayablesCapability(
      actor,
      caseId,
      "external_responsibility:payables_confirm",
    );
    return super.payablesAccept(actor, caseId, input, key);
  }

  override async payablesReturn(
    actor: TrustedActorContext,
    caseId: string,
    input: PayablesReturnExternalResponsibilityCase,
    key: string,
  ) {
    await this.requirePayablesCapability(
      actor,
      caseId,
      "external_responsibility:payables_confirm",
    );
    return super.payablesReturn(actor, caseId, input, key);
  }

  override async followUp(
    actor: TrustedActorContext,
    caseId: string,
    input: CreateExternalDeductionFollowUp,
    key: string,
  ) {
    const permission = await this.casePermissions(actor.actorId, caseId);
    if (!permission.can_sign && !permission.can_payables_follow_up) {
      throw new ApplicationError(
        "FORBIDDEN",
        "当前用户无权跟进扣款",
        403,
      );
    }
    return super.followUp(actor, caseId, input, key);
  }

  override async recordDeduction(
    actor: TrustedActorContext,
    caseId: string,
    input: CreateExternalDeductionEntry,
    key: string,
  ) {
    await this.requirePayablesCapability(
      actor,
      caseId,
      "external_deduction:record",
    );
    try {
      return await super.recordDeduction(actor, caseId, input, key);
    } catch (error: unknown) {
      const message = deductionLedgerValidationMessage(error);
      if (message) throw new ApplicationError("VALIDATION_ERROR", message, 400);
      throw error;
    }
  }

  override async close(
    actor: TrustedActorContext,
    caseId: string,
    input: CloseExternalDeductionCase,
    key: string,
  ) {
    await this.requirePayablesCapability(
      actor,
      caseId,
      "external_deduction:close",
    );
    return this.closeService.close(actor, caseId, input, key);
  }

  override async requestSpecialApproval(
    actor: TrustedActorContext,
    caseId: string,
    input: RequestExternalDeductionSpecialApproval,
    key: string,
  ) {
    await this.requirePayablesCapability(
      actor,
      caseId,
      "external_deduction:close",
    );
    return super.requestSpecialApproval(actor, caseId, input, key);
  }

  override async get(
    ...args: Parameters<FinalExternalResponsibilityService["get"]>
  ): Promise<ExternalResponsibilityBatchResponse> {
    const value = await super.get(...args);
    if (!value) return null;
    const actor = args[0];
    return {
      ...value,
      items: value.items.map((item) => this.normalizeAmountLineSnapshot(item)),
      cases: await Promise.all(
        value.cases.map((item) => this.enrichPermissions(actor, item)),
      ),
    };
  }

  override async getCase(
    ...args: Parameters<FinalExternalResponsibilityService["getCase"]>
  ): Promise<ExternalResponsibilityCaseResponse> {
    const value = await super.getCase(...args);
    return this.enrichPermissions(args[0], value);
  }

  async listSupplierOptions(
    actor: TrustedActorContext,
    orderId: string,
  ): Promise<SupplierOption[]> {
    const permitted = await this.productionDatabase.query<{
      permitted: boolean;
    }>(
      `SELECT EXISTS(
         SELECT 1
         FROM rework_external_responsibility_batches batch
         JOIN rework_external_responsibility_items item
           ON item.batch_id=batch.batch_id
         WHERE batch.rework_order_id=$2
           AND batch.status='active'
           AND external_responsibility_can_sign(
             $1,$2,item.responsibility_type
           )
       ) permitted`,
      [actor.actorId, orderId],
    );
    if (!permitted.rows[0]?.permitted) {
      throw new ApplicationError(
        "FORBIDDEN",
        "当前用户无权为该返工单选择供应商",
        403,
      );
    }

    const result = await this.productionDatabase.query<{
      supplier_id: string;
      supplier_type: "factory" | "embroidery_washing" | "fabric";
      supplier_name: string;
    }>(
      `SELECT DISTINCT supplier.supplier_id,supplier.supplier_type,
              supplier.supplier_name
       FROM current_supplier_catalog supplier
       WHERE supplier.active=true
         AND EXISTS(
           SELECT 1
           FROM rework_external_responsibility_batches batch
           JOIN rework_external_responsibility_items item
             ON item.batch_id=batch.batch_id
           WHERE batch.rework_order_id=$2
             AND batch.status='active'
             AND external_responsibility_can_sign(
               $1,$2,item.responsibility_type
             )
             AND supplier.supplier_type=
               external_responsibility_expected_supplier_type(
                 item.responsibility_type
               )
         )
       ORDER BY supplier.supplier_type,supplier.supplier_name,
                supplier.supplier_id`,
      [actor.actorId, orderId],
    );
    return result.rows.map((row) => ({
      supplierId: row.supplier_id,
      supplierType: row.supplier_type,
      supplierName: row.supplier_name,
    }));
  }

  async createTemporarySupplier(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateExternalTemporarySupplier,
    key: string,
  ): Promise<Result<SupplierOption>> {
    const client = await this.productionDatabase.connect();
    try {
      await client.query("BEGIN");
      const result = await this.temporarySupplierIdempotency.execute(client, {
        scope: "rework.external_responsibility.temporary_supplier.create",
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ orderId, input }))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 201,
        response: await this.insertTemporarySupplier(
          client,
          actor,
          orderId,
          input,
        ),
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

  private async insertTemporarySupplier(
    client: PoolClient,
    actor: TrustedActorContext,
    orderId: string,
    input: CreateExternalTemporarySupplier,
  ): Promise<SupplierOption> {
    const permitted = await client.query<{ permitted: boolean }>(
      `SELECT EXISTS(
         SELECT 1
         FROM rework_external_responsibility_batches batch
         JOIN rework_external_responsibility_items item
           ON item.batch_id=batch.batch_id
         WHERE batch.rework_order_id=$2
           AND batch.status='active'
           AND external_responsibility_expected_supplier_type(
             item.responsibility_type
           )=$3
           AND external_responsibility_can_sign(
             $1,$2,item.responsibility_type
           )
       ) permitted`,
      [actor.actorId, orderId, input.supplierType],
    );
    if (!permitted.rows[0]?.permitted) {
      throw new ApplicationError(
        "FORBIDDEN",
        "当前用户无权为该返工单新增此类供应商",
        403,
      );
    }

    const supplierId = randomUUID();
    const supplierCode = `TMP-${{
      factory: "FAC",
      embroidery_washing: "EMB",
      fabric: "FAB",
    }[input.supplierType]}-${randomUUID().replaceAll("-", "").slice(0, 10).toUpperCase()}`;
    await client.query(
      `SELECT
         set_config('dx_rework.supplier_version_event_id',$1,true),
         set_config('dx_rework.supplier_version_request_id',$2,true),
         set_config(
           'dx_rework.supplier_version_authorization_capability',
           'external_responsibility:sign',
           true
         ),
         set_config('dx_rework.external_supplier_order_id',$3,true)`,
      [randomUUID(), actor.requestId, orderId],
    );
    await client.query(
      `INSERT INTO supplier_catalog_items(
         supplier_id,supplier_code,supplier_type
       ) VALUES($1,$2,$3)`,
      [supplierId, supplierCode, input.supplierType],
    );
    await client.query(
      `INSERT INTO supplier_catalog_versions(
         supplier_id,version,supplier_name,active,changed_by,change_reason
       ) VALUES($1,1,$2,true,$3,$4)`,
      [
        supplierId,
        input.supplierName,
        actor.actorId,
        `外部责任处理临时新增：${orderId}`,
      ],
    );
    return {
      supplierId,
      supplierType: input.supplierType,
      supplierName: input.supplierName,
    };
  }

  private async requirePayablesCapability(
    actor: TrustedActorContext,
    caseId: string,
    capability: PayablesCapability,
  ): Promise<void> {
    const permission = await this.productionDatabase.query<{
      permitted: boolean;
    }>(
      `SELECT external_responsibility_can_payables(
         $1,target_case.rework_order_id,target_case.responsibility_type,$3
       ) permitted
       FROM rework_external_responsibility_cases target_case
       JOIN rework_external_responsibility_batches batch
         ON batch.batch_id=target_case.batch_id
       WHERE target_case.case_id=$2 AND batch.status='active'`,
      [actor.actorId, caseId, capability],
    );
    if (!permission.rows[0]?.permitted) {
      throw new ApplicationError(
        "FORBIDDEN",
        "当前用户没有该外部扣款动作的授权",
        403,
      );
    }
  }

  private async casePermissions(
    actorId: string,
    caseId: string,
  ): Promise<PermissionRow> {
    const result = await this.productionDatabase.query<PermissionRow>(
      `SELECT
         external_responsibility_can_sign(
           $1,target_case.rework_order_id,target_case.responsibility_type
         ) can_sign,
         external_responsibility_can_payables(
           $1,target_case.rework_order_id,target_case.responsibility_type,
           'external_responsibility:payables_confirm'
         ) can_payables_confirm,
         external_responsibility_can_payables(
           $1,target_case.rework_order_id,target_case.responsibility_type,
           'external_deduction:follow_up'
         ) can_payables_follow_up,
         external_responsibility_can_payables(
           $1,target_case.rework_order_id,target_case.responsibility_type,
           'external_deduction:record'
         ) can_record,
         external_responsibility_can_payables(
           $1,target_case.rework_order_id,target_case.responsibility_type,
           'external_deduction:close'
         ) can_close
       FROM rework_external_responsibility_cases target_case
       WHERE target_case.case_id=$2`,
      [actorId, caseId],
    );
    return result.rows[0] ?? {
      can_sign: false,
      can_payables_confirm: false,
      can_payables_follow_up: false,
      can_record: false,
      can_close: false,
    };
  }

  private normalizeAmountLineSnapshot(item: ExternalItem): ExternalItem {
    return Array.isArray(item.amountLineSnapshot)
      ? { ...item, amountLineSnapshot: { lines: item.amountLineSnapshot } }
      : item;
  }

  private async enrichPermissions(
    actor: TrustedActorContext,
    value: ExternalResponsibilityCaseResponse,
  ): Promise<ExternalResponsibilityCaseResponse> {
    const permission = await this.casePermissions(actor.actorId, value.caseId);
    const active = value.status !== "superseded";
    const followUp = active && value.status === "deduction_follow_up";
    const recordable = active && [
      "pending_payables_confirmation",
      "deduction_follow_up",
    ].includes(value.status);
    return {
      ...value,
      items: value.items.map((item) => this.normalizeAmountLineSnapshot(item)),
      canPayablesConfirm:
        active
        && value.status === "pending_payables_confirmation"
        && permission.can_payables_confirm,
      canFollowUp:
        followUp
        && (permission.can_sign || permission.can_payables_follow_up),
      canRecordDeduction: recordable && permission.can_record,
      canClose: value.canClose && followUp && permission.can_close,
      canRequestSpecialApproval:
        value.canRequestSpecialApproval && followUp && permission.can_close,
    };
  }
}
