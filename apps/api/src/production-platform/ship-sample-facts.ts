import type {Pool,PoolClient} from 'pg';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
type DB=Pick<Pool|PoolClient,'query'>;
const actualTime=(value:unknown):string|null=>value==null?null:(value instanceof Date?value:new Date(String(value))).toISOString();
export async function shipSampleFacts(db:DB,orderId:string){
 const records=(await db.query(`SELECT e.event_id,e.occurred_at,e.payload,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='ship_sample_sent' ORDER BY e.recorded_at,e.event_id`,[orderId])).rows.map(e=>({eventId:e.event_id,occurredAt:actualTime(e.occurred_at),operatorName:e.display_name,trackingNumber:String(e.payload.trackingNumber),lineIds:e.payload.lineIds as string[],legacy:false}));
 if((await db.query("SELECT to_regclass('digital_factory_facts') AS relation")).rows[0]?.relation){
  const old=(await db.query(`SELECT f.*,u.display_name,v.order_snapshot FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id)
   JOIN digital_bulk_preparations p USING(preparation_id) JOIN digital_instruction_versions v ON v.production_order_id=p.production_order_id AND v.version=p.instruction_version JOIN app_users u ON u.id=f.actor_id
   WHERE r.production_order_id=$1 AND f.kind='船样寄出' ORDER BY f.recorded_at`,[orderId])).rows;
  for(const f of old){const lines=Array.isArray(f.order_snapshot?.lines)?f.order_snapshot.lines:[];records.push({eventId:f.fact_id,occurredAt:actualTime(f.occurred_at),operatorName:f.display_name,trackingNumber:String(f.payload.trackingNumber??''),lineIds:lines.map((l:{lineId?:string})=>l.lineId).filter((id:unknown):id is string=>typeof id==='string'),legacy:true});}
 }
 return records;
}
/** Native sample events override legacy observations without becoming production prerequisites. */
export async function shipSampleSlaEvidence(db:DB,orderId:string){
 const facts:Record<string,SlaNodeFact>={};
 for(const record of await shipSampleFacts(db,orderId))for(const lineId of record.lineIds){
  const fact:SlaNodeFact={businessCompleted:true,...(record.occurredAt?{completedAt:record.occurredAt}:{}),evidence:`${record.legacy?'digital_factory_facts':'digital_production_task_events'}:${record.eventId}`};
  facts[`ship_sample:${lineId}`]=fact;facts[`ship_sample_advance:${lineId}`]=fact;
 }
 return facts;
}
