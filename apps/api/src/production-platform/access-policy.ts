import type { Pool, PoolClient } from "pg";
import type { DigitalResourceKind, DigitalAccessPurpose } from "@dx-rework/contracts/digital-production-access";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { ApplicationError } from "../platform/errors.js";

type Database = Pick<Pool | PoolClient, "query">;
export const isDigitalLeader = (actor: TrustedActorContext) => isRootActor(actor) || actor.actorRoles.some(role => ["owner_group", "production_management"].includes(role));
export const isDigitalTechnicalManager = (actor: TrustedActorContext) => actor.actorRoles.includes("pattern_room_supervisor");
export const digitalForbidden = (): never => { throw new ApplicationError("FORBIDDEN", "无权访问该数字生产资料或执行此操作", 403); };
export const digitalNotFound = (): never => { throw new ApplicationError("NOT_FOUND", "资料不存在或不在授权范围", 404); };
export class DigitalProductionAccessPolicy {
  constructor(private readonly database: Database) {}
  async activeRole(userId: string, role: string): Promise<boolean> {
    const found = await this.database.query(`SELECT 1 FROM app_users u JOIN user_role_assignments a ON a.user_id=u.id
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.id=$1 AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false AND a.role_code=$2 AND a.revoked_at IS NULL
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`, [userId, role]);
    return Boolean(found.rowCount);
  }
  async delegated(actor: TrustedActorContext, kind: DigitalResourceKind, id: string, purpose: DigitalAccessPurpose): Promise<boolean> {
    const column = { order: "production_order_id", source: "source_id", task: "task_id" }[kind];
    const result = await this.database.query(`SELECT 1 FROM digital_production_delegations d JOIN app_users u ON u.id=d.delegate_id AND u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false
      WHERE d.${column}=$1 AND d.delegate_id=$2 AND d.purpose=$3 AND d.revoked_at IS NULL AND d.expires_at>CURRENT_TIMESTAMP
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`, [id, actor.actorId, purpose]);
    return Boolean(result.rowCount);
  }
  async allowed(actor: TrustedActorContext, kind: DigitalResourceKind, id: string, purpose: DigitalAccessPurpose): Promise<boolean> {
    if (kind === "task") {
      const task = (await this.database.query("SELECT * FROM digital_production_task_access WHERE task_id=$1", [id])).rows[0];
      if (!task) return false;
      if (isRootActor(actor)) return true;
      if (purpose === "budget") return false;
      if (purpose === "execute") return await this.activeRole(actor.actorId, task.required_role)
        && (task.assignee_id === actor.actorId || await this.delegated(actor, kind, id, "execute"));
      return isDigitalLeader(actor) || isDigitalTechnicalManager(actor) || (actor.actorRoles.includes("development_clerk") && task.task_kind.startsWith("development_")) || (task.assignee_id === actor.actorId && await this.activeRole(actor.actorId, task.required_role))
        || await this.delegated(actor, kind, id, "technical") || await this.delegated(actor, kind, id, "execute")
        || await this.allowed(actor, task.production_order_id ? "order" : "source", task.production_order_id ?? task.source_id, "technical");
    }
    if (purpose === "execute") return false;
    const table = kind === "order" ? "digital_production_orders" : "digital_production_sources";
    const column = kind === "order" ? "production_order_id" : "source_id";
    const row = (await this.database.query(`SELECT * FROM ${table} WHERE ${column}=$1`, [id])).rows[0];
    if (!row) return false;
    if (isDigitalLeader(actor)) return true;
    if (purpose === "technical" && isDigitalTechnicalManager(actor)) return true;
    const owns = actor.actorRoles.includes("sample_designer") && row.created_by === actor.actorId;
    const primary = kind === "order" && actor.actorRoles.includes("order_merchandiser") && row.primary_merchandiser_id === actor.actorId;
    if (owns || primary) return true;
    if (purpose === "budget" && !actor.actorRoles.some(role => ["sample_designer", "order_merchandiser"].includes(role))) return false;
    return this.delegated(actor, kind, id, purpose);
  }
  async assert(actor: TrustedActorContext, kind: DigitalResourceKind, id: string, purpose: DigitalAccessPurpose): Promise<void> {
    if (!await this.allowed(actor, kind, id, purpose)) digitalNotFound();
  }
}
