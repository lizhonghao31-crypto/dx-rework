import type {PoolClient} from "pg";
import type {JourneyRiskHistory,OrderJourney} from "@dx-rework/contracts/digital-production-journey";

/** Historical evaluation uses the immutable completion event and its own deadline revision only. */
export async function readJourneyRiskHistory(db:Pick<PoolClient,"query">,order:OrderJourney):Promise<JourneyRiskHistory[]>{
  const byTask=new Map(order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records.filter(record=>record.domain==="task").map(record=>[record.id,{node,record}] as const))));
  if(!byTask.size)return [];
  const rows=(await db.query(`SELECT e.event_id,e.task_id,e.occurred_at,e.time_quality,r.due_at FROM digital_production_task_events e
    LEFT JOIN LATERAL(SELECT due_at FROM digital_production_deadline_revisions r WHERE r.event_id=e.event_id AND r.reason='completion' ORDER BY revision_id DESC LIMIT 1)r ON true
    WHERE e.task_id=ANY($1::uuid[]) AND e.event_kind='completed' ORDER BY e.recorded_at DESC,e.event_id DESC`,[[...byTask.keys()]])).rows;
  return rows.map(row=>{
    const {node,record}=byTask.get(row.task_id)!;
    const at=row.occurred_at?new Date(row.occurred_at).toISOString():null,deadline=row.due_at?new Date(row.due_at).toISOString():null;
    const proven=at&&deadline&&['现场登记','已核实'].includes(row.time_quality);
    const overdueSeconds=proven?Math.max(0,(Date.parse(at)-Date.parse(deadline))/1000):null;
    return {eventId:row.event_id,nodeId:node.instanceId,label:node.label,round:node.round,at,deadline,assessment:!proven?'insufficient':overdueSeconds!>0?'late':'not_late',overdueSeconds,record};
  });
}
