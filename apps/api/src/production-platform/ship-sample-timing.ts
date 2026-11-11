import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import {slaDateBoundary} from '@dx-rework/domain/digital-sla-plan';
import {shipSampleFacts} from './ship-sample-facts.js';
import type {Pool,PoolClient} from 'pg';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {OrderTimePlanRepository} from './order-time-plan-repository.js';
type DB=Pick<Pool|PoolClient,'query'>;
/** Target dates retain day precision; the exclusive deadline is next midnight in Beijing. */
export async function shipSampleTargets(db:DB,orderId:string,perOrder=false){
 const exists=(await db.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation;
 const row=exists?(await db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1',[orderId])).rows[0]:null;
 const base=row?validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}):null,applications=row?await slaApplications(db,orderId):[],value=base?.parameters.ship_sample_advance?.value;
 // Historical orders retain their existing ten-day display; this does not create a frozen historical SLA.
 const days=value?.kind==='offset'?value.days:10;
 const lines=(await db.query(`SELECT line_id, customer_warehouse_arrival_date::text AS customer_date, (customer_warehouse_arrival_date-$2::int)::text AS target_date,
 ((customer_warehouse_arrival_date-$2::int+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS due_at
 FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[orderId,days])).rows;
 const sent=new Set((await shipSampleFacts(db,orderId)).flatMap(r=>r.lineIds));
 const saved=perOrder?await new OrderTimePlanRepository(db).current({kind:'order',id:orderId}):null;
 const effective=lines.map(l=>{
  if(perOrder){
   const scope=saved?.input.scopes.find(scope=>scope.lineId===l.line_id),work=scope&&saved?.input.work.find(work=>work.parameterKey==='ship_sample'&&work.id.endsWith(':'+l.line_id)),target=scope&&work?saved?.targets[scope.scopeRef]?.[work.id]?.end:null;
   const selected=saved?orderTimeRule(saved.input.plan,'ship_sample_advance')?.rule:null,advance=selected?.kind==='offset'?selected.days:null;
   // The retained PO target is the same B used by the cockpit, including the
   // production-start constraint. Only approved H changes may retarget it.
   const dueAt=target?.at??null,targetDate=dueAt?new Date(Date.parse(dueAt)+(target?.exclusive?-1:0)+8*3600000).toISOString().slice(0,10):null;
   return {lineId:l.line_id as string,sent:sent.has(l.line_id),days:advance,targetDate,dueAt,snapshotId:saved?.id??null,notificationEnabled:selected?.reminder.enabled===true};
  }
  const applied=base?appliedSlaWindow(base,'ship_sample_advance',`sample:${l.line_id}`,applications):null,parameter=applied?.snapshot.parameters.ship_sample_advance?.value,advance=parameter?.kind==='offset'?parameter.days:days;
  const targetDate=l.customer_date?new Date(Date.parse(`${l.customer_date}T00:00:00Z`)-advance*86400000).toISOString().slice(0,10):null;
  return {lineId:l.line_id as string,sent:sent.has(l.line_id),days:advance,targetDate,dueAt:targetDate?slaDateBoundary(targetDate).at:null,snapshotId:applied?.snapshotId??row?.snapshot_id??null,notificationEnabled:parameter?.kind==='offset'?parameter.notificationEnabled!==false:value?.kind==='offset'?value.notificationEnabled!==false:true};
 });
 return {snapshotId:effective.find(l=>!l.sent)?.snapshotId??row?.snapshot_id??null,days:effective.find(l=>!l.sent)?.days??days,lines:effective};
}
