import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { z } from "zod";
import type { DigitalDelegationSchema, DigitalResourceKind } from "@dx-rework/contracts/digital-production-access";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";
import { DigitalProductionAccessPolicy, digitalForbidden, digitalNotFound, isDigitalLeader, isDigitalTechnicalManager } from "./access-policy.js";

const conflict = (message: string): never => { throw new ApplicationError("DIGITAL_PRODUCTION_CONFLICT", message, 409); };
export class DigitalProductionAccessService {
  constructor(private readonly database: Pool) {}
  private async transaction<T>(action: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.database.connect();
    try { await client.query("BEGIN"); const result = await action(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  }
  private async audit(client: PoolClient, actor: TrustedActorContext, action: string, id: string, before: unknown, after: unknown) {
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
      VALUES($1,$2,$3,$4,'digital_access',$5,$6,$7)`, [randomUUID(), actor.requestId, actor.actorId, action, id, JSON.stringify(before), JSON.stringify(after)]);
  }
  async candidates(actor: TrustedActorContext) {
    if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor) && !actor.actorRoles.includes("sample_designer") && !actor.actorRoles.includes("development_clerk")) digitalForbidden();
    const roles = isDigitalLeader(actor) || isDigitalTechnicalManager(actor) ? null : actor.actorRoles.includes("development_clerk") ? ["development_clerk", "pattern_room_worker", "pattern_room_tail_inspector"] : ["order_merchandiser"];
    return (await this.database.query(`SELECT u.id,u.display_name AS "displayName",array_agg(DISTINCT a.role_code) AS roles
      FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND ($1::text[] IS NULL OR a.role_code=ANY($1))
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      GROUP BY u.id,u.display_name ORDER BY u.display_name,u.id`, [roles])).rows;
  }
  async setCustomerDefault(actor: TrustedActorContext, code: string, merchandiserId: string | null) {
    if (!isRootActor(actor) && !actor.actorRoles.includes("production_management")) digitalForbidden();
    return this.transaction(async client => {
      if (merchandiserId && !await new DigitalProductionAccessPolicy(client).activeRole(merchandiserId, "order_merchandiser")) conflict("主跟单必须为在职有效订单跟单");
      const previous = (await client.query("SELECT default_merchandiser_id FROM digital_production_customers WHERE code=$1 FOR UPDATE", [code])).rows[0] ?? digitalNotFound();
      await client.query("UPDATE digital_production_customers SET default_merchandiser_id=$2 WHERE code=$1", [code, merchandiserId]);
      await this.audit(client, actor, "digital_customer_default_assigned", code, previous, { merchandiserId });
      return { customerCode: code, merchandiserId };
    });
  }
  async assignMerchandiser(actor: TrustedActorContext, id: string, merchandiserId: string, expectedVersion: number) {
    if (!isDigitalLeader(actor)) digitalForbidden();
    return this.transaction(async client => {
      if (!await new DigitalProductionAccessPolicy(client).activeRole(merchandiserId, "order_merchandiser")) conflict("主跟单必须为在职有效订单跟单");
      const before = (await client.query("SELECT primary_merchandiser_id,version FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [id])).rows[0] ?? digitalNotFound();
      if (before.version !== expectedVersion) conflict("订单已更新，请刷新");
      await client.query("UPDATE digital_production_orders SET primary_merchandiser_id=$2,version=version+1 WHERE production_order_id=$1", [id, merchandiserId]);
      await this.audit(client, actor, "digital_primary_merchandiser_assigned", id, before, { merchandiserId });
      return { version: expectedVersion + 1 };
    });
  }
  async delegate(actor: TrustedActorContext, input: z.infer<typeof DigitalDelegationSchema>) {
    if (!isDigitalLeader(actor) && (!isDigitalTechnicalManager(actor) || input.purpose === "budget")) digitalForbidden();
    if (new Date(input.expiresAt).getTime() <= Date.now()) conflict("代理期限必须在将来");
    return this.transaction(async client => {
      const policy = new DigitalProductionAccessPolicy(client);
      await policy.assert(actor, input.resourceKind, input.resourceId, "technical");
      if (input.purpose === "budget") {
        if (!await policy.activeRole(input.delegateId, "sample_designer") && !await policy.activeRole(input.delegateId, "order_merchandiser")) digitalForbidden();
      } else if (input.resourceKind === "task" && input.purpose === "execute") {
        const task = (await client.query("SELECT required_role FROM digital_production_task_access WHERE task_id=$1 FOR UPDATE", [input.resourceId])).rows[0] ?? digitalNotFound();
        if (!await policy.activeRole(input.delegateId, task.required_role)) digitalForbidden();
      } else {
        const active = await client.query(`SELECT 1 FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
          JOIN business_roles r ON r.role_code=a.role_code AND r.enabled WHERE u.id=$1 AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false
          AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`, [input.delegateId]);
        if (!active.rowCount) digitalForbidden();
      }
      const column = { order: "production_order_id", source: "source_id", task: "task_id" }[input.resourceKind];
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([actor.actorId, input])]);
      const existing = (await client.query(`SELECT delegation_id FROM digital_production_delegations WHERE ${column}=$1 AND delegate_id=$2 AND purpose=$3 AND granted_by=$4 AND expires_at=$5 AND revoked_at IS NULL`, [input.resourceId, input.delegateId, input.purpose, actor.actorId, input.expiresAt])).rows[0];
      if (existing) return { delegationId: existing.delegation_id as string };
      const id = randomUUID();
      await client.query(`INSERT INTO digital_production_delegations(delegation_id,${column},delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,$4,$5,$6)`, [id, input.resourceId, input.delegateId, input.purpose, actor.actorId, input.expiresAt]);
      await this.audit(client, actor, "digital_delegation_granted", id, null, input);
      return { delegationId: id };
    });
  }
  async delegations(actor: TrustedActorContext, kind: DigitalResourceKind, id: string) {
    if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor)) digitalForbidden();
    await new DigitalProductionAccessPolicy(this.database).assert(actor, kind, id, "technical");
    const column = { order: "production_order_id", source: "source_id", task: "task_id" }[kind];
    return (await this.database.query(`SELECT delegation_id AS "delegationId",delegate_id AS "delegateId",purpose,expires_at AS "expiresAt",revoked_at AS "revokedAt" FROM digital_production_delegations WHERE ${column}=$1 ORDER BY created_at DESC`, [id])).rows;
  }
  async revoke(actor: TrustedActorContext, id: string) {
    return this.transaction(async client => {
      const row = (await client.query("SELECT * FROM digital_production_delegations WHERE delegation_id=$1 FOR UPDATE", [id])).rows[0] ?? digitalNotFound();
      if (!isDigitalLeader(actor) && (!isDigitalTechnicalManager(actor) || row.purpose === "budget")) digitalForbidden();
      if (!row.revoked_at) {
        await client.query("UPDATE digital_production_delegations SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2 WHERE delegation_id=$1", [id, actor.actorId]);
        await this.audit(client, actor, "digital_delegation_revoked", id, row, { revoked: true });
      }
      return { revoked: true };
    });
  }
  async requestDelivery(actor: TrustedActorContext, id: string, input: { deliveryDate: string; expectedVersion: number; reason: string }) {
    return this.transaction(async client => {
      const order = (await client.query("SELECT * FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [id])).rows[0] ?? digitalNotFound();
      if (!isRootActor(actor) && (!actor.actorRoles.includes("order_merchandiser") || order.primary_merchandiser_id !== actor.actorId)) digitalForbidden();
      if (order.version !== input.expectedVersion) conflict("订单已更新，请刷新");
      const requestId = randomUUID();
      await client.query(`INSERT INTO digital_production_delivery_requests(request_id,production_order_id,expected_version,previous_date,requested_date,reason,requested_by)
        VALUES($1,$2,$3,$4,$5,$6,$7)`, [requestId, id, input.expectedVersion, order.contract_delivery_date, input.deliveryDate, input.reason, actor.actorId]);
      await this.audit(client, actor, "digital_delivery_requested", id, { deliveryDate: order.contract_delivery_date }, { requestId, ...input });
      return { requestId };
    });
  }
  async deliveryRequests(actor: TrustedActorContext, id: string) {
    await new DigitalProductionAccessPolicy(this.database).assert(actor, "order", id, "technical");
    return (await this.database.query(`SELECT r.request_id AS "requestId",r.requested_date::text AS "deliveryDate",r.reason,d.decision
      FROM digital_production_delivery_requests r LEFT JOIN digital_production_delivery_decisions d USING(request_id)
      WHERE r.production_order_id=$1 ORDER BY r.created_at DESC`, [id])).rows;
  }
  async decideDelivery(actor: TrustedActorContext, requestId: string, decision: "approved" | "rejected") {
    if (!isRootActor(actor) && !actor.actorRoles.includes("production_management")) digitalForbidden();
    return this.transaction(async client => {
      const request = (await client.query("SELECT * FROM digital_production_delivery_requests WHERE request_id=$1 FOR UPDATE", [requestId])).rows[0] ?? digitalNotFound();
      if (!isRootActor(actor) && request.requested_by === actor.actorId) digitalForbidden();
      const previous = (await client.query("SELECT decision FROM digital_production_delivery_decisions WHERE request_id=$1", [requestId])).rows[0];
      if (previous) { if (previous.decision !== decision) conflict("该申请已处理"); return { decision }; }
      const order = (await client.query("SELECT version FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [request.production_order_id])).rows[0]!;
      if (decision === "approved") {
        if (order.version !== request.expected_version) conflict("申请后订单已变更，请重新申请");
        await client.query("UPDATE digital_production_orders SET contract_delivery_date=$2,version=version+1 WHERE production_order_id=$1", [request.production_order_id, request.requested_date]);
      }
      await client.query("INSERT INTO digital_production_delivery_decisions(request_id,decision,decided_by) VALUES($1,$2,$3)", [requestId, decision, actor.actorId]);
      await this.audit(client, actor, "digital_delivery_decided", request.production_order_id, request, { decision });
      return { decision };
    });
  }
}
