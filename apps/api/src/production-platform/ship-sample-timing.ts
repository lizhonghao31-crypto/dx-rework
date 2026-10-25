import {shipSampleFacts} from './ship-sample-facts.js';
import type {Pool,PoolClient} from 'pg';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
type DB=Pick<Pool|PoolClient,'query'>;
/** Target dates retain day precision; the exclusive deadline is next midnight in Beijing. */
export async function shipSampleTargets(db:DB,orderId:string){
 const exists=(await db.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation;
 const row=exists?(await db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1',[orderId])).rows[0]:null;
 const value=row?validateDigitalSlaSnapshot({ruleVersion:row.rule_version,parameters:row.parameters_json}).parameters.ship_sample_advance?.value:null;
 // Historical orders retain their existing ten-day display; this does not create a frozen historical SLA.
 const days=value?.kind==='offset'?value.days:10;
 const lines=(await db.query(`SELECT line_id, (customer_warehouse_arrival_date-$2::int)::text AS target_date,
 ((customer_warehouse_arrival_date-$2::int+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AS due_at
 FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position`,[orderId,days])).rows;
 const sent=new Set((await shipSampleFacts(db,orderId)).flatMap(r=>r.lineIds));
 return {snapshotId:row?.snapshot_id??null,days,lines:lines.map(l=>({lineId:l.line_id as string,sent:sent.has(l.line_id),targetDate:l.target_date as string|null,dueAt:l.due_at?new Date(l.due_at).toISOString():null}))};
}
