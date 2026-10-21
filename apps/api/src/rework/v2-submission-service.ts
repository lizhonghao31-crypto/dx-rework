import { createHash } from "node:crypto";

import type { ReworkOrderResponse, SubmitReworkOrder } from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import { ensureOtherCraftComplete } from "./special-process.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type OrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderResponse["status"];
  rework_kind: "qc_rework" | "inhouse_finishing";
  source_system: string;
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
  inspection_report: ReworkOrderResponse["inspectionReport"];
  created_by: string;
  updated_by: string;
  version: number;
  created_at: Date;
  updated_at: Date;
  submitted_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  has_other_open_style_order?: boolean;
}>;
type DatabaseError = Readonly<{ code?: string }>;

type FactoryState = Readonly<{
  type: "own_factory" | "supplier";
  supplierId: string | null;
  supplierVersion: number | null;
}> | null;

const factoryFromRow = (row: OrderRow): FactoryState => {
  if (!row.processing_factory_type) return null;
  if (row.processing_factory_type === "own_factory") {
    return { type: "own_factory", supplierId: null, supplierVersion: null };
  }
  return {
    type: "supplier",
    supplierId: row.processing_factory_supplier_id,
    supplierVersion: row.processing_factory_supplier_version,
  };
};

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
  const code = (error as DatabaseError | null)?.code;
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "引用的跟单、加工厂或附件不存在", 404);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "本次返工提交未通过业务校验，系统未能确定具体字段或状态原因；请申请人在本单提交页核对原资料，仍失败时提供订单链接给管理员核查，不要重复建单", 400);
  }
  if (code === "55000") throw new ApplicationError("CONFLICT", "返工单不允许绕过受控流程修改", 409);
  throw error;
};

