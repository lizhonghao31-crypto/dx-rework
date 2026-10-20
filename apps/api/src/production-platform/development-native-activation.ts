import {randomUUID} from "node:crypto";
import type {PoolClient} from "pg";
import type {TrustedActorContext} from "../tools/repositories.js";
import {OperationEventRepository} from "../tools/repositories.js";
import {DigitalProductionAccessPolicy} from "./access-policy.js";
import type {TodoService} from "../todos/service.js";

/**
 * Internal activation adapter, never an HTTP capability. A saved current-round
 * arrangement and all non-native prerequisites authorize only the initial,
 * frozen-price execution. Existing segments and rework amounts are untouched.
 */
export async function activateInitialDevelopmentExecution(db:PoolClient,actor:TrustedActorContext,taskId:string,todos:Pick<TodoService,"completeOpenByDedupeKey">){
  if(!(await db.query("SELECT to_regclass('digital_development_round_arrangements') AS relation")).rows[0]?.relation)return false;
  const task=(await db.query(`SELECT t.*,a.source_id,a.assignee_id FROM digital_production_tasks t
    JOIN digital_production_task_access a USING(task_id)
    WHERE t.task_id=$1 AND a.task_kind='development_sewing' AND (t.state='pending' OR t.state='blocked' AND t.blocked_reason='前置条件未满足')`,[taskId])).rows[0];
  if(!task?.assignee_id)return false;
  let plan=(await db.query(`SELECT * FROM digital_development_round_arrangements WHERE source_id=$1 AND round_number=$2
    AND entries->>'development_sewing'=$3`,[task.source_id,task.route_version,task.assignee_id])).rows[0];
  if(!plan&&task.route_version===1){plan=(await db.query("SELECT changed_by,version,NULL::uuid AS manager_id FROM digital_development_dispatch WHERE source_id=$1 AND sewing_worker_id=$2",[task.source_id,task.assignee_id])).rows[0];}
  if(!plan)return false;
  if((await db.query(`SELECT 1 FROM digital_production_task_conditions WHERE task_id=$1 AND stage='activation' AND NOT satisfied AND condition_key<>'pattern_assignment_ready'
    UNION ALL SELECT 1 FROM digital_production_task_dependencies d JOIN digital_production_tasks t ON t.task_id=d.predecessor_id WHERE d.task_id=$1 AND t.state<>'completed'
    UNION ALL SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind='source' AND resource_id=$2 AND state<>'active' LIMIT 1`,[taskId,task.source_id])).rowCount)return false;
  if(!await new DigitalProductionAccessPolicy(db).lockActiveRole(task.assignee_id,"pattern_room_worker"))return false;
  const native=(await db.query(`SELECT o.order_id,o.current_round_id,o.status,r.round_type,r.category_id,r.price_version,r.agreed_amount,r.quantity,r.unit_price
    FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
    WHERE l.source_id=$1 AND o.deleted_at IS NULL FOR UPDATE OF o,r`,[task.source_id])).rows[0];
  if(!native||native.status!=="pending_assignment"||native.round_type!=="initial"||!native.category_id||native.price_version==null||native.agreed_amount==null||native.quantity==null||native.unit_price==null)return false;
  if((await db.query("SELECT 1 FROM pattern_room_segments WHERE round_id=$1",[native.current_round_id])).rowCount)return false;
  const people=(await db.query(`SELECT person_id,display_name FROM business_people
    WHERE app_user_id=$1 AND active AND person_type='internal' FOR SHARE`,[task.assignee_id])).rows;
  if(people.length!==1)return false;
  const segmentId=randomUUID();
  await db.query(`INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount)
    VALUES($1,$2,1,$3,$4,$5,'internal',$6)`,[segmentId,native.current_round_id,people[0].person_id,task.assignee_id,people[0].display_name,native.agreed_amount]);
  await db.query(`UPDATE pattern_room_rounds SET status='in_progress',assigned_at=CURRENT_TIMESTAMP,assigned_by=$2,
    supervisor_user_id=$3 WHERE round_id=$1`,[native.current_round_id,plan.changed_by,plan.manager_id]);
  await db.query("UPDATE pattern_room_orders SET status='in_progress',version=version+1,updated_at=CURRENT_TIMESTAMP WHERE order_id=$1",[native.order_id]);
  await db.query("UPDATE pattern_room_node_times SET exited_at=CURRENT_TIMESTAMP,exit_reason='completed' WHERE round_id=$1 AND exited_at IS NULL",[native.current_round_id]);
  await db.query("INSERT INTO pattern_room_node_times(node_id,round_id,stage) VALUES($1,$2,'in_progress')",[randomUUID(),native.current_round_id]);
  await todos.completeOpenByDedupeKey(db,actor,`pattern-room:${native.order_id}:${native.current_round_id}:assignment`,"总委派人员及真实前置已齐备，首次车板已启动");
  await new OperationEventRepository().append(db,actor,{action:"development.initial_execution_activated",entityType:"pattern_room_order",entityId:native.order_id,
    after:{taskId,sourceId:task.source_id,roundNumber:task.route_version,nativeRoundId:native.current_round_id,segmentId,workerUserId:task.assignee_id,arrangedBy:plan.changed_by,planVersion:plan.version},
    reason:"本轮人员已安排且实际前置齐备，沿原执行价启动首次车板"});
  return true;
}
