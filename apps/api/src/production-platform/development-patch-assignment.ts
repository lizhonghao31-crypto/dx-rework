import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionTaskService} from './task-service.js';
export async function isCurrentDevelopmentPatch(db:PoolClient,orderId:string){
 if(!(await db.query("SELECT to_regclass('digital_development_patch_native_rounds') AS relation")).rows[0]?.relation)return null;
 return (await db.query(`SELECT p.task_id FROM pattern_room_orders o JOIN digital_development_patch_native_rounds n ON n.native_round_id=o.current_round_id
  JOIN digital_development_patch_tasks p USING(issue_id) WHERE o.order_id=$1 AND p.purpose='work' AND o.deleted_at IS NULL`,[orderId])).rows[0]??null;
}
/** The native command has validated its current segment and amount; this only mirrors the exact patch task. */
export async function syncDevelopmentPatchAssignment(db:PoolClient,database:Pool,actor:TrustedActorContext,orderId:string,workerId:string,action:'assign'|'transfer'){
 const patch=await isCurrentDevelopmentPatch(db,orderId);if(!patch)return false;
 await new DigitalProductionTaskService(database).syncNativeSewingWithClient(db,actor,patch.task_id,orderId,workerId,action);return true;
}
