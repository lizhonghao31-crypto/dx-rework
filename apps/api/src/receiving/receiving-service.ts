import {readReceivingBoard,type BoardResult} from "./receiving-board-query.js";
import {invalidatePackingAliasCandidates} from './packing-alias-invalidation.js';
import {normalizePackingTime,resolvePackingTime} from './packing-actual-time.js';
import {packingReceiptAllocations} from './packing-receipt-allocations.js';
import type {PackingTimeInput,PackingActualTime,PackingAllocationInput} from '@dx-rework/contracts';
import {RECEIVING_PACKING_SCOPE_UNRESOLVED_SQL,RECEIVING_GROUP_PACKING_JOIN_SQL,RECEIVING_BOARD_BASE_SQL,type RepeatedReceivingSource,type ReceiptSource,type ReceivingDifferenceType,type StyleOperationSnapshot} from "./receiving-quantity-query.js";
export {RECEIVING_BOARD_BASE_SQL,RECEIVING_BATCH_BOARD_BASE_SQL,DIGITAL_RECEIVING_BASE_SQL} from "./receiving-quantity-query.js";
import {businessNow} from '../acceptance-clock/business-time.js';
import {linkDigitalReceipt} from "../production-platform/receiving-link-adapter.js";
import {receivingDocumentHistory} from "./receiving-document-history.js";
import {parsePendingReceivingIdentity,pendingReceivingSelection,pendingReceivingView} from './pending-receiving-view.js';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
import { hasWarehouseReceivingRole } from "@dx-rework/contracts";
import { readReceivingAnalysis } from "./receiving-analysis.js";
import type { ProductionClosureService } from "../sourcing/production-closure-service.js";
import { createHash, randomUUID } from "node:crypto";

import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

const MAX_RECEIVING_IMAGES = 3;
const RECEIVING_IMAGE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RecordPackingInput = Readonly<{
  receivingBatchId: string;
  expectedVersion: number;
  expectedPackingRevisionId?: string | null;
  packingQuantity: number;
  packingTime?:PackingTimeInput;
  packingAllocations?:readonly PackingAllocationInput[];
}>;

type ResolveReceivingDifferenceInput = Readonly<{
  receivingBatchId: string;
  expectedVersion: number;
  expectedDocumentQuantity: number;
  expectedActualQuantity: number;
  expectedPackingRevisionId?: string | null;
  differenceType: ReceivingDifferenceType;
  result: string;
  attachmentIds?: readonly string[];
}>;

type CreateRepeatedReceivingInput = Readonly<{
  pendingAllocation?: string;
  cuttingOrderId?: string;
  productionOrderId?: string;
  factoryDecisionId?: string|null;
  receivingBatchId: string;
  source: RepeatedReceivingSource;
  documentQuantity?: number;
  actualQuantity: number;
  defectiveQuantity?: number;
}>;

type CreateReceivingInput = Readonly<{
  pendingAllocation?: string;
  cuttingOrderId?: string;
  productionOrderId?: string;
  factoryDecisionId?: string|null;
  styleNo?: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity?: number;
  attachmentIds?: readonly string[];
  receivedDate?: string;
}>;

type NormalizedCreateReceivingInput = Readonly<{
  cuttingOrderId?: string;
  productionOrderId?: string;
  factoryDecisionId?: string|null;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  attachmentIds: readonly string[];
  receivedDate: string | null;
  receivingSource: Exclude<ReceiptSource, "legacy">;
}>;

type CorrectReceivingBatchInput = Readonly<{
  expectedVersion: number;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity?: number;
  attachmentIds?: readonly string[];
}>;

type CorrectReceivingReceiptInput = Readonly<{
  expectedVersion: number;
  source?: RepeatedReceivingSource;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
}>;

type CuttingReceivingOption = Readonly<{
  cuttingOrderId: string;
  styleNo: string;
  color: string | null;
  supplierName: string;
  actualCutCount: number;
  styleConflictCount: number;
}>;

type RepeatReceivingOption = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  cuttingOrderId?: string;
  color?: string | null;
  supplierName?: string;
  actualCutCount?: number;
  styleConflictCount?: number;
}>;

type ReceivingReceipt = Readonly<{
  receiptId: string;
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  receivedBy: string;
  receivedAt: string;
}>;

type ReceivingBatchSnapshot = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  documentQuantity: number;
  actualQuantity: number;
  defectiveQuantity: number;
  differenceQuantity: number;
  version: number;
}>;

type PackingRevisionResult = Readonly<{
  packingRevisionId: string;
  receivingBatchId: string;
  packingQuantity: number;
  recordedBy: string;
  recordedAt: string;
  packingActualTime?:PackingActualTime;
}>;

type DifferenceResolutionResult = Readonly<{
  resolutionId: string;
  receivingBatchId: string;
  differenceType: ReceivingDifferenceType;
  differenceQuantity: number;
  result: string;
  handledBy: string;
  handledAt: string;
}>;

type Result<T> = Readonly<{ value: T; reused: boolean }>;

const hash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify({ scope, payload })).digest("hex");

const fail = (message: string, status = 400, code = "VALIDATION_ERROR"): never => {
  throw new ApplicationError(code, message, status);
};

const normalizeStyleNo = (value: string): string => {
  const normalized = value.trim().toUpperCase();
  if (!normalized || normalized.length > 100) fail("款号不能为空且不能超过100个字符");
  return normalized;
};

const normalizeDifferenceType = (value: string): ReceivingDifferenceType => {
  if (value === "receiving" || value === "packing") return value;
  return fail("差异类型无效");
};

const normalizeResolutionResult = (value: string): string => {
  const normalized = value.trim();
  if (!normalized || normalized.length > 500) fail("处理结果不能为空且不能超过500个字符");
  return normalized;
};

const normalizeOptionalUuid = (value: string | null | undefined, label: string): string | null => {
  if (value === null || value === undefined || value === "") return null;
  if (!UUID_PATTERN.test(value)) fail(`${label}无效`);
  return value;
};

const validateQuantity = (value: number, label: string, allowZero: boolean): number => {
  if (!Number.isInteger(value) || value < (allowZero ? 0 : 1) || value > 10_000_000) {
    fail(`${label}必须是${allowZero ? "大于等于0" : "大于0"}的整数`);
  }
  return value;
};

const normalizeRepeatedReceivingSource = (value: unknown): RepeatedReceivingSource => {
  if (value === "jiashun" || value === "other_factory") return value;
  return fail("请选择嘉顺收货或其他工厂收货");
};

const normalizeAttachmentIds = (values: readonly string[] | undefined): readonly string[] => {
  const attachmentIds = values ?? [];
  if (attachmentIds.length > MAX_RECEIVING_IMAGES) fail("送货单图片最多3张");
  if (new Set(attachmentIds).size !== attachmentIds.length) fail("送货单图片不能重复");
  if (attachmentIds.some((value) => !UUID_PATTERN.test(value))) fail("送货单图片标识无效");
  return attachmentIds;
};

const normalizeReplacementAttachmentIds = (
  values: readonly string[] | undefined,
): readonly string[] | undefined => {
  if (values === undefined) return undefined;
  const attachmentIds = normalizeAttachmentIds(values);
  if (attachmentIds.length === 0) fail("替换送货单图片至少选择1张");
  return attachmentIds;
};

const businessDate = (now: Date): string => new Intl.DateTimeFormat("en-CA", {
  timeZone: "Asia/Shanghai",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
}).format(now);

const shiftDate = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day! + days)).toISOString().slice(0, 10);
};

const normalizeReceivingBackfillDate = (value: string | undefined, now = businessNow()): string | null => {
  if (value === undefined) return null;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) {
    fail("补录日期无效");
  }
  const today = businessDate(now);
  if (value < shiftDate(today, -2) || value > shiftDate(today, -1)) {
    fail("补录仅支持昨天和前天；今天请使用普通收货");
  }
  return value;
};

export class ReceivingService {
  constructor(
    private readonly database: Pool,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly production?: Pick<ProductionClosureService,"linkReceiptByCuttingOrder"|"linkReceipt">,
    private readonly options: Readonly<{ allowLegacyStyleInput?: boolean }> = {},
  ) {}

  async canDownloadBoundAttachment(
    actor: Readonly<{ actorRoles: readonly string[] }>,
    binding: Readonly<{ attachmentId?: string; entityType: string; entityId: string; mimeType?: string }>,
  ): Promise<boolean> {
    if (binding.entityType !== "receiving_batch" || !binding.mimeType?.startsWith("image/")) return false;
    if (actor.actorRoles.length === 0) return false;
    const result=await this.database.query<{permitted:boolean}>(`
      SELECT EXISTS(
        SELECT 1 FROM receiving_batches batch
        WHERE batch.receiving_batch_id::text=$1
          AND batch.deleted_at IS NULL
          AND ($2::text IS NULL OR EXISTS(
            SELECT 1 FROM attachments attachment
            WHERE attachment.attachment_id::text=$2
              AND attachment.entity_type='receiving_batch'
              AND attachment.entity_id=batch.receiving_batch_id::text
              AND attachment.status='ready'
              AND attachment.mime_type LIKE 'image/%'
              AND NOT EXISTS(
                SELECT 1 FROM receiving_attachment_retirements retired
                WHERE retired.attachment_id=attachment.attachment_id
              )
          ))
      ) permitted`,[binding.entityId,binding.attachmentId ?? null]);
    return result.rows[0]?.permitted===true;
  }

