import { hasMemberModulePolicy, memberCanWriteModule } from "../access/member-module-policy.js";
import { PoCustomerDateService } from "./po-customer-date-service.js";
import { randomUUID } from "node:crypto";
import { DigitalProductionTaskService } from "./task-service.js";
import { TodoService } from "../todos/service.js";
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
    const auditId=randomUUID();
    await client.query(`INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state)
      VALUES($1,$2,$3,$4,'digital_access',$5,$6,$7)`, [auditId, actor.requestId, actor.actorId, action, id, JSON.stringify(before), JSON.stringify(after)]);
    return auditId;
  }
  async options(actor:TrustedActorContext){
    const policy=new DigitalProductionAccessPolicy(this.database),root=isRootActor(actor);
    const director=root||actor.actorRoles.includes("production_management")&&await policy.activeRole(actor.actorId,"production_management");
    const manage=director||actor.actorRoles.includes("owner_group")&&await policy.activeRole(actor.actorId,"owner_group");
    return {manage,customers:director,approveDelivery:director,create:root||actor.actorRoles.includes("sample_designer"),actorId:actor.actorId,roles:actor.actorRoles};
  }
  private async personnelActor(client:PoolClient,actor:TrustedActorContext,allowOwner:boolean){
    if(isRootActor(actor))return;
    const policy=new DigitalProductionAccessPolicy(client);
    if(actor.actorRoles.includes("production_management")&&await policy.lockActiveRole(actor.actorId,"production_management"))return;
    if(allowOwner&&actor.actorRoles.includes("owner_group")&&await policy.lockActiveRole(actor.actorId,"owner_group"))return;
    digitalForbidden();
  }
  private async lockMemberPolicy(client:PoolClient){
    // The original binding command holds this same key exclusively before users.
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended('member-module-owner-bindings',0))");
  }
  private async eligibleMerchandiser(client:PoolClient,userId:string):Promise<boolean>{
    if(!await new DigitalProductionAccessPolicy(client).lockActiveRole(userId,"order_merchandiser"))return false;
    const required=["sourcing:view","sourcing:inquiry:create","sourcing:contract:record"];
    const capabilities=(await client.query("SELECT capability FROM role_capabilities WHERE role_code='order_merchandiser' AND capability=ANY($1::text[]) FOR SHARE",[required])).rows;
    if(!required.every(capability=>capabilities.some(row=>row.capability===capability))||!await memberCanWriteModule(client,userId,"sourcing"))return false;
    if(!await hasMemberModulePolicy(client))return true;
    await client.query("SELECT policy_key FROM access_security_policy WHERE policy_key='primary' FOR SHARE");
    return (await client.query("SELECT bool_and(todo_user_has_direct_role($1,'order_merchandiser',capability)) AS eligible FROM unnest($2::text[]) required(capability)",[userId,required])).rows[0]?.eligible===true;
  }
  async candidates(actor: TrustedActorContext) {
    if (!isDigitalLeader(actor) && !isDigitalTechnicalManager(actor) && !actor.actorRoles.includes("sample_designer") && !actor.actorRoles.includes("development_clerk")) digitalForbidden();
    const roles = isDigitalLeader(actor) || isDigitalTechnicalManager(actor) ? null : actor.actorRoles.includes("development_clerk") ? ["development_clerk", "pattern_room_worker", "pattern_room_tail_inspector"] : ["order_merchandiser", "pattern_room_worker"];
    const memberPolicy=await hasMemberModulePolicy(this.database) ? "AND member_module_can_write(u.id,'sourcing') AND todo_user_has_direct_role(u.id,'order_merchandiser','sourcing:contract:record')" : "";
    return (await this.database.query(`SELECT u.id,u.display_name AS "displayName",array_agg(DISTINCT a.role_code) AS roles
      FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND ($1::text[] IS NULL OR a.role_code=ANY($1))
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      AND (a.role_code<>'order_merchandiser' OR (NOT EXISTS(
        SELECT 1 FROM unnest(ARRAY['sourcing:view','sourcing:inquiry:create','sourcing:contract:record']) required(capability)
        WHERE NOT EXISTS(SELECT 1 FROM role_capabilities c WHERE c.role_code=a.role_code AND c.capability=required.capability)) ${memberPolicy}))
      GROUP BY u.id,u.display_name ORDER BY u.display_name,u.id`, [roles])).rows;
  }
  async setCustomerDefault(actor: TrustedActorContext, code: string, merchandiserId: string | null) {
    if (!isRootActor(actor) && !actor.actorRoles.includes("production_management")) digitalForbidden();
    return this.transaction(async client => {
      await this.lockMemberPolicy(client);
      await this.personnelActor(client,actor,false);
      if (merchandiserId && !await this.eligibleMerchandiser(client,merchandiserId)) conflict("主跟单必须为在职有效且可办理外发的订单跟单");
      const previous = (await client.query("SELECT default_merchandiser_id FROM digital_production_customers WHERE code=$1 FOR UPDATE", [code])).rows[0] ?? digitalNotFound();
      await client.query("UPDATE digital_production_customers SET default_merchandiser_id=$2 WHERE code=$1", [code, merchandiserId]);
      await this.audit(client, actor, "digital_customer_default_assigned", code, previous, { merchandiserId });
      return { customerCode: code, merchandiserId };
    });
  }
  async assignMerchandiser(actor: TrustedActorContext, id: string, merchandiserId: string, expectedVersion: number) {
    if (!isDigitalLeader(actor)) digitalForbidden();
    return this.transaction(async client => {
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      await this.lockMemberPolicy(client);
      await this.personnelActor(client,actor,true);
      if (!await this.eligibleMerchandiser(client,merchandiserId)) conflict("主跟单必须为在职有效且可办理外发的订单跟单");
      await client.query("SELECT role_code FROM role_capabilities WHERE role_code='order_merchandiser' FOR SHARE");
      const before = (await client.query("SELECT primary_merchandiser_id,version FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [id])).rows[0] ?? digitalNotFound();
      if (before.version !== expectedVersion) conflict("订单已更新，请刷新");
      await client.query(`SELECT s.sourcing_case_id FROM sourcing_cases s JOIN digital_production_child_links l ON l.child_id=s.sourcing_case_id
        WHERE l.module='sourcing' AND l.production_order_id=$1 ORDER BY s.sourcing_case_id FOR UPDATE OF s`,[id]);
      await client.query("UPDATE digital_production_orders SET primary_merchandiser_id=$2,version=version+1 WHERE production_order_id=$1", [id, merchandiserId]);
      await new DigitalProductionTaskService(this.database).syncSourcingAssignee(client, actor, id, merchandiserId);
      const auditId=await this.audit(client, actor, "digital_primary_merchandiser_assigned", id, before, { merchandiserId,version:expectedVersion+1 });
      await new TodoService(this.database).reassignDigitalSourcingWithClient(client,actor,id,before.primary_merchandiser_id,merchandiserId,auditId);
      return { version: expectedVersion + 1 };
    });
  }
  // Retired compatibility calls never read, grant or revoke historical digital delegations.
  async delegate(actor: TrustedActorContext, input: z.infer<typeof DigitalDelegationSchema>) { void actor; void input; return digitalForbidden(); }
  async delegations(actor: TrustedActorContext, kind: DigitalResourceKind, id: string) { void actor; void kind; void id; return digitalForbidden(); }
  async revoke(actor: TrustedActorContext, id: string) { void actor; void id; return digitalForbidden(); }
  async requestDelivery(actor: TrustedActorContext, id: string, input: { deliveryDate: string; expectedVersion: number; reason: string }) {
    await new DigitalProductionAccessPolicy(this.database).assert(actor,"order",id,"technical");
    void input;
    conflict("请从制单交期区域选择明确 PO 申请客户仓到货日变更");
  }
  async deliveryRequests(actor:TrustedActorContext,id:string){
    const dates=await new PoCustomerDateService(this.database).read(actor,id);
    return dates.dateRequests.map(row=>({...row,deliveryDate:row.date,decision:row.status==="待批准"?null:row.status==="已批准"?"approved":"rejected"}));
  }
  async decideDelivery(actor:TrustedActorContext,requestId:string,decision:"approved"|"rejected"){
    if(!isRootActor(actor)&&(!actor.actorRoles.includes("production_management")||!await new DigitalProductionAccessPolicy(this.database).activeRole(actor.actorId,"production_management")))digitalForbidden();
    let orderId:string|null=null;
    for(const table of ["digital_po_customer_requests","digital_instruction_date_requests","digital_production_delivery_requests"]){
      if(!(await this.database.query("SELECT to_regclass($1) AS relation",[table])).rows[0]?.relation)continue;
      orderId=(await this.database.query(`SELECT production_order_id FROM ${table} WHERE request_id=$1`,[requestId])).rows[0]?.production_order_id??null;
      if(orderId)break;
    }
    if(!orderId)digitalNotFound();
    await new PoCustomerDateService(this.database).decide(actor,orderId!,requestId,decision==="approved",`existing-date-decision:${requestId}:${decision}`);
    return {decision};
  }
}
