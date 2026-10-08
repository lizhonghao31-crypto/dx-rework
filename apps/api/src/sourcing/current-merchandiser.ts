import type { Pool, PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";
import { ApplicationError } from "../platform/errors.js";
type Database=Pick<Pool|PoolClient,"query">;

/** Current digital handling rights are separate from immutable native creation history. */
export async function effectiveSourcingMerchandiser(db:Database,caseId:string,creator:string,generation?:string|null):Promise<string|null>{
  if(generation===undefined)generation=(await db.query("SELECT to_jsonb(s)->>'workflow_generation' AS generation FROM sourcing_cases s WHERE sourcing_case_id=$1",[caseId])).rows[0]?.generation;
  if(generation!=="digital_production_v1")return creator;
  const row=(await db.query(`SELECT o.primary_merchandiser_id FROM digital_production_child_links l
    JOIN digital_production_orders o USING(production_order_id)
    WHERE l.module='sourcing' AND l.child_id=$1`,[caseId])).rows[0];
  // A missing canonical link never restores the historical creator's current privileges.
  return row?.primary_merchandiser_id??null;
}

export async function lockDigitalSourcingHandover(client:PoolClient,caseId:string,actor:TrustedActorContext,capability=actor.authorizationCapability):Promise<void>{
  const row=(await client.query("SELECT to_jsonb(s)->>'workflow_generation' AS generation FROM sourcing_cases s WHERE sourcing_case_id=$1",[caseId])).rows[0];
  if(row?.generation!=="digital_production_v1")return;
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
  if(actor.actorRoles.includes("root_superuser"))return;
  const allowed=(await client.query("SELECT digital_sourcing_actor_can_write($1,$2,$3) AS allowed",[actor.actorId,actor.actorRoles,capability])).rows[0]?.allowed;
  if(allowed!==true)throw new ApplicationError("FORBIDDEN","当前岗位或外发办理权限已变化，请重新核验",403);
}
