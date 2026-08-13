import { createHash, randomUUID } from "node:crypto";
import type {
  OwnerSignatureCommand,
  ResponsibilityDeterminationResponse,
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
import { AuthorizedResponsibilityDeterminationService } from "./responsibility-determination-authorized-service.js";
import { ExternalResponsibilityService } from "./external-responsibility-service.js";

type OrderRow = Readonly<{
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
}>;

type Result<T> = { value: T; reused: boolean };

const fail = (message: string, status = 409, code = "CONFLICT"): never => {
  throw new ApplicationError(code, message, status);
};

/**
 * N08 is intentionally a single owner decision.  It does not ask the owner to
 * re-confirm a merchandiser's supplier selection: N07 already owns that data
 * quality.  Approval freezes the responsibility facts and generates N09/N11
 * ledgers in the same transaction; rejection returns to N07 without a fake
 * mandatory reason field.
 */
export class ResponsibilityOwnerSignatureService {
  private readonly idempotency = new IdempotencyService();
  private readonly events = new OperationEventRepository();
  private readonly determinations: AuthorizedResponsibilityDeterminationService;
  private readonly external: ExternalResponsibilityService;

  constructor(
    private readonly database: Pool,
    private readonly todos?: TodoProjectionService,
  ) {
    this.determinations = new AuthorizedResponsibilityDeterminationService(
      database,
      todos,
    );
    this.external = new ExternalResponsibilityService(database, todos);
  }

  approve(
    actor: TrustedActorContext,
    orderId: string,
    input: OwnerSignatureCommand,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.owner_approve", key, { orderId, input }, async (client) => {
      const order = await this.order(client, orderId, true);
      this.requireOwner(actor);
      this.requirePending(order, input.expectedOrderVersion);
      const determination = await this.finalized(client, orderId);
      const eventId = await this.event(
        client,
        actor,
        "rework.responsibility.owner_approve",
        order,
        "completed",
      );
      await client.query(
        `INSERT INTO rework_responsibility_owner_signatures(
           owner_signature_id,rework_order_id,determination_id,decision,
           signed_by,operation_event_id,request_id)
         VALUES($1,$2,$3,'approved',$4,$5,$6)`,
        [randomUUID(), orderId, determination.determination_id, actor.actorId, eventId, actor.requestId],
      );
      // N09 is system work.  Supplier/amount cards are materialised before the
      // main order flips to completed, so a successful N08 approval is atomic.
      await this.external.ensureForFinalized(client, actor, order, determination.determination_id);
      await client.query(
        `UPDATE rework_orders
         SET status='completed',version=version+1,updated_by=$2,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1 AND status='pending_owner_signature'`,
        [orderId, actor.actorId],
      );
      await this.todos?.completeOpenByDedupePrefix(
        client,
        actor,
        `owner-signature:${orderId}:`,
        "Owner signature approved; settlement ledgers were generated",
      );
      return this.determinations.get(actor, orderId, client);
    });
  }

  reject(
    actor: TrustedActorContext,
    orderId: string,
    input: OwnerSignatureCommand,
    key: string,
  ): Promise<Result<ResponsibilityDeterminationResponse>> {
    return this.mutate(actor, "rework.responsibility.owner_reject", key, { orderId, input }, async (client) => {
      const order = await this.order(client, orderId, true);
      this.requireOwner(actor);
      this.requirePending(order, input.expectedOrderVersion);
      const determination = await this.finalized(client, orderId);
      const eventId = await this.event(
        client,
        actor,
        "rework.responsibility.owner_reject",
        order,
        "pending_responsibility_determination",
      );
      await client.query(
        `INSERT INTO rework_responsibility_owner_signatures(
           owner_signature_id,rework_order_id,determination_id,decision,
           signed_by,operation_event_id,request_id)
         VALUES($1,$2,$3,'rejected',$4,$5,$6)`,
        [randomUUID(), orderId, determination.determination_id, actor.actorId, eventId, actor.requestId],
      );
      await client.query(
        `UPDATE rework_orders
         SET status='pending_responsibility_determination',version=version+1,
             updated_by=$2,updated_at=CURRENT_TIMESTAMP
         WHERE rework_order_id=$1 AND status='pending_owner_signature'`,
        [orderId, actor.actorId],
      );
      await this.todos?.completeOpenByDedupePrefix(
        client,
        actor,
        `owner-signature:${orderId}:`,
        "Owner signature rejected; returned to responsibility determination",
      );
      await this.todos?.actionableForResponsibilityHandler(client, actor, {
        category: "responsibility_determination",
        sourceEventId: eventId,
        sourceAction: "rework.responsibility.owner_reject",
        entityType: "rework_order",
        entityId: orderId,
        recipientUserId: determination.handler_user_id,
        route: { routeName: "responsibility_detail", entityId: orderId },
        dedupeKey: `responsibility:${orderId}:owner-reject:${determination.determination_version}`,
      });
      return this.determinations.get(actor, orderId, client);
    });
  }

  private requireOwner(actor: TrustedActorContext): void {
    const granted = actor.authorizationCapabilities ?? [actor.authorizationCapability];
    if (!isRootActor(actor) && !granted.includes("responsibility:owner_sign")) {
      fail("只有老板权限组可以确认或驳回责任签字", 403, "FORBIDDEN");
    }
  }

  private requirePending(order: OrderRow, expectedVersion: number): void {
    if (order.version !== expectedVersion) fail("返工单版本冲突");
    if (order.status !== "pending_owner_signature") {
      fail("返工单不在待老板签字状态", 409, "INVALID_STATE_TRANSITION");
    }
  }

  private async finalized(client: PoolClient, orderId: string) {
    const result = await client.query<{
      determination_id: string;
      determination_version: number;
      handler_user_id: string;
    }>(
      `SELECT determination_id,determination_version,handler_user_id
       FROM rework_responsibility_determinations current
       WHERE current.rework_order_id=$1
         AND current.stage='finalized'
         AND current.settlement_schema_version=2
         AND NOT EXISTS(
           SELECT 1 FROM rework_responsibility_determinations successor
           WHERE successor.replaces_determination_id=current.determination_id
         )
       FOR UPDATE`,
      [orderId],
    );
    return result.rows[0] ?? fail("待签字的责任版本不存在", 409, "INVALID_STATE_TRANSITION");
  }

  private async order(client: PoolClient, orderId: string, locked: boolean): Promise<OrderRow> {
    const result = await client.query<OrderRow>(
      `SELECT rework_order_id,rework_no,status,version,style_no,order_no,merchandiser_user_id,
              processing_factory_type,processing_factory_supplier_id,
              processing_factory_supplier_version,problem_part,problem_description,rework_quantity
       FROM rework_orders
       WHERE rework_order_id=$1 AND status<>'deleted' ${locked ? "FOR UPDATE" : ""}`,
      [orderId],
    );
    return result.rows[0] ?? fail("返工单不存在", 404, "NOT_FOUND");
  }

  private audit(order: OrderRow, status: ResponsibilityDeterminationResponse["reworkStatus"], version: number) {
    return {
      reworkOrderId: order.rework_order_id,
      reworkNo: order.rework_no,
      status,
      styleNo: order.style_no,
      orderNo: order.order_no,
      merchandiserUserId: order.merchandiser_user_id,
      processingFactory: order.processing_factory_type === null ? null : order.processing_factory_type === "own_factory"
        ? { type: "own_factory" }
        : {
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
    action: "rework.responsibility.owner_approve" | "rework.responsibility.owner_reject",
    order: OrderRow,
    nextStatus: ResponsibilityDeterminationResponse["reworkStatus"],
  ): Promise<string> {
    const eventId = await this.events.append(
      client,
      { ...actor, authorizationCapability: "responsibility:owner_sign" },
      {
        action,
        entityType: "rework_order",
        entityId: order.rework_order_id,
        before: this.audit(order, order.status, order.version),
        after: this.audit(order, nextStatus, order.version + 1),
      },
    );
    await client.query(
      `SELECT set_config('dx_rework.responsibility_event_id',$1,true),
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
      }, async () => ({ statusCode: 200, response: await work(client) }));
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
