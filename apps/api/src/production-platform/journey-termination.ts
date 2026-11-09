import type {PoolClient} from 'pg';

export type JourneyTermination={kind:'cancelled'|'special_closure';at:string|null;precision:'instant'|'unknown';originEventRef:string|null;scopeRef:string};
/** A terminal business event stops observation; it never supplies delivery A.
 * Do not substitute lifecycle.changed_at, query time or a customer target when
 * the effective termination event has no trustworthy business timestamp.
 */
export async function journeyTermination(db:Pick<PoolClient,'query'>,resource:{kind:'source'|'order';id:string},asOf:string):Promise<JourneyTermination|null>{
 const lifecycle=(await db.query(`SELECT state FROM digital_production_resource_lifecycle
   WHERE resource_kind=$1 AND resource_id=$2`,[resource.kind,resource.id])).rows[0];
 const scopeRef=`${resource.kind}:${resource.id}`;
 const instant=(value:unknown)=>{
  if(value==null)return null;
  const millis=value instanceof Date?value.getTime():Date.parse(String(value));
  return Number.isFinite(millis)&&millis<=Date.parse(asOf)?new Date(millis).toISOString():null;
 };
 if(lifecycle?.state==='cancelled'){
  const event=(await db.query(`SELECT event_id,occurred_at,time_quality FROM digital_production_task_events
    WHERE resource_kind=$1 AND resource_id=$2 AND event_kind='cancel'
    ORDER BY (task_id IS NULL) DESC,recorded_at DESC,event_id DESC LIMIT 1`,[resource.kind,resource.id])).rows[0];
  const at=event&&['现场登记','已核实'].includes(event.time_quality)?instant(event.occurred_at):null;
  return {kind:'cancelled',at,precision:at?'instant':'unknown',originEventRef:event?`digital_production_task_events:${event.event_id}`:null,scopeRef};
 }
 if(resource.kind!=='order')return null;
 const closure=(await db.query('SELECT closed_at FROM digital_order_closures WHERE production_order_id=$1',[resource.id])).rows[0];
 if(!closure)return null;
 const at=instant(closure.closed_at);
 return {kind:'special_closure',at,precision:at?'instant':'unknown',originEventRef:`digital_order_closures:${resource.id}`,scopeRef};
}
