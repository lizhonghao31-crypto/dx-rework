import { createHash, randomUUID } from "node:crypto";

import type {
  ConfirmHighMultiplier,
  FinalizeResponsibility,
  ResponsibilityDeterminationResponse,
  TakeoverResponsibility,
  TransferResponsibility,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";

import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";

type Result<T> = Readonly<{ value: T; reused: boolean }>;
type Queryable = Pool | PoolClient;

type OrderRow = Readonly<{
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
}>;

type LeafRow = Readonly<{
  determination_id: string;
  determination_version: number;
  stage: "draft" | "finalized";
  handler_user_id: string;
  created_by: string;
  reason: string | null;
  source_order_review_id: string;
  input_snapshot: unknown;
  calculation_total: string;
}>;

type PermissionRow = Readonly<{
  determine_eligible: boolean;
  direct_takeover: boolean;
  direct_confirm: boolean;
  handler_user_id: string | null;
  leaf_created_by: string | null;
  leaf_stage: "draft" | "finalized" | null;
  has_high_multiplier: boolean;
  high_multiplier_confirmed: boolean;
}>;

type HighMultiplierRow = Readonly<{
  configuration_item_id: string;
  multiplier: string;
  high_multiplier_reason: string | null;
}>;

const fail = (
  message: string,
  statusCode = 409,
  code = "CONFLICT",
): never => {
  throw new ApplicationError(code, message, statusCode);
};

const actorCapabilities = (
  actor: TrustedActorContext,
): readonly string[] =>
  actor.authorizationCapabilities ?? [actor.authorizationCapability];

export class AuthorizedResponsibilityDeterminationService extends ResponsibilityDeterminationService {
  private readonly authorizationIdempotency = new IdempotencyService();
  private readonly authorizationEvents = new OperationEventRepository();

  constructor(private readonly database: Pool) {
    super(database);
  }

  async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Queryable = this.database,
  ): Promise<ResponsibilityDeterminationResponse> {
    const order = await this.order(executor, orderId, false);
    const permissions = await this.permissions(executor, actor, order);
    if (!permissions.canView) {
      fail("当前用户无权查看责任判定", 403, "FORBIDDEN");
    }

    const response = await super.get(actor, orderId, executor);
    return {
      ...response,
      handlerUserId: permissions.handlerUserId,
      canDetermine: permissions.canDetermine,
      canTakeover: permissions.canTakeover,
      canConfirmHighMultiplier: permissions.canConfirmHighMultiplier,
    };
  }

  async finalize(
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
        const order = await this.order(client, orderId, true);
        this.ensureOrderVersion(order, input.expectedOrderVersion);
        if (order.status !== "pending_responsibility_determination") {
          fail("返工单不在待判责状态");
        }

        const permissions = await this.permissions(client, actor, order);
        if (!permissions.canDetermine || permissions.handlerUserId !== actor.actorId) {
          fail("只有当前有效处理人可以正式判定", 403, "FORBIDDEN");
        }

        const current = await this.leaf(client, orderId, true);
        if (
          !current ||
          current.stage !== "draft" ||
          current.determination_version !==
            input.expectedCurrentDeterminationVersion
        ) {
          fail("判责版本冲突");
        }

        const confirmation = await client.query<{ confirmation_id: string }>(
          `SELECT confirmation_id
           FROM rework_responsibility_high_multiplier_confirmations
           WHERE determination_id=$1`,
          [current.determination_id],
        );
        const highMultiplier = await client.query(
          `SELECT 1
           FROM rework_responsibility_processes
           WHERE determination_id=$1 AND multiplier>2
           LIMIT 1`,
          [current.determination_id],
        );
        if (highMultiplier.rowCount && !confirmation.rows[0]) {
          fail("高倍率尚未完成独立确认");
        }

        const eventId = await this.event(
          client,
          actor,
          "rework.responsibility.finalize",
          "responsibility:determine",
          order,
          "pending_responsibility_action",
        );
        const finalizedId = randomUUID();

        await client.query(
          `INSERT INTO rework_responsibility_determinations(
             determination_id,rework_order_id,determination_version,
             replaces_determination_id,source_order_review_id,stage,
             handler_user_id,created_by,reason,
             source_high_multiplier_confirmation_id,input_snapshot,
             calculation_total,operation_event_id,request_id
           )
           SELECT $1,rework_order_id,determination_version+1,determination_id,
                  source_order_review_id,'finalized',$2,$3,reason,$4,
                  input_snapshot,calculation_total,$5,$6
           FROM rework_responsibility_determinations
           WHERE determination_id=$7`,
          [
            finalizedId,
            permissions.handlerUserId,
            actor.actorId,
            confirmation.rows[0]?.confirmation_id ?? null,
            eventId,
            actor.requestId,
            current.determination_id,
          ],
        );
        await client.query(
          `INSERT INTO rework_responsibility_processes
           SELECT $1,configuration_item_id,process_name_snapshot,
                  pricing_unit_snapshot,multiplier,high_multiplier_reason,
                  base_amount,responsibility_amount,$2,$3
           FROM rework_responsibility_processes
           WHERE determination_id=$4`,
          [finalizedId, eventId, actor.requestId, current.determination_id],
        );
        await client.query(
          `INSERT INTO rework_responsibility_allocations
           SELECT $1,configuration_item_id,responsibility_type,share_bps,
                  rounded_amount,$2,$3
           FROM rework_responsibility_allocations
           WHERE determination_id=$4`,
          [finalizedId, eventId, actor.requestId, current.determination_id],
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
          [finalizedId, eventId, actor.requestId, current.determination_id],
        );
        await this.advanceOrder(
          client,
          orderId,
          actor.actorId,
          "pending_responsibility_action",
        );
        return this.get(actor, orderId, client);
      },
    );
  }

  async transfer(
    actor: TrustedActorContext,
    orderId: string,
    input: TransferResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(
      actor,
      "rework.responsibility.transfer",
      key,
      { orderId, input },
      200,
      async (client) => {
        const order = await this.order(client, orderId, true);
        this.ensureOrderVersion(order, input.expectedOrderVersion);
        if (order.status !== "pending_responsibility_determination") {
          fail("只有待判责返工单可以转交");
        }

        const permissions = await this.permissions(client, actor, order);
        if (!permissions.canDetermine || permissions.handlerUserId !== actor.actorId) {
          fail("只有当前有效处理人可以转交", 403, "FORBIDDEN");
        }
        if (input.toUserId === actor.actorId) {
          fail("不能转交给当前处理人", 400, "VALIDATION_ERROR");
        }

        const current = await this.leaf(client, orderId, true);
        if (
          (current?.determination_version ?? null) !==
          input.expectedCurrentDeterminationVersion
        ) {
          fail("判责版本冲突");
        }

        if (!(await this.canDetermine(client, input.toUserId, orderId))) {
          fail(
            "目标处理人必须在当前组织内、在职、启用并具备判责能力",
            400,
            "VALIDATION_ERROR",
          );
        }

        const eventId = await this.event(
          client,
          actor,
          "rework.responsibility.transfer",
          "responsibility:determine",
          order,
          order.status,
          input.reason,
        );
        await client.query(
          `INSERT INTO rework_responsibility_handler_events(
             handler_event_id,rework_order_id,determination_id,event_type,
             from_user_id,to_user_id,acted_by,reason,created_at,
             operation_event_id,request_id
           ) VALUES($1,$2,$3,'transferred',$4,$5,$6,$7,DEFAULT,$8,$9)`,
          [
            randomUUID(),
            orderId,
            current?.determination_id ?? null,
            permissions.handlerUserId,
            input.toUserId,
            actor.actorId,
            input.reason,
            eventId,
            actor.requestId,
          ],
        );
        await this.advanceOrder(client, orderId, actor.actorId, order.status);
        return this.get(actor, orderId, client);
      },
    );
  }

  async takeover(
    actor: TrustedActorContext,
    orderId: string,
    input: TakeoverResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(
      actor,
      "rework.responsibility.takeover",
      key,
      { orderId, input },
      200,
      async (client) => {
        const order = await this.order(client, orderId, true);
        this.ensureOrderVersion(order, input.expectedOrderVersion);
        if (order.status !== "pending_responsibility_determination") {
          fail("只有待判责返工单可以接管");
        }

        const permissions = await this.permissions(client, actor, order);
        if (!permissions.directTakeover) {
          fail("只有直接有效的老板权限组可以接管", 403, "FORBIDDEN");
        }
        if (permissions.handlerUserId === actor.actorId) {
          fail("当前用户已经是处理人", 400, "VALIDATION_ERROR");
        }

        const current = await this.leaf(client, orderId, true);
        if (
          (current?.determination_version ?? null) !==
          input.expectedCurrentDeterminationVersion
        ) {
          fail("判责版本冲突");
        }

        const eventId = await this.event(
          client,
          actor,
          "rework.responsibility.takeover",
          "responsibility:takeover",
          order,
          order.status,
          input.reason,
        );
        await client.query(
          `INSERT INTO rework_responsibility_handler_events(
             handler_event_id,rework_order_id,determination_id,event_type,
             from_user_id,to_user_id,acted_by,reason,created_at,
             operation_event_id,request_id
           ) VALUES($1,$2,$3,'taken_over',$4,$5,$5,$6,DEFAULT,$7,$8)`,
          [
            randomUUID(),
            orderId,
            current?.determination_id ?? null,
            permissions.handlerUserId,
            actor.actorId,
            input.reason,
            eventId,
            actor.requestId,
          ],
        );
        await this.advanceOrder(client, orderId, actor.actorId, order.status);
        return this.get(actor, orderId, client);
      },
    );
  }

  async confirmHighMultiplier(
    actor: TrustedActorContext,
    determinationId: string,
    input: ConfirmHighMultiplier,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(
      actor,
      "rework.responsibility.high_multiplier.confirm",
      key,
      { determinationId, input },
      200,
      async (client) => {
        const currentResult = await client.query<LeafRow & { rework_order_id: string }>(
          `SELECT determination_id,determination_version,stage,
                  handler_user_id,created_by,reason,source_order_review_id,
                  input_snapshot,calculation_total::text,rework_order_id
           FROM rework_responsibility_determinations
           WHERE determination_id=$1
           FOR SHARE`,
          [determinationId],
        );
        const current =
          currentResult.rows[0] ??
          fail("判责版本不存在", 404, "NOT_FOUND");
        const order = await this.order(
          client,
          current.rework_order_id,
          true,
        );
        this.ensureOrderVersion(order, input.expectedOrderVersion);
        if (order.status !== "pending_responsibility_determination") {
          fail("返工单不在待判责状态");
        }
        if (
          current.stage !== "draft" ||
          current.determination_version !==
            input.expectedCurrentDeterminationVersion
        ) {
          fail("判责版本冲突");
        }

        const permissions = await this.permissions(client, actor, order);
        if (!permissions.directConfirm) {
          fail("只有直接有效的老板权限组可以确认高倍率", 403, "FORBIDDEN");
        }
        if (current.created_by === actor.actorId) {
          fail("提交人与确认人必须是不同老板", 403, "FORBIDDEN");
        }

        const highRows = await client.query<HighMultiplierRow>(
          `SELECT configuration_item_id,multiplier::text,
                  high_multiplier_reason
           FROM rework_responsibility_processes
           WHERE determination_id=$1 AND multiplier>2
           ORDER BY configuration_item_id`,
          [determinationId],
        );
        if (highRows.rows.length === 0) {
          fail("该版本不存在高倍率");
        }
        const alreadyConfirmed = await client.query(
          `SELECT 1
           FROM rework_responsibility_high_multiplier_confirmations
           WHERE determination_id=$1`,
          [determinationId],
        );
        if (alreadyConfirmed.rowCount) {
          fail("该版本已经完成高倍率确认");
        }

        const snapshot = {
          determinationId,
          determinationVersion: current.determination_version,
          submittedBy: current.created_by,
          handlerUserId: permissions.handlerUserId,
          processes: highRows.rows.map((row) => ({
            configurationItemId: row.configuration_item_id,
            multiplier: row.multiplier,
            highMultiplierReason: row.high_multiplier_reason,
          })),
        };
        const eventId = await this.event(
          client,
          actor,
          "rework.responsibility.high_multiplier.confirm",
          "responsibility:confirm_high_multiplier",
          order,
          order.status,
          input.reason,
        );
        await client.query(
          `INSERT INTO rework_responsibility_high_multiplier_confirmations(
             confirmation_id,determination_id,confirmed_by,confirmed_at,
             reason,confirmation_snapshot,operation_event_id,request_id
           ) VALUES($1,$2,$3,DEFAULT,$4,$5,$6,$7)`,
          [
            randomUUID(),
            determinationId,
            actor.actorId,
            input.reason,
            snapshot,
            eventId,
            actor.requestId,
          ],
        );
        await this.advanceOrder(
          client,
          order.rework_order_id,
          actor.actorId,
          order.status,
        );
        return this.get(actor, order.rework_order_id, client);
      },
    );
  }

  private async permissions(
    client: Queryable,
    actor: TrustedActorContext,
    order: OrderRow,
  ): Promise<{
    canView: boolean;
    canDetermine: boolean;
    canTakeover: boolean;
    canConfirmHighMultiplier: boolean;
    directTakeover: boolean;
    directConfirm: boolean;
    handlerUserId: string | null;
  }> {
    const result = await client.query<PermissionRow>(
      `SELECT
         responsibility_can_determine($1,$2) AS determine_eligible,
         responsibility_actor_has_direct_role(
           $1,'responsibility:takeover',ARRAY['owner_group']
         ) AS direct_takeover,
         responsibility_actor_has_direct_role(
           $1,'responsibility:confirm_high_multiplier',ARRAY['owner_group']
         ) AS direct_confirm,
         responsibility_effective_handler($2) AS handler_user_id,
         (
           SELECT leaf.created_by
           FROM rework_responsibility_determinations leaf
           WHERE leaf.rework_order_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM rework_responsibility_determinations successor
               WHERE successor.replaces_determination_id=leaf.determination_id
             )
           LIMIT 1
         ) AS leaf_created_by,
         (
           SELECT leaf.stage
           FROM rework_responsibility_determinations leaf
           WHERE leaf.rework_order_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM rework_responsibility_determinations successor
               WHERE successor.replaces_determination_id=leaf.determination_id
             )
           LIMIT 1
         ) AS leaf_stage,
         EXISTS(
           SELECT 1
           FROM rework_responsibility_processes process
           JOIN rework_responsibility_determinations leaf
             ON leaf.determination_id=process.determination_id
           WHERE leaf.rework_order_id=$2
             AND leaf.stage='draft'
             AND process.multiplier>2
             AND NOT EXISTS (
               SELECT 1 FROM rework_responsibility_determinations successor
               WHERE successor.replaces_determination_id=leaf.determination_id
             )
         ) AS has_high_multiplier,
         EXISTS(
           SELECT 1
           FROM rework_responsibility_high_multiplier_confirmations confirmation
           JOIN rework_responsibility_determinations leaf
             ON leaf.determination_id=confirmation.determination_id
           WHERE leaf.rework_order_id=$2
             AND NOT EXISTS (
               SELECT 1 FROM rework_responsibility_determinations successor
               WHERE successor.replaces_determination_id=leaf.determination_id
             )
         ) AS high_multiplier_confirmed`,
      [actor.actorId, order.rework_order_id],
    );
    const row = result.rows[0]!;
    const capabilities = actorCapabilities(actor);
    const pending = order.status === "pending_responsibility_determination";
    const canView =
      (row.determine_eligible &&
        capabilities.includes("responsibility:determine")) ||
      (row.direct_takeover &&
        capabilities.includes("responsibility:takeover")) ||
      (row.direct_confirm &&
        capabilities.includes("responsibility:confirm_high_multiplier"));
    const canDetermine =
      pending &&
      row.determine_eligible &&
      capabilities.includes("responsibility:determine") &&
      (row.handler_user_id === null ||
        row.handler_user_id === actor.actorId);
    const canTakeover =
      pending &&
      row.direct_takeover &&
      capabilities.includes("responsibility:takeover") &&
      row.handler_user_id !== actor.actorId;
    const canConfirmHighMultiplier =
      pending &&
      row.direct_confirm &&
      capabilities.includes("responsibility:confirm_high_multiplier") &&
      row.leaf_stage === "draft" &&
      row.has_high_multiplier &&
      !row.high_multiplier_confirmed &&
      row.leaf_created_by !== actor.actorId;

    return {
      canView,
      canDetermine,
      canTakeover,
      canConfirmHighMultiplier,
      directTakeover:
        row.direct_takeover &&
        capabilities.includes("responsibility:takeover"),
      directConfirm:
        row.direct_confirm &&
        capabilities.includes("responsibility:confirm_high_multiplier"),
      handlerUserId: row.handler_user_id,
    };
  }

  private async canDetermine(
    client: Queryable,
    actorId: string,
    orderId: string,
  ): Promise<boolean> {
    const result = await client.query<{ permitted: boolean }>(
      "SELECT responsibility_can_determine($1,$2) AS permitted",
      [actorId, orderId],
    );
    return result.rows[0]?.permitted === true;
  }

  private async leaf(
    client: Queryable,
    orderId: string,
    locked: boolean,
  ): Promise<LeafRow | null> {
    const result = await client.query<LeafRow>(
      `SELECT determination_id,determination_version,stage,
              handler_user_id,created_by,reason,source_order_review_id,
              input_snapshot,calculation_total::text
       FROM rework_responsibility_determinations leaf
       WHERE leaf.rework_order_id=$1
         AND NOT EXISTS (
           SELECT 1
           FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=leaf.determination_id
         )
       ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  private async order(
    client: Queryable,
    orderId: string,
    locked: boolean,
  ): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,
              merchandiser_user_id,processing_factory_type,
              processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,
              problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1
       ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private ensureOrderVersion(order: OrderRow, expectedVersion: number): void {
    if (order.version !== expectedVersion) {
      fail("返工单版本冲突");
    }
  }

  private orderAudit(
    order: OrderRow,
    status = order.status,
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

  private async event(
    client: PoolClient,
    actor: TrustedActorContext,
    action: string,
    capability: string,
    order: OrderRow,
    status: string,
    reason?: string,
  ): Promise<string> {
    const eventId = await this.authorizationEvents.append(
      client,
      { ...actor, authorizationCapability: capability },
      {
        action,
        entityType: "rework_order",
        entityId: order.rework_order_id,
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

  private async advanceOrder(
    client: PoolClient,
    orderId: string,
    actorId: string,
    status: string,
  ): Promise<void> {
    await client.query(
      `UPDATE rework_orders
       SET status=$3,version=version+1,updated_by=$2,
           updated_at=CURRENT_TIMESTAMP
       WHERE rework_order_id=$1`,
      [orderId, actorId, status],
    );
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
      const result = await this.authorizationIdempotency.execute(
        client,
        {
          scope,
          actorKey: actor.actorId,
          key,
          requestHash: createHash("sha256")
            .update(JSON.stringify(payload))
            .digest("hex"),
          expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        },
        async () => ({
          statusCode,
          response: await work(client),
        }),
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