  async create(
    actor: TrustedActorContext,
    input: CreateReceivingInput,
    idempotencyKey: string,
  ): Promise<Result<ReceivingReceipt>> {
    const actualQuantity = validateQuantity(input.actualQuantity, "实际收货数量", true);
    const defectiveQuantity = validateQuantity(input.defectiveQuantity ?? 0, "次品数量", true);
    if (defectiveQuantity > actualQuantity) fail("次品数量不能超过实际收货数量");
    if (input.cuttingOrderId !== undefined && !UUID_PATTERN.test(input.cuttingOrderId)) fail("请选择有效的已裁正式款号");
    if (input.cuttingOrderId === undefined) {
      if (!this.options.allowLegacyStyleInput || input.styleNo === undefined) {
        fail("请选择有效的已裁正式款号");
      }
    }
    const receivingSource: "initial" | "backfill" = input.receivedDate === undefined ? "initial" : "backfill";
    const normalized = {
      ...(input.pendingAllocation!==undefined?{pendingAllocation:input.pendingAllocation}:{}),
      ...(input.cuttingOrderId ? { cuttingOrderId: input.cuttingOrderId } : {}),
      ...(input.productionOrderId ? { productionOrderId: input.productionOrderId } : {}),
      ...(input.factoryDecisionId!==undefined?{factoryDecisionId:normalizeOptionalUuid(input.factoryDecisionId,"分厂标识")}:{ }),
      ...(input.styleNo ? { styleNo: normalizeStyleNo(input.styleNo) } : {}),
      documentQuantity: validateQuantity(input.documentQuantity, "送货单数量", false),
      actualQuantity,
      defectiveQuantity,
      attachmentIds: normalizeAttachmentIds(input.attachmentIds),
      receivedDate: normalizeReceivingBackfillDate(input.receivedDate),
      receivingSource,
    };
    const scope = "receiving.receipt.create";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        await this.assertPendingSelection(client,actor,normalized,null);
        const cutting = normalized.cuttingOrderId
          ? await this.resolveCuttingSelection(client, normalized.cuttingOrderId)
          : normalized.styleNo && !normalized.productionOrderId && this.options.allowLegacyStyleInput
            ? await this.resolveUniqueExactCuttingSelection(client, normalized.styleNo)
            : null;
        return {
          statusCode: 201,
          response: await this.createInTransaction(client, actor, {
            ...normalized,
            ...(cutting ? { cuttingOrderId: cutting.cuttingOrderId } : {}),
            styleNo: cutting?.styleNo ?? normalized.styleNo!,
          }),
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createRepeated(
    actor: TrustedActorContext,
    input: CreateRepeatedReceivingInput,
    idempotencyKey: string,
  ): Promise<Result<ReceivingReceipt>> {
    if (!UUID_PATTERN.test(input.receivingBatchId)) fail("收货订单标识无效");
    if (input.cuttingOrderId !== undefined && !UUID_PATTERN.test(input.cuttingOrderId)) fail("请选择有效的已裁正式款号");
    if (input.cuttingOrderId === undefined && !this.options.allowLegacyStyleInput) {
      fail("请选择有效的已裁正式款号");
    }
    const actualQuantity = validateQuantity(input.actualQuantity, "实际收货数量", true);
    const defectiveQuantity = validateQuantity(input.defectiveQuantity ?? 0, "次品数量", true);
    const source = normalizeRepeatedReceivingSource(input.source);
    const documentQuantity = source === "other_factory"
      ? validateQuantity(input.documentQuantity ?? Number.NaN, "本次送货单数量", false)
      : undefined;
    if (defectiveQuantity > actualQuantity) fail("次品数量不能超过实际收货数量");
    const scope = "receiving.receipt.repeat";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, {
          ...(input.pendingAllocation!==undefined?{pendingAllocation:input.pendingAllocation}:{}),
          ...(input.cuttingOrderId ? { cuttingOrderId: input.cuttingOrderId } : {}),
          ...(input.productionOrderId ? { productionOrderId: input.productionOrderId } : {}),
      ...(input.factoryDecisionId!==undefined?{factoryDecisionId:normalizeOptionalUuid(input.factoryDecisionId,"分厂标识")}:{ }),
          receivingBatchId: input.receivingBatchId,
          source,
          ...(documentQuantity === undefined ? {} : { documentQuantity }),
          actualQuantity,
          defectiveQuantity,
        }),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        await this.assertPendingSelection(client,actor,input,input.receivingBatchId);
        const storedBatch = await client.query<{ cutting_order_id: string | null }>(
          `SELECT cutting_order_id
           FROM receiving_batches
           WHERE receiving_batch_id=$1 AND deleted_at IS NULL
           FOR SHARE`,
          [input.receivingBatchId],
        );
        const storedCuttingOrderId = storedBatch.rows[0]?.cutting_order_id
          ?? (storedBatch.rowCount ? null : fail("收货订单不存在", 404, "NOT_FOUND"));
        if (input.cuttingOrderId && storedCuttingOrderId
            && input.cuttingOrderId !== storedCuttingOrderId) {
          fail("该收货订单已关联另一条裁床任务，请重新搜索选择", 409, "CONFLICT");
        }
        const effectiveCuttingOrderId = input.cuttingOrderId ?? storedCuttingOrderId ?? undefined;
        const cutting = effectiveCuttingOrderId
          ? await this.resolveCuttingSelection(client, effectiveCuttingOrderId)
          : null;
        const target = await this.repeatReceivingBatch(
          client,
          input.receivingBatchId,
          cutting?.cuttingOrderId,
        );
        if (cutting && normalizeStyleNo(cutting.styleNo) !== normalizeStyleNo(target.styleNo)) {
          fail("已裁正式款号与所选多次收货订单不一致，请重新选择", 409, "CONFLICT");
        }
        if (cutting) {
          const existingLink = await client.query<{ cutting_order_id: string }>(
            "SELECT cutting_order_id FROM receiving_receipts WHERE receiving_batch_id=$1 AND cutting_order_id IS NOT NULL ORDER BY received_at,receipt_id LIMIT 1",
            [target.receivingBatchId],
          );
          if (existingLink.rows[0]?.cutting_order_id
              && existingLink.rows[0].cutting_order_id !== cutting.cuttingOrderId) {
            fail("该收货订单已关联另一条裁床任务，请重新搜索选择", 409, "CONFLICT");
          }
        }
        return {
          statusCode: 201,
          response: await this.createInTransaction(client, actor, {
            ...(cutting ? { cuttingOrderId: cutting.cuttingOrderId } : {}),
            ...(input.productionOrderId ? { productionOrderId: input.productionOrderId } : {}),
      ...(input.factoryDecisionId!==undefined?{factoryDecisionId:normalizeOptionalUuid(input.factoryDecisionId,"分厂标识")}:{ }),
            styleNo: cutting?.styleNo ?? target.styleNo,
            documentQuantity: documentQuantity ?? target.documentQuantity,
            actualQuantity,
            defectiveQuantity,
            attachmentIds: [],
            receivedDate: null,
            receivingSource: source,
          }, target.receivingBatchId),
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async resolveUniqueExactCuttingSelection(
    client: PoolClient,
    styleNo: string,
  ): Promise<(CuttingReceivingOption & { sourcingCaseId: string }) | null> {
    const relation = await client.query<{ relation_name: string | null }>(
      "SELECT to_regclass('current_cutting_style_options')::text AS relation_name",
    );
    if (!relation.rows[0]?.relation_name) return null;

    const normalizedStyle = normalizeStyleNo(styleNo);
    const matches = await client.query<{ cutting_order_id: string }>(
      `SELECT cutting_order_id
       FROM current_cutting_style_options
       WHERE upper(btrim(formal_style_no))=$1
       ORDER BY cutting_order_id
       LIMIT 2`,
      [normalizedStyle],
    );
    if (matches.rowCount !== 1) return null;
    return this.resolveCuttingSelection(client, matches.rows[0]!.cutting_order_id);
  }

  private async resolveCuttingSelection(
    client: PoolClient,
    cuttingOrderId: string,
  ): Promise<CuttingReceivingOption & { sourcingCaseId: string }> {
    const locked = await client.query<{ sourcing_case_id: string }>(
      `SELECT cutting.sourcing_case_id
       FROM cutting_orders cutting
       JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=cutting.sourcing_case_id
        AND source_case.deleted_at IS NULL
       WHERE cutting.cutting_order_id=$1
       FOR SHARE OF cutting,source_case`,
      [cuttingOrderId],
    );
    const source = locked.rows[0]
      ?? fail("该裁床订单已失效，请重新搜索正式款号", 409, "INVALID_STATE_TRANSITION");
    const result = await client.query<{
      cutting_order_id: string;
      formal_style_no: string;
      color: string | null;
      supplier_name: string;
      actual_cut_count: string;
      style_conflict_count: string;
    }>(
      `SELECT cutting_order_id,upper(btrim(formal_style_no)) AS formal_style_no,
              color,supplier_name,actual_cut_count::text,
              style_conflict_count::text
       FROM current_cutting_style_options
       WHERE cutting_order_id=$1`,
      [cuttingOrderId],
    );
    const row = result.rows[0]
      ?? fail("该款尚未完成实裁或正式款号不可用，请重新搜索", 409, "INVALID_STATE_TRANSITION");
    return {
      cuttingOrderId: row.cutting_order_id,
      sourcingCaseId: source.sourcing_case_id,
      styleNo: row.formal_style_no,
      color: row.color,
      supplierName: row.supplier_name,
      actualCutCount: Number(row.actual_cut_count),
      styleConflictCount: Number(row.style_conflict_count),
    };
  }

  private assertRootCorrector(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "receiving:correct"
      || !actor.actorRoles.includes("root_superuser")
    ) {
      fail("只有Root可以修改或删除收货订单", 403, "FORBIDDEN");
    }
  }

  private assertBoardOperator(
    actor: TrustedActorContext,
    capability: "receiving:packing_manage" | "receiving:resolve_difference" | "receiving:export",
    role?: "tail_supervisor" | "warehouse_receiver" | "order_merchandiser",
  ): void {
    const root = actor.actorRoles.includes("root_superuser");
    if (!root && (
      actor.authorizationCapability !== capability
      || !actor.authorizationCapabilities?.includes(capability)
      || (role !== undefined && !(role === "warehouse_receiver" ? hasWarehouseReceivingRole(actor.actorRoles) : actor.actorRoles.includes(role)))
    )) {
      fail("没有权限执行此订单回货操作", 403, "FORBIDDEN");
    }
  }

  private async authorizeBoardWrite(client: PoolClient, actor: TrustedActorContext, capability: "receiving:packing_manage" | "receiving:resolve_difference"): Promise<TrustedActorContext> {
    try {
      const result = await client.query<{roles:string[]}>("SELECT receiving_authorized_board_operator($1,$2) roles", [actor.actorId,capability]);
      return {...actor,actorRoles:result.rows[0]!.roles,authorizationCapability:capability};
    } catch(error) {
      if((error as {code?:string}).code === "42501") fail("当前账号无权执行此订单回货操作",403,"FORBIDDEN");
      throw error;
    }
  }

  private async styleOperationSnapshot(
    client: PoolClient,
    receivingBatchId: string,
  ): Promise<StyleOperationSnapshot> {
    if (!UUID_PATTERN.test(receivingBatchId)) fail("收货订单标识无效");
    const batchResult = await client.query<{ style_no: string; cutting_order_id: string | null }>(
      "SELECT style_no,cutting_order_id FROM receiving_batches WHERE receiving_batch_id=$1 AND deleted_at IS NULL",
      [receivingBatchId],
    );
    const batch = batchResult.rows[0];
    if (!batch) return fail("收货订单不存在", 404, "NOT_FOUND");
    const styleNo = normalizeStyleNo(batch.style_no);
    const operationKey = batch.cutting_order_id ? `cutting:${batch.cutting_order_id}` : styleNo;
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [operationKey]);
    const snapshotResult = await client.query<{
      receiving_batch_id: string;
      style_no: string;
      version: number;
      document_quantity: string;
      actual_quantity: string;
      packing_revision_id: string | null;
      packing_quantity: string | null;
      packing_source_quantity:string|null;packing_scope_merge_event_ids:string[];packing_scope_unresolved:boolean;
      receiving_quantity_changed_at: string | null;
      receiving_quantity_revision: string;
      actual_quantity_changed_at: string | null;
      actual_quantity_revision: string;
    }>(
      `${RECEIVING_BOARD_BASE_SQL}
       SELECT action.receiving_batch_id,totals.style_key AS style_no,action.version,
              totals.document_quantity,
              totals.current_actual_quantity AS actual_quantity,
              packing.packing_revision_id,packing.packing_quantity,packing.source_quantity AS packing_source_quantity,packing_scope.merge_event_ids AS packing_scope_merge_event_ids,${RECEIVING_PACKING_SCOPE_UNRESOLVED_SQL} AS packing_scope_unresolved,
              totals.receiving_quantity_changed_at::text,totals.actual_quantity_changed_at::text,
              totals.receiving_quantity_revision,totals.actual_quantity_revision
       FROM style_totals totals
       JOIN LATERAL (
         SELECT item.receiving_batch_id,item.version
         FROM batch_totals item
         WHERE item.group_key=totals.group_key
         ORDER BY item.last_all_received_at DESC NULLS LAST,item.receiving_batch_id DESC
         LIMIT 1
       ) action ON true
       ${RECEIVING_GROUP_PACKING_JOIN_SQL}
       WHERE totals.group_key=COALESCE('cut:'||$4::uuid::text,'style:'||$3)`,
      ["2000-01-01", "2999-12-31", styleNo, batch.cutting_order_id],
    );
    const snapshot = snapshotResult.rows[0];
    if (!snapshot) return fail("收货订单不存在", 404, "NOT_FOUND");
    if (snapshot.receiving_batch_id !== receivingBatchId) {
      fail("订单已产生新的收货记录，请刷新后重试", 409, "CONFLICT");
    }
    return {
      receivingBatchId: snapshot.receiving_batch_id,
      styleNo: snapshot.style_no,
      version: snapshot.version,
      documentQuantity: Number(snapshot.document_quantity),
      actualQuantity: Number(snapshot.actual_quantity),
      packingRevisionId: snapshot.packing_revision_id,
      packingQuantity: snapshot.packing_quantity === null ? null : Number(snapshot.packing_quantity),
      packingSourceQuantity:snapshot.packing_source_quantity==null?null:Number(snapshot.packing_source_quantity),packingScopeMergeEventIds:snapshot.packing_scope_merge_event_ids,packingScopeUnresolved:snapshot.packing_scope_unresolved,
      receivingQuantityChangedAt:snapshot.receiving_quantity_changed_at,
      receivingQuantityRevision:snapshot.receiving_quantity_revision,
      actualQuantityChangedAt:snapshot.actual_quantity_changed_at,
      actualQuantityRevision:snapshot.actual_quantity_revision,
    };
  }

  private validateExpectedVersion(value: number): number {
    if (!Number.isInteger(value) || value < 1) fail("收货订单版本无效");
    return value;
  }

  private async lockStyles(client: PoolClient, styles: readonly string[]): Promise<void> {
    for (const style of [...new Set(styles)].sort()) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [style]);
    }
  }

  private async mutableBatch(
    client: PoolClient,
    receivingBatchId: string,
    allowReworkHistory = false,
  ): Promise<Readonly<{
    style_no: string;
    version: number;
    deleted_at: Date | null;
    document_quantity: string;
    actual_quantity: string;
    defective_quantity: string;
    has_rework_history: boolean;
  }>> {
    const result = await client.query<{
      style_no: string;
      version: number;
      deleted_at: Date | null;
      document_quantity: string;
      actual_quantity: string;
      defective_quantity: string;
      has_rework_history: boolean;
    }>(
      `SELECT batch.style_no,batch.version,batch.deleted_at,
              batch.delivery_note_quantity::bigint AS document_quantity,
              (totals.actual_quantity+batch.actual_quantity_adjustment)::bigint AS actual_quantity,
              (totals.defective_quantity+batch.defective_quantity_adjustment)::bigint AS defective_quantity,
              EXISTS(
                SELECT 1 FROM rework_orders rework
                WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
              ) AS has_rework_history
       FROM receiving_batches batch
       JOIN LATERAL (
         SELECT sum(receipt.document_quantity)::bigint AS document_quantity,
                sum(receipt.actual_quantity)::bigint AS actual_quantity,
                sum(receipt.defective_quantity)::bigint AS defective_quantity
         FROM receiving_receipts receipt
         WHERE receipt.receiving_batch_id=batch.receiving_batch_id
       ) totals ON totals.document_quantity IS NOT NULL
       WHERE batch.receiving_batch_id=$1
       FOR UPDATE OF batch`,
      [receivingBatchId],
    );
    const row = result.rows[0];
    if (!row) return fail("收货订单不存在", 404, "NOT_FOUND");
    if (row.deleted_at) return fail("收货订单不存在", 404, "NOT_FOUND");
    if (row.has_rework_history && !allowReworkHistory) {
      fail("该订单已经发起过返工，不能再修改或删除", 409, "INVALID_STATE_TRANSITION");
    }
    return row;
  }

  private async replaceReceivingImages(
    client: PoolClient,
    actor: TrustedActorContext,
    receivingBatchId: string,
    attachmentIds: readonly string[] | undefined,
  ): Promise<void> {
    if (attachmentIds === undefined) return;
    const candidates = await client.query<{
      attachment_id: string;
      uploaded_by: string;
      mime_type: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
    }>(
      `SELECT attachment_id,uploaded_by,mime_type,status,entity_type,entity_id
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
       FOR UPDATE`,
      [attachmentIds],
    );
    if (candidates.rows.length !== attachmentIds.length) fail("送货单图片不存在或不可用；请收货登记人在本页核对每张图片的上传状态及归属，保留已成功上传且可用的图片");
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("送货单图片尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的送货单图片", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("送货单图片仅支持JPEG、PNG、WebP");
      if (row.entity_type !== null || row.entity_id !== null) {
        fail("替换图片已绑定到其他业务记录", 409, "CONFLICT");
      }
    }
    const current = await client.query<{ attachment_id: string }>(
      `SELECT attachment.attachment_id
       FROM attachments attachment
       WHERE attachment.entity_type='receiving_batch'
         AND attachment.entity_id=$1
         AND attachment.status='ready'
         AND attachment.mime_type LIKE 'image/%'
         AND NOT EXISTS(
           SELECT 1 FROM receiving_attachment_retirements retired
           WHERE retired.attachment_id=attachment.attachment_id
         )
       FOR UPDATE`,
      [receivingBatchId],
    );
    const replacedAttachmentIds = current.rows.map((row) => row.attachment_id);
    const eventId = await this.events.append(client, actor, {
      action: "receiving.batch.images.replace",
      entityType: "receiving_batch",
      entityId: receivingBatchId,
      before: { receivingBatchId, attachmentIds: replacedAttachmentIds },
      after: { receivingBatchId, attachmentIds, replacedAttachmentIds },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await client.query(
      `UPDATE attachments
       SET entity_type='receiving_batch',entity_id=$2
       WHERE attachment_id=ANY($1::uuid[])
         AND entity_type IS NULL AND entity_id IS NULL`,
      [attachmentIds, receivingBatchId],
    );
    if (replacedAttachmentIds.length > 0) {
      await client.query(
        `INSERT INTO receiving_attachment_retirements(
           attachment_id,receiving_batch_id,operation_event_id,retired_by,request_id
         )
         SELECT unnest($1::uuid[]),$2,$3,$4,$5`,
        [replacedAttachmentIds, receivingBatchId, eventId, actor.actorId, actor.requestId],
      );
    }
  }

  async correctBatch(
    actor: TrustedActorContext,
    receivingBatchId: string,
    input: CorrectReceivingBatchInput,
  ): Promise<ReceivingBatchSnapshot> {
    this.assertRootCorrector(actor);
    if (!UUID_PATTERN.test(receivingBatchId)) fail("收货订单标识无效");
    const normalized = {
      expectedVersion: this.validateExpectedVersion(input.expectedVersion),
      styleNo: normalizeStyleNo(input.styleNo),
      documentQuantity: validateQuantity(input.documentQuantity, "送货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "实际收货数量", true),
      defectiveQuantity: input.defectiveQuantity === undefined
        ? undefined
        : validateQuantity(input.defectiveQuantity, "次品数量", true),
      attachmentIds: normalizeReplacementAttachmentIds(input.attachmentIds),
    };
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const currentStyle = await client.query<{ style_no: string }>(
        "SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1",
        [receivingBatchId],
      );
      const styleRow = currentStyle.rows[0];
      if (!styleRow) return fail("收货订单不存在", 404, "NOT_FOUND");
      await this.lockStyles(client, [styleRow.style_no, normalized.styleNo]);
      const current = await this.mutableBatch(client, receivingBatchId, true);
      if (current.version !== normalized.expectedVersion) {
        fail("收货订单版本已变化，本次未覆盖；请Root在本单收货记录重新读取数量和送货单后再提交", 409, "CONFLICT");
      }
      if (current.has_rework_history && normalized.attachmentIds !== undefined) {
        fail("返工发起后不能替换送货单图片", 409, "INVALID_STATE_TRANSITION");
      }
      const defectiveQuantity = normalized.defectiveQuantity ?? Number(current.defective_quantity);
      if (defectiveQuantity > normalized.actualQuantity) fail("次品数量不能超过实际收货数量");
      const before: ReceivingBatchSnapshot = {
        receivingBatchId,
        styleNo: current.style_no,
        documentQuantity: Number(current.document_quantity),
        actualQuantity: Number(current.actual_quantity),
        defectiveQuantity: Number(current.defective_quantity),
        differenceQuantity: Number(current.actual_quantity) - Number(current.document_quantity),
        version: current.version,
      };

      const quantityChanged=before.documentQuantity!==normalized.documentQuantity||before.actualQuantity!==normalized.actualQuantity||before.defectiveQuantity!==defectiveQuantity;
      const receipts=(await client.query(`SELECT r.receipt_id,coalesce(c.receiving_source,r.receiving_source) AS source,
        coalesce(c.document_quantity,r.document_quantity)::bigint AS document_quantity,
        coalesce(c.actual_quantity,r.actual_quantity)::bigint AS actual_quantity,
        coalesce(c.defective_quantity,r.defective_quantity)::bigint AS defective_quantity
        FROM receiving_receipts r LEFT JOIN LATERAL(SELECT * FROM receiving_receipt_corrections c
          WHERE c.receipt_id=r.receipt_id ORDER BY c.created_at DESC,c.correction_id DESC LIMIT 1)c ON true
        WHERE r.receiving_batch_id=$1 ORDER BY r.received_at,r.receipt_id`,[receivingBatchId])).rows;
      if(quantityChanged&&receipts.length!==1)fail('本单有多笔收货，请展开收货记录并修正实际录错的那一笔；累计数不能猜分摊',409,'CONFLICT');
      const appendQuantityCorrection=async(eventId:string)=>{
        if(!quantityChanged)return;
        const receipt=receipts[0]!;
        await client.query(`INSERT INTO receiving_receipt_corrections(correction_id,receipt_id,receiving_batch_id,receiving_source,
          document_quantity,actual_quantity,defective_quantity,corrected_by,operation_event_id,request_id)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[randomUUID(),receipt.receipt_id,receivingBatchId,receipt.source,
          normalized.documentQuantity,normalized.actualQuantity,defectiveQuantity,actor.actorId,eventId,actor.requestId]);
      };
      const targetResult = current.has_rework_history ? { rows: [] } : await client.query<{
        receiving_batch_id: string;
        has_rework_history: boolean;
      }>(
        `SELECT target.receiving_batch_id,
                EXISTS(
                  SELECT 1 FROM rework_orders history
                  WHERE history.source_receiving_batch_id=target.receiving_batch_id
                ) AS has_rework_history
         FROM receiving_batches target
         WHERE upper(btrim(target.style_no))=$1
           AND $1<>upper(btrim($3))
           AND target.receiving_batch_id<>$2
           AND target.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1
             FROM receiving_receipts receipt
             JOIN operation_events event ON event.event_id=receipt.operation_event_id
             WHERE receipt.receiving_batch_id=target.receiving_batch_id
               AND event.after_state->>'backfilled'='true'
           )
         ORDER BY target.created_at DESC,target.receiving_batch_id DESC
         LIMIT 1`,
        [normalized.styleNo, receivingBatchId, current.style_no],
      );
      const targetRow = targetResult.rows[0];
      if (targetRow?.has_rework_history && normalized.attachmentIds !== undefined) {
        fail("目标订单已经发起过返工，不能替换送货单图片", 409, "INVALID_STATE_TRANSITION");
      }
      const targetId = targetRow?.receiving_batch_id;
      if (targetId) {
        const target = await this.mutableBatch(client, targetId, true);
        const targetBefore: ReceivingBatchSnapshot = {
          receivingBatchId: targetId,
          styleNo: target.style_no,
          documentQuantity: Number(target.document_quantity),
          actualQuantity: Number(target.actual_quantity),
          defectiveQuantity: Number(target.defective_quantity),
          differenceQuantity: Number(target.actual_quantity) - Number(target.document_quantity),
          version: target.version,
        };
        const after: ReceivingBatchSnapshot = {
          receivingBatchId: targetId,
          styleNo: target.style_no,
          documentQuantity: Number(target.document_quantity),
          actualQuantity: Number(target.actual_quantity) + normalized.actualQuantity,
          defectiveQuantity: Number(target.defective_quantity) + defectiveQuantity,
          differenceQuantity: Number(target.actual_quantity) + normalized.actualQuantity
            - Number(target.document_quantity),
          version: target.version + 1,
        };
        if (after.defectiveQuantity > after.actualQuantity) fail("合并后的次品数量不能超过实际收货数量");
        const sourceFacts = await client.query<{
          actual_quantity: string;
          defective_quantity: string;
        }>(
          `SELECT sum(actual_quantity)::bigint AS actual_quantity,
                  sum(defective_quantity)::bigint AS defective_quantity
           FROM receiving_receipts WHERE receiving_batch_id=$1`,
          [receivingBatchId],
        );
        const sourceActualAdjustment = normalized.actualQuantity
          - Number(sourceFacts.rows[0]?.actual_quantity ?? 0);
        const sourceDefectiveAdjustment = defectiveQuantity
          - Number(sourceFacts.rows[0]?.defective_quantity ?? 0);
        const mergeEventId = await this.events.append(client, actor, {
          action: "receiving.batch.merge",
          entityType: "receiving_batch",
          entityId: targetId,
          before: targetBefore,
          after: {
            ...after,
            sourceReceivingBatchId: receivingBatchId,
            targetReceivingBatchId: targetId,
            actualQuantityAdjustment: sourceActualAdjustment,
            defectiveQuantityAdjustment: sourceDefectiveAdjustment,
            source: { ...before, correctedStyleNo: normalized.styleNo },
          },
        });
        await appendQuantityCorrection(mergeEventId);
        await client.query(
          "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
          [mergeEventId, actor.requestId],
        );
        await client.query(
          "UPDATE receiving_receipts SET receiving_batch_id=$2 WHERE receiving_batch_id=$1",
          [receivingBatchId, targetId],
        );
        await client.query(
          `UPDATE attachments SET entity_id=$2
           WHERE entity_type='receiving_batch' AND entity_id=$1`,
          [receivingBatchId, targetId],
        );
        await client.query("SELECT set_config('dx_rework.receiving_root_action','merge',true)");
        const merged = await client.query(
          `UPDATE receiving_batches batch
           SET document_quantity_adjustment=$2-(
                 SELECT sum(receipt.document_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               actual_quantity_adjustment=$3-(
                 SELECT sum(receipt.actual_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               defective_quantity_adjustment=$4-(
                 SELECT sum(receipt.defective_quantity) FROM receiving_receipts receipt
                 WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               ),
               version=batch.version+1,updated_by=$5,updated_at=clock_timestamp(),
               last_operation_event_id=$6,last_request_id=$7
           WHERE batch.receiving_batch_id=$1 AND batch.version=$8 AND batch.deleted_at IS NULL`,
          [
            targetId,
            after.documentQuantity,
            after.actualQuantity,
            after.defectiveQuantity,
            actor.actorId,
            mergeEventId,
            actor.requestId,
            target.version,
          ],
        );
        if (merged.rowCount !== 1) fail("目标收货订单状态已变化，请刷新后重试", 409, "CONFLICT");

        const deleteAfter = { ...before, version: current.version + 1, deleted: true as const, mergedInto: targetId };
        const deleteEventId = await this.events.append(client, actor, {
          action: "receiving.batch.delete",
          entityType: "receiving_batch",
          entityId: receivingBatchId,
          before,
          after: deleteAfter,
        });
        await client.query("SELECT set_config('dx_rework.receiving_root_action','delete',true)");
        const deleted = await client.query(
          `UPDATE receiving_batches
           SET deleted_at=clock_timestamp(),deleted_by=$2,version=version+1,
               updated_by=$2,updated_at=clock_timestamp(),
               last_operation_event_id=$3,last_request_id=$4
           WHERE receiving_batch_id=$1 AND version=$5 AND deleted_at IS NULL`,
          [receivingBatchId, actor.actorId, deleteEventId, actor.requestId, current.version],
        );
        if (deleted.rowCount !== 1) fail("来源收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
        await this.replaceReceivingImages(client, actor, targetId, normalized.attachmentIds);
        await invalidatePackingAliasCandidates(client,[current.style_no,normalized.styleNo]);
        await client.query("COMMIT");
        return after;
      }

      const after: ReceivingBatchSnapshot = {
        receivingBatchId,
        styleNo: normalized.styleNo,
        documentQuantity: normalized.documentQuantity,
        actualQuantity: normalized.actualQuantity,
        defectiveQuantity,
        differenceQuantity: normalized.actualQuantity - normalized.documentQuantity,
        version: current.version + 1,
      };
      const eventId = await this.events.append(client, actor, {
        action: "receiving.batch.correct",
        entityType: "receiving_batch",
        entityId: receivingBatchId,
        before,
        after,
      });
      await client.query(
        "SELECT set_config('dx_rework.receiving_root_action','correct',true),set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
        [eventId, actor.requestId],
      );
      await appendQuantityCorrection(eventId);
      const updated = await client.query(
        `UPDATE receiving_batches batch
         SET style_no=$2,delivery_note_quantity=$3,
             document_quantity_adjustment=$3-(SELECT sum(document_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             actual_quantity_adjustment=$4-(SELECT sum(actual_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             defective_quantity_adjustment=$5-(SELECT sum(defective_quantity) FROM receiving_receipts WHERE receiving_batch_id=batch.receiving_batch_id),
             version=batch.version+1,updated_by=$6,updated_at=clock_timestamp(),
             last_operation_event_id=$7,last_request_id=$8
         WHERE batch.receiving_batch_id=$1 AND batch.version=$9 AND batch.deleted_at IS NULL`,
        [receivingBatchId, normalized.styleNo, normalized.documentQuantity, normalized.actualQuantity,
          defectiveQuantity, actor.actorId, eventId, actor.requestId, normalized.expectedVersion],
      );
      if (updated.rowCount !== 1) fail("收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
      if (current.has_rework_history && current.style_no !== normalized.styleNo) {
        await client.query(
          `UPDATE rework_orders
           SET style_no=$2,version=version+1,updated_by=$3,updated_at=clock_timestamp()
           WHERE source_receiving_batch_id=$1 AND style_no IS DISTINCT FROM $2`,
          [receivingBatchId, normalized.styleNo, actor.actorId],
        );
      }
      await this.replaceReceivingImages(client, actor, receivingBatchId, normalized.attachmentIds);
      await invalidatePackingAliasCandidates(client,[current.style_no,normalized.styleNo]);
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async deleteBatch(
    actor: TrustedActorContext,
    receivingBatchId: string,
    expectedVersion: number,
  ): Promise<Readonly<{ receivingBatchId: string; deleted: true }>> {
    this.assertRootCorrector(actor);
    if (!UUID_PATTERN.test(receivingBatchId)) fail("收货订单标识无效");
    const version = this.validateExpectedVersion(expectedVersion);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const currentStyle = await client.query<{ style_no: string }>(
        "SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1",
        [receivingBatchId],
      );
      const styleRow = currentStyle.rows[0];
      if (!styleRow) return fail("收货订单不存在", 404, "NOT_FOUND");
      await this.lockStyles(client, [styleRow.style_no]);
      const current = await this.mutableBatch(client, receivingBatchId);
      if (current.version !== version) fail("收货订单版本已变化，本次未覆盖；请Root在本单收货记录重新读取数量和送货单后再提交", 409, "CONFLICT");
      const before = {
        receivingBatchId,
        styleNo: current.style_no,
        documentQuantity: Number(current.document_quantity),
        actualQuantity: Number(current.actual_quantity),
        defectiveQuantity: Number(current.defective_quantity),
        differenceQuantity: Number(current.actual_quantity) - Number(current.document_quantity),
        version: current.version,
      };
      const after = { ...before, version: current.version + 1, deleted: true as const };
      const eventId = await this.events.append(client, actor, {
        action: "receiving.batch.delete",
        entityType: "receiving_batch",
        entityId: receivingBatchId,
        before,
        after,
      });
      await client.query("SELECT set_config('dx_rework.receiving_root_action','delete',true)");
      const updated = await client.query(
        `UPDATE receiving_batches batch
         SET deleted_at=clock_timestamp(),deleted_by=$2,version=batch.version+1,
             updated_by=$2,updated_at=clock_timestamp(),
             last_operation_event_id=$3,last_request_id=$4
         WHERE batch.receiving_batch_id=$1
           AND batch.version=$5
           AND batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1 FROM rework_orders rework
             WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
           )`,
        [receivingBatchId, actor.actorId, eventId, actor.requestId, version],
      );
      if (updated.rowCount !== 1) fail("收货订单状态已变化，请刷新后重试", 409, "CONFLICT");
      await invalidatePackingAliasCandidates(client,[current.style_no]);
      await client.query("COMMIT");
      return { receivingBatchId, deleted: true };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async repeatReceivingBatch(
    client: PoolClient,
    receivingBatchId: string,
    cuttingOrderId?: string,
  ): Promise<{ receivingBatchId: string; styleNo: string; documentQuantity: number }> {
    if (cuttingOrderId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cutting:${cuttingOrderId}`]);
      const target = await client.query<{
        receiving_batch_id: string;
        style_no: string;
        document_quantity: string;
      }>(
        `SELECT batch.receiving_batch_id,
                upper(btrim(batch.style_no)) AS style_no,
                batch.delivery_note_quantity::bigint AS document_quantity
         FROM receiving_batches batch
         WHERE batch.receiving_batch_id=$1
           AND batch.cutting_order_id=$2
           AND batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1 FROM receiving_receipts receipt
             JOIN operation_events event ON event.event_id=receipt.operation_event_id
             WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               AND event.after_state->>'backfilled'='true'
           )
           AND NOT EXISTS(
             SELECT 1 FROM rework_orders rework
             WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
               AND (
                 rework.status='completed'
                 OR EXISTS(
                   SELECT 1 FROM operation_events event
                   WHERE event.entity_type='rework_order'
                     AND event.entity_id=rework.rework_order_id::text
                     AND event.after_state->>'status'='completed'
                 )
               )
           )
           AND EXISTS(
             SELECT 1 FROM attachments attachment
             WHERE attachment.entity_type='receiving_batch'
               AND attachment.entity_id=batch.receiving_batch_id::text
               AND attachment.status='ready'
               AND NOT EXISTS(
                 SELECT 1 FROM receiving_attachment_retirements retired
                 WHERE retired.attachment_id=attachment.attachment_id
               )
           )
           AND batch.receiving_batch_id=(
             SELECT latest.receiving_batch_id
             FROM receiving_batches latest
             WHERE latest.cutting_order_id=$2
               AND latest.deleted_at IS NULL
               AND NOT EXISTS(
                 SELECT 1 FROM receiving_receipts receipt
                 JOIN operation_events event ON event.event_id=receipt.operation_event_id
                 WHERE receipt.receiving_batch_id=latest.receiving_batch_id
                   AND event.after_state->>'backfilled'='true'
               )
             ORDER BY latest.created_at DESC,latest.receiving_batch_id DESC
             LIMIT 1
           )
         FOR UPDATE OF batch`,
        [receivingBatchId, cuttingOrderId],
      );
      const row = target.rows[0];
      if (!row) return fail("该订单已不可追加收货，请重新搜索选择", 409, "INVALID_STATE_TRANSITION");
      return {
        receivingBatchId: row.receiving_batch_id,
        styleNo: row.style_no,
        documentQuantity: Number(row.document_quantity),
      };
    }

    const initial = await client.query<{ style_no: string }>(
      `SELECT style_no FROM receiving_batches
       WHERE receiving_batch_id=$1 AND deleted_at IS NULL`,
      [receivingBatchId],
    );
    const initialRow = initial.rows[0];
    if (!initialRow) return fail("收货订单不存在", 404, "NOT_FOUND");
    const styleNo = normalizeStyleNo(initialRow.style_no);
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [styleNo]);
    const target = await client.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
    }>(
      `SELECT batch.receiving_batch_id,
              upper(btrim(batch.style_no)) AS style_no,
              batch.delivery_note_quantity::bigint AS document_quantity
       FROM receiving_batches batch
       WHERE batch.receiving_batch_id=$1
         AND batch.deleted_at IS NULL
         AND NOT EXISTS(
           SELECT 1 FROM receiving_receipts receipt
           JOIN operation_events event ON event.event_id=receipt.operation_event_id
           WHERE receipt.receiving_batch_id=batch.receiving_batch_id
             AND event.after_state->>'backfilled'='true'
         )
         AND NOT EXISTS(
           SELECT 1 FROM rework_orders rework
           WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
             AND (
               rework.status='completed'
               OR EXISTS(
                 SELECT 1 FROM operation_events event
                 WHERE event.entity_type='rework_order'
                   AND event.entity_id=rework.rework_order_id::text
                   AND event.after_state->>'status'='completed'
               )
             )
         )
         AND EXISTS(
           SELECT 1 FROM attachments attachment
           WHERE attachment.entity_type='receiving_batch'
             AND attachment.entity_id=batch.receiving_batch_id::text
             AND attachment.status='ready'
             AND NOT EXISTS(
               SELECT 1 FROM receiving_attachment_retirements retired
               WHERE retired.attachment_id=attachment.attachment_id
             )
         )
         AND batch.receiving_batch_id=(
           SELECT latest.receiving_batch_id
           FROM receiving_batches latest
           WHERE upper(btrim(latest.style_no))=$2
             AND latest.deleted_at IS NULL
             AND NOT EXISTS(
               SELECT 1 FROM receiving_receipts receipt
               JOIN operation_events event ON event.event_id=receipt.operation_event_id
               WHERE receipt.receiving_batch_id=latest.receiving_batch_id
                 AND event.after_state->>'backfilled'='true'
             )
           ORDER BY latest.created_at DESC,latest.receiving_batch_id DESC
           LIMIT 1
         )
       FOR UPDATE OF batch`,
      [receivingBatchId, styleNo],
    );
    const row = target.rows[0];
    if (!row) return fail("该订单已不可追加收货，请重新搜索选择", 409, "INVALID_STATE_TRANSITION");
    return {
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
    };
  }

  private async resolveReceivingBatch(
    client: PoolClient,
    actor: TrustedActorContext,
    styleNo: string,
    documentQuantity: number,
    receivedDate: string | null,
    cuttingOrderId?: string,
  ): Promise<{ receivingBatchId: string; isNew: boolean }> {
    if (cuttingOrderId) {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`cutting:${cuttingOrderId}`]);
      const latest = await client.query<{ receiving_batch_id: string; closed: boolean }>(
        `SELECT batch.receiving_batch_id,
                EXISTS(
                  SELECT 1 FROM rework_orders rework
                  WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                    AND (
                      rework.status='completed'
                      OR EXISTS (
                        SELECT 1 FROM operation_events event
                        WHERE event.entity_type='rework_order'
                          AND event.entity_id=rework.rework_order_id::text
                          AND event.after_state->>'status'='completed'
                      )
                    )
                ) AS closed
         FROM receiving_batches batch
         WHERE batch.cutting_order_id=$1
           AND batch.deleted_at IS NULL
           AND NOT EXISTS(
             SELECT 1
             FROM receiving_receipts backfill_receipt
             JOIN operation_events backfill_event
               ON backfill_event.event_id=backfill_receipt.operation_event_id
             WHERE backfill_receipt.receiving_batch_id=batch.receiving_batch_id
               AND backfill_event.after_state->>'backfilled'='true'
           )
         ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
         LIMIT 1`,
        [cuttingOrderId],
      );
      const current = latest.rows[0];
      if (!receivedDate && current && !current.closed) {
        return fail("该裁床任务已有收货记录，请到“多次收货”录入", 409, "REPEAT_RECEIVING_REQUIRED");
      }
      const receivingBatchId = randomUUID();
      await client.query(
        `INSERT INTO receiving_batches(
           receiving_batch_id,cutting_order_id,style_no,delivery_note_quantity,created_by,created_at
         ) VALUES($1,$2,$3,$4,$5,COALESCE(
           ($6::date+(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
           CURRENT_TIMESTAMP
         ))`,
        [receivingBatchId, cuttingOrderId, styleNo, documentQuantity, actor.actorId, receivedDate],
      );
      return { receivingBatchId, isNew: true };
    }

    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [styleNo]);
    const latest = await client.query<{ receiving_batch_id: string; closed: boolean }>(
      `SELECT batch.receiving_batch_id,
              EXISTS(
                SELECT 1 FROM rework_orders rework
                WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                  AND (
                    rework.status='completed'
                    OR EXISTS (
                      SELECT 1 FROM operation_events event
                      WHERE event.entity_type='rework_order'
                        AND event.entity_id=rework.rework_order_id::text
                        AND event.after_state->>'status'='completed'
                    )
                  )
              ) AS closed
       FROM receiving_batches batch
       WHERE upper(btrim(batch.style_no))=$1
         AND batch.deleted_at IS NULL
         AND NOT EXISTS(
           SELECT 1
           FROM receiving_receipts backfill_receipt
           JOIN operation_events backfill_event
             ON backfill_event.event_id=backfill_receipt.operation_event_id
           WHERE backfill_receipt.receiving_batch_id=batch.receiving_batch_id
             AND backfill_event.after_state->>'backfilled'='true'
         )
       ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
       LIMIT 1`,
      [styleNo],
    );
    const current = latest.rows[0];
    if (!receivedDate && current && !current.closed) {
      return fail("该款号已有收货记录，请到“多次收货”录入", 409, "REPEAT_RECEIVING_REQUIRED");
    }
    const receivingBatchId = randomUUID();
    await client.query(
      `INSERT INTO receiving_batches(
         receiving_batch_id,style_no,delivery_note_quantity,created_by,created_at
       ) VALUES($1,$2,$3,$4,COALESCE(
         ($5::date+(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
         CURRENT_TIMESTAMP
       ))`,
      [receivingBatchId, styleNo, documentQuantity, actor.actorId, receivedDate],
    );
    return { receivingBatchId, isNew: true };
  }

  private async bindReceivingImages(
    client: PoolClient,
    actor: TrustedActorContext,
    receivingBatchId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const existing = await client.query<{ count: string }>(
      `SELECT count(*)::text AS count
       FROM attachments
       WHERE entity_type='receiving_batch' AND entity_id=$1 AND status='ready'
         AND NOT EXISTS(
           SELECT 1 FROM receiving_attachment_retirements retired
           WHERE retired.attachment_id=attachments.attachment_id
         )`,
      [receivingBatchId],
    );
    const existingCount = Number(existing.rows[0]?.count ?? 0);

    if (attachmentIds.length === 0) {
      if (existingCount === 0) fail("送货单图片必传，最多3张");
      return;
    }

    const candidates = await client.query<{
      attachment_id: string;
      uploaded_by: string;
      mime_type: string;
      status: string;
      entity_type: string | null;
      entity_id: string | null;
    }>(
      `SELECT attachment_id,uploaded_by,mime_type,status,entity_type,entity_id
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
       FOR UPDATE`,
      [attachmentIds],
    );
    if (candidates.rows.length !== attachmentIds.length) fail("送货单图片不存在或不可用；请收货登记人在本页核对每张图片的上传状态及归属，保留已成功上传且可用的图片");

    let newBindings = 0;
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("送货单图片尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的送货单图片", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("送货单图片仅支持JPEG、PNG、WebP");
      const alreadyBound = row.entity_type === "receiving_batch" && row.entity_id === receivingBatchId;
      if (row.entity_type !== null && !alreadyBound) fail("送货单图片已绑定到其他业务记录", 409, "CONFLICT");
      if (!alreadyBound) newBindings += 1;
    }
    if (existingCount + newBindings > MAX_RECEIVING_IMAGES) fail("送货单图片最多3张");

    await client.query(
      `UPDATE attachments
       SET entity_type='receiving_batch',entity_id=$2
       WHERE attachment_id=ANY($1::uuid[])
         AND entity_type IS NULL`,
      [attachmentIds, receivingBatchId],
    );
  }

  private async createInTransaction(
    client: PoolClient,
    actor: TrustedActorContext,
    input: NormalizedCreateReceivingInput,
    targetReceivingBatchId?: string,
  ): Promise<ReceivingReceipt> {
    const receivingBatchId = targetReceivingBatchId ?? (await this.resolveReceivingBatch(
      client,
      actor,
      input.styleNo,
      input.documentQuantity,
      input.receivedDate,
      input.cuttingOrderId,
    )).receivingBatchId;
    const receiptId = randomUUID();
    const eventId = await this.events.append(client, actor, {
      action: "receiving.receipt.create",
      entityType: "receiving_receipt",
      entityId: receiptId,
      after: {
        ...(input.cuttingOrderId ? { cuttingOrderId: input.cuttingOrderId } : {}),
        ...(input.productionOrderId ? { productionOrderId: input.productionOrderId } : {}),
      ...(input.factoryDecisionId!==undefined?{factoryDecisionId:normalizeOptionalUuid(input.factoryDecisionId,"分厂标识")}:{ }),
        receiptId,
        receivingBatchId,
        styleNo: input.styleNo,
        documentQuantity: input.documentQuantity,
        actualQuantity: input.actualQuantity,
        defectiveQuantity: input.defectiveQuantity,
        differenceQuantity: input.actualQuantity - input.documentQuantity,
        receivingSource: input.receivingSource,
        deliveryNoteIncrement: input.receivingSource === "other_factory" ? input.documentQuantity : 0,
        attachmentIds: input.attachmentIds,
        ...(input.receivedDate ? { receivedDate: input.receivedDate, backfilled: true } : {}),
      },
    });
    await client.query(
      "SELECT set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
      [eventId, actor.requestId],
    );
    await this.bindReceivingImages(client, actor, receivingBatchId, input.attachmentIds);

    const inserted = input.cuttingOrderId
      ? await client.query<{
          receipt_id: string;
          receiving_batch_id: string;
          style_no: string;
          document_quantity: number;
          actual_quantity: number;
          defective_quantity: number;
          difference_quantity: number;
          received_by: string;
          received_at: Date;
        }>(
          `INSERT INTO receiving_receipts(
             receipt_id,receiving_batch_id,cutting_order_id,style_no,document_quantity,actual_quantity,defective_quantity,
             receiving_source,received_by,operation_event_id,request_id,received_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE(
             ($12::date+($13::timestamptz AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
             $13::timestamptz
           ))
           RETURNING receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,defective_quantity,
                     difference_quantity,received_by,received_at`,
          [
            receiptId,receivingBatchId,input.cuttingOrderId,input.styleNo,input.documentQuantity,
            input.actualQuantity,input.defectiveQuantity,input.receivingSource,actor.actorId,eventId,
            actor.requestId,input.receivedDate,businessNow().toISOString(),
          ],
        )
      : await client.query<{
          receipt_id: string;
          receiving_batch_id: string;
          style_no: string;
          document_quantity: number;
          actual_quantity: number;
          defective_quantity: number;
          difference_quantity: number;
          received_by: string;
          received_at: Date;
        }>(
          `INSERT INTO receiving_receipts(
             receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,defective_quantity,
             receiving_source,received_by,operation_event_id,request_id,received_at
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,COALESCE(
             ($11::date+($12::timestamptz AT TIME ZONE 'Asia/Shanghai')::time) AT TIME ZONE 'Asia/Shanghai',
             $12::timestamptz
           ))
           RETURNING receipt_id,receiving_batch_id,style_no,document_quantity,actual_quantity,defective_quantity,
                     difference_quantity,received_by,received_at`,
          [
            receiptId,receivingBatchId,input.styleNo,input.documentQuantity,input.actualQuantity,
            input.defectiveQuantity,input.receivingSource,actor.actorId,eventId,actor.requestId,input.receivedDate,businessNow().toISOString(),
          ],
        );
    if (input.receivingSource === "other_factory") {
      await client.query("SELECT set_config('dx_rework.receiving_root_action','append_other_factory',true)");
      const updated = await client.query(
        `UPDATE receiving_batches
         SET delivery_note_quantity=delivery_note_quantity+$2,
             version=version+1,updated_by=$3,updated_at=clock_timestamp(),
             last_operation_event_id=$4,last_request_id=$5
         WHERE receiving_batch_id=$1 AND deleted_at IS NULL`,
        [receivingBatchId, input.documentQuantity, actor.actorId, eventId, actor.requestId],
      );
      if (updated.rowCount !== 1) fail("该订单已不可追加收货，请重新搜索选择", 409, "INVALID_STATE_TRANSITION");
    }
    const row = inserted.rows[0]!;
    if(!input.cuttingOrderId)await invalidatePackingAliasCandidates(client,[input.styleNo]);
    await linkDigitalReceipt(client,receiptId,receivingBatchId);
    if (this.production && input.cuttingOrderId) {
      await this.production.linkReceiptByCuttingOrder(client,actor,{
        cuttingOrderId:input.cuttingOrderId,receiptId,...(input.productionOrderId?{productionOrderId:input.productionOrderId}:{}),...(input.factoryDecisionId!==undefined?{factoryDecisionId:input.factoryDecisionId}:{}),
        styleNo:input.styleNo,operationEventId:eventId,receivedAt:row.received_at.toISOString(),
      });
    } else if (this.production && input.productionOrderId) {
      await this.production.linkReceipt(client,actor,{productionOrderId:input.productionOrderId,receiptId,...(input.factoryDecisionId!==undefined?{factoryDecisionId:input.factoryDecisionId}:{}),
        styleNo:input.styleNo,operationEventId:eventId,receivedAt:row.received_at.toISOString()});
    }
    return {
      receiptId: row.receipt_id,
      receivingBatchId: row.receiving_batch_id,
      styleNo: row.style_no,
      documentQuantity: row.document_quantity,
      actualQuantity: row.actual_quantity,
      defectiveQuantity: row.defective_quantity,
      differenceQuantity: row.difference_quantity,
      receivedBy: row.received_by,
      receivedAt: row.received_at.toISOString(),
    };
  }

  async listCuttingOptions(query = ""): Promise<readonly CuttingReceivingOption[]> {
    const needle = query.trim().toUpperCase();
    if (needle.length < 4) return [];
    const result = await this.database.query<{
      cutting_order_id: string;
      formal_style_no: string;
      color: string | null;
      supplier_name: string;
      actual_cut_count: string;
      style_conflict_count: string;
    }>(
      `SELECT cutting_order_id,upper(btrim(formal_style_no)) AS formal_style_no,
              color,supplier_name,actual_cut_count::text,style_conflict_count::text
       FROM current_cutting_style_options
       WHERE right(upper(btrim(formal_style_no)),char_length($1))=$1
       ORDER BY formal_style_no,supplier_name,color NULLS LAST,cutting_order_id
       LIMIT 20`,
      [needle],
    );
    return result.rows.map((row) => ({
      cuttingOrderId: row.cutting_order_id,
      styleNo: row.formal_style_no,
      color: row.color,
      supplierName: row.supplier_name,
      actualCutCount: Number(row.actual_cut_count),
      styleConflictCount: Number(row.style_conflict_count),
    }));
  }

  async listRepeatOptions(query = ""): Promise<readonly RepeatReceivingOption[]> {
    const needle = query.trim().toUpperCase();
    if (needle.length < 4) return [];

    if (this.options.allowLegacyStyleInput) {
      const result = await this.database.query<{
        receiving_batch_id: string;
        style_no: string;
        document_quantity: string;
        cutting_order_id: string | null;
      }>(
        `WITH ranked AS (
           SELECT batch.receiving_batch_id,batch.cutting_order_id,
                  upper(btrim(batch.style_no)) AS style_no,
                  batch.delivery_note_quantity::bigint AS document_quantity,
                  row_number() OVER (
                    PARTITION BY CASE
                      WHEN batch.cutting_order_id IS NULL
                        THEN 'legacy:'||upper(btrim(batch.style_no))
                      ELSE 'cutting:'||batch.cutting_order_id::text
                    END
                    ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
                  ) AS position,
                  EXISTS(
                    SELECT 1 FROM rework_orders rework
                    WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                      AND (
                        rework.status='completed'
                        OR EXISTS (
                          SELECT 1 FROM operation_events event
                          WHERE event.entity_type='rework_order'
                            AND event.entity_id=rework.rework_order_id::text
                            AND event.after_state->>'status'='completed'
                        )
                      )
                  ) AS closed,
                  EXISTS(
                    SELECT 1 FROM attachments attachment
                    WHERE attachment.entity_type='receiving_batch'
                      AND attachment.entity_id=batch.receiving_batch_id::text
                      AND attachment.status='ready'
                      AND NOT EXISTS(
                        SELECT 1 FROM receiving_attachment_retirements retired
                        WHERE retired.attachment_id=attachment.attachment_id
                      )
                  ) AS has_images
           FROM receiving_batches batch
           WHERE batch.deleted_at IS NULL
             AND NOT EXISTS(
               SELECT 1
               FROM receiving_receipts receipt
               JOIN operation_events event ON event.event_id=receipt.operation_event_id
               WHERE receipt.receiving_batch_id=batch.receiving_batch_id
                 AND event.after_state->>'backfilled'='true'
             )
         )
         SELECT receiving_batch_id,cutting_order_id,style_no,document_quantity
         FROM ranked
         WHERE position=1 AND NOT closed AND has_images
           AND right(style_no,char_length($1))=$1
         ORDER BY style_no
         LIMIT 20`,
        [needle],
      );

      const linkedIds = result.rows
        .map((row) => row.cutting_order_id)
        .filter((value): value is string => value !== null);

      if (linkedIds.length === 0) {
        return result.rows.map((row) => ({
          receivingBatchId: row.receiving_batch_id,
          styleNo: row.style_no,
          documentQuantity: Number(row.document_quantity),
        }));
      }

      const linked = await this.database.query<{
        cutting_order_id: string;
        color: string | null;
        supplier_name: string;
        actual_cut_count: string;
        style_conflict_count: string;
      }>(
        `SELECT cutting_order_id,color,supplier_name,
                actual_cut_count::text,style_conflict_count::text
         FROM current_cutting_style_options
         WHERE cutting_order_id=ANY($1::uuid[])`,
        [linkedIds],
      );
      const linkedById = new Map(linked.rows.map((row) => [row.cutting_order_id, row] as const));

      return result.rows.flatMap((row) => {
        if (!row.cutting_order_id) {
          return [{
            receivingBatchId: row.receiving_batch_id,
            styleNo: row.style_no,
            documentQuantity: Number(row.document_quantity),
          }];
        }
        const option = linkedById.get(row.cutting_order_id);
        if (!option) return [];
        return [{
          receivingBatchId: row.receiving_batch_id,
          cuttingOrderId: option.cutting_order_id,
          styleNo: row.style_no,
          documentQuantity: Number(row.document_quantity),
          color: option.color,
          supplierName: option.supplier_name,
          actualCutCount: Number(option.actual_cut_count),
          styleConflictCount: Number(option.style_conflict_count),
        }];
      });
    }

    const result = await this.database.query<{
      receiving_batch_id: string;
      style_no: string;
      document_quantity: string;
      cutting_order_id: string;
      color: string | null;
      supplier_name: string;
      actual_cut_count: string;
      style_conflict_count: string;
    }>(
      `WITH ranked AS (
         SELECT batch.receiving_batch_id,
                batch.cutting_order_id,
                upper(btrim(batch.style_no)) AS style_no,
                batch.delivery_note_quantity::bigint AS document_quantity,
                row_number() OVER (
                  PARTITION BY batch.cutting_order_id
                  ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
                ) AS position,
                EXISTS(
                  SELECT 1 FROM rework_orders rework
                  WHERE rework.source_receiving_batch_id=batch.receiving_batch_id
                    AND (
                      rework.status='completed'
                      OR EXISTS (
                        SELECT 1 FROM operation_events event
                        WHERE event.entity_type='rework_order'
                          AND event.entity_id=rework.rework_order_id::text
                          AND event.after_state->>'status'='completed'
                      )
                    )
                ) AS closed,
                EXISTS(
                  SELECT 1 FROM attachments attachment
                  WHERE attachment.entity_type='receiving_batch'
                    AND attachment.entity_id=batch.receiving_batch_id::text
                    AND attachment.status='ready'
                    AND NOT EXISTS(
                      SELECT 1 FROM receiving_attachment_retirements retired
                      WHERE retired.attachment_id=attachment.attachment_id
                    )
                ) AS has_images
         FROM receiving_batches batch
         WHERE batch.deleted_at IS NULL
           AND batch.cutting_order_id IS NOT NULL
           AND NOT EXISTS(
             SELECT 1
             FROM receiving_receipts receipt
             JOIN operation_events event ON event.event_id=receipt.operation_event_id
             WHERE receipt.receiving_batch_id=batch.receiving_batch_id
               AND event.after_state->>'backfilled'='true'
           )
       )
       SELECT ranked.receiving_batch_id,ranked.style_no,ranked.document_quantity,
              option_row.cutting_order_id,option_row.color,option_row.supplier_name,
              option_row.actual_cut_count::text,option_row.style_conflict_count::text
       FROM ranked
       JOIN current_cutting_style_options option_row
         ON option_row.cutting_order_id=ranked.cutting_order_id
       WHERE ranked.position=1 AND NOT ranked.closed AND ranked.has_images
         AND right(ranked.style_no,char_length($1))=$1
       ORDER BY ranked.style_no,option_row.supplier_name,option_row.color NULLS LAST,
                option_row.cutting_order_id
       LIMIT 20`,
      [needle],
    );
    return result.rows.map((row) => ({
      receivingBatchId: row.receiving_batch_id,
      cuttingOrderId: row.cutting_order_id,
      styleNo: row.style_no,
      documentQuantity: Number(row.document_quantity),
      color: row.color,
      supplierName: row.supplier_name,
      actualCutCount: Number(row.actual_cut_count),
      styleConflictCount: Number(row.style_conflict_count),
    }));
  }

  async listStyleOptions(query = ""): Promise<readonly string[]> {
    const needle = query.trim().toUpperCase();
    const result = await this.database.query<{ style_no: string }>(
      `SELECT DISTINCT upper(btrim(source.style_no)) AS style_no
       FROM (
         SELECT style_no FROM receiving_batches WHERE deleted_at IS NULL
         UNION
         SELECT style_no FROM rework_orders WHERE style_no IS NOT NULL AND status<>'deleted'
       ) source
       WHERE ($1::text='' OR upper(btrim(source.style_no)) LIKE '%' || $1 || '%')
       ORDER BY style_no
       LIMIT 100`,
      [needle],
    );
    return result.rows.map((row) => row.style_no);
  }

  async correctReceipt(
    actor: TrustedActorContext,
    receiptId: string,
    input: CorrectReceivingReceiptInput,
  ): Promise<ReceivingBatchSnapshot> {
    this.assertRootCorrector(actor);
    if (!UUID_PATTERN.test(receiptId)) fail("收货记录标识无效");
    const normalized = {
      expectedVersion: this.validateExpectedVersion(input.expectedVersion),
      source: input.source===undefined?undefined:normalizeRepeatedReceivingSource(input.source),
      documentQuantity: validateQuantity(input.documentQuantity, "本次送货单数量", false),
      actualQuantity: validateQuantity(input.actualQuantity, "本次实际收货数量", true),
      defectiveQuantity: validateQuantity(input.defectiveQuantity, "本次次品数量", true),
    };
    if (normalized.defectiveQuantity > normalized.actualQuantity) fail("次品数量不能超过实际收货数量");

    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const receipt = await client.query<{
        receiving_batch_id: string;
        style_no: string;
        document_quantity: string;
        actual_quantity: string;
        defective_quantity: string;
        receiving_source: ReceiptSource;
        corrected_document_quantity: string | null;
        corrected_actual_quantity: string | null;
        corrected_defective_quantity: string | null;
        corrected_receiving_source: ReceiptSource | null;
        is_base_receipt: boolean;
      }>(
        `SELECT receipt.receiving_batch_id,receipt.style_no,
                receipt.document_quantity::bigint,receipt.actual_quantity::bigint,
                receipt.defective_quantity::bigint,receipt.receiving_source,
                correction.document_quantity::bigint AS corrected_document_quantity,
                correction.actual_quantity::bigint AS corrected_actual_quantity,
                correction.defective_quantity::bigint AS corrected_defective_quantity,
                correction.receiving_source AS corrected_receiving_source,
                receipt.receipt_id=(
                  SELECT base.receipt_id
                  FROM receiving_receipts base
                  JOIN receiving_batches origin ON origin.receiving_batch_id=base.receiving_batch_id
                  JOIN operation_events creation ON creation.event_id=base.operation_event_id
                  WHERE base.receiving_batch_id=receipt.receiving_batch_id
                  -- 0086 froze a migrated batch's creation at its earliest original
                  -- receipt. That proven baseline precedes later native repeats;
                  -- an older receipt merged from another batch cannot claim it.
                  ORDER BY CASE
                    WHEN creation.after_state->>'receivingBatchId'=base.receiving_batch_id::text
                      OR NOT (creation.after_state ? 'receivingBatchId') AND base.received_at=origin.created_at THEN 0
                    WHEN creation.after_state ? 'receivingBatchId' THEN 2
                    ELSE 1 END,base.received_at,base.receipt_id
                  LIMIT 1
                ) AS is_base_receipt
         FROM receiving_receipts receipt
         LEFT JOIN LATERAL (
           SELECT item.document_quantity,item.actual_quantity,item.defective_quantity,item.receiving_source
           FROM receiving_receipt_corrections item
           WHERE item.receipt_id=receipt.receipt_id
           ORDER BY item.created_at DESC,item.correction_id DESC
           LIMIT 1
         ) correction ON true
         WHERE receipt.receipt_id=$1`,
        [receiptId],
      );
      const fact = receipt.rows[0];
      if (!fact) return fail("收货记录不存在", 404, "NOT_FOUND");
      // Style/owning-batch locks serialize all native quantity writers. Taking
      // a receipt FOR UPDATE first would deadlock a card correction's FK insert.
      await this.lockStyles(client, [fact.style_no]);
      const batch = await this.mutableBatch(client, fact.receiving_batch_id, true);
      if (batch.version !== normalized.expectedVersion) {
        fail("收货订单版本已变化，本次未覆盖；请Root在本单收货记录重新读取数量和送货单后再提交", 409, "CONFLICT");
      }

      const beforeReceipt = {
        source: fact.corrected_receiving_source ?? fact.receiving_source,
        documentQuantity: Number(fact.corrected_document_quantity ?? fact.document_quantity),
        actualQuantity: Number(fact.corrected_actual_quantity ?? fact.actual_quantity),
        defectiveQuantity: Number(fact.corrected_defective_quantity ?? fact.defective_quantity),
      };
      const correctionSource=normalized.source??beforeReceipt.source;
      const rawTotals = await client.query<{
        document_quantity: string;
        actual_quantity: string;
        defective_quantity: string;
        effective_actual_quantity:string;
        effective_defective_quantity:string;
      }>(
        `SELECT sum(r.document_quantity)::bigint AS document_quantity,
                sum(r.actual_quantity)::bigint AS actual_quantity,
                sum(r.defective_quantity)::bigint AS defective_quantity,
                sum(coalesce(c.actual_quantity,r.actual_quantity))::bigint AS effective_actual_quantity,
                sum(coalesce(c.defective_quantity,r.defective_quantity))::bigint AS effective_defective_quantity
         FROM receiving_receipts r LEFT JOIN LATERAL(SELECT document_quantity,actual_quantity,defective_quantity,receiving_source FROM receiving_receipt_corrections c
           WHERE c.receipt_id=r.receipt_id ORDER BY c.created_at DESC,c.correction_id DESC LIMIT 1)c ON true
         WHERE r.receiving_batch_id=$1`,
        [fact.receiving_batch_id],
      );
      const raw = rawTotals.rows[0]!;
      const oldDeliveryContribution = fact.is_base_receipt
        ? beforeReceipt.documentQuantity
        : beforeReceipt.source === "other_factory" ? beforeReceipt.documentQuantity : 0;
      const nextDeliveryContribution = fact.is_base_receipt
        ? normalized.documentQuantity
        : correctionSource === "other_factory" ? normalized.documentQuantity : 0;
      // Merge deliberately retained the target's approved delivery-note baseline.
      // Only this receipt's explicit document delta may change that baseline.
      const documentQuantity = Number(batch.document_quantity)
        + nextDeliveryContribution - oldDeliveryContribution;
      const actualQuantity = Number(raw.effective_actual_quantity) + normalized.actualQuantity - beforeReceipt.actualQuantity;
      const defectiveQuantity = Number(raw.effective_defective_quantity) + normalized.defectiveQuantity - beforeReceipt.defectiveQuantity;
      if (defectiveQuantity > actualQuantity) fail("次品数量不能超过实际收货数量");
      const after: ReceivingBatchSnapshot = {
        receivingBatchId: fact.receiving_batch_id,
        styleNo: batch.style_no,
        documentQuantity,
        actualQuantity,
        defectiveQuantity,
        differenceQuantity: actualQuantity - documentQuantity,
        version: batch.version + 1,
      };
      const eventId = await this.events.append(client, actor, {
        action: "receiving.batch.correct",
        entityType: "receiving_batch",
        entityId: fact.receiving_batch_id,
        before: {
          receivingBatchId: fact.receiving_batch_id,
          styleNo: batch.style_no,
          documentQuantity: Number(batch.document_quantity),
          actualQuantity: Number(batch.actual_quantity),
          defectiveQuantity: Number(batch.defective_quantity),
          differenceQuantity: Number(batch.actual_quantity) - Number(batch.document_quantity),
          version: batch.version,
        },
        after: {
          ...after,
          receiptId,
          receiptBefore: beforeReceipt,
          receiptAfter: {
            source: correctionSource,
            documentQuantity: normalized.documentQuantity,
            actualQuantity: normalized.actualQuantity,
            defectiveQuantity: normalized.defectiveQuantity,
          },
        },
      });
      await client.query(
        "SELECT set_config('dx_rework.receiving_root_action','correct',true),set_config('dx_rework.receiving_event_id',$1,true),set_config('dx_rework.receiving_request_id',$2,true)",
        [eventId, actor.requestId],
      );
      await client.query(
        `INSERT INTO receiving_receipt_corrections(
           correction_id,receipt_id,receiving_batch_id,receiving_source,
           document_quantity,actual_quantity,defective_quantity,
           corrected_by,operation_event_id,request_id
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [randomUUID(), receiptId, fact.receiving_batch_id, correctionSource,
          normalized.documentQuantity, normalized.actualQuantity, normalized.defectiveQuantity,
          actor.actorId, eventId, actor.requestId],
      );
      const updated = await client.query(
        `UPDATE receiving_batches
         SET delivery_note_quantity=$2::bigint,
             document_quantity_adjustment=$2::bigint-$3::bigint,
             actual_quantity_adjustment=$4::bigint-$5::bigint,
             defective_quantity_adjustment=$6::bigint-$7::bigint,
             version=version+1,updated_by=$8,updated_at=CURRENT_TIMESTAMP,
             last_operation_event_id=$9,last_request_id=$10
         WHERE receiving_batch_id=$1 AND version=$11`,
        [fact.receiving_batch_id, after.documentQuantity, Number(raw.document_quantity),
          after.actualQuantity, Number(raw.actual_quantity), after.defectiveQuantity,
          Number(raw.defective_quantity), actor.actorId, eventId, actor.requestId, batch.version],
      );
      if (updated.rowCount !== 1) fail("收货订单版本已变化，本次未覆盖；请Root在本单收货记录重新读取数量和送货单后再提交", 409, "CONFLICT");
      await client.query("COMMIT");
      return after;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async recordPacking(
    actor: TrustedActorContext,
    input: RecordPackingInput,
    idempotencyKey: string,
  ): Promise<Result<PackingRevisionResult>> {
    this.assertBoardOperator(actor, "receiving:packing_manage", "warehouse_receiver");
    const normalized = {
      receivingBatchId: input.receivingBatchId,
      expectedVersion: this.validateExpectedVersion(input.expectedVersion),
      expectedPackingRevisionId: normalizeOptionalUuid(input.expectedPackingRevisionId, "装箱数量版本"),
      packingQuantity: validateQuantity(input.packingQuantity, "装箱数量", true),
      ...(input.packingTime===undefined?{}:{packingTime:normalizePackingTime(input.packingTime)}),
      ...(input.packingAllocations===undefined?{}:{packingAllocations:input.packingAllocations}),
    };
    const scope = "receiving.packing.record";
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      actor = await this.authorizeBoardWrite(client,actor,"receiving:packing_manage");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const snapshot = await this.styleOperationSnapshot(client, normalized.receivingBatchId);
        if ((snapshot.packingRevisionId !== null||snapshot.packingScopeUnresolved) && !actor.actorRoles.includes("root_superuser")) {
          fail("已录入的装箱数量只有Root可以修改",403,"FORBIDDEN");
        }
        if (snapshot.version !== normalized.expectedVersion
            || snapshot.packingRevisionId !== normalized.expectedPackingRevisionId) {
          fail("订单或装箱数量已更新，本次未覆盖；请在本单回货处理页重新读取累计收货与装箱数，再核对后提交", 409, "CONFLICT");
        }
        const packingRevisionId = randomUUID();
        const now=businessNow().toISOString(),packingActualTime=resolvePackingTime(normalized.packingTime,now);
        const allocations=normalized.packingAllocations===undefined?undefined:await packingReceiptAllocations(client,snapshot.receivingBatchId,normalized.packingQuantity,normalized.packingAllocations,now);
        const eventId = await this.events.append(client, actor, {
          action: "receiving.packing.record",
          entityType: "receiving_batch",
          entityId: snapshot.receivingBatchId,
          before: snapshot.packingRevisionId === null ? null : {
            packingRevisionId: snapshot.packingRevisionId,
            packingQuantity: snapshot.packingSourceQuantity??snapshot.packingQuantity,
          },
          after: { packingRevisionId, packingQuantity: normalized.packingQuantity,packingScopeMergeEventIds:snapshot.packingScopeMergeEventIds??[],...(normalized.packingTime?{packingActualTime}:{}),...(allocations?{packingAllocations:allocations}:{}) },
        });
        const inserted = await client.query<{
          packing_revision_id: string;
          receiving_batch_id: string;
          packing_quantity: string;
          recorded_by: string;
          created_at: Date;
        }>(
          `INSERT INTO receiving_packing_revisions(
             packing_revision_id,receiving_batch_id,packing_quantity,recorded_by,
             operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6)
           RETURNING packing_revision_id,receiving_batch_id,packing_quantity,recorded_by,created_at`,
          [packingRevisionId, snapshot.receivingBatchId, normalized.packingQuantity,
            actor.actorId, eventId, actor.requestId],
        );
        const row = inserted.rows[0]!;
        return {
          statusCode: 201,
          response: {
            packingRevisionId: row.packing_revision_id,
            receivingBatchId: row.receiving_batch_id,
            packingQuantity: Number(row.packing_quantity),
            recordedBy: row.recorded_by,
            recordedAt: row.created_at.toISOString(),
            ...(normalized.packingTime?{packingActualTime}:{}),
          },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "42501") {
        const correctionOnly = (error as { constraint?: string }).constraint === "receiving_packing_root_correction_only";
        fail(correctionOnly ? "已录入的装箱数量只有Root可以修改" : "当前账号无权执行此订单回货操作", 403, "FORBIDDEN");
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private normalizeDifferenceImages(values: readonly string[]): readonly string[] {
    if (values.length > MAX_RECEIVING_IMAGES) fail("处理凭证最多3张");
    if (new Set(values).size !== values.length) fail("处理凭证不能重复");
    if (values.some((value) => !UUID_PATTERN.test(value))) fail("处理凭证标识无效");
    return values;
  }

  private async bindDifferenceImages(
    client: PoolClient, actor: TrustedActorContext, resolutionId: string, attachmentIds: readonly string[],
  ): Promise<void> {
    if (!attachmentIds.length) return;
    const candidates = await client.query<{
      attachment_id: string; uploaded_by: string; mime_type: string; status: string;
      entity_type: string | null; entity_id: string | null;
    }>(`SELECT attachment_id,uploaded_by,mime_type,status,entity_type,entity_id
        FROM attachments WHERE attachment_id=ANY($1::uuid[]) ORDER BY attachment_id FOR UPDATE`, [attachmentIds]);
    if (candidates.rows.length !== attachmentIds.length) fail("处理凭证不存在或不可用；请回货处理人在本页核对凭证是否上传完成且未用于其他业务，不能复用他人凭证");
    for (const row of candidates.rows) {
      if (row.status !== "ready") fail("处理凭证尚未上传完成");
      if (row.uploaded_by !== actor.actorId) fail("只能使用本人上传的处理凭证", 403, "FORBIDDEN");
      if (!RECEIVING_IMAGE_MIME_TYPES.has(row.mime_type)) fail("处理凭证仅支持JPEG、PNG、WebP图片");
      if (row.entity_type !== null || row.entity_id !== null) fail("处理凭证已绑定到其他业务记录", 409, "CONFLICT");
    }
    await client.query(`UPDATE attachments SET entity_type='receiving_difference_resolution',entity_id=$2
      WHERE attachment_id=ANY($1::uuid[]) AND entity_type IS NULL`, [attachmentIds, resolutionId]);
  }

  async resolveDifference(
    actor: TrustedActorContext,
    input: ResolveReceivingDifferenceInput,
    idempotencyKey: string,
  ): Promise<Result<DifferenceResolutionResult>> {
    const differenceType = normalizeDifferenceType(input.differenceType);
    this.assertBoardOperator(actor,"receiving:resolve_difference","order_merchandiser");
    const normalized = {
      receivingBatchId: input.receivingBatchId,
      expectedVersion: this.validateExpectedVersion(input.expectedVersion),
      expectedDocumentQuantity: validateQuantity(input.expectedDocumentQuantity, "送货单数量", true),
      expectedActualQuantity: validateQuantity(input.expectedActualQuantity, "实收数量", true),
      expectedPackingRevisionId: normalizeOptionalUuid(input.expectedPackingRevisionId, "装箱数量版本"),
      differenceType,
      result: normalizeResolutionResult(input.result),
      ...(input.attachmentIds?.length ? { attachmentIds: this.normalizeDifferenceImages(input.attachmentIds) } : {}),
    };
    const scope = `receiving.difference.resolve.${differenceType}`;
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      actor = await this.authorizeBoardWrite(client,actor,"receiving:resolve_difference");
      const outcome = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: hash(scope, normalized),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      }, async () => {
        const snapshot = await this.styleOperationSnapshot(client, normalized.receivingBatchId);
        if (snapshot.version !== normalized.expectedVersion) {
          fail("订单数量已更新，请刷新后重试", 409, "CONFLICT");
        }
        if (snapshot.documentQuantity !== normalized.expectedDocumentQuantity
            || snapshot.actualQuantity !== normalized.expectedActualQuantity) {
          fail("订单数量已变化，本次未覆盖；请负责跟单在本单回货处理页重新读取累计收货数、送货单数与装箱记录后再处理", 409, "CONFLICT");
        }
        if (differenceType === "packing"
            && snapshot.packingRevisionId !== normalized.expectedPackingRevisionId) {
          fail("装箱数量已更新，本次未覆盖；请重新读取本单最新装箱数与差异，再决定是否提交", 409, "CONFLICT");
        }
        if (differenceType === "packing" && snapshot.packingQuantity === null) {
          fail("请先录入装箱数量；请有权回货岗位在本单回货处理页登记实际装箱数，再处理与累计收货数的差异");
        }
        const differenceQuantity = differenceType === "receiving"
          ? snapshot.actualQuantity - snapshot.documentQuantity
          : snapshot.packingQuantity! - snapshot.actualQuantity;
        if (differenceQuantity === 0) fail("当前没有需要处理的差异；请查看本单最新装箱数与累计收货数，无须新增差异处理记录", 409, "CONFLICT");
        const handled=(await client.query(`SELECT 1 FROM receiving_difference_resolutions resolution
          WHERE resolution.receiving_batch_id=$1 AND resolution.difference_type=$2
            AND resolution.actual_quantity_snapshot=$3
            AND ($2='packing' OR resolution.document_quantity_snapshot=$4)
            AND ($2='receiving' OR (resolution.packing_revision_id=$5 AND resolution.packing_quantity_snapshot=$6))
            AND resolution.difference_quantity_snapshot=$7
            AND COALESCE((SELECT event.after_state->>'quantityRevision' FROM operation_events event
              WHERE event.event_id=resolution.operation_event_id)=$9::text,
              $8::timestamptz IS NULL OR resolution.created_at>=$8::timestamptz)
          LIMIT 1`,[snapshot.receivingBatchId,differenceType,snapshot.actualQuantity,snapshot.documentQuantity,
          snapshot.packingRevisionId,snapshot.packingQuantity,differenceQuantity,
          differenceType==='receiving'?snapshot.receivingQuantityChangedAt:snapshot.actualQuantityChangedAt,
          differenceType==='receiving'?snapshot.receivingQuantityRevision:snapshot.actualQuantityRevision])).rowCount;
        if(handled) fail('当前差异已处理，请刷新查看处理结果',409,'CONFLICT');
        const resolutionId = randomUUID();
        const eventId = await this.events.append(client, actor, {
          action: "receiving.difference.resolve",
          entityType: "receiving_batch",
          entityId: snapshot.receivingBatchId,
          after: {
            resolutionId,
            quantityRevision:differenceType==="receiving"?snapshot.receivingQuantityRevision:snapshot.actualQuantityRevision,
            differenceType,
            documentQuantity: snapshot.documentQuantity,
            actualQuantity: snapshot.actualQuantity,
            packingRevisionId: differenceType === "packing" ? snapshot.packingRevisionId : null,
            packingQuantity: differenceType === "packing" ? snapshot.packingQuantity : null,
            differenceQuantity,
            result: normalized.result,
            attachmentIds: normalized.attachmentIds ?? [],
          },
        });
        const inserted = await client.query<{
          resolution_id: string;
          receiving_batch_id: string;
          difference_type: ReceivingDifferenceType;
          difference_quantity_snapshot: string;
          result: string;
          handled_by: string;
          created_at: Date;
        }>(
          `INSERT INTO receiving_difference_resolutions(
             resolution_id,receiving_batch_id,difference_type,
             document_quantity_snapshot,actual_quantity_snapshot,
             packing_revision_id,packing_quantity_snapshot,difference_quantity_snapshot,
             result,handled_by,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
           RETURNING resolution_id,receiving_batch_id,difference_type,
                     difference_quantity_snapshot,result,handled_by,created_at`,
          [resolutionId, snapshot.receivingBatchId, differenceType,
            snapshot.documentQuantity, snapshot.actualQuantity,
            differenceType === "packing" ? snapshot.packingRevisionId : null,
            differenceType === "packing" ? snapshot.packingQuantity : null,
            differenceQuantity, normalized.result, actor.actorId, eventId, actor.requestId],
        );
        await this.bindDifferenceImages(client, actor, resolutionId, normalized.attachmentIds ?? []);
        const row = inserted.rows[0]!;
        return {
          statusCode: 201,
          response: {
            resolutionId: row.resolution_id,
            receivingBatchId: row.receiving_batch_id,
            differenceType: row.difference_type,
            differenceQuantity: Number(row.difference_quantity_snapshot),
            result: row.result,
            handledBy: row.handled_by,
            handledAt: row.created_at.toISOString(),
          },
        };
      });
      await client.query("COMMIT");
      return { value: outcome.response, reused: outcome.reused };
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async analysis(actor: TrustedActorContext, input: unknown) {
    return readReceivingAnalysis(this.database, RECEIVING_BOARD_BASE_SQL, actor, input);
  }

  async exportBoard(
    actor: TrustedActorContext,
    startDate: string,
    endDate: string,
    query = "",
    status = "all",
  ): Promise<BoardResult> {
    this.assertBoardOperator(actor, "receiving:export");
    const board = await this.board(startDate, endDate, query, status, 1, 50_001);
    if (board.totalCount > 50_000) fail("导出订单超过50000条，请缩小筛选范围");
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await this.events.append(client, actor, {
        action: "receiving.board.export",
        entityType: "receiving_board",
        entityId: "receiving-board",
        after: {
          startDate: board.startDate,
          endDate: board.endDate,
          query: query.trim().toUpperCase(),
          status: board.status,
          mode: board.mode,
          orderCount: board.totalCount,
        },
      });
      await client.query("COMMIT");
      return board;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  documentHistory(batchId:string){return receivingDocumentHistory(this.database,batchId);}
  private async activePendingReceiver(client:PoolClient,actor:TrustedActorContext){
    if(actor.actorRoles.includes('root_superuser'))return;
    if(!hasWarehouseReceivingRole(actor.actorRoles)||actor.authorizationCapability!=='receiving:create'||!actor.authorizationCapabilities?.includes('receiving:create')||
      !await new DigitalProductionAccessPolicy(client).activeRole(actor.actorId,'warehouse_receiver'))fail('仅当前原收货岗位可办理待收货',403,'FORBIDDEN');
  }
  private async assertPendingSelection(client:PoolClient,actor:TrustedActorContext,input:{pendingAllocation?:string;cuttingOrderId?:string;productionOrderId?:string;factoryDecisionId?:string|null},receivingBatchId:string|null){
    if(input.pendingAllocation===undefined)return;
    await this.activePendingReceiver(client,actor);
    const identity=parsePendingReceivingIdentity(input.pendingAllocation);
    if(!identity||input.cuttingOrderId!==identity[4]||input.productionOrderId!==identity[1]||input.factoryDecisionId!==identity[2])return fail('收货范围与原单据不同，请返回待收货重选',409,'CONFLICT');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`cutting:${identity[4]}`]);
    const selection=await pendingReceivingSelection(client,identity);
    if(!selection||selection.receivingBatchId!==receivingBatchId)return fail('原待收范围或收货批次已更新，请返回待收货重选',409,'CONFLICT');
  }
  async pendingSelection(actor:TrustedActorContext,id:string){
    const identity=parsePendingReceivingIdentity(id);
    if(!identity)return fail('待收货范围无效');
    const client=await this.database.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.activePendingReceiver(client,actor);
      const item=await pendingReceivingSelection(client,identity);
      if(!item)return fail('原待收范围已变更或尚未发回，请刷新列表',409,'CONFLICT');
      await client.query('COMMIT');return item;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  async pending(actor:TrustedActorContext,input:{search:string;page:number;status:'open'|'all'|'collected'}){
    if(!Number.isInteger(input.page)||input.page<1||input.page>100000||input.search.length>100||!['open','all','collected'].includes(input.status))fail('待收货筛选无效');
    const client=await this.database.connect();
    try{
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await this.activePendingReceiver(client,actor);
      // The original expected-receipt view allows this warehouse role to act
      // across receiving allocations. Do not grant that scope to other board readers.
      const {rows}=await client.query<{order_id:string}>(`SELECT DISTINCT route.production_order_id AS order_id
        FROM digital_factory_routes route JOIN digital_factory_facts fact USING(preparation_id)
        WHERE fact.kind='仓库实际发厂' AND fact.payload ? 'dispatchEvidence'`);
      const result=await pendingReceivingView(client,rows.map(row=>row.order_id),input);
      await client.query('COMMIT');
      return result;
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
  }
  board(
    startDateInput: string,
    endDateOrQuery = startDateInput,
    query = "",
    statusInput = "all",
    pageInput = 1,
    pageSizeInput = 15,
    targetBatchId?: string,
  ): Promise<BoardResult> {
    return readReceivingBoard(this.database, startDateInput, endDateOrQuery, query, statusInput, pageInput, pageSizeInput, targetBatchId);
  }

}

export { normalizeReceivingBackfillDate };
export type {
  BoardResult,
  CorrectReceivingBatchInput,
  CorrectReceivingReceiptInput,
  CreateRepeatedReceivingInput,
  DifferenceResolutionResult,
  RecordPackingInput,
  ResolveReceivingDifferenceInput,
  PackingRevisionResult,
  RepeatReceivingOption,
  CreateReceivingInput,
  ReceivingBatchSnapshot,
  ReceivingReceipt,
};
