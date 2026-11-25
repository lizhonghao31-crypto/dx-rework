import {reworkTransitionRejection} from "../platform/business-rejection-guidance.js";
import {linkDigitalRework} from "../production-platform/receiving-link-adapter.js";
import {linkNewDigitalChild} from "../production-platform/child-link-repository.js";
import {currentCraftProblemForRework,lockCraftProblemAuthority,type CraftProblemLocator} from "../production-platform/quality-craft-problem-scope.js";
import {lockGarmentReworkAuthority,lockOriginalGarmentReworkOrder,readGarmentReworkSource} from "../production-platform/garment-quality.js";
import type {GarmentReworkSource} from '@dx-rework/contracts/order-closure';
import { createHash, randomUUID } from "node:crypto";

import {
  InspectionReportDraftSchema,
  MAX_REWORK_ATTACHMENTS,
  REWORK_IMAGE_SUPPLEMENT_ROLES,
} from "@dx-rework/contracts";
import type {
  CreateReworkDraft,
  DeleteReworkOrderResponse,
  InspectionReportDraft,
  ReworkInitiationOptionsResponse,
  ReworkOrderResponse,
  ReworkOrderStatus,
  SubmitReworkOrder,
  SupplementReworkOrderImages,
  TransitionReworkOrder,
  UpdateReworkDraft,
  WaiveTailInspection,
} from "@dx-rework/contracts";
import { DomainRuleError, transitionReworkOrder } from "@dx-rework/domain";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import type { TodoService } from "../todos/service.js";
import { ensureOtherCraftComplete, resolveSpecialProcess } from "./special-process.js";

type DatabaseError = Readonly<{ code?: string }>;
type FactoryState = Readonly<{
  type: "own_factory" | "supplier";
  supplierId: string | null;
  supplierVersion: number | null;
}> | null;
type CreateReworkDraftWithReceivingBatch = CreateReworkDraft & Readonly<{
  receivingBatchId?: string;
}>;
type ReceivingReworkEntry = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  processingFactorySupplierId: string | null;
  merchandiserUserId: string | null;
  sourceImageAttachmentId: string | null;
  existingReworkOrderId?: string | null;
}>;
type ReworkDraftSource = Readonly<{
  receivingBatchId: string | null;
  styleNo: string | null;
}>;
type OriginalCraftDraft=Readonly<{scope:CraftProblemLocator;execution:"internal"|"factory";quantity:number}>;
type ReworkOrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderStatus;
  rework_kind: "qc_rework" | "inhouse_finishing";
  style_no: string | null;
  customer_supply_code: string | null;
  factory_style_no: string | null;
  order_no: string | null;
  order_quantity: number | null;
  merchandiser_user_id: string | null;
  processing_factory_type: "own_factory" | "supplier" | null;
  processing_factory_supplier_id: string | null;
  processing_factory_supplier_version: number | null;
  rework_reason: string | null;
  rework_process: string | null;
  problem_part: string | null;
  problem_description: string | null;
  rework_quantity: number | null;
  tail_inspection_required: boolean;
  special_process_type?: "none" | "inspection" | "other_craft" | null;
  other_craft_description?: string | null;
  tail_inspection_cost_bearer: "own_factory" | "processing_factory" | null;
  tail_inspection_cost_bearer_source: "legacy_default" | "quality_inspection" | "production_override" | null;
  inspection_report: InspectionReportDraft | null;
  source_receiving_batch_id: string | null;
  source_craft_qc_check_id?: string|null;
  craft_rework_execution?: "internal"|"factory"|null;
  created_by: string;
  updated_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  deleted_at: Date | null;
  deleted_by: string | null;
  has_other_open_style_order: boolean;
}>;
type MutationResult<T> = Readonly<{ value: T; reused: boolean }>;

const ORDER_SELECT = `SELECT orders.*,
  EXISTS (
    SELECT 1
    FROM rework_orders other
    WHERE other.rework_order_id<>orders.rework_order_id
      AND other.style_no=orders.style_no
      AND other.status NOT IN ('completed','cancelled','deleted')
  ) AS has_other_open_style_order
FROM rework_orders orders`;

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalize(child)]),
    );
  }
  return value;
};

const requestHash = (scope: string, payload: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize({ scope, payload }))).digest("hex");

const translateDatabaseError = (error: unknown): never => {
  if (error instanceof ApplicationError) throw error;
  if (error instanceof DomainRuleError) {
    throw new ApplicationError("INVALID_STATE_TRANSITION", reworkTransitionRejection(error.message), 409);
  }
  const code = (error as DatabaseError | null)?.code;
  if (code === "23505") throw new ApplicationError("CONFLICT", "返工单号或幂等记录已存在", 409);
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的跟单、加工厂或附件不存在", 404);
  if (code === "42501") throw new ApplicationError("FORBIDDEN", "当前用户无权执行该操作", 403);
  if (code === "55000") throw new ApplicationError("CONFLICT", "返工单不允许绕过受控流程修改", 409);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "返工输入未通过业务校验，系统未能确定具体字段或状态原因；请核对本单当前办理页，仍失败时提供订单链接给管理员核查，不要反复提交", 400);
  }
  throw error;
};

const factoryFromRow = (row: ReworkOrderRow): FactoryState => {
  if (row.processing_factory_type === null) return null;
  if (row.processing_factory_type === "own_factory") {
    return { type: "own_factory", supplierId: null, supplierVersion: null };
  }
  return {
    type: "supplier",
    supplierId: row.processing_factory_supplier_id,
    supplierVersion: row.processing_factory_supplier_version,
  };
};

