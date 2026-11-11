import type {PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy,digitalForbidden} from './access-policy.js';

type DB=Pick<PoolClient,'query'>;
export type LinkedDevelopmentOrder={order_id:string;current_round_id:string;version:number;status:string};

/** A legacy tail return may create unpriced follow-up work, never approve its pay. */
export async function authorizeDevelopmentReturn(db:DB,actor:TrustedActorContext,sourceId:string,taskId:string,round:number){
 await new DigitalProductionAccessPolicy(db).assert(actor,'task',taskId,'execute');
 const proof=await db.query(`SELECT 1 FROM digital_production_tasks t
  JOIN digital_production_task_access a USING(task_id)
  JOIN digital_development_route_facts f ON f.task_id=t.task_id AND f.source_id=a.source_id
  WHERE t.task_id=$1 AND a.source_id=$2 AND a.task_kind='development_tail_check'
   AND t.route_version=$3 AND t.state='completed' AND f.route_version=$3
   AND f.kind='尾查退回' AND f.actor_id=$4 AND f.payload->>'result'='退回'`,[taskId,sourceId,round,actor.actorId]);
 if(!proof.rowCount)digitalForbidden();
}

/** Original link and order identity; the caller keeps its lifecycle transaction. */
export async function linkedDevelopmentOrder(db:DB,sourceId:string,lock=false):Promise<LinkedDevelopmentOrder|null>{
 if(!(await db.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation)return null;
 return (await db.query(`SELECT o.order_id,o.current_round_id,o.version,o.status
  FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
  WHERE l.source_id=$1 AND o.deleted_at IS NULL${lock?' FOR UPDATE OF o':''}`,[sourceId])).rows[0]??null;
}

/** A development round never inherits whichever native round happens to be current. */
export async function developmentNativeRound(db:DB,sourceId:string,roundNumber:number):Promise<string|null>{
 if(!await linkedDevelopmentOrder(db,sourceId))return null;
 const creation=(await db.query(`SELECT r.round_id,e.after_state->'value'->>'developmentRound' AS development_round
  FROM digital_development_pattern_links l JOIN pattern_room_rounds r USING(order_id)
  LEFT JOIN operation_events e ON e.entity_type='pattern_room_order' AND e.entity_id=l.order_id::text
   AND e.action='pattern_room.order.submitted' AND e.after_state->>'roundId'=r.round_id::text
   AND e.after_state->'value'->>'developmentSourceId'=l.source_id::text
  WHERE l.source_id=$1 AND r.round_type='initial'`,[sourceId])).rows;
 let round=roundNumber;
 while(round>1){
  if(creation.length===1&&creation[0]!.development_round===String(round))return creation[0]!.round_id;
  const rows=(await db.query(`SELECT DISTINCT r.round_id FROM audit_events e
   JOIN digital_development_pattern_links l ON l.source_id=$1
   JOIN pattern_room_rounds r ON r.order_id=l.order_id AND r.round_id::text=e.after_state->>'nativeRoundId'
   WHERE e.entity_type='digital_development' AND e.entity_id=$1::text
    AND e.action='development_round_published' AND e.after_state->>'roundNumber'=$2::text`,[sourceId,round])).rows;
  if(rows.length)return rows.length===1?rows[0]!.round_id:null;
  const inherited=(await db.query(`SELECT t.route_version FROM digital_development_rounds d
   JOIN digital_production_tasks t ON t.task_id::text=d.inherited->'development_sewing'->>'taskId'
   JOIN digital_production_task_access a USING(task_id)
   WHERE d.source_id=$1 AND d.round_number=$2 AND a.source_id=$1
    AND a.task_kind='development_sewing' AND t.state='completed' AND t.route_version<$2`,[sourceId,round])).rows;
  if(inherited.length!==1)return null;
  round=inherited[0]!.route_version;
 }
 return creation.length===1&&(!creation[0]!.development_round||creation[0]!.development_round==='1')?creation[0]!.round_id:null;
}
