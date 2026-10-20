import type {Pool,PoolClient} from 'pg';
/** Existing Root self-work exception, proven by the actual current native segment.
 * This never makes Root a general craft candidate or grants any ordinary role. */
export async function isNativeRootSewingRecipient(db:Pick<Pool|PoolClient,'query'>,sourceId:string,userId:string){
 return Boolean((await db.query(`SELECT 1 FROM digital_development_pattern_links l
  JOIN pattern_room_orders o USING(order_id) JOIN pattern_room_rounds r ON r.round_id=o.current_round_id
  JOIN pattern_room_segments s ON s.round_id=r.round_id AND s.ended_at IS NULL
  JOIN business_people p ON p.person_id=s.person_id AND p.active AND p.app_user_id=s.worker_user_id
  WHERE l.source_id=$1 AND o.deleted_at IS NULL AND o.status='in_progress' AND r.status='in_progress'
   AND s.worker_user_id=$2 AND access_is_root_actor($2)`,[sourceId,userId])).rowCount);
}