export class ReworkV2SubmissionService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
    private readonly outbox = new MessageOutboxRepository(),
    private readonly todos?: TodoProjectionService,
  ) {}

  async submit(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SubmitReworkOrder,
    idempotencyKey: string,
    kind: "qc_rework" | "inhouse_finishing" = "qc_rework",
  ): Promise<Readonly<{ value: ReworkOrderResponse; reused: boolean }>> {
    if (kind === "inhouse_finishing") this.ensureFinishingInitiator(actor);
    else this.ensureInitiator(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const scope = kind === "inhouse_finishing" ? "rework.finishing.submit.v2" : "rework.submit.v2";
      const result = await this.idempotency.execute<ReworkOrderResponse>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { reworkOrderId, kind, ...input }),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 200,
        response: await this.submitOnce(client, actor, reworkOrderId, input, kind),
      }));
      await client.query("COMMIT");
      return { value: result.response, reused: result.reused };
    } catch (error: unknown) {
      await client.query("ROLLBACK");
      return translateDatabaseError(error);
    } finally {
      client.release();
    }
  }

  private async submitOnce(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SubmitReworkOrder,
    kind: "qc_rework" | "inhouse_finishing",
  ): Promise<ReworkOrderResponse> {
    const current = await this.lockOwnedDraft(client, actor, reworkOrderId);
    ensureOtherCraftComplete(current);
    if (current.rework_kind !== kind) {
      throw new ApplicationError("FORBIDDEN", "返工类别与提交入口不一致", 403);
    }
    if (kind === "inhouse_finishing" && (current.tail_inspection_required
      || current.tail_inspection_cost_bearer || current.inspection_report)) {
      throw new ApplicationError("VALIDATION_ERROR", "本厂做尾不能填写整查或QC报告", 400);
    }
    if (current.version !== input.expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被更新，请刷新后重试", 409);
    }
    if (current.status !== "draft") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以提交", 409);
    }
    if (!current.style_no || !current.processing_factory_type || !current.merchandiser_user_id) {
      throw new ApplicationError("VALIDATION_ERROR", "请完整填写款号、加工厂和订单跟单", 400);
    }
    if (current.tail_inspection_required && (
      !current.tail_inspection_cost_bearer
      || current.tail_inspection_cost_bearer_source !== "quality_inspection"
    )) {
      throw new ApplicationError("VALIDATION_ERROR", "请由质检明确选择整查费用承担方", 400);
    }
    if (current.tail_inspection_cost_bearer === "processing_factory"
      && current.processing_factory_type !== "supplier") {
      throw new ApplicationError("VALIDATION_ERROR", "加工厂承担整查费用时必须选择外发加工厂", 400);
    }
    await this.ensureActiveMerchandiser(client, current.merchandiser_user_id);
    await this.ensureFactoryStillAvailable(client, factoryFromRow(current));
    const attachmentIds = await this.attachmentIds(client, reworkOrderId);
    if (kind === "qc_rework") await this.ensureReadyBoundImage(client, actor, reworkOrderId, attachmentIds);

    const numberResult = current.rework_no
      ? { rows: [{ rework_no: current.rework_no }] }
      : await client.query<{ rework_no: string }>("SELECT next_rework_order_number() AS rework_no");
    const reworkNo = numberResult.rows[0]!.rework_no;
    const nextVersion = current.version + 1;
    const before = await this.auditState(client, current);
    const after = {
      ...before,
      reworkNo,
      status: "pending_process_configuration" as const,
      attachmentIds,
      version: nextVersion,
    };
    const eventId = await this.events.append(client, actor, {
      action: kind === "inhouse_finishing" ? "rework.finishing.submit" : "rework.submit",
      entityType: "rework_order",
      entityId: reworkOrderId,
      before,
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
      sourceAction: kind === "inhouse_finishing" ? "rework.finishing.submit" : "rework.submit",
      entityType: "rework_order",
      entityId: reworkOrderId,
      requiredRole: "tail_supervisor",
      requiredCapability: "process:configure",
      route: { routeName: "process_configuration", entityId: reworkOrderId },
      policyKey: "general",
      dedupeKey: `process-config:${reworkOrderId}:${nextVersion}`,
    });

    const saved = await client.query<OrderRow>(
      `SELECT orders.*,
         EXISTS (
           SELECT 1 FROM rework_orders other
           WHERE other.rework_order_id<>orders.rework_order_id
             AND other.style_no=orders.style_no
             AND other.status NOT IN ('completed','cancelled','deleted')
         ) AS has_other_open_style_order
       FROM rework_orders orders
       WHERE orders.rework_order_id=$1`,
      [reworkOrderId],
    );
    return this.dto(saved.rows[0]!, attachmentIds);
  }

  private async lockOwnedDraft(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
  ): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT * FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted'
       FOR UPDATE`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    if (!actor.actorRoles.includes("root_superuser") && row.created_by !== actor.actorId) {
      throw new ApplicationError("FORBIDDEN", "只能提交本人发起的返工单", 403);
    }
    return row;
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

  private async ensureFactoryStillAvailable(client: PoolClient, factory: FactoryState): Promise<void> {
    if (!factory) throw new ApplicationError("VALIDATION_ERROR", "请选择加工厂", 400);
    if (factory.type === "own_factory") return;
    const result = await client.query(
      `SELECT 1 FROM current_supplier_catalog
       WHERE supplier_id=$1 AND supplier_type='factory' AND active=true`,
      [factory.supplierId],
    );
    if (!result.rows[0]) {
      throw new ApplicationError("NOT_FOUND", "草稿中的加工厂已停用，请重新选择", 404);
    }
  }

  private async attachmentIds(client: PoolClient, reworkOrderId: string): Promise<string[]> {
    const result = await client.query<{ attachment_id: string }>(
      `SELECT attachment_id
       FROM attachments
       WHERE entity_type='rework_order' AND entity_id=$1
       ORDER BY created_at,attachment_id`,
      [reworkOrderId],
    );
    return result.rows.map((row) => row.attachment_id);
  }

  private async ensureReadyBoundImage(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    attachmentIds: readonly string[],
  ): Promise<void> {
    if (attachmentIds.length === 0) {
      throw new ApplicationError("REWORK_IMAGE_REQUIRED", "提交返工单前至少上传 1 张验货或问题图片", 400);
    }
    const expectedUploader = actor.actorRoles.includes("root_superuser") ? null : actor.actorId;
    const result = await client.query<{ attachment_id: string; mime_type: string }>(
      `SELECT attachment_id,mime_type
       FROM attachments
       WHERE attachment_id=ANY($1::uuid[])
         AND ($2::uuid IS NULL OR uploaded_by=$2)
         AND status='ready'
         AND entity_type='rework_order'
         AND entity_id=$3
       FOR UPDATE`,
      [attachmentIds, expectedUploader, reworkOrderId],
    );
    if (result.rowCount !== attachmentIds.length) {
      throw new ApplicationError("ATTACHMENT_NOT_READY", "附件未完成上传、归属不符或已被替换", 409);
    }
    if (!result.rows.some((item) => ["image/jpeg", "image/png", "image/webp"].includes(item.mime_type))) {
      throw new ApplicationError("REWORK_IMAGE_REQUIRED", "提交返工单前至少上传 1 张验货或问题图片", 400);
    }
  }

  private async auditState(client: PoolClient, row: OrderRow): Promise<Record<string, unknown>> {
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      reworkKind: row.rework_kind,
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

  private dto(row: OrderRow, attachmentIds: readonly string[]): ReworkOrderResponse {
    const factory = factoryFromRow(row);
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
      reworkKind: row.rework_kind,
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
      attachmentIds: [...attachmentIds],
      hasOtherOpenStyleOrder: Boolean(row.has_other_open_style_order),
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      submittedAt: row.submitted_at?.toISOString() ?? null,
      cancelledAt: row.cancelled_at?.toISOString() ?? null,
      cancelReason: row.cancel_reason,
    };
  }

  private async setAuditContext(client: PoolClient, eventId: string, requestId: string): Promise<void> {
    await client.query(
      `SELECT
         set_config('dx_rework.rework_event_id',$1,true),
         set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, requestId],
    );
  }

  private ensureFinishingInitiator(actor: TrustedActorContext): void {
    if (actor.authorizationCapability !== "process:configure"
      || !actor.actorRoles.includes("tail_supervisor")
      || !actor.authorizationCapabilities?.includes("process:configure")) {
      throw new ApplicationError("FORBIDDEN", "只有尾部主管、老板或超级用户可以提交本厂做尾", 403);
    }
  }

  private ensureInitiator(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:initiate"
      || !actor.actorRoles.includes("quality_control")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控、老板或超级用户可以提交返工单", 403);
    }
  }
}
