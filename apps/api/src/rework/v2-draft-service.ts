import { createHash } from "node:crypto";

import type { ReworkOrderResponse } from "@dx-rework/contracts";
import type { SaveReworkV2Draft } from "@dx-rework/contracts/rework-supply-context";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";

type DatabaseError = Readonly<{ code?: string }>;
type FactoryState = Readonly<{
  type: "own_factory" | "supplier";
  supplierId: string | null;
  supplierVersion: number | null;
}> | null;
type OrderRow = Readonly<{
  rework_order_id: string;
  rework_no: string | null;
  status: ReworkOrderResponse["status"];
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
  if (code === "23503") throw new ApplicationError("NOT_FOUND", "所选订单跟单或加工厂不存在", 404);
  if (code === "23514" || code === "22P02") {
    throw new ApplicationError("VALIDATION_ERROR", "返工草稿数据不符合业务约束", 400);
  }
  if (code === "55000") throw new ApplicationError("CONFLICT", "返工草稿不允许绕过受控流程修改", 409);
  throw error;
};

export class ReworkV2DraftService {
  constructor(
    private readonly database: Pool,
    private readonly corporationId: string,
    private readonly idempotency = new IdempotencyService(),
    private readonly events = new OperationEventRepository(),
  ) {}

  async get(actor: TrustedActorContext, reworkOrderId: string): Promise<ReworkOrderResponse> {
    this.ensureInitiator(actor);
    const row = await this.getAccessible(this.database, actor, reworkOrderId);
    if (row.status !== "draft") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以在 N01 编辑", 409);
    }
    return this.dto(this.database, row);
  }

  async save(
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SaveReworkV2Draft,
    idempotencyKey: string,
  ): Promise<Readonly<{ value: ReworkOrderResponse; reused: boolean }>> {
    this.ensureInitiator(actor);
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const scope = "rework.draft.update.v2";
      const result = await this.idempotency.execute<ReworkOrderResponse>(client, {
        scope,
        actorKey: actor.actorId,
        key: idempotencyKey,
        requestHash: requestHash(scope, { reworkOrderId, ...input }),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 200,
        response: await this.saveOnce(client, actor, reworkOrderId, input),
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

  private async saveOnce(
    client: PoolClient,
    actor: TrustedActorContext,
    reworkOrderId: string,
    input: SaveReworkV2Draft,
  ): Promise<ReworkOrderResponse> {
    const current = await this.lockAccessible(client, actor, reworkOrderId);
    if (current.status !== "draft") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "只有草稿可以修改 N01 资料", 409);
    }
    if (current.version !== input.expectedVersion) {
      throw new ApplicationError("CONFLICT", "返工单已被更新，请刷新后重试", 409);
    }
    if (input.merchandiserUserId) await this.ensureActiveMerchandiser(client, input.merchandiserUserId);
    const nextFactory = await this.resolveFactory(client, input.processingFactory);
    const currentFactory = factoryFromRow(current);
    const nextStyleNo = input.styleNo?.trim() || null;
    const nextTailCostBearer = input.tailInspectionRequired ? input.tailInspectionCostBearer : null;
    const nextTailCostBearerSource = nextTailCostBearer ? "quality_inspection" as const : null;
    const unchanged = current.style_no === nextStyleNo
      && current.merchandiser_user_id === input.merchandiserUserId
      && currentFactory?.type === nextFactory?.type
      && currentFactory?.supplierId === nextFactory?.supplierId
      && currentFactory?.supplierVersion === nextFactory?.supplierVersion
      && current.tail_inspection_required === input.tailInspectionRequired
      && current.tail_inspection_cost_bearer === nextTailCostBearer
      && current.tail_inspection_cost_bearer_source === nextTailCostBearerSource;
    if (unchanged) return this.dto(client, current);

    const nextVersion = current.version + 1;
    const before = await this.auditState(client, current);
    const after = {
      ...before,
      styleNo: nextStyleNo,
      merchandiserUserId: input.merchandiserUserId,
      processingFactory: nextFactory,
      tailInspectionRequired: input.tailInspectionRequired,
      tailInspectionCostBearer: nextTailCostBearer,
      tailInspectionCostBearerSource: nextTailCostBearerSource,
      version: nextVersion,
    };
    const eventId = await this.events.append(client, actor, {
      action: "rework.draft.update",
      entityType: "rework_order",
      entityId: reworkOrderId,
      before,
      after,
    });
    await this.setAuditContext(client, eventId, actor.requestId);
    await client.query(
      `UPDATE rework_orders
       SET style_no=$2,
           merchandiser_user_id=$3,
           processing_factory_type=$4,
           processing_factory_supplier_id=$5,
           processing_factory_supplier_version=$6,
           tail_inspection_required=$7,tail_inspection_cost_bearer=$8,
           tail_inspection_cost_bearer_source=$9,
           updated_by=$10,version=$11,updated_at=CURRENT_TIMESTAMP
       WHERE rework_order_id=$1`,
      [
        reworkOrderId,
        nextStyleNo,
        input.merchandiserUserId,
        nextFactory?.type ?? null,
        nextFactory?.supplierId ?? null,
        nextFactory?.supplierVersion ?? null,
        input.tailInspectionRequired,
        nextTailCostBearer,
        nextTailCostBearerSource,
        actor.actorId,
        nextVersion,
      ],
    );
    const saved = await this.getAccessible(client, actor, reworkOrderId);
    return this.dto(client, saved);
  }

  private async lockAccessible(
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
    this.ensureOwnership(actor, row.created_by);
    return row;
  }

  private async getAccessible(
    client: Pick<PoolClient, "query">,
    actor: TrustedActorContext,
    reworkOrderId: string,
  ): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT orders.*,
         EXISTS (
           SELECT 1 FROM rework_orders other
           WHERE other.rework_order_id<>orders.rework_order_id
             AND other.style_no=orders.style_no
             AND other.status NOT IN ('completed','cancelled','deleted')
         ) AS has_other_open_style_order
       FROM rework_orders orders
       WHERE orders.rework_order_id=$1 AND orders.status<>'deleted'`,
      [reworkOrderId],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "返工单不存在", 404);
    this.ensureOwnership(actor, row.created_by);
    return row;
  }

  private ensureOwnership(actor: TrustedActorContext, createdBy: string): void {
    if (!actor.actorRoles.includes("root_superuser") && createdBy !== actor.actorId) {
      throw new ApplicationError("FORBIDDEN", "只能维护本人发起的返工草稿", 403);
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
    input: SaveReworkV2Draft["processingFactory"],
  ): Promise<FactoryState> {
    if (!input) return null;
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

  private async auditState(
    client: Pick<PoolClient, "query">,
    row: OrderRow,
  ): Promise<Record<string, unknown>> {
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
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
      tailInspectionCostBearer: row.tail_inspection_cost_bearer,
      tailInspectionCostBearerSource: row.tail_inspection_cost_bearer_source,
      inspectionReport: row.inspection_report,
      attachmentIds: await this.attachmentIds(client, row.rework_order_id),
      version: row.version,
    };
  }

  private async dto(
    client: Pick<PoolClient, "query">,
    row: OrderRow,
  ): Promise<ReworkOrderResponse> {
    const factory = factoryFromRow(row);
    return {
      reworkOrderId: row.rework_order_id,
      reworkNo: row.rework_no,
      status: row.status,
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
      tailInspectionCostBearer: row.tail_inspection_cost_bearer,
      inspectionReport: row.inspection_report,
      attachmentIds: await this.attachmentIds(client, row.rework_order_id),
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

  private ensureInitiator(actor: TrustedActorContext): void {
    if (
      actor.authorizationCapability !== "rework:initiate"
      || !actor.actorRoles.includes("quality_control")
    ) {
      throw new ApplicationError("FORBIDDEN", "只有品控、老板或超级用户可以维护 N01 草稿", 403);
    }
  }
}
