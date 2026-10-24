import type {PoolClient} from 'pg';
import {DIGITAL_SLA_PARAMETERS,validateDigitalSlaSnapshot,type DigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
export type SlaApplication={eventId:string;snapshotId:string;keys:string[];excluded:string[];snapshot:DigitalSlaSnapshot};
/** Explicit application references live in the original append-only business event stream. */
export async function slaApplications(db:Pick<PoolClient,'query'>,orderId:string):Promise<SlaApplication[]>{
 const rows=(await db.query(`SELECT e.event_id,e.payload,s.* FROM digital_production_task_events e
 JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=e.payload->>'snapshotId' AND s.production_order_id=e.resource_id
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='sla_standard_applied'
 ORDER BY s.revision`,[orderId])).rows;
 return rows.map(r=>({eventId:r.event_id,snapshotId:r.snapshot_id,keys:r.payload.parameterKeys,excluded:r.payload.completedWindows,
 snapshot:validateDigitalSlaSnapshot({ruleVersion:r.rule_version,parameters:r.parameters_json})}));
}
/** Never changes a business start or completion. Completed-at-application windows keep their old assessment. */
export function appliedSlaWindow(base:DigitalSlaSnapshot,key:string,windowKey:string,applications:SlaApplication[]){
 const snapshot=structuredClone(base);let applicationId:string|null=null,snapshotId:string|null=null;
 for(const application of applications){
  if(application.excluded.includes(windowKey))continue;
  const parents=DIGITAL_SLA_PARAMETERS.find(p=>p.key===key)?.includedIn??[];
  if(!application.keys.some(k=>k===key||k==='warning_ratio'||parents.includes(k)))continue;
  for(const selected of application.keys){
   if(!application.keys.includes(selected))continue;
   // Existing legitimate customer/order exceptions outrank a newly applied global standard.
   if(snapshot.parameters[selected]?.source!=='global')continue;
   const value=application.snapshot.parameters[selected];if(!value)continue;
   snapshot.parameters[selected]=structuredClone(value);applicationId=application.eventId;snapshotId=application.snapshotId;
  }
 }
 return {snapshot,applicationId,snapshotId};
}
