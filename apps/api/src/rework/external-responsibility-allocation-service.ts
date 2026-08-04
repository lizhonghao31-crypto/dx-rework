import { createHash, randomUUID } from "node:crypto";

import type {
  AllocateExternalSuppliers,
  ExternalResponsibilityBatchResponse,
} from "@dx-rework/contracts/external-responsibility";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  MessageOutboxRepository,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";

type Result<T> = { value: T; reused: boolean };
type ResponsibilityType =
  | "processing_factory"
  | "embroidery_factory"
  | "washing_factory"
  | "fabric_supplier";
type BatchReader = {
  get(
    actor: TrustedActorContext,
    orderId: string,
    executor: PoolClient,
  ): Promise<ExternalResponsibilityBatchResponse>;
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

const payablesRole = (type: ResponsibilityType): string => ({
  processing_factory: "factory_payables",
  fabric_supplier: "fabric_payables",
  embroidery_factory: "embroidery_washing_payables",
  washing_factory: "embroidery_washing_payables",
})[type];

const expectedSupplierType = (
  type: ResponsibilityType,
): "factory" | "embroidery_washing" | "fabric" =>
  type === "processing_factory"
    ? "factory"
    : type === "fabric_supplier"
      ? "fabric"
      : "embroidery_washing";

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
 * Atomic supplier allocation path used by production and PostgreSQL workflow
 * tests. It persists the processing-factory override reason as an immutable
 * case fact instead of accepting and discarding it.
 */
export class ExternalResponsibilityAllocationService {
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();
  private readonly outbox = new MessageOutboxRepository();

  constructor(
    private readonly database: Pool,
    private readonly reader: BatchReader,
    private readonly todos?: TodoProjectionService,
  ) {}

  async allocateSuppliers(
    actor: TrustedActorContext,
    batchId: string,
    input: AllocateExternalSuppliers,
    key: string,
  ): Promise<Result<ExternalResponsibilityBatchResponse>> {
    const client = await this.database.connect();
    try {
      await client.query("BEGIN");
      const result = await this.idempotency.execute(client, {
        scope: "rework.external_responsibility.allocate",
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256")
          .update(JSON.stringify({ batchId, input }))
          .digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({
        statusCode: 201,
        response: await this.performAllocation(
          client,
          actor,
          batchId,
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

  private async performAllocation(
    client: PoolClient,
    actor: TrustedActorContext,
    batchId: string,
    input: AllocateExternalSuppliers,
  ): Promise<ExternalResponsibilityBatchResponse> {
    const batchResult = await client.query<{
      rework_order_id: string;
      batch_version: number;
      status: "active" | "superseded";
    }>(
      `SELECT rework_order_id,batch_version,status
       FROM rework_external_responsibility_batches
       WHERE batch_id=$1
       FOR UPDATE`,
      [batchId],
    );
    const batch = batchResult.rows[0]
      ?? fail("外部责任批次不存在", 404, "NOT_FOUND");
    if (
      batch.status !== "active"
      || batch.batch_version !== input.expectedBatchVersion
    ) {
      fail("外部责任批次版本冲突");
    }

    const orderResult = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,
              problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1
       FOR UPDATE`,
      [batch.rework_order_id],
    );
    const order = orderResult.rows[0]
      ?? fail("返工单不存在", 404, "NOT_FOUND");
    if (order.status !== "pending_responsibility_action") {
      fail("返工单不在责任处理状态", 409, "INVALID_STATE_TRANSITION");
    }

    const eventId = await this.events.append(
      client,
      { ...actor, authorizationCapability: "external_responsibility:sign" },
      {
        action: "rework.external_responsibility.allocate",
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

    for (const allocation of input.allocations) {
      const items = await client.query<{
        external_item_id: string;
        responsibility_type: ResponsibilityType;
      }>(
        `SELECT item.external_item_id,item.responsibility_type
         FROM rework_external_responsibility_items item
         WHERE item.batch_id=$1
           AND item.external_item_id=ANY($2::uuid[])
         FOR UPDATE`,
        [batchId, allocation.externalItemIds],
      );
      if (
        items.rowCount !== allocation.externalItemIds.length
        || items.rows.some(
          (item) => item.responsibility_type !== allocation.responsibilityType,
        )
      ) {
        fail(
          "外部责任项目不属于所选责任类型",
          400,
          "VALIDATION_ERROR",
        );
      }
      const assigned = await client.query(
        `SELECT 1
         FROM rework_external_responsibility_case_items
         WHERE external_item_id=ANY($1::uuid[])`,
        [allocation.externalItemIds],
      );
      if (assigned.rowCount) fail("外部责任项目已经分配给供应商");

      const permission = await client.query<{ permitted: boolean }>(
        `SELECT external_responsibility_can_sign($1,$2,$3) permitted`,
        [actor.actorId, order.rework_order_id, allocation.responsibilityType],
      );
      if (!permission.rows[0]?.permitted) {
        fail("当前用户不能为该责任类型签收", 403, "FORBIDDEN");
      }

      const processingFactoryChanged =
        allocation.responsibilityType === "processing_factory"
        && (
          order.processing_factory_type !== "supplier"
          || allocation.supplierId !== order.processing_factory_supplier_id
        );
      const overrideReason = processingFactoryChanged
        ? allocation.processingFactoryOverrideReason ?? null
        : null;
      if (processingFactoryChanged && !overrideReason) {
        fail("改选其他加工厂必须填写原因", 400, "VALIDATION_ERROR");
      }

      const supplier = await client.query<{
        supplier_code: string;
        supplier_name: string;
        supplier_type: "factory" | "embroidery_washing" | "fabric";
        version: number;
      }>(
        `SELECT supplier_code,supplier_name,supplier_type,version
         FROM current_supplier_catalog
         WHERE supplier_id=$1 AND active=true`,
        [allocation.supplierId],
      );
      const selected = supplier.rows[0]
        ?? fail("供应商不存在或已停用", 400, "VALIDATION_ERROR");
      if (
        selected.supplier_type
        !== expectedSupplierType(allocation.responsibilityType)
      ) {
        fail("供应商类型与责任类型不匹配", 400, "VALIDATION_ERROR");
      }

      const total = await client.query<{ total: string }>(
        `SELECT COALESCE(sum(proposed_amount),0)::text total
         FROM rework_external_responsibility_items
         WHERE external_item_id=ANY($1::uuid[])`,
        [allocation.externalItemIds],
      );
      const caseId = randomUUID();
      await client.query(
        `INSERT INTO rework_external_responsibility_cases(
           case_id,batch_id,rework_order_id,responsibility_type,
           supplier_id,supplier_version,supplier_code_snapshot,
           supplier_name_snapshot,supplier_type_snapshot,
           business_handler_user_id,payables_handler_role_snapshot,
           proposed_deduction_amount,processing_factory_override_reason,
           created_by,operation_event_id,request_id
         ) VALUES(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$10,$14,$15
         )`,
        [
          caseId,
          batchId,
          order.rework_order_id,
          allocation.responsibilityType,
          allocation.supplierId,
          selected.version,
          selected.supplier_code,
          selected.supplier_name,
          selected.supplier_type,
          actor.actorId,
          payablesRole(allocation.responsibilityType),
          total.rows[0]!.total,
          overrideReason,
          eventId,
          actor.requestId,
        ],
      );
      for (const itemId of allocation.externalItemIds) {
        await client.query(
          `INSERT INTO rework_external_responsibility_case_items(
             case_id,external_item_id,operation_event_id,request_id
           ) VALUES($1,$2,$3,$4)`,
          [caseId, itemId, eventId, actor.requestId],
        );
      }
      await this.outbox.enqueue(client, {
        topic: "rework.external_responsibility.pending_business_signoff",
        aggregateType: "external_responsibility_case",
        aggregateId: caseId,
        recipientKey: actor.actorId,
        idempotencyKey: `external-case:pending-business:${caseId}`,
        payload: {
          caseId,
          reworkOrderId: order.rework_order_id,
          delivery: "intent_only",
        },
      });
      await this.todos?.actionableForNamedSourceActor(client, actor, {
        category: "external_business_signoff",
        sourceEventId: eventId,
        sourceAction: "rework.external_responsibility.allocate",
        entityType: "rework_order",
        entityId: order.rework_order_id,
        recipientUserId: actor.actorId,
        sourceActorEventId: eventId,
        permittedCapabilities: ["external_responsibility:sign"],
        route: {
          routeName: "external_responsibility_detail",
          entityId: caseId,
          reworkOrderId: order.rework_order_id,
        },
        policyKey: "general",
        dedupeKey: `external-signoff:${caseId}:1`,
      });
    }

    await client.query(
      `UPDATE rework_external_responsibility_batches
       SET batch_version=batch_version+1
       WHERE batch_id=$1`,
      [batchId],
    );
    return this.reader.get(actor, order.rework_order_id, client);
  }
}
