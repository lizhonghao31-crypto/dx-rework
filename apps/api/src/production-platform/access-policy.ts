import {wholeOrderActiveSql} from './whole-order-visibility.js';
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import type { Pool, PoolClient } from "pg";
import type { DigitalResourceKind, DigitalAccessPurpose } from "@dx-rework/contracts/digital-production-access";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";

type Database = Pick<Pool | PoolClient, "query">;
export const isDigitalLeader = (actor: TrustedActorContext) => isRootActor(actor) || actor.actorRoles.some(role => ["owner_group", "production_management"].includes(role));
// Read range only, from the authenticated server role snapshot. Never use this
// predicate for assignment, execution, correction or other management commands.
export const isDigitalManagementReader = (actor: TrustedActorContext) => isDigitalLeader(actor) || actor.actorRoles.includes("pmc");
export const isDigitalTechnicalManager = (actor: TrustedActorContext) => actor.actorRoles.includes("pattern_room_supervisor");
export const digitalForbidden = (): never => { throw new ApplicationError("FORBIDDEN", "无权访问该数字生产资料或执行此操作", 403); };
export const digitalNotFound = (): never => { throw new ApplicationError("NOT_FOUND", "资料不存在或不在授权范围", 404); };
export class DigitalProductionAccessPolicy {
  constructor(private readonly database: Database) {}
  // Hold current eligibility while a personnel write commits; deactivation/revocation must serialize.
  async lockActiveRole(userId: string, role: string): Promise<boolean> {
    const context=acceptanceBusinessContext();if(context&&!await context.acceptsActor(userId))return false;
    const found=await this.database.query(`SELECT 1 FROM app_users u
      JOIN user_role_assignments a ON a.user_id=u.id AND (a.role_code=$2 OR ($2='warehouse_receiver' AND a.role_code='warehouse_supervisor')) AND a.revoked_at IS NULL
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      JOIN identity_mappings i ON i.user_id=u.id AND i.active AND i.employed
      WHERE u.id=$1 AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
      FOR SHARE OF u,a,r,i`,[userId,role]);
    return Boolean(found.rowCount);
  }
  async activeRole(userId: string, role: string): Promise<boolean> {
    const context=acceptanceBusinessContext();if(context&&!await context.acceptsActor(userId))return false;
    const found = await this.database.query(`SELECT 1 FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.id=$1 AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND (a.role_code=$2 OR ($2='warehouse_receiver' AND a.role_code='warehouse_supervisor')) AND a.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`, [userId,role]);
    return Boolean(found.rowCount);
  }
  async allowed(actor: TrustedActorContext, kind: DigitalResourceKind, id: string, purpose: DigitalAccessPurpose): Promise<boolean> {
    if (kind === "task") {
      const task = (await this.database.query(`SELECT * FROM digital_production_task_access WHERE task_id=$1 AND ${await wholeOrderActiveSql(this.database,'task','task_id')}`, [id])).rows[0];
      if (!task) return false;
      if (isRootActor(actor)) return true;
      if (purpose === "budget") return false;
      if (purpose === "execute") return await this.activeRole(actor.actorId, task.required_role)
        && task.assignee_id === actor.actorId;
      return isDigitalManagementReader(actor) || isDigitalTechnicalManager(actor) || (actor.actorRoles.includes("development_clerk") && task.task_kind.startsWith("development_")) || (task.assignee_id === actor.actorId && await this.activeRole(actor.actorId, task.required_role))
        || await this.resourceAllowed(actor, task.production_order_id ? "order" : "source", task.production_order_id ?? task.source_id, "technical", false);
    }
    return this.resourceAllowed(actor, kind, id, purpose, true);
  }
  private async resourceAllowed(actor: TrustedActorContext, kind: Exclude<DigitalResourceKind, "task">, id: string, purpose: DigitalAccessPurpose, includeTaskParticipation: boolean): Promise<boolean> {
    if (purpose === "execute") return false;
    const table = kind === "order" ? "digital_production_orders" : "digital_production_sources";
    const column = kind === "order" ? "production_order_id" : "source_id";
    const row = (await this.database.query(`SELECT * FROM ${table} WHERE ${column}=$1 AND ${await wholeOrderActiveSql(this.database,kind,column)}`, [id])).rows[0];
    if (!row) return false;
    if (isDigitalManagementReader(actor)) return true;
    if (purpose === "technical" && isDigitalTechnicalManager(actor)) return true;
    if(kind==="source"&&purpose==="technical"&&actor.actorRoles.includes("order_merchandiser")&&await this.activeRole(actor.actorId,"order_merchandiser")){
      if((await this.database.query("SELECT 1 FROM digital_production_orders WHERE source_id=$1 AND primary_merchandiser_id=$2",[id,actor.actorId])).rowCount)return true;
    }
    // Early preparation participation grants only scoped technical documents, never budget or other task metadata.
    if(purpose==='technical'&&includeTaskParticipation&&(await this.database.query("SELECT to_regclass('digital_preparation_responsibilities') AS relation")).rows[0]?.relation){
      const sourceId=kind==='source'?id:row.source_id??null,orderId=kind==='order'?id:null;
      if(orderId&&(await this.database.query('SELECT 1 FROM digital_bulk_dispatch WHERE production_order_id=$1 AND warehouse_worker_id=$2',[orderId,actor.actorId])).rowCount&&await this.activeRole(actor.actorId,'warehouse_receiver'))return true;
      const assigned=(await this.database.query(`SELECT * FROM digital_preparation_responsibilities WHERE (resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2) ORDER BY (resource_kind='order') DESC,version DESC LIMIT 1`,[orderId,sourceId])).rows[0];
      if(assigned?.warehouse_worker_id===actor.actorId&&await this.activeRole(actor.actorId,'warehouse_receiver'))return true;
      if(assigned?.color_confirmation_worker_id===actor.actorId&&await this.activeRole(actor.actorId,assigned.color_confirmation_role))return true;
      if(kind==='source'&&actor.actorRoles.includes('order_merchandiser')&&await this.activeRole(actor.actorId,'order_merchandiser')){
        const handover=(await this.database.query("SELECT m.state,m.body,d.version AS document_version FROM digital_preparation_material_versions m LEFT JOIN digital_development_documents d ON d.source_id=m.resource_id WHERE m.resource_kind='source' AND m.resource_id=$1 AND m.kind='design_handover' AND m.scope_ref='whole' ORDER BY m.version DESC LIMIT 1",[id])).rows[0];
        if(handover?.state==='ready'&&handover.body.recipientId===actor.actorId&&handover.body.sourceDocumentVersion===handover.document_version)return true;
      }
    }
    if(kind==='order'&&purpose==='technical'&&includeTaskParticipation&&actor.actorRoles.includes('quality_control')&&await this.activeRole(actor.actorId,'quality_control')&&(await this.database.query("SELECT to_regclass('digital_qc_supervision_settings') AS relation")).rows[0]?.relation){
      const lead=(await this.database.query('SELECT quality_lead_id FROM digital_qc_supervision_settings WHERE production_order_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
      if(lead?.quality_lead_id===actor.actorId)return true;
    }
    const owns = actor.actorRoles.includes("sample_designer") && row.created_by === actor.actorId;
    const primary = kind === "order" && actor.actorRoles.includes("order_merchandiser") && row.primary_merchandiser_id === actor.actorId;
    if (owns || primary && await this.activeRole(actor.actorId,"order_merchandiser")) return true;
    if(kind==="order"&&purpose==="technical"){
      if(actor.actorRoles.includes("development_clerk")&&await this.activeRole(actor.actorId,"development_clerk")&&row.source_id)return true;
      // Necessary order documents do not grant metadata access to other tasks.
      if(!includeTaskParticipation)return false;
      const available=(await this.database.query("SELECT to_regclass('digital_bulk_preparations') AS relation")).rows[0]?.relation;
      const tasks=available?(await this.database.query("SELECT a.task_id,a.assignee_id,a.required_role FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) JOIN digital_bulk_preparations p ON p.preparation_id=t.route_instance_id AND p.production_order_id=a.production_order_id JOIN digital_instruction_documents effective ON effective.production_order_id=p.production_order_id AND effective.published_version=p.instruction_version WHERE a.production_order_id=$1 AND t.state<>'cancelled' AND p.source_round=COALESCE((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1) AND a.task_kind IN ('bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external','process_logistics','bulk_qc','factory_production_qc','warehouse_dispatch','bulk_ship_sample')",[id])).rows:[];
      for(const task of tasks){
        if(task.assignee_id===actor.actorId&&await this.activeRole(actor.actorId,task.required_role))return true;
      }
    }
    if (purpose === "budget" && !actor.actorRoles.some(role => ["sample_designer", "order_merchandiser"].includes(role))) return false;
    return false;
  }
  async assert(actor: TrustedActorContext, kind: DigitalResourceKind, id: string, purpose: DigitalAccessPurpose): Promise<void> {
    if (!await this.allowed(actor, kind, id, purpose)) digitalNotFound();
  }
}
