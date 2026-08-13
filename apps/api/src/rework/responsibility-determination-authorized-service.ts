import { createHash, randomUUID } from "node:crypto";
import type {
  ConfirmHighMultiplier,
  CreateResponsibilityDraft,
  FinalizeResponsibility,
  ResponsibilityDeterminationResponse,
  TakeoverResponsibility,
  TransferResponsibility,
} from "@dx-rework/contracts";
import type { Pool, PoolClient } from "pg";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import {
  IdempotencyService,
  OperationEventRepository,
  type TrustedActorContext,
} from "../tools/repositories.js";
import type { TodoProjectionService } from "../todos/projection-service.js";
import { ResponsibilityDeterminationService } from "./responsibility-determination-service.js";
import { OwnFactoryApprovalService } from "./own-factory-approval-service.js";
import { ExternalResponsibilityService, maybeCompleteResponsibilityAction } from "./external-responsibility-service.js";

type Result<T> = { value: T; reused: boolean };
type Queryable = Pool | PoolClient;
type OrderRow = {
  rework_order_id: string;
  rework_no: string | null;
  status: ResponsibilityDeterminationResponse["reworkStatus"];
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
type LeafRow = {
  determination_id: string;
  determination_version: number;
  stage: "draft" | "finalized";
  handler_user_id: string;
  created_by: string;
  settlement_schema_version: 1 | 2;
};
type PermissionRow = {
  determine_eligible: boolean;
  direct_takeover: boolean;
  direct_confirm: boolean;
  handler_user_id: string | null;
  leaf_created_by: string | null;
  leaf_stage: "draft" | "finalized" | null;
  has_high_multiplier: boolean;
  high_multiplier_confirmed: boolean;
  owner_sign: boolean;
};
type HighMultiplierRow = {
  configuration_item_id: string;
  multiplier: string;
  high_multiplier_reason: string | null;
};

const fail = (message: string, statusCode = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, statusCode);
};
const capabilities = (actor: TrustedActorContext): readonly string[] =>
  actor.authorizationCapabilities ?? [actor.authorizationCapability];

export class AuthorizedResponsibilityDeterminationService {
  private readonly base: ResponsibilityDeterminationService;
  private readonly ownFactoryApprovals: OwnFactoryApprovalService;
  private readonly externalResponsibilities: ExternalResponsibilityService;
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();

  constructor(
    private readonly database: Pool,
    private readonly todos?: TodoProjectionService,
  ) {
    this.base = new ResponsibilityDeterminationService(database);
    this.ownFactoryApprovals = new OwnFactoryApprovalService(database, todos);
    this.externalResponsibilities = new ExternalResponsibilityService(database, todos);
  }

  async get(
    actor: TrustedActorContext,
    orderId: string,
    executor: Queryable = this.database,
  ): Promise<ResponsibilityDeterminationResponse> {
    const order = await this.order(executor, orderId, false);
    const permission = await this.permissions(executor, actor, order);
    if (!permission.canView) fail("当前用户无权查看责任判定", 403, "FORBIDDEN");
    const response = await this.base.get(actor, orderId, executor);
    return {
      ...response,
      handlerUserId: permission.handlerUserId,
      canDetermine: permission.canDetermine,
      canTakeover: permission.canTakeover,
      canConfirmHighMultiplier: permission.canConfirmHighMultiplier,
      canOwnerSign: permission.canOwnerSign,
      ownerSignature: await this.ownerSignature(executor, orderId),
    };
  }

  async saveDraft(
    actor: TrustedActorContext,
    orderId: string,
    input: CreateResponsibilityDraft,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    const result = await this.base.saveDraft(actor, orderId, input, key);
    return { ...result, value: await this.get(actor, orderId) };
  }

