import type {PoolClient} from "pg";
import type {JourneyRiskHistory,JourneyRecord} from "@dx-rework/contracts/digital-production-journey";
import type {JourneyAuthorizedTask} from "./journey-read-scope.js";

/** Historical evaluation uses the immutable completion event and its own deadline revision only. */
export async function readJourneyRiskHistory(db:Pick<PoolClient,"query">,authorized:readonly JourneyAuthorizedTask[]):Promise<JourneyRiskHistory[]>{
  const byTask=new Map(authorized.map(task=>[task.id,task]));
  if(!byTask.size)return [];
  const rows=(await db.query(`SELECT e.event_id,e.task_id,e.occurred_at,e.time_quality,r.due_at FROM digital_production_task_events e
    LEFT JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions r WHERE r.event_id=e.event_id AND r.reason='completion' ORDER BY revision_id DESC LIMIT 1)r ON true
    WHERE e.task_id=ANY($1::uuid[]) AND e.event_kind='completed' ORDER BY e.recorded_at DESC,e.event_id DESC`,[[...byTask.keys()]])).rows;
  return rows.map(row=>{
    const task=byTask.get(row.task_id)!;
    const record:JourneyRecord={domain:"task",id:task.id,url:`/ui/digital-production?task=${encodeURIComponent(task.id)}`,mode:"read",version:task.round,lineId:null};
    const at=row.occurred_at?new Date(row.occurred_at).toISOString():null,deadline=row.due_at?new Date(row.due_at).toISOString():null;
    const proven=at&&deadline&&['现场登记','已核实'].includes(row.time_quality);
    const overdueSeconds=proven?Math.max(0,(Date.parse(at)-Date.parse(deadline))/1000):null;
    return {eventId:row.event_id,nodeId:task.id,label:task.label,round:task.round,at,deadline,assessment:!proven?'insufficient':overdueSeconds!>0?'late':'not_late',overdueSeconds,record};
  });
}
