import type {DigitalTaskCompletion} from '@dx-rework/contracts/digital-production-tasks';
import type {Pool,PoolClient} from 'pg';
import {developmentRecordedTime} from './development-occurrence.js';

type Task={task_id:string;source_id:string|null;route_version:number;task_kind:string;state:string;completed_at:Date|string|null;completed_quality:string};
type Recorded={fact_id:string;payload:Record<string,unknown>|null;corrected:boolean};
/** A later native correction, including explicit unknown, supersedes the old
 * date payload. Neither registration time nor responsibility quality proves A. */
export function taskCompletionOccurrence(task:Task,asOf:string,recorded?:Recorded):DigitalTaskCompletion{
 const sourceRef=`task:${task.task_id}`,unknown:DigitalTaskCompletion={precision:'unknown',at:null,date:null,quality:'missing',sourceRef};
 if(task.state!=='completed')return unknown;
 if(recorded&&!recorded.corrected){
  const payload=task.task_kind==='development_shipping'&&recorded.payload?.sentDate
   ?{actualCompletedDate:recorded.payload.sentDate,timeQuality:'补报未核实'}:recorded.payload;
  const actual=developmentRecordedTime(payload,asOf);
  if(actual?.date)return {precision:'date',at:null,date:actual.date,quality:actual.quality,sourceRef:`development-route-fact:${recorded.fact_id}`};
 }
 if(!task.completed_at||!['现场登记','已核实','补报未核实'].includes(task.completed_quality))return unknown;
 const at=new Date(task.completed_at);if(!Number.isFinite(at.getTime())||at.getTime()>Date.parse(asOf))return unknown;
 return {precision:'instant',at:at.toISOString(),date:null,quality:task.completed_quality==='补报未核实'?'unverified':'verified',sourceRef};
}
/** Called only after original exact task authorization; optional legacy route
 * storage is never queried before its existence is established. */
export async function readTaskCompletionOccurrence(db:Pick<Pool|PoolClient,'query'>,task:Task,asOf:string):Promise<DigitalTaskCompletion>{
 let recorded:Recorded|undefined;
 if(task.state==='completed'&&task.source_id&&task.task_kind.startsWith('development_')
  &&(await db.query("SELECT to_regclass('digital_development_route_facts') AS completion_relation")).rows[0]?.completion_relation){
  recorded=(await db.query<Recorded>(`SELECT f.fact_id,f.payload,EXISTS(SELECT 1 FROM digital_production_task_events e
   WHERE e.task_id=f.task_id AND e.event_kind='time_corrected' AND e.payload->>'originalKind'='completed') AS corrected
   FROM digital_development_route_facts f WHERE f.task_id=$1 AND f.source_id=$2 AND f.route_version=$3 ORDER BY f.sequence DESC LIMIT 1`,[task.task_id,task.source_id,task.route_version])).rows[0];
 }
 return taskCompletionOccurrence(task,asOf,recorded);
}