  async finalize(
    actor: TrustedActorContext,
    orderId: string,
    input: FinalizeResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.finalize", key, { orderId, input }, 200, async (client) => {
      const order = await this.order(client, orderId, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_responsibility_determination") fail("返工单不在待判责状态");
      const permission = await this.permissions(client, actor, order);
      if (!permission.canDetermine || (!isRootActor(actor) && permission.handlerUserId !== actor.actorId)) {
        fail("只有当前有效处理人可以正式判定", 403, "FORBIDDEN");
      }
      const current = (await this.leaf(client, orderId, true)) ?? fail("判责版本冲突");
      if (current.stage !== "draft" || current.determination_version !== input.expectedCurrentDeterminationVersion) {
        fail("判责版本冲突");
      }
      const confirmation = await client.query<{ confirmation_id: string }>(
        "SELECT confirmation_id FROM rework_responsibility_high_multiplier_confirmations WHERE determination_id=$1",
        [current.determination_id],
      );
      const high = await client.query(
        "SELECT 1 FROM rework_responsibility_processes WHERE determination_id=$1 AND multiplier>2 LIMIT 1",
        [current.determination_id],
      );
      if (current.settlement_schema_version === 1 && high.rowCount && !confirmation.rows[0]) fail("高倍率尚未完成独立确认");
      if (current.settlement_schema_version === 2) {
        const incomplete = await client.query(
          `SELECT 1
           FROM rework_responsibility_allocations
           WHERE determination_id=$1
             AND (
               multiplier IS NULL
               OR multiplier<1
               OR (responsibility_type<>'own_factory' AND (
                 supplier_id IS NULL OR multiplier<1.2
               ))
             )
           LIMIT 1`,
          [current.determination_id],
        );
        if (incomplete.rowCount) {
          fail("提交老板签字前必须填写全部责任方、外部供应商及合规倍率", 400, "VALIDATION_ERROR");
        }
      }
      const nextStatus = current.settlement_schema_version === 2
        ? "pending_owner_signature" as const
        : "pending_responsibility_action" as const;
      const eventId = await this.event(
        client,
        actor,
        current.settlement_schema_version === 2
          ? "rework.responsibility.submit_owner_signature"
          : "rework.responsibility.finalize",
        "responsibility:determine",
        order,
        nextStatus,
      );
      const id = randomUUID();
      await client.query(
        `INSERT INTO rework_responsibility_determinations(
           determination_id,rework_order_id,determination_version,replaces_determination_id,
           source_order_review_id,stage,handler_user_id,created_by,reason,
           source_high_multiplier_confirmation_id,input_snapshot,calculation_total,
           operation_event_id,request_id,settlement_schema_version)
         SELECT $1,rework_order_id,determination_version+1,determination_id,
                source_order_review_id,'finalized',$2,$3,reason,$4,input_snapshot,
                calculation_total,$5,$6,settlement_schema_version
         FROM rework_responsibility_determinations WHERE determination_id=$7`,
        [id, permission.handlerUserId, actor.actorId, confirmation.rows[0]?.confirmation_id ?? null, eventId, actor.requestId, current.determination_id],
      );
      await client.query(
        `INSERT INTO rework_responsibility_processes
         SELECT $1,configuration_item_id,process_name_snapshot,pricing_unit_snapshot,
                multiplier,high_multiplier_reason,base_amount,responsibility_amount,$2,$3
         FROM rework_responsibility_processes WHERE determination_id=$4`,
        [id, eventId, actor.requestId, current.determination_id],
      );
      await client.query(
        `INSERT INTO rework_responsibility_allocations(
           determination_id,configuration_item_id,responsibility_type,share_bps,
           rounded_amount,operation_event_id,request_id,multiplier,supplier_id,
           supplier_version,supplier_code_snapshot,supplier_name_snapshot,
           supplier_type_snapshot)
         SELECT $1,configuration_item_id,responsibility_type,share_bps,rounded_amount,$2,$3,
                multiplier,supplier_id,supplier_version,supplier_code_snapshot,
                supplier_name_snapshot,supplier_type_snapshot
         FROM rework_responsibility_allocations WHERE determination_id=$4`,
        [id, eventId, actor.requestId, current.determination_id],
      );
      await client.query(
        `INSERT INTO rework_responsibility_amount_lines
         SELECT $1,configuration_item_id,work_report_id,person_id,responsibility_type,
                base_member_share_amount,multiplier,share_bps,unrounded_amount,rounded_amount,
                rounding_rule,worker_display_name_snapshot,task_mode_snapshot,member_snapshot,
                report_snapshot,$2,$3
         FROM rework_responsibility_amount_lines WHERE determination_id=$4`,
        [id, eventId, actor.requestId, current.determination_id],
      );
      const directOwnerFinalizer = (await client.query<{ permitted: boolean }>(
        `SELECT responsibility_actor_has_direct_role(
           $1,'own_factory:approve',ARRAY['owner_group']
         ) permitted`,
        [actor.actorId],
      )).rows[0]?.permitted === true;
      if (current.settlement_schema_version === 2) {
        await this.advance(client, orderId, actor.actorId, nextStatus);
        await this.todos?.completeOpenByDedupePrefix(
          client,
          actor,
          `responsibility:${orderId}:`,
          "Responsibility determination was submitted for owner signature",
        );
        await this.todos?.actionableForAllDirectRole(client, actor, {
          category: "owner_signature",
          sourceEventId: eventId,
          sourceAction: "rework.responsibility.submit_owner_signature",
          entityType: "rework_order",
          entityId: orderId,
          requiredRole: "owner_group",
          requiredCapability: "responsibility:owner_sign",
          route: { routeName: "responsibility_detail", entityId: orderId },
          policyKey: "general",
          dedupeKey: `owner-signature:${orderId}:${current.determination_version + 1}`,
        });
        return this.get(actor, orderId, client);
      }
      const ownFactoryApprovalId = await this.ownFactoryApprovals.ensureForFinalized(
        client,
        actor,
        order,
        id,
        !directOwnerFinalizer,
      );
      await this.externalResponsibilities.ensureForFinalized(client, actor, order, id);
      await this.advance(client, orderId, actor.actorId, "pending_responsibility_action");
      const actionOrder = {
        ...order,
        status: "pending_responsibility_action" as const,
        version: order.version + 1,
      };
      if (directOwnerFinalizer && ownFactoryApprovalId) {
        await this.ownFactoryApprovals.approveDuringFinalization(
          client,
          actor,
          ownFactoryApprovalId,
          actionOrder.version,
        );
      } else {
        await maybeCompleteResponsibilityAction(client, actor, actionOrder);
      }
      await this.todos?.completeOpenByDedupePrefix(
        client,
        actor,
        `responsibility:${orderId}:`,
        "Responsibility determination was finalized",
      );
      return this.get(actor, orderId, client);
    });
  }

  async transfer(
    actor: TrustedActorContext,
    orderId: string,
    input: TransferResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.transfer", key, { orderId, input }, 200, async (client) => {
      const order = await this.order(client, orderId, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_responsibility_determination") fail("只有待判责返工单可以转交");
      const permission = await this.permissions(client, actor, order);
      if (!permission.canDetermine || (!isRootActor(actor) && permission.handlerUserId !== actor.actorId)) {
        fail("只有当前有效处理人可以转交", 403, "FORBIDDEN");
      }
      if (input.toUserId === actor.actorId) fail("不能转交给当前处理人", 400, "VALIDATION_ERROR");
      const current = await this.leaf(client, orderId, true);
      if ((current?.determination_version ?? null) !== input.expectedCurrentDeterminationVersion) fail("判责版本冲突");
      if (!(await this.canDetermine(client, input.toUserId, orderId))) {
        fail("目标处理人必须在当前组织内、在职、启用并具备判责能力", 400, "VALIDATION_ERROR");
      }
      const eventId = await this.event(client, actor, "rework.responsibility.transfer", "responsibility:determine", order, order.status, input.reason);
      await client.query(
        `INSERT INTO rework_responsibility_handler_events(
           handler_event_id,rework_order_id,determination_id,event_type,from_user_id,
           to_user_id,acted_by,reason,created_at,operation_event_id,request_id)
         VALUES($1,$2,$3,'transferred',$4,$5,$6,$7,DEFAULT,$8,$9)`,
        [randomUUID(), orderId, current?.determination_id ?? null, permission.handlerUserId, input.toUserId, actor.actorId, input.reason, eventId, actor.requestId],
      );
      await this.todos?.cancelOpenByDedupePrefix(client, actor, `responsibility:${orderId}:`, "Responsibility handler transferred");
      await this.todos?.actionableForResponsibilityHandler(client, actor, {
        category: "responsibility_determination",
        sourceEventId: eventId,
        sourceAction: "rework.responsibility.transfer",
        entityType: "rework_order",
        entityId: orderId,
        recipientUserId: input.toUserId,
        route: { routeName: "responsibility_detail", entityId: orderId },
        dedupeKey: `responsibility:${orderId}:transfer:${eventId}`,
      });
      await this.advance(client, orderId, actor.actorId, order.status);
      return this.get(actor, orderId, client);
    });
  }

  async takeover(
    actor: TrustedActorContext,
    orderId: string,
    input: TakeoverResponsibility,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.takeover", key, { orderId, input }, 200, async (client) => {
      const order = await this.order(client, orderId, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_responsibility_determination") fail("只有待判责返工单可以接管");
      const permission = await this.permissions(client, actor, order);
      if (!permission.directTakeover) fail("只有直接有效的老板权限组可以接管", 403, "FORBIDDEN");
      if (permission.handlerUserId === actor.actorId) fail("当前用户已经是处理人", 400, "VALIDATION_ERROR");
      const current = await this.leaf(client, orderId, true);
      if ((current?.determination_version ?? null) !== input.expectedCurrentDeterminationVersion) fail("判责版本冲突");
      const eventId = await this.event(client, actor, "rework.responsibility.takeover", "responsibility:takeover", order, order.status, input.reason);
      await client.query(
        `INSERT INTO rework_responsibility_handler_events(
           handler_event_id,rework_order_id,determination_id,event_type,from_user_id,
           to_user_id,acted_by,reason,created_at,operation_event_id,request_id)
         VALUES($1,$2,$3,'taken_over',$4,$5,$5,$6,DEFAULT,$7,$8)`,
        [randomUUID(), orderId, current?.determination_id ?? null, permission.handlerUserId, actor.actorId, input.reason, eventId, actor.requestId],
      );
      await this.todos?.cancelOpenByDedupePrefix(client, actor, `responsibility:${orderId}:`, "Responsibility handler taken over");
      await this.todos?.actionableForResponsibilityHandler(client, actor, {
        category: "responsibility_determination",
        sourceEventId: eventId,
        sourceAction: "rework.responsibility.takeover",
        entityType: "rework_order",
        entityId: orderId,
        recipientUserId: actor.actorId,
        route: { routeName: "responsibility_detail", entityId: orderId },
        dedupeKey: `responsibility:${orderId}:takeover:${eventId}`,
      });
      await this.advance(client, orderId, actor.actorId, order.status);
      return this.get(actor, orderId, client);
    });
  }

  async confirmHighMultiplier(
    actor: TrustedActorContext,
    determinationId: string,
    input: ConfirmHighMultiplier,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.high_multiplier.confirm", key, { determinationId, input }, 200, async (client) => {
      const currentResult = await client.query<LeafRow & { rework_order_id: string }>(
        `SELECT determination_id,determination_version,stage,handler_user_id,created_by,rework_order_id
         FROM rework_responsibility_determinations WHERE determination_id=$1 FOR SHARE`,
        [determinationId],
      );
      const current = currentResult.rows[0] ?? fail("判责版本不存在", 404, "NOT_FOUND");
      const order = await this.order(client, current.rework_order_id, true);
      this.ensureVersion(order, input.expectedOrderVersion);
      if (order.status !== "pending_responsibility_determination") fail("返工单不在待判责状态");
      if (current.stage !== "draft" || current.determination_version !== input.expectedCurrentDeterminationVersion) fail("判责版本冲突");
      const permission = await this.permissions(client, actor, order);
      if (!permission.directConfirm) fail("只有直接有效的老板权限组或 Root 可以确认高倍率", 403, "FORBIDDEN");
      const rows = await client.query<HighMultiplierRow>(
        `SELECT configuration_item_id,multiplier::text,high_multiplier_reason
         FROM rework_responsibility_processes
         WHERE determination_id=$1 AND multiplier>2 ORDER BY configuration_item_id`,
        [determinationId],
      );
      if (!rows.rows.length) fail("该版本不存在高倍率");
      const existing = await client.query(
        "SELECT 1 FROM rework_responsibility_high_multiplier_confirmations WHERE determination_id=$1",
        [determinationId],
      );
      if (existing.rowCount) fail("该版本已经完成高倍率确认");
      const snapshot = {
        determinationId,
        determinationVersion: current.determination_version,
        submittedBy: current.created_by,
        handlerUserId: permission.handlerUserId,
        processes: rows.rows.map((row) => ({
          configurationItemId: row.configuration_item_id,
          multiplier: row.multiplier,
          highMultiplierReason: row.high_multiplier_reason,
        })),
      };
      const eventId = await this.event(client, actor, "rework.responsibility.high_multiplier.confirm", "responsibility:confirm_high_multiplier", order, order.status, input.reason);
      await client.query(
        `INSERT INTO rework_responsibility_high_multiplier_confirmations(
           confirmation_id,determination_id,confirmed_by,confirmed_at,reason,
           confirmation_snapshot,operation_event_id,request_id)
         VALUES($1,$2,$3,DEFAULT,$4,$5,$6,$7)`,
        [randomUUID(), determinationId, actor.actorId, input.reason, snapshot, eventId, actor.requestId],
      );
      await this.todos?.completeOpenByDedupePrefix(
        client,
        actor,
        `high-multiplier:${determinationId}:${current.determination_version}:`,
        "Owner high-multiplier confirmation completed",
      );
      await this.advance(client, order.rework_order_id, actor.actorId, order.status);
      return this.get(actor, order.rework_order_id, client);
    });
  }

  private async permissions(client: Queryable, actor: TrustedActorContext, order: OrderRow) {
    const result = await client.query<PermissionRow>(
      `SELECT responsibility_can_determine($1,$2) determine_eligible,
              responsibility_actor_has_direct_role($1,'responsibility:takeover',ARRAY['owner_group']) direct_takeover,
              responsibility_actor_has_direct_role($1,'responsibility:confirm_high_multiplier',ARRAY['owner_group']) direct_confirm,
              responsibility_actor_has_direct_role($1,'responsibility:owner_sign',ARRAY['owner_group']) owner_sign,
              responsibility_effective_handler($2) handler_user_id,
              (SELECT created_by FROM rework_responsibility_determinations leaf
               WHERE leaf.rework_order_id=$2 AND NOT EXISTS(
                 SELECT 1 FROM rework_responsibility_determinations successor
                 WHERE successor.replaces_determination_id=leaf.determination_id) LIMIT 1) leaf_created_by,
              (SELECT stage FROM rework_responsibility_determinations leaf
               WHERE leaf.rework_order_id=$2 AND NOT EXISTS(
                 SELECT 1 FROM rework_responsibility_determinations successor
                 WHERE successor.replaces_determination_id=leaf.determination_id) LIMIT 1) leaf_stage,
              EXISTS(SELECT 1 FROM rework_responsibility_processes process
                JOIN rework_responsibility_determinations leaf USING(determination_id)
                WHERE leaf.rework_order_id=$2 AND leaf.stage='draft' AND process.multiplier>2
                  AND NOT EXISTS(SELECT 1 FROM rework_responsibility_determinations successor
                    WHERE successor.replaces_determination_id=leaf.determination_id)) has_high_multiplier,
              EXISTS(SELECT 1 FROM rework_responsibility_high_multiplier_confirmations confirmation
                JOIN rework_responsibility_determinations leaf USING(determination_id)
                WHERE leaf.rework_order_id=$2 AND NOT EXISTS(
                  SELECT 1 FROM rework_responsibility_determinations successor
                  WHERE successor.replaces_determination_id=leaf.determination_id)) high_multiplier_confirmed`,
      [actor.actorId, order.rework_order_id],
    );
    const row = result.rows[0]!;
    const caps = capabilities(actor);
    const pending = order.status === "pending_responsibility_determination";
    const pendingOwnerSignature = order.status === "pending_owner_signature";
    const root = isRootActor(actor);
    const canView = root ||
      (row.determine_eligible && caps.includes("responsibility:determine")) ||
      (row.direct_takeover && caps.includes("responsibility:takeover")) ||
      (row.direct_confirm && caps.includes("responsibility:confirm_high_multiplier")) ||
      (row.owner_sign && caps.includes("responsibility:owner_sign"));
    return {
      canView,
      canDetermine: pending && (root || (
        row.determine_eligible && caps.includes("responsibility:determine") &&
        (row.handler_user_id === null || row.handler_user_id === actor.actorId)
      )),
      canTakeover: pending && row.handler_user_id !== actor.actorId &&
        (root || (row.direct_takeover && caps.includes("responsibility:takeover"))),
      canConfirmHighMultiplier: pending &&
        (root || (row.direct_confirm && caps.includes("responsibility:confirm_high_multiplier"))) &&
        row.leaf_stage === "draft" && row.has_high_multiplier && !row.high_multiplier_confirmed,
      directTakeover: root || (row.direct_takeover && caps.includes("responsibility:takeover")),
      directConfirm: root || (row.direct_confirm && caps.includes("responsibility:confirm_high_multiplier")),
      canOwnerSign: pendingOwnerSignature && (
        root || (row.owner_sign && caps.includes("responsibility:owner_sign"))
      ),
      handlerUserId: row.handler_user_id,
    };
  }

  private async ownerSignature(
    client: Queryable,
    orderId: string,
  ): Promise<ResponsibilityDeterminationResponse["ownerSignature"]> {
    const result = await client.query<{
      determination_id: string;
      decision: "approved" | "rejected";
      signed_by: string;
      signed_at: Date;
    }>(
      `SELECT determination_id,decision,signed_by,signed_at
       FROM rework_responsibility_owner_signatures
       WHERE rework_order_id=$1
       ORDER BY signed_at DESC,owner_signature_id DESC
       LIMIT 1`,
      [orderId],
    );
    const row = result.rows[0];
    return row ? {
      determinationId: row.determination_id,
      decision: row.decision,
      signedBy: row.signed_by,
      signedAt: row.signed_at.toISOString(),
    } : null;
  }

  private async canDetermine(client: Queryable, actorId: string, orderId: string): Promise<boolean> {
    const result = await client.query<{ permitted: boolean }>(
      "SELECT responsibility_can_determine($1,$2) permitted",
      [actorId, orderId],
    );
    return result.rows[0]?.permitted === true;
  }

  private async leaf(client: Queryable, orderId: string, locked: boolean): Promise<LeafRow | null> {
    const result = await client.query<LeafRow>(
      `SELECT determination_id,determination_version,stage,handler_user_id,created_by,settlement_schema_version
       FROM rework_responsibility_determinations leaf
       WHERE leaf.rework_order_id=$1 AND NOT EXISTS(
         SELECT 1 FROM rework_responsibility_determinations successor
         WHERE successor.replaces_determination_id=leaf.determination_id)
       ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? null;
  }

  private async order(client: Queryable, orderId: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,
              processing_factory_type,processing_factory_supplier_id,processing_factory_supplier_version,
              problem_part,problem_description,rework_quantity
       FROM rework_orders WHERE rework_order_id=$1 AND status<>'deleted' ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private ensureVersion(order: OrderRow, expected: number): void {
    if (order.version !== expected) fail("返工单版本冲突");
  }

  private audit(order: OrderRow, status = order.status, version = order.version) {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null :
        order.processing_factory_type === "own_factory" ? { type: "own_factory" } : {
          type: "supplier",
          supplierId: order.processing_factory_supplier_id,
          supplierVersion: order.processing_factory_supplier_version,
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
    status: ResponsibilityDeterminationResponse["reworkStatus"],
    reason?: string,
  ): Promise<string> {
    const eventId = await this.events.append(client, { ...actor, authorizationCapability: capability }, {
      action,
      entityType: "rework_order",
      entityId: order.rework_order_id,
      before: this.audit(order),
      after: this.audit(order, status, order.version + 1),
      ...(reason ? { reason } : {}),
    });
    await client.query(
      `SELECT set_config('dx_rework.responsibility_event_id',$1,true),
              set_config('dx_rework.responsibility_request_id',$2,true),
              set_config('dx_rework.rework_event_id',$1,true),
              set_config('dx_rework.rework_request_id',$2,true)`,
      [eventId, actor.requestId],
    );
    return eventId;
  }

  private async advance(
    client: PoolClient,
    orderId: string,
    actorId: string,
    status: ResponsibilityDeterminationResponse["reworkStatus"],
  ): Promise<void> {
    await client.query(
      `UPDATE rework_orders SET status=$3,version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
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
      const result = await this.idempotency.execute(client, {
        scope,
        actorKey: actor.actorId,
        key,
        requestHash: createHash("sha256").update(JSON.stringify(payload)).digest("hex"),
        expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      }, async () => ({ statusCode, response: await work(client) }));
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