export class ReworkInitiationService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly todos?: TodoProjectionService,
    private readonly todoService?: TodoService,
  ) {}

  async getReceivingEntry(receivingBatchId: string, finishingActor?: TrustedActorContext): Promise<ReceivingReworkEntry> {
    if (finishingActor) this.ensureFinishingInitiator(finishingActor);
    const digitalSource = (await this.database.query<{ relation: string | null }>(
      "SELECT to_regclass('digital_production_child_links') AS relation",
    )).rows[0]?.relation;
    // Digital sourcing may be created on behalf of the primary merchandiser.
    // Both stable child links must agree; never infer an order from its style.
    const merchandiserSource = digitalSource
      ? "CASE WHEN source_case.workflow_generation='digital_production_v1' THEN digital_order.primary_merchandiser_id ELSE source_case.created_by END AS merchandiser_user_id"
      : "source_case.created_by AS merchandiser_user_id";
    const digitalSourceJoins = digitalSource ? `
       LEFT JOIN digital_production_child_links digital_cutting
         ON digital_cutting.module='cutting'
        AND digital_cutting.child_id=cutting.cutting_order_id
       LEFT JOIN digital_production_child_links digital_sourcing
         ON digital_sourcing.module='sourcing'
        AND digital_sourcing.child_id=source_case.sourcing_case_id
        AND digital_sourcing.production_order_id=digital_cutting.production_order_id
       LEFT JOIN digital_production_orders digital_order
         ON digital_order.production_order_id=digital_sourcing.production_order_id` : "";
    const result = await this.database.query<{
      style_no: string;
      has_existing_rework: boolean;
      processing_factory_supplier_id: string | null;
      merchandiser_user_id: string | null;
      source_image_attachment_id: string | null;
    }>(
      `SELECT batch.style_no,
              EXISTS(
                SELECT 1
                FROM rework_orders existing_order
                WHERE existing_order.source_receiving_batch_id=batch.receiving_batch_id
                  AND existing_order.status NOT IN ('cancelled','deleted')
              ) AS has_existing_rework,
              snapshot.supplier_id AS processing_factory_supplier_id,
              ${merchandiserSource},
              source_line.image_attachment_id AS source_image_attachment_id
       FROM receiving_batches batch
       LEFT JOIN cutting_orders cutting
         ON cutting.cutting_order_id=batch.cutting_order_id
       LEFT JOIN sourcing_cases source_case
         ON source_case.sourcing_case_id=cutting.sourcing_case_id
        AND source_case.deleted_at IS NULL
       LEFT JOIN current_sourcing_case_lines source_line
         ON source_line.sourcing_case_id=cutting.sourcing_case_id
        AND source_line.position=cutting.sourcing_line_position
       LEFT JOIN sourcing_approval_snapshots snapshot
         ON snapshot.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
       ${digitalSourceJoins}
       WHERE batch.receiving_batch_id=$1
         AND batch.deleted_at IS NULL`,
      [receivingBatchId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "收货批次不存在", 404);
    let existingReworkOrderId: string | null = null;
    if (row.has_existing_rework && finishingActor) {
      const existing = await this.database.query<{ rework_order_id: string }>(
        `SELECT rework_order_id FROM rework_orders
         WHERE source_receiving_batch_id=$1 AND status='draft'
           AND rework_kind='inhouse_finishing' AND created_by=$2
         ORDER BY created_at DESC LIMIT 1`,
        [receivingBatchId, finishingActor.actorId],
      );
      existingReworkOrderId = existing.rows[0]?.rework_order_id ?? null;
    }
    if (row.has_existing_rework && !existingReworkOrderId) {
      throw new ApplicationError("CONFLICT", "该收货批次已有返工单，不能重复发起", 409);
    }
    return {
      receivingBatchId,
      ...(existingReworkOrderId ? { existingReworkOrderId } : {}),
      styleNo: row.style_no.trim().toUpperCase(),
      processingFactorySupplierId: row.processing_factory_supplier_id,
      merchandiserUserId: row.merchandiser_user_id,
      sourceImageAttachmentId: row.source_image_attachment_id,
    };
  }

  async getFinishingDraft(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkOrderResponse> {
    this.ensureFinishingInitiator(actor);
    const order = await this.getOwnedWithClient(this.database, actor.actorId, reworkOrderId);
    if (order.reworkKind !== "inhouse_finishing" || order.status !== "draft") {
      throw new ApplicationError("FORBIDDEN", "本厂做尾草稿不可访问", 403);
    }
    return order;
  }

  async createCraftDraft(actor:TrustedActorContext,original:OriginalCraftDraft,idempotencyKey:string){
    return this.createDraft(actor,original.execution==="factory"?{tailInspectionRequired:false}:{},idempotencyKey,"qc_rework",original);
  }

  async createGarmentDraft(actor:TrustedActorContext,source:GarmentReworkSource,idempotencyKey:string){
    return this.createDraft(actor,{},idempotencyKey,'qc_rework',undefined,source);
  }

  async createDraft(
    actor: TrustedActorContext,
    input: CreateReworkDraftWithReceivingBatch,
    idempotencyKey: string,
    kind: "qc_rework" | "inhouse_finishing" = "qc_rework",
    originalCraft?: OriginalCraftDraft,
    originalGarment?: GarmentReworkSource,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    if((originalCraft||originalGarment)&&kind!=="qc_rework"||originalCraft&&originalGarment)throw new ApplicationError("VALIDATION_ERROR","仅可选择一个原质检返工来源，不是本厂做尾",400);
    let authority:Awaited<ReturnType<typeof lockCraftProblemAuthority>>|null=null;
    return this.mutate(actor, originalCraft?"rework.craft.draft.create":originalGarment?'rework.garment.draft.create':kind === "inhouse_finishing" ? "rework.finishing.draft.create" : "rework.draft.create", idempotencyKey, { ...input, kind,...(originalCraft?{originalCraft}:{}),...(originalGarment?{originalGarment}:{}) }, 201, async (client) => {
      if (kind === "inhouse_finishing" && !input.receivingBatchId) {
        throw new ApplicationError("VALIDATION_ERROR", "本厂做尾必须选择收货批次", 400);
      }
      if (kind === "inhouse_finishing" && (input.tailInspectionRequired !== false
        || input.tailInspectionCostBearer || input.inspectionReport || (input.attachmentIds?.length ?? 0) > 0)) {
        throw new ApplicationError("VALIDATION_ERROR", "本厂做尾无需整查和QC报告", 400);
      }
      const reworkOrderId = randomUUID();
      if(originalCraft&&!authority)throw new ApplicationError("FORBIDDEN","原工艺检查无办理权限",403);
      const craft=originalCraft&&authority?await currentCraftProblemForRework(client,originalCraft.scope,authority):null;
      if(originalCraft&&craft){
        if(!Number.isSafeInteger(originalCraft.quantity)||originalCraft.quantity<1||originalCraft.quantity>craft.evidence.problemQuantity)
          throw new ApplicationError("VALIDATION_ERROR",`本次返工不能超过原工艺问题范围 ${craft.evidence.problemQuantity} 片`,400);
        const active=(await client.query<{rework_order_id:string}>(
          "SELECT rework_order_id FROM rework_orders WHERE source_craft_qc_check_id=$1 AND status NOT IN ('cancelled','deleted')",
          [craft.evidence.checkId],
        )).rows[0];
        if(active)return this.getOwnedWithClient(client,actor.actorId,active.rework_order_id);
      }
      const garment=originalGarment?await this.lockGarmentDraftSource(client,actor,originalGarment):null;
      if(garment){
        const active=(await client.query<{rework_order_id:string;source_garment_qc_event_id:string|null;created_by:string}>(`SELECT rework_order_id,source_garment_qc_event_id,created_by FROM rework_orders
          WHERE source_receiving_batch_id=$1 AND status NOT IN ('cancelled','deleted')`,[garment.receivingBatchId])).rows;
        if(active.length===1&&active[0]?.source_garment_qc_event_id===garment.sourceEventId&&active[0].created_by===actor.actorId)
          return this.getOwnedWithClient(client,actor.actorId,active[0].rework_order_id);
        if(active.length)throw new ApplicationError('CONFLICT','该收货批次已有返工，请查看原单，不能重复发起',409);
      }
      const specialProcess = resolveSpecialProcess(input, undefined, kind === "inhouse_finishing");
      const sourceReceivingBatch = craft?{receivingBatchId:null,styleNo:craft.source.styleNo}:await this.resolveSourceReceivingBatch(
        client,
        garment?.receivingBatchId??input.receivingBatchId,
        input.styleNo,
      );
      const merchandiserUserId=craft?craft.source.merchandiserId:garment?garment.merchandiserId:input.merchandiserUserId??null;
      const factoryInput=craft?(originalCraft?.execution==="factory"?{type:"supplier" as const,supplierId:craft.evidence.factoryId}:{type:"own_factory" as const}):
        garment?.factorySupplierId?{type:'supplier' as const,supplierId:garment.factorySupplierId}:input.processingFactory??null;
      const factory = await this.resolveFactory(client, factoryInput);
      if (merchandiserUserId) {
        await this.ensureActiveMerchandiser(client, merchandiserUserId);
      }
      const attachmentIds = input.attachmentIds ?? [];
      const next = {
        reworkOrderId,
        reworkNo: null,
        status: "draft" as const,
        reworkKind: kind,
        ...(craft&&originalCraft?{originalCraftQuality:{checkId:craft.evidence.checkId,unit:"片",execution:originalCraft.execution},craftScope:originalCraft.scope}:{}),
        ...(garment?{garmentQualitySource:originalGarment}:{}),
        receivingBatchId: sourceReceivingBatch.receivingBatchId,
        styleNo: sourceReceivingBatch.styleNo,
        customerSupplyCode: input.customerSupplyCode ?? null,
        factoryStyleNo: input.factoryStyleNo ?? null,
        orderNo: input.orderNo ?? null,
        orderQuantity: input.orderQuantity ?? null,
        merchandiserUserId,
        processingFactory: factory,
        reworkReason: input.reworkReason ?? null,
        reworkProcess: input.reworkProcess ?? null,
        problemPart: input.problemPart ?? null,
        problemDescription: garment?.problem??input.problemDescription??null,
        reworkQuantity: craft?originalCraft!.quantity:garment?.quantity??input.reworkQuantity??null,
        ...specialProcess,
        tailInspectionCostBearer: !specialProcess.tailInspectionRequired
          ? null
          : input.tailInspectionCostBearer ?? null,
        tailInspectionCostBearerSource: specialProcess.tailInspectionRequired
          && input.tailInspectionCostBearer
          ? "quality_inspection" as const
          : null,
        inspectionReport: input.inspectionReport ?? null,
        attachmentIds,
        version: 1,
      };
      const eventId = await this.events.append(client, actor, {
        action: kind === "inhouse_finishing" ? "rework.finishing.draft.create" : "rework.draft.create",
        entityType: "rework_order",
        entityId: reworkOrderId,
        after: next,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `INSERT INTO rework_orders(
           rework_order_id,style_no,customer_supply_code,factory_style_no,
           order_no,order_quantity,merchandiser_user_id,
           processing_factory_type,processing_factory_supplier_id,
           processing_factory_supplier_version,rework_reason,rework_process,
           problem_part,problem_description,rework_quantity,tail_inspection_required,
           tail_inspection_cost_bearer,tail_inspection_cost_bearer_source,inspection_report,
           source_receiving_batch_id,created_by,updated_by,special_process_type,other_craft_description${kind === "inhouse_finishing" ? ",rework_kind" : ""}${craft?",source_craft_qc_check_id,craft_rework_execution":""}${garment?',source_garment_qc_event_id':''}
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21,$22,$23${kind === "inhouse_finishing" ? ",$24" : ""}${craft?",$24,$25":""}${garment?',$24':''})`,
        [
          reworkOrderId,
          next.styleNo,
          next.customerSupplyCode,
          next.factoryStyleNo,
          next.orderNo,
          next.orderQuantity,
          next.merchandiserUserId,
          factory?.type ?? null,
          factory?.supplierId ?? null,
          factory?.supplierVersion ?? null,
          next.reworkReason,
          next.reworkProcess,
          next.problemPart,
          next.problemDescription,
          next.reworkQuantity,
          next.tailInspectionRequired,
          next.tailInspectionCostBearer,
          next.tailInspectionCostBearerSource,
          next.inspectionReport,
          sourceReceivingBatch.receivingBatchId,
          actor.actorId,
          next.specialProcessType,
          next.otherCraftDescription,
          ...(kind === "inhouse_finishing" ? [kind] : []),
          ...(craft?[craft.evidence.checkId,originalCraft!.execution]:[]),
          ...(garment?[garment.sourceEventId]:[]),
        ],
      );
      if(garment&&originalGarment)await linkNewDigitalChild(client,{module:'rework',childId:reworkOrderId,
        productionOrderId:originalGarment.orderId,lines:[{childLineKey:'record',lineId:garment.lineId}]});
      else if(!craft)await linkDigitalRework(client,reworkOrderId,sourceReceivingBatch.receivingBatchId);
      await this.syncAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    }, originalCraft ? async client=>{authority=await lockCraftProblemAuthority(client,actor,originalCraft.scope);} :
      originalGarment?client=>lockGarmentReworkAuthority(client,actor,originalGarment.orderId):undefined);
  }

  private async lockGarmentDraftSource(client:PoolClient,actor:TrustedActorContext,source:GarmentReworkSource){
    const proof=await readGarmentReworkSource(client,actor,source);
    const batch=(await client.query<{style_no:string}>('SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1',[proof.receivingBatchId])).rows[0];
    if(!batch)throw new ApplicationError('NOT_FOUND','原收货批次不存在',404);
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))',[batch.style_no.trim().toUpperCase()]);
    await client.query('SELECT 1 FROM receiving_batches WHERE receiving_batch_id=$1 FOR UPDATE',[proof.receivingBatchId]);
    return readGarmentReworkSource(client,actor,source);
  }

  private async resolveSourceReceivingBatch(
    client: PoolClient,
    receivingBatchId: string | undefined,
    requestedStyleNo: string | null | undefined,
  ): Promise<ReworkDraftSource> {
    if (!receivingBatchId) {
      const normalizedStyleNo = requestedStyleNo?.trim().toUpperCase() ?? "";
      if (!normalizedStyleNo) return { receivingBatchId: null, styleNo: null };
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalizedStyleNo]);
      const fallback = await client.query<{ receiving_batch_id: string }>(
        `SELECT batch.receiving_batch_id
         FROM receiving_batches batch
         WHERE upper(btrim(batch.style_no))=$1
           AND batch.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM rework_orders completed_order
             WHERE completed_order.source_receiving_batch_id=batch.receiving_batch_id
               AND completed_order.status='completed'
           )
         ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
         LIMIT 1`,
        [normalizedStyleNo],
      );
      const fallbackBatchId = fallback.rows[0]?.receiving_batch_id;
      if (fallbackBatchId) {
        return this.resolveSourceReceivingBatch(client, fallbackBatchId, normalizedStyleNo);
      }
      return {
        receivingBatchId: null,
        styleNo: normalizedStyleNo,
      };
    }
    const source = await client.query<{ style_no: string }>(
      "SELECT style_no FROM receiving_batches WHERE receiving_batch_id=$1 AND deleted_at IS NULL",
      [receivingBatchId],
    );
    const sourceRow = source.rows[0];
    if (!sourceRow) throw new ApplicationError("NOT_FOUND", "收货批次不存在", 404);
    const normalizedStyleNo = sourceRow.style_no.trim().toUpperCase();
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [normalizedStyleNo]);
    const batch = await client.query<{ style_no: string; has_existing_rework: boolean }>(
      `SELECT batch.style_no,
              EXISTS(
                SELECT 1 FROM rework_orders existing_order
                WHERE existing_order.source_receiving_batch_id=batch.receiving_batch_id
                  AND existing_order.status NOT IN ('cancelled','deleted')
              ) AS has_existing_rework
       FROM receiving_batches batch
       WHERE batch.receiving_batch_id=$1
         AND batch.deleted_at IS NULL
       FOR UPDATE`,
      [receivingBatchId],
    );
    const row = batch.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "收货批次不存在", 404);
    if (row.has_existing_rework) {
      throw new ApplicationError("CONFLICT", "该收货批次已有返工单，不能重复发起", 409);
    }
    return { receivingBatchId, styleNo: normalizedStyleNo };
  }

  async updateDraft(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: UpdateReworkDraft,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.draft.update", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "draft");
      if (current.status !== "draft") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以修改", 409);
      }

      const existingAttachmentIds = await this.attachmentIds(client, reworkOrderId);
      const attachmentIds = input.attachmentIds ?? existingAttachmentIds;
      const merchandiserUserId = input.merchandiserUserId === undefined
        ? current.merchandiser_user_id
        : input.merchandiserUserId;
      if (merchandiserUserId) await this.ensureActiveMerchandiser(client, merchandiserUserId);
      const factory = input.processingFactory === undefined
        ? factoryFromRow(current)
        : await this.resolveFactory(client, input.processingFactory);
      const exactCraft=Boolean(current.source_craft_qc_check_id);
      if (
        (current.source_receiving_batch_id||exactCraft)
        && input.styleNo !== undefined
        && input.styleNo?.trim().toUpperCase() !== current.style_no?.trim().toUpperCase()
      ) {
        throw new ApplicationError("VALIDATION_ERROR", exactCraft?"原工艺批次的款号不能在返工单修改":"来源收货批次的款号不能在返工单修改", 400);
      }
      let nextStyleNo = current.source_receiving_batch_id||exactCraft
        ? current.style_no
        : input.styleNo === undefined ? current.style_no : input.styleNo;
      let sourceReceivingBatchId = current.source_receiving_batch_id;
      if (!sourceReceivingBatchId&&!exactCraft) {
        const legacySource = await this.resolveSourceReceivingBatch(client, undefined, nextStyleNo);
        sourceReceivingBatchId = legacySource.receivingBatchId;
        nextStyleNo = legacySource.styleNo;
      }
      const nextVersion = current.version + 1;
      const specialProcess = resolveSpecialProcess(input, current, current.rework_kind === "inhouse_finishing");
      const nextTailInspectionRequired = specialProcess.tailInspectionRequired;
      const nextTailInspectionCostBearer = nextTailInspectionRequired
        ? (input.tailInspectionCostBearer === undefined
            ? current.tail_inspection_cost_bearer
            : input.tailInspectionCostBearer)
        : null;
      const nextTailInspectionCostBearerSource = nextTailInspectionCostBearer === null
        ? null
        : input.tailInspectionCostBearer !== undefined
          ? "quality_inspection" as const
          : current.tail_inspection_cost_bearer_source;
      const next = {
        reworkOrderId,
        reworkNo: current.rework_no,
        status: "draft" as const,
        reworkKind: current.rework_kind,
        receivingBatchId: sourceReceivingBatchId,
        styleNo: nextStyleNo,
        customerSupplyCode: input.customerSupplyCode === undefined
          ? current.customer_supply_code
          : input.customerSupplyCode,
        factoryStyleNo: input.factoryStyleNo === undefined
          ? current.factory_style_no
          : input.factoryStyleNo,
        orderNo: input.orderNo === undefined ? current.order_no : input.orderNo,
        orderQuantity: input.orderQuantity === undefined
          ? current.order_quantity
          : input.orderQuantity,
        merchandiserUserId,
        processingFactory: factory,
        reworkReason: input.reworkReason === undefined
          ? current.rework_reason
          : input.reworkReason,
        reworkProcess: input.reworkProcess === undefined
          ? current.rework_process
          : input.reworkProcess,
        problemPart: input.problemPart === undefined ? current.problem_part : input.problemPart,
        problemDescription: input.problemDescription === undefined
          ? current.problem_description
          : input.problemDescription,
        reworkQuantity: input.reworkQuantity === undefined
          ? current.rework_quantity
          : input.reworkQuantity,
        tailInspectionRequired: nextTailInspectionRequired,
        specialProcessType: specialProcess.specialProcessType,
        otherCraftDescription: specialProcess.otherCraftDescription,
        tailInspectionCostBearer: nextTailInspectionCostBearer,
        tailInspectionCostBearerSource: nextTailInspectionCostBearerSource,
        inspectionReport: input.inspectionReport === undefined
          ? current.inspection_report
          : input.inspectionReport,
        attachmentIds,
        version: nextVersion,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.draft.update",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: await this.auditState(client, current),
        after: next,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET style_no=$2,customer_supply_code=$3,factory_style_no=$4,
             order_no=$5,order_quantity=$6,merchandiser_user_id=$7,
             processing_factory_type=$8,processing_factory_supplier_id=$9,
             processing_factory_supplier_version=$10,rework_reason=$11,
             rework_process=$12,problem_part=$13,problem_description=$14,
             rework_quantity=$15,tail_inspection_required=$16,
             tail_inspection_cost_bearer=$17,tail_inspection_cost_bearer_source=$18,
             inspection_report=$19,updated_by=$20,version=$21,source_receiving_batch_id=$22,
             special_process_type=$23,other_craft_description=$24,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [
          reworkOrderId,
          next.styleNo,
          next.customerSupplyCode,
          next.factoryStyleNo,
          next.orderNo,
          next.orderQuantity,
          next.merchandiserUserId,
          factory?.type ?? null,
          factory?.supplierId ?? null,
          factory?.supplierVersion ?? null,
          next.reworkReason,
          next.reworkProcess,
          next.problemPart,
          next.problemDescription,
          next.reworkQuantity,
          next.tailInspectionRequired,
          next.tailInspectionCostBearer,
          next.tailInspectionCostBearerSource,
          next.inspectionReport,
          actor.actorId,
          nextVersion,
          sourceReceivingBatchId,
          next.specialProcessType,
          next.otherCraftDescription,
        ],
      );
      if (input.attachmentIds !== undefined) {
        await this.syncAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      }
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    });
  }

  async supplementOrderImages(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SupplementReworkOrderImages,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.attachments.supplement", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockForSupplementalImages(client, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      const existingAttachmentIds = await this.attachmentIds(client, reworkOrderId);
      const nextAttachmentIds = [...existingAttachmentIds, ...input.attachmentIds];
      if (nextAttachmentIds.length > MAX_REWORK_ATTACHMENTS) {
        throw new ApplicationError(
          "VALIDATION_ERROR",
          `每张返工单最多保留 ${MAX_REWORK_ATTACHMENTS} 份附件`,
          400,
        );
      }
      await this.ensureReadySupplementalImages(client, actor.actorId, input.attachmentIds);
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = { ...before, attachmentIds: nextAttachmentIds, version: nextVersion };
      const eventId = await this.events.append(client, actor, {
        action: "rework.attachments.supplement",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, nextVersion],
      );
      await this.bindSupplementalImages(client, reworkOrderId, input.attachmentIds);
      return this.getAccessibleWithClient(client, reworkOrderId);
    });
  }

  async waiveTailInspection(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: WaiveTailInspection,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(
      actor,
      "rework.tail_inspection.waive",
      idempotencyKey,
      { reworkOrderId, ...input },
      200,
      async (client) => {
        const current = await this.lockAccessible(client, reworkOrderId);
        this.ensureVersion(current, input.expectedVersion);
        if (!current.tail_inspection_required) {
          throw new ApplicationError("CONFLICT", "该返工单已经无需整查", 409);
        }
        if (!(["in_progress", "pending_order_review"] as ReworkOrderStatus[]).includes(current.status)) {
          throw new ApplicationError(
            "INVALID_STATE_TRANSITION",
            "只能在返工执行中或提交最终数量前改为无需整查；已提交最终数量的订单请先由 IE 驳回",
            409,
          );
        }

        const unifiedReports = await client.query<{
          work_report_id: string;
          assignment_mode: "individual" | "collective";
          rejected_person_id: string | null;
          report_snapshot: Record<string, unknown>;
        }>(
          `SELECT report.work_report_id,task.assignment_mode,
                  CASE WHEN task.assignment_mode='individual' THEN (
                    SELECT member.person_id
                    FROM rework_work_task_members member
                    WHERE member.work_task_id=task.work_task_id
                    ORDER BY member.person_id
                    LIMIT 1
                  ) END AS rejected_person_id,
                  to_jsonb(report) AS report_snapshot
           FROM rework_work_reports report
           JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=report.configuration_item_id
           WHERE report.rework_order_id=$1
             AND report.status='submitted'
             AND item.execution_kind='tail_inspection'
             AND NOT EXISTS (
               SELECT 1 FROM rework_work_report_rejections rejection
               WHERE rejection.work_report_id=report.work_report_id
             )
           ORDER BY report.created_at,report.work_report_id
           FOR UPDATE OF report`,
          [reworkOrderId],
        );
        const unifiedTailReportIds = await client.query<{ work_report_id: string }>(
          `SELECT report.work_report_id
           FROM rework_work_reports report
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=report.configuration_item_id
           WHERE report.rework_order_id=$1
             AND item.execution_kind='tail_inspection'
           ORDER BY report.work_report_id`,
          [reworkOrderId],
        );
        const tailTasks = await client.query<{ work_task_id: string }>(
          `SELECT task.work_task_id
           FROM rework_work_tasks task
           JOIN rework_process_configuration_items item
             ON item.configuration_item_id=task.configuration_item_id
           WHERE task.rework_order_id=$1 AND task.status='active'
             AND item.execution_kind='tail_inspection'
           ORDER BY task.work_task_id
           FOR UPDATE OF task`,
          [reworkOrderId],
        );
        const legacyReports = await client.query<{ tail_inspection_report_id: string }>(
          `SELECT tail_inspection_report_id
           FROM rework_tail_inspection_reports
           WHERE rework_order_id=$1 AND status='submitted'
           ORDER BY tail_inspection_report_id
           FOR UPDATE`,
          [reworkOrderId],
        );
        const legacyTailReportIds = await client.query<{ tail_inspection_report_id: string }>(
          `SELECT tail_inspection_report_id
           FROM rework_tail_inspection_reports
           WHERE rework_order_id=$1
           ORDER BY tail_inspection_report_id`,
          [reworkOrderId],
        );
        const legacyAssignments = await client.query<{ tail_inspection_assignment_id: string }>(
          `SELECT tail_inspection_assignment_id
           FROM rework_tail_inspection_assignments
           WHERE rework_order_id=$1 AND revoked_at IS NULL
           ORDER BY tail_inspection_assignment_id
           FOR UPDATE`,
          [reworkOrderId],
        );

        const workerReadiness = await client.query<{ ready: boolean }>(
          `SELECT EXISTS(
             SELECT 1
             FROM rework_process_configurations configuration
             JOIN rework_process_configuration_items item
               ON item.configuration_id=configuration.configuration_id
             WHERE configuration.rework_order_id=$1
               AND configuration.status='approved'
               AND item.execution_kind='worker'
           )
           AND NOT EXISTS(
             SELECT 1
             FROM rework_process_configurations configuration
             JOIN rework_process_configuration_items item
               ON item.configuration_id=configuration.configuration_id
             WHERE configuration.rework_order_id=$1
               AND configuration.status='approved'
               AND item.execution_kind='worker'
               AND NOT EXISTS(
                 SELECT 1 FROM rework_work_tasks task
                 WHERE task.rework_order_id=$1
                   AND task.configuration_item_id=item.configuration_item_id
                   AND task.status='active'
               )
           )
           AND NOT EXISTS(
             SELECT 1
             FROM rework_work_tasks task
             JOIN rework_process_configuration_items item
               ON item.configuration_item_id=task.configuration_item_id
             WHERE task.rework_order_id=$1 AND task.status='active'
               AND item.execution_kind='worker'
               AND NOT EXISTS(
                 SELECT 1 FROM rework_work_reports report
                 WHERE report.work_task_id=task.work_task_id
                   AND report.status='submitted'
                   AND NOT EXISTS(
                     SELECT 1 FROM rework_work_report_rejections rejection
                     WHERE rejection.work_report_id=report.work_report_id
                   )
               )
           ) AS ready`,
          [reworkOrderId],
        );
        const nextStatus: ReworkOrderStatus = workerReadiness.rows[0]?.ready
          ? "pending_order_review"
          : "in_progress";
        const nextVersion = current.version + 1;
        const before = await this.auditState(client, current);
        const after = {
          ...before,
          status: nextStatus,
          tailInspectionRequired: false,
          specialProcessType: current.special_process_type == null ? null : "none",
          otherCraftDescription: null,
          tailInspectionCostBearer: null,
          tailInspectionCostBearerSource: null,
          version: nextVersion,
          waiverReason: input.reason,
          invalidatedTailWorkReportIds: unifiedReports.rows.map((row) => row.work_report_id),
          retiredTailWorkTaskIds: tailTasks.rows.map((row) => row.work_task_id),
          invalidatedLegacyTailReportIds: legacyReports.rows.map((row) => row.tail_inspection_report_id),
          retiredLegacyTailAssignmentIds: legacyAssignments.rows.map((row) => row.tail_inspection_assignment_id),
        };
        const eventId = await this.events.append(client, actor, {
          action: "rework.tail_inspection.waive",
          entityType: "rework_order",
          entityId: reworkOrderId,
          before,
          after,
        });
        await this.setTailWaiverAuditContext(client, eventId, actor.requestId);

        for (const report of unifiedReports.rows) {
          await client.query(
            `INSERT INTO rework_work_report_rejections(
               report_rejection_id,work_report_id,rework_order_id,rejected_person_id,
               rejected_by,reason,report_snapshot
             ) VALUES($1,$2,$3,$4,$5,$6,$7)`,
            [
              randomUUID(), report.work_report_id, reworkOrderId,
              report.assignment_mode === "individual" ? report.rejected_person_id : null,
              actor.actorId, input.reason, report.report_snapshot,
            ],
          );
        }
        await client.query(
          `UPDATE rework_work_tasks task
           SET status='superseded',superseded_at=CURRENT_TIMESTAMP
           FROM rework_process_configuration_items item
           WHERE task.rework_order_id=$1 AND task.status='active'
             AND item.configuration_item_id=task.configuration_item_id
             AND item.execution_kind='tail_inspection'`,
          [reworkOrderId],
        );
        await client.query(
          `UPDATE rework_tail_inspection_reports
           SET status='rejected',rejected_at=CURRENT_TIMESTAMP,rejected_by=$2,rejection_reason=$3
           WHERE rework_order_id=$1 AND status='submitted'`,
          [reworkOrderId, actor.actorId, input.reason],
        );
        await client.query(
          `UPDATE rework_tail_inspection_assignments
           SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason=$3
           WHERE rework_order_id=$1 AND revoked_at IS NULL`,
          [reworkOrderId, actor.actorId, input.reason],
        );
        await client.query(
          `UPDATE rework_orders
           SET tail_inspection_required=false,tail_inspection_cost_bearer=NULL,
               special_process_type=CASE WHEN special_process_type IS NULL THEN NULL ELSE 'none' END,
               other_craft_description=NULL,
               tail_inspection_cost_bearer_source=NULL,status=$2,updated_by=$3,
               version=$4,updated_at=CURRENT_TIMESTAMP
           WHERE rework_order_id=$1`,
          [reworkOrderId, nextStatus, actor.actorId, nextVersion],
        );

        const todoReason = `该订单已改为无需整查：${input.reason}`;
        await this.todos?.cancelOpenByDedupePrefix(
          client, actor, `tail-inspection:${reworkOrderId}:`, todoReason,
        );
        for (const report of legacyTailReportIds.rows) {
          await this.todos?.cancelOpenByDedupeKey(
            client, actor, `tail-inspection-return:${report.tail_inspection_report_id}`, todoReason,
          );
        }
        for (const report of unifiedTailReportIds.rows) {
          await this.todos?.cancelOpenByDedupeKey(
            client, actor, `work-report-return:${report.work_report_id}`, todoReason,
          );
        }
        await this.todos?.cancelOpenByDedupePrefix(
          client, actor, `whole-order-review:${reworkOrderId}:`, todoReason,
        );
        if (nextStatus === "pending_order_review") {
          await this.todos?.actionableForUniqueDirectRole(client, actor, {
            category: "whole_order_review",
            sourceEventId: eventId,
            sourceAction: "rework.tail_inspection.waive",
            entityType: "rework_order",
            entityId: reworkOrderId,
            requiredRole: "tail_supervisor",
            requiredCapability: "submission:audit",
            route: { routeName: "rework_detail", entityId: reworkOrderId, tab: "whole_order_review" },
            policyKey: "general",
            dedupeKey: `whole-order-review:${reworkOrderId}:${nextVersion}`,
          });
        }
        return this.getAccessibleWithClient(client, reworkOrderId);
      },
    );
  }

  async submit(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SubmitReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    let originalGarment:GarmentReworkSource|null=null;
    return this.mutate(actor, "rework.submit", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockOwned(client, actor.actorId, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "pending_process_configuration");
      if(originalGarment)await readGarmentReworkSource(client,actor,originalGarment);
      this.ensureComplete(current);
      if (current.merchandiser_user_id) {
        await this.ensureActiveMerchandiser(client, current.merchandiser_user_id);
      }
      await this.ensureFactoryStillAvailable(client, factoryFromRow(current)!);
      const attachmentIds = await this.attachmentIds(client, reworkOrderId);
      await this.ensureReadyBoundAttachments(client, actor.actorId, reworkOrderId, attachmentIds);
      const numberResult = current.rework_no
        ? { rows: [{ rework_no: current.rework_no }] }
        : await client.query<{ rework_no: string }>("SELECT next_rework_order_number() AS rework_no");
      const reworkNo = numberResult.rows[0]!.rework_no;
      const nextVersion = current.version + 1;
      const after = {
        ...(await this.auditState(client, current)),
        reworkNo,
        status: "pending_process_configuration" as const,
        version: nextVersion,
        attachmentIds,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.submit",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before: await this.auditState(client, current),
        after,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET rework_no=$2,status='pending_process_configuration',
             submitted_at=COALESCE(submitted_at,CURRENT_TIMESTAMP),
             updated_by=$3,version=$4,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, reworkNo, actor.actorId, nextVersion],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.pending_process_configuration",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo, styleNo: current.style_no },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:submitted:${nextVersion}`,
      });
      await this.todos?.actionableForUniqueDirectRole(client, actor, {
        category: "process_configuration",
        sourceEventId: eventId,
        sourceAction: "rework.submit",
        entityType: "rework_order",
        entityId: reworkOrderId,
        requiredRole: "tail_supervisor",
        requiredCapability: "process:configure",
        route: { routeName: "process_configuration", entityId: reworkOrderId },
        policyKey: "general",
        dedupeKey: `process-config:${reworkOrderId}:${nextVersion}`,
      });
      return this.getOwnedWithClient(client, actor.actorId, reworkOrderId);
    },async client=>{originalGarment=await lockOriginalGarmentReworkOrder(client,actor,reworkOrderId);});
  }

  async withdraw(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: TransitionReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.withdraw", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockInitiationMaintenance(client, actor, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "draft");
      if (current.status !== "pending_process_configuration") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "只有待配置工序的返工单可以撤回", 409);
      }
      await this.ensureNoProcessConfigurationStarted(client, reworkOrderId);
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = { ...before, status: "draft" as const, version: nextVersion };
      const eventId = await this.events.append(client, actor, {
        action: "rework.withdraw",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
        reason: input.reason,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET status='draft',updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, nextVersion],
      );
      await this.todos?.cancelOpenByDedupePrefix(
        client,
        actor,
        `process-config:${reworkOrderId}:`,
        "The rework order was withdrawn before process configuration started",
      );
      await this.outbox.enqueue(client, {
        topic: "rework.withdrawn",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: current.rework_no, reason: input.reason },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:withdrawn:${nextVersion}`,
      });
      return this.getAccessibleWithClient(client, reworkOrderId);
    });
  }

  async cancel(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: TransitionReworkOrder,
    idempotencyKey: string,
  ): Promise<MutationResult<ReworkOrderResponse>> {
    return this.mutate(actor, "rework.cancel", idempotencyKey, { reworkOrderId, ...input }, 200, async (client) => {
      const current = await this.lockInitiationMaintenance(client, actor, reworkOrderId);
      this.ensureVersion(current, input.expectedVersion);
      transitionReworkOrder(current.status, "cancelled");
      if (current.status !== "draft" && current.status !== "pending_process_configuration") {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "当前返工单不能取消", 409);
      }
      if (current.status === "pending_process_configuration") {
        await this.ensureNoProcessConfigurationStarted(client, reworkOrderId);
      }
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = {
        ...before,
        status: "cancelled" as const,
        cancelReason: input.reason,
        version: nextVersion,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.cancel",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
        reason: input.reason,
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await client.query(
        `UPDATE rework_orders
         SET status='cancelled',cancelled_at=CURRENT_TIMESTAMP,cancelled_by=$2,
             cancel_reason=$3,updated_by=$2,version=$4,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, input.reason, nextVersion],
      );
      await this.todos?.cancelOpenByDedupePrefix(
        client,
        actor,
        `process-config:${reworkOrderId}:`,
        "The rework order was cancelled before process configuration started",
      );
      await this.outbox.enqueue(client, {
        topic: "rework.cancelled",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: current.rework_no, reason: input.reason },
        recipientKey: "role:tail_supervisor",
        idempotencyKey: `${reworkOrderId}:cancelled:${nextVersion}`,
      });
      return this.getAccessibleWithClient(client, reworkOrderId);
    });
  }

  async deleteByRoot(
    actor: TrustedActorContext,
    reworkOrderId: string,
    idempotencyKey: string,
  ): Promise<MutationResult<DeleteReworkOrderResponse>> {
    return this.mutateRootDeletion(actor, idempotencyKey, { reworkOrderId }, async (client) => {
      const current = await this.lockForRootDeletion(client, reworkOrderId);
      if (current.status === "deleted") return { reworkOrderId, deleted: true };
      const nextVersion = current.version + 1;
      const before = await this.auditState(client, current);
      const after = {
        ...before,
        status: "deleted" as const,
        deletedBy: actor.actorId,
        version: nextVersion,
      };
      const eventId = await this.events.append(client, actor, {
        action: "rework.delete",
        entityType: "rework_order",
        entityId: reworkOrderId,
        before,
        after,
        reason: "Root confirmed logical deletion",
      });
      await this.setAuditContext(client, eventId, actor.requestId);
      await this.todoService?.cancelOpenForReworkOrder(
        client,
        actor,
        reworkOrderId,
        "The rework order was deleted by root",
      );
      await client.query(
        `UPDATE rework_orders
         SET status='deleted',deleted_at=CURRENT_TIMESTAMP,deleted_by=$2,
             updated_by=$2,version=$3,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1`,
        [reworkOrderId, actor.actorId, nextVersion],
      );
      await this.outbox.enqueue(client, {
        topic: "rework.deleted",
        aggregateType: "rework_order",
        aggregateId: reworkOrderId,
        payload: { reworkOrderId, reworkNo: current.rework_no },
        recipientKey: "system:rework",
        idempotencyKey: `${reworkOrderId}:deleted:${nextVersion}`,
      });
      return { reworkOrderId, deleted: true };
    });
  }

  async getOwn(
    actor: TrustedActorContext,
    reworkOrderId: string,
  ): Promise<ReworkOrderResponse> {
    this.ensureInitiator(actor);
    return this.getOwnedWithClient(this.database, actor.actorId, reworkOrderId);
  }

  async listOwn(
    actor: TrustedActorContext,
    status?: ReworkOrderStatus,
  ): Promise<ReworkOrderResponse[]> {
    this.ensureInitiator(actor);
    const values: unknown[] = [actor.actorId];
    const statusFilter = status ? " AND orders.status=$2" : "";
    if (status) values.push(status);
    const result = await this.database.query<ReworkOrderRow>(
      `${ORDER_SELECT} WHERE orders.created_by=$1 AND orders.status<>'deleted'${statusFilter}
       ORDER BY orders.updated_at DESC,orders.rework_order_id`,
      values,
    );
    const attachments = new Map<string, string[]>();
    if (result.rows.length) {
      const files = await this.database.query<{ entity_id: string; attachment_id: string }>(
        `SELECT entity_id,attachment_id FROM attachments
         WHERE entity_type='rework_order' AND entity_id=ANY($1::text[])
         ORDER BY entity_id,created_at,attachment_id`,
        [result.rows.map((row) => row.rework_order_id)],
      );
      for (const file of files.rows) {
        const ids = attachments.get(file.entity_id) ?? [];
        ids.push(file.attachment_id);
        attachments.set(file.entity_id, ids);
      }
    }
    return result.rows.map((row) => this.projectOrder(row, attachments.get(row.rework_order_id) ?? []));
  }

  async listInitiationOptions(
    actor: TrustedActorContext,
    kind: "qc_rework" | "inhouse_finishing" = "qc_rework",
  ): Promise<ReworkInitiationOptionsResponse> {
    if (kind === "inhouse_finishing") this.ensureFinishingInitiator(actor);
    else this.ensureInitiator(actor);
    const [merchandisers, factories, colors] = await Promise.all([
      this.database.query<{ user_id: string; display_name: string }>(
        `SELECT users.id AS user_id,users.display_name
         FROM app_users users
         JOIN identity_mappings identity ON identity.user_id=users.id
         JOIN access_security_policy policy
           ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
         JOIN user_role_assignments assignment
           ON assignment.user_id=users.id
          AND assignment.role_code='order_merchandiser'
          AND assignment.revoked_at IS NULL
         WHERE users.enabled=true
           AND identity.provider='dingtalk'
           AND identity.corp_id=$1
           AND identity.active=true AND identity.employed=true
         ORDER BY users.display_name,users.id`,
        [this.corporationId],
      ),
      this.database.query<{
        supplier_id: string;
        version: number;
        supplier_name: string;
        personal_usage_count: number;
        global_usage_count: number;
        personal_last_used_at: Date | null;
        global_last_used_at: Date | null;
      }>(
        `SELECT catalog.supplier_id,catalog.version,catalog.supplier_name,
                COALESCE(usage.personal_usage_count,0)::int AS personal_usage_count,
                COALESCE(usage.global_usage_count,0)::int AS global_usage_count,
                usage.personal_last_used_at,usage.global_last_used_at
         FROM current_supplier_catalog catalog
         LEFT JOIN (
           SELECT processing_factory_supplier_id AS supplier_id,
                  COUNT(*) FILTER (WHERE created_by=$1)::int AS personal_usage_count,
                  COUNT(*)::int AS global_usage_count,
                  MAX(submitted_at) FILTER (WHERE created_by=$1) AS personal_last_used_at,
                  MAX(submitted_at) AS global_last_used_at
           FROM rework_orders
           WHERE submitted_at IS NOT NULL
             AND status<>'deleted'
             AND processing_factory_type='supplier'
             AND processing_factory_supplier_id IS NOT NULL
           GROUP BY processing_factory_supplier_id
         ) usage ON usage.supplier_id=catalog.supplier_id
         WHERE catalog.supplier_type='factory' AND catalog.active=true
         ORDER BY catalog.supplier_name,catalog.supplier_id`,
        [actor.actorId],
      ),
      this.database.query<{
        value: string;
        personal_usage_count: number;
        global_usage_count: number;
        personal_last_used_at: Date | null;
        global_last_used_at: Date | null;
      }>(
        `WITH submitted_colors AS (
           SELECT BTRIM(inspection_report->>'color') AS value,
                  LOWER(BTRIM(inspection_report->>'color')) AS normalized_value,
                  created_by,submitted_at
           FROM rework_orders
           WHERE submitted_at IS NOT NULL
             AND status<>'deleted'
             AND BTRIM(COALESCE(inspection_report->>'color',''))<>''
         )
         SELECT (ARRAY_AGG(value ORDER BY submitted_at DESC))[1] AS value,
                COUNT(*) FILTER (WHERE created_by=$1)::int AS personal_usage_count,
                COUNT(*)::int AS global_usage_count,
                MAX(submitted_at) FILTER (WHERE created_by=$1) AS personal_last_used_at,
                MAX(submitted_at) AS global_last_used_at
         FROM submitted_colors
         GROUP BY normalized_value`,
        [actor.actorId],
      ),
    ]);
    return {
      merchandisers: merchandisers.rows.map((row) => ({
        userId: row.user_id,
        displayName: row.display_name,
      })),
      factories: factories.rows.map((row) => ({
        supplierId: row.supplier_id,
        supplierVersion: row.version,
        supplierName: row.supplier_name,
        personalUsageCount: row.personal_usage_count,
        globalUsageCount: row.global_usage_count,
        lastUsedAt: (row.personal_last_used_at ?? row.global_last_used_at)?.toISOString() ?? null,
      })),
      colorSuggestions: colors.rows.map((row) => ({
        value: row.value,
        personalUsageCount: row.personal_usage_count,
        globalUsageCount: row.global_usage_count,
        lastUsedAt: (row.personal_last_used_at ?? row.global_last_used_at)?.toISOString() ?? null,
      })),
    };
  }

  async canDownloadBoundAttachment(
    actor: Readonly<{ actorId: string; actorRoles: readonly string[]; capabilities: readonly string[] }>,
    binding: Readonly<{ attachmentId?: string; entityType: string; entityId: string }>,
  ): Promise<boolean> {
    if (binding.entityType === "sourcing_case" && binding.attachmentId
      && (actor.actorRoles.includes("root_superuser") || actor.actorRoles.includes("owner_group")
        || (actor.actorRoles.includes("tail_supervisor") && actor.capabilities.includes("process:configure")))) {
      const source = await this.database.query(
        `SELECT 1 FROM receiving_batches batch
         JOIN cutting_orders cutting ON cutting.cutting_order_id=batch.cutting_order_id
         JOIN current_sourcing_case_lines line ON line.sourcing_case_id=cutting.sourcing_case_id
           AND line.position=cutting.sourcing_line_position
         WHERE batch.deleted_at IS NULL AND cutting.sourcing_case_id::text=$1
           AND line.image_attachment_id::text=$2 LIMIT 1`,
        [binding.entityId, binding.attachmentId],
      );
      return (source.rowCount ?? 0) > 0;
    }
    if (binding.entityType !== "rework_order") return false;
    const result = await this.database.query<{
      created_by: string;
      status: ReworkOrderStatus;
    }>(
      "SELECT created_by,status FROM rework_orders WHERE rework_order_id=$1",
      [binding.entityId],
    );
    const order = result.rows[0];
    if (!order || order.status === "deleted") return false;
    const isOwnQcEvidence = actor.actorRoles.includes("quality_control")
      && actor.capabilities.includes("rework:initiate")
      && order.created_by === actor.actorId;
    const isSupervisorConfigurationEvidence = actor.actorRoles.includes("tail_supervisor")
      && actor.capabilities.includes("process:configure")
      && order.status !== "draft"
      && order.status !== "cancelled";
    const isIeReviewEvidence = actor.actorRoles.includes("ie_reviewer")
      && actor.capabilities.includes("process:review")
      && order.status === "pending_ie_review";
    return isOwnQcEvidence || isSupervisorConfigurationEvidence || isIeReviewEvidence;
  }

  private async mutate<T>(
    actor: TrustedActorContext,
    scope: string,
    idempotencyKey: string,
    payload: unknown,
    statusCode: number,
    work: (client: PoolClient) => Promise<T>,
    authorizeBeforeReplay?: (client:PoolClient)=>Promise<void>,
  ): Promise<MutationResult<T>> {
    if (scope === "rework.finishing.draft.create") {
      this.ensureFinishingInitiator(actor);
    } else if (scope === "rework.attachments.supplement") {
      this.ensureSupplementalImageActor(actor);
    } else if (scope === "rework.tail_inspection.waive") {
      this.ensureTailInspectionWaiverActor(actor);
    } else {
      this.ensureInitiator(actor);
    }
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      await authorizeBeforeReplay?.(client);
      const result = await this.idempotency.execute<T>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, payload),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async mutateRootDeletion<T>(
    actor: TrustedActorContext,
    idempotencyKey: string,
    payload: unknown,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<MutationResult<T>> {
    this.ensureRootDeleteActor(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute<T>(client, {
        scope: "rework.delete",
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash("rework.delete", payload),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode: 200, response: await work(client) }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private ensureFinishingInitiator(actor: TrustedActorContext): void {
    if (actor.authorizationCapability !== "process:configure"
      || !actor.actorRoles.includes("tail_supervisor")
      || !actor.authorizationCapabilities?.includes("process:configure")) {
      throw new ApplicationError("FORBIDDEN", "只有尾部主管、老板或超级用户可以发起本厂做尾", 403);
    }
  }

  private ensureInitiator(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:initiate"
      || !actor.actorRoles.includes("quality_control")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控人员可以发起和维护返工单", 403);
    }
  }

  private ensureSupplementalImageActor(actor: TrustedActorContext): void {
    const hasAllowedRole = actor.actorRoles.includes("root_superuser")
      || actor.actorRoles.some((role) => REWORK_IMAGE_SUPPLEMENT_ROLES.includes(
        role as (typeof REWORK_IMAGE_SUPPLEMENT_ROLES)[number],
      ));
    if (actor.authorizationCapability !== "tools:user" || !hasAllowedRole) {
      throw new ApplicationError("FORBIDDEN", "当前角色无权补充返工单图片", 403);
    }
  }

  private ensureRootDeleteActor(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:delete"
      || !actor.actorRoles.includes("root_superuser")
      || !actor.authorizationCapabilities?.includes("rework:delete")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有超级用户可以删除返工单", 403);
    }
  }

  private ensureTailInspectionWaiverActor(actor: TrustedActorContext): void {
    const allowedRole = actor.actorRoles.includes("root_superuser")
      || actor.actorRoles.includes("owner_group")
      || actor.actorRoles.includes("production_management");
    if (
      actor.authorizationCapability !== "tail_inspection:waive"
      || !actor.authorizationCapabilities?.includes("tail_inspection:waive")
      || !allowedRole
    ) {
      throw new ApplicationError("FORBIDDEN", "只有老板、供应链总监或超级用户可以改为无需整查", 403);
    }
  }

  private ensureVersion(row: ReworkOrderRow, expectedVersion: number): void {
    if (row.version !== expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被更新，请刷新后重试", 409);
    }
  }

  private ensureComplete(row: ReworkOrderRow): void {
    ensureOtherCraftComplete(row);
    if (
      !row.style_no
      || !row.processing_factory_type
      || !row.order_quantity
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "请完整填写供应商、款号和订单数量", 400);
    }
    if (row.tail_inspection_required && (
      !row.tail_inspection_cost_bearer
      || row.tail_inspection_cost_bearer_source !== "quality_inspection"
    )) {
      throw new ApplicationError("VALIDATION_ERROR", "请由质检明确选择整查费用承担方", 400);
    }
    if (row.tail_inspection_cost_bearer === "processing_factory"
      && row.processing_factory_type !== "supplier") {
      throw new ApplicationError("VALIDATION_ERROR", "加工厂承担整查费用时必须选择外发加工厂", 400);
    }
    const report = InspectionReportDraftSchema.safeParse(row.inspection_report);
    if (
      !report.success
      || !report.data.styleName
      || !report.data.inspectionStage
      || !report.data.inspectionLocation
      || !report.data.color
      || !report.data.sampleQuantity
    ) {
      throw new ApplicationError("VALIDATION_ERROR", "请完整填写款式、颜色、验货阶段、验货地址和抽检数量", 400);
    }
  }

  private async ensureActiveMerchandiser(client: PoolClient, userId: string): Promise<void> {
    const result = await client.query(
      `SELECT 1
       FROM app_users users
       JOIN identity_mappings identity ON identity.user_id=users.id
       JOIN access_security_policy policy
         ON policy.policy_key='primary' AND policy.dingtalk_corp_id=identity.corp_id
       JOIN user_role_assignments assignment
         ON assignment.user_id=users.id
        AND assignment.role_code='order_merchandiser'
        AND assignment.revoked_at IS NULL
       WHERE users.id=$1 AND users.enabled=true
         AND identity.provider='dingtalk'
         AND identity.corp_id=$2
         AND identity.active=true AND identity.employed=true`,
      [userId, this.corporationId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "所选订单跟单不存在、不在职或角色无效", 404);
    }
  }

  private async resolveFactory(
    client: PoolClient,
    input: CreateReworkDraft["processingFactory"],
  ): Promise<FactoryState> {
    if (input === null || input === undefined) return null;
    if (input.type === "own_factory") {
      return { type: "own_factory", supplierId: null, supplierVersion: null };
    }
    const result = await client.query<{ supplier_id: string; version: number }>(
      `SELECT supplier_id,version
       FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [input.supplierId],
    );
    const supplier = result.rows[0];
    if (!supplier) throw new ApplicationError("NOT_FOUND", "所选加工厂不存在或已停用", 404);
    return {
      type: "supplier",
      supplierId: supplier.supplier_id,
      supplierVersion: supplier.version,
    };
  }

  private async ensureFactoryStillAvailable(client: PoolClient, factory: FactoryState): Promise<void> {
    if (!factory || factory.type === "own_factory") return;
    const result = await client.query(
      `SELECT 1 FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [factory.supplierId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "草稿中的加工厂已停用，请重新选择", 404);
    }
  }

  private async lockForSupplementalImages(
    client: PoolClient,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT}
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'
       FOR UPDATE OF orders`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (row.status === "cancelled") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "已取消的返工单不能补充图片", 409);
    }
    return row;
  }

  /** Root may maintain N01 across creators; all workflow/version guards still apply. */
  private async lockInitiationMaintenance(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    return actor.actorRoles.includes("root_superuser")
      ? this.lockAccessible(client, reworkOrderId)
      : this.lockOwned(client, actor.actorId, reworkOrderId);
  }

  private async lockOwned(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT}
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'
       FOR UPDATE OF orders`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (row.created_by !== actorId) {
      throw new ApplicationError("FORBIDDEN", "只能查看和维护本人发起的返工单", 403);
    }
    return row;
  }

  private async lockForRootDeletion(
    client: PoolClient,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT}
       WHERE orders.rework_order_id=$1
       FOR UPDATE OF orders`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    return row;
  }

  private async lockAccessible(
    client: PoolClient,
    reworkOrderId: string,
  ): Promise<ReworkOrderRow> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT}
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'
       FOR UPDATE OF orders`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    return row;
  }

  private async ensureNoProcessConfigurationStarted(
    client: PoolClient,
    reworkOrderId: string,
  ): Promise<void> {
    const configuration = await client.query(
      "SELECT 1 FROM rework_process_configurations WHERE rework_order_id=$1 LIMIT 1 FOR SHARE",
      [reworkOrderId],
    );
    if (configuration.rowCount !== 0) {
      throw new ApplicationError(
        "INVALID_STATE_TRANSITION",
        "尾部主管已开始配置工序，品控不能再撤回或取消该返工单",
        409,
      );
    }
  }

  private async getOwnedWithClient(
    client: Pick<PoolClient, "query">,
    actorId: string,
    reworkOrderId: string,
  ): Promise<ReworkOrderResponse> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT} WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (row.created_by !== actorId) {
      throw new ApplicationError("FORBIDDEN", "只能查看和维护本人发起的返工单", 403);
    }
    return this.dto(client, row);
  }

  private async getAccessibleWithClient(
    client: Pick<PoolClient, "query">,
    reworkOrderId: string,
  ): Promise<ReworkOrderResponse> {
    const result = await client.query<ReworkOrderRow>(
      `${ORDER_SELECT} WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    return this.dto(client, row);
  }

  private async attachmentIds(
    client: Pick<PoolClient, "query">,
    reworkOrderId: string,
  ): Promise<string[]> {
    const result = await client.query<{ attachment_id: string }>(
      `SELECT attachment_id
       FROM attachments
       WHERE entity_type='rework_order' AND entity_id=$1
       ORDER BY created_at,attachment_id`,
      [reworkOrderId],
    );
    return result.rows.map((row) => row.attachment_id);
  }

  private async ensureReadyBoundAttachments(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    if (attachmentIds.length === 0) {
      throw new ApplicationError(
        "REWORK_IMAGE_REQUIRED",
        "提交返工单前至少上传 1 张验货或问题图片",
        400,
      );
    }
    const result = await client.query<{ attachment_id: string; mime_type: string }>(
      `SELECT attachment_id,mime_type
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
         AND uploaded_by=$2
         AND status='ready'
         AND entity_type='rework_order'
         AND entity_id=$3
       FOR UPDATE`,
      [attachmentIds, actorId, reworkOrderId],
    );
    if (result.rowCount !== attachmentIds.length) {
      throw new ApplicationError("ATTACHMENT_NOT_READY", "附件未完成上传、归属不符或已被替换", 409);
    }
    if (!result.rows.some((attachment) => ["image/jpeg", "image/png", "image/webp"].includes(attachment.mime_type))) {
      throw new ApplicationError(
        "REWORK_IMAGE_REQUIRED",
        "提交返工单前至少上传 1 张验货或问题图片，PDF 仅可作为补充附件",
        400,
      );
    }
  }

  private async ensureReadySupplementalImages(
    client: PoolClient,
    actorId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const candidates = await client.query(
      `SELECT attachment_id
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
         AND uploaded_by=$2
         AND status='ready'
         AND mime_type IN ('image/jpeg','image/png','image/webp')
         AND entity_type IS NULL AND entity_id IS NULL
       FOR UPDATE`,
      [attachmentIds, actorId],
    );
    if (candidates.rowCount !== attachmentIds.length) {
      throw new ApplicationError(
        "ATTACHMENT_NOT_READY",
        "补充图片未完成上传、并非本人上传、格式不支持或已绑定其他业务",
        409,
      );
    }
  }

  private async bindSupplementalImages(
    client: PoolClient,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const result = await client.query(
      `UPDATE attachments
       SET entity_type='rework_order',entity_id=$2,updated_at=CURRENT_TIMESTAMP
       WHERE attachment_id=ANY($1::uuid[])
         AND entity_type IS NULL AND entity_id IS NULL`,
      [attachmentIds, reworkOrderId],
    );
    if (result.rowCount !== attachmentIds.length) {
      throw new ApplicationError("CONFLICT", "补充图片状态已变化，请刷新后重试", 409);
    }
  }

  private async syncAttachments(
    client: PoolClient,
    actorId: string,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    const uniqueIds = [...new Set(attachmentIds)];
    if (uniqueIds.length !== attachmentIds.length) {
      throw new ApplicationError("VALIDATION_ERROR", "附件不能重复", 400);
    }
    if (uniqueIds.length > 0) {
      const candidates = await client.query(
        `SELECT attachment_id
         FROM attachments
         WHERE attachment_id=ANY($1::uuid[])
           AND uploaded_by=$2
           AND status='ready'
           AND (
             (entity_type IS NULL AND entity_id IS NULL)
             OR
             (entity_type='rework_order' AND entity_id=$3)
           )
         FOR UPDATE`,
        [uniqueIds, actorId, reworkOrderId],
      );
      if (candidates.rowCount !== uniqueIds.length) {
        throw new ApplicationError(
          "ATTACHMENT_NOT_READY",
          "附件未完成上传、并非本人上传或已绑定其他业务",
          409,
        );
      }
    }
    await client.query(
      `UPDATE attachments
       SET entity_type=NULL,entity_id=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE entity_type='rework_order' AND entity_id=$1
         AND NOT (attachment_id=ANY($2::uuid[]))`,
      [reworkOrderId, uniqueIds],
    );
    if (uniqueIds.length > 0) {
      await client.query(
        `UPDATE attachments
         SET entity_type='rework_order',entity_id=$2,updated_at=CURRENT_TIMESTAMP
         WHERE attachment_id=ANY($1::uuid[])
           AND entity_type IS NULL AND entity_id IS NULL`,
        [uniqueIds, reworkOrderId],
      );
    }
  }

  private async auditState(
    client: Pick<PoolClient, "query">,
    row: ReworkOrderRow,
  ): Promise<Record<string, unknown>> {
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      reworkKind: row.rework_kind,
      receivingBatchId: row.source_receiving_batch_id,
      styleNo: row.style_no,
      customerSupplyCode: row.customer_supply_code,
      factoryStyleNo: row.factory_style_no,
      orderNo: row.order_no,
      orderQuantity: row.order_quantity,
      merchandiserUserId: row.merchandiser_user_id,
      processingFactory: factoryFromRow(row),
      reworkReason: row.rework_reason,
      reworkProcess: row.rework_process,
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity,
      tailInspectionRequired: row.tail_inspection_required,
      specialProcessType: row.special_process_type ?? null,
      otherCraftDescription: row.other_craft_description ?? null,
      tailInspectionCostBearer: row.tail_inspection_cost_bearer,
      tailInspectionCostBearerSource: row.tail_inspection_cost_bearer_source,
      inspectionReport: row.inspection_report,
      attachmentIds: await this.attachmentIds(client, row.rework_order_id),
      version: row.version,
    };
  }

  private async setAuditContext(
    client: PoolClient,
    eventId: string,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private async setTailWaiverAuditContext(
    client: PoolClient,
    eventId: string,
    requestId: string,
  ): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true),
         set_config('dx_rework.work_event_id',$1,true),
         set_config('dx_rework.work_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private async dto(
    client: Pick<PoolClient, "query">,
    row: ReworkOrderRow,
  ): Promise<ReworkOrderResponse> {
    return this.projectOrder(row, await this.attachmentIds(client, row.rework_order_id));
  }

  private projectOrder(row: ReworkOrderRow, attachmentIds: string[]): ReworkOrderResponse {
    const factory = factoryFromRow(row);
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      reworkKind: row.rework_kind,
      receivingBatchId: row.source_receiving_batch_id,
      ...(row.source_craft_qc_check_id&&row.craft_rework_execution?{originalCraftQuality:{checkId:row.source_craft_qc_check_id,unit:"片" as const,execution:row.craft_rework_execution}}:{}),
      styleNo: row.style_no,
      customerSupplyCode: row.customer_supply_code,
      factoryStyleNo: row.factory_style_no,
      orderNo: row.order_no,
      orderQuantity: row.order_quantity,
      merchandiserUserId: row.merchandiser_user_id,
      processingFactory: factory?.type === "supplier"
        ? {
            type: "supplier",
            supplierId: factory.supplierId!,
            supplierVersion: factory.supplierVersion!,
          }
        : factory?.type === "own_factory"
          ? { type: "own_factory" }
          : null,
      reworkReason: row.rework_reason,
      reworkProcess: row.rework_process,
      problemPart: row.problem_part,
      problemDescription: row.problem_description,
      reworkQuantity: row.rework_quantity,
      tailInspectionRequired: row.tail_inspection_required,
      specialProcessType: row.special_process_type ?? null,
      otherCraftDescription: row.other_craft_description ?? null,
      tailInspectionCostBearer: row.tail_inspection_cost_bearer,
      tailInspectionCostBearerSource: row.tail_inspection_cost_bearer_source,
      inspectionReport: row.inspection_report,
      attachmentIds,
      hasOtherOpenStyleOrder: Boolean(row.has_other_open_style_order),
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cancelReason: row.cancel_reason,
    };
  }
}


