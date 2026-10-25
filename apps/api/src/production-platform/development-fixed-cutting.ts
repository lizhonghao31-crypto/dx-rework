import type {PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import {isRootActor} from "../access/business-authority.js";
import {ApplicationError} from "../platform/errors.js";
import {DigitalProductionAccessPolicy,digitalForbidden} from "./access-policy.js";
type DB=Pick<PoolClient,"query">;
export async function fixedDevelopmentCutter(db:DB){
  if(!(await db.query("SELECT to_regclass('digital_development_fixed_cutting') AS relation")).rows[0]?.relation)return null;
  const row=(await db.query("SELECT f.*,u.display_name FROM digital_development_fixed_cutting f JOIN app_users u ON u.id=f.worker_id ORDER BY f.version DESC LIMIT 1")).rows[0];
  return {version:row?.version??0,assigneeId:row?.worker_id??null,assigneeName:row?.display_name??null,
    valid:Boolean(row&&await new DigitalProductionAccessPolicy(db).activeRole(row.worker_id,"pattern_room_worker"))};
}
export async function canConfigureDevelopmentCutter(db:DB,actor:TrustedActorContext,lock=false){
  if(isRootActor(actor))return true;
  const policy=new DigitalProductionAccessPolicy(db);
  for(const role of ["pattern_room_supervisor","production_management","owner_group"])
    if(actor.actorRoles.includes(role)&&await (lock?policy.lockActiveRole(actor.actorId,role):policy.activeRole(actor.actorId,role)))return true;
  return false;
}
/** Existing execution command supplies source authorization, idempotency and the lifecycle transaction. */
export async function saveFixedDevelopmentCutter(db:PoolClient,actor:TrustedActorContext,input:{expectedVersion:number;assigneeId:string;reason:string}){
  if(!await canConfigureDevelopmentCutter(db,actor,true))digitalForbidden();
  await db.query("LOCK TABLE digital_development_fixed_cutting IN SHARE ROW EXCLUSIVE MODE");
  const current=await fixedDevelopmentCutter(db);
  if(!current||current.version!==input.expectedVersion)throw new ApplicationError("DEVELOPMENT_CONFLICT","固定裁板人员已更新，请重新读取后保存",409);
  const policy=new DigitalProductionAccessPolicy(db);
  if(!await policy.lockActiveRole(input.assigneeId,"pattern_room_worker"))throw new ApplicationError("DEVELOPMENT_CONFLICT","固定裁板人员须为在职有效的板房师傅",409);
  await db.query("INSERT INTO digital_development_fixed_cutting(version,worker_id,changed_by,reason) VALUES($1,$2,$3,$4)",[current.version+1,input.assigneeId,actor.actorId,input.reason]);
  const candidates=(await db.query(`SELECT a.task_id,a.assignee_id FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
    WHERE a.task_kind='development_cutting' AND t.state IN ('pending','ready','blocked')
    AND EXISTS(SELECT 1 FROM digital_development_sla_plans p WHERE p.source_id=a.source_id)
    ORDER BY a.task_id FOR UPDATE OF t,a`)).rows;
  const affected:string[]=[];
  for(const task of candidates)if(!task.assignee_id||!await policy.activeRole(task.assignee_id,"pattern_room_worker"))affected.push(task.task_id);
  // Keep active ongoing assignments. Only unassigned/invalid tasks join the newly configured fixed position.
  return {version:current.version+1,affected};
}
