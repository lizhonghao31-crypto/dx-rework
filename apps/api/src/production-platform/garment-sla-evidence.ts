import {slaApplications,appliedSlaWindow} from './sla-applied-window.js';
import type {Pool,PoolClient} from 'pg';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import {validateDigitalSlaSnapshot} from '@dx-rework/contracts/digital-sla';
import {garmentQuality} from './garment-quality.js';
/** Arrival QC is its own original event, never a rework tail-inspection report. */
export async function garmentSlaEvidence(db:Pick<Pool|PoolClient,'query'>,orderId:string){
 const quality=(await garmentQuality(db,orderId)).filter(r=>r.quantity>0);
 const snapshots=(await db.query(`SELECT e.payload->>'receiptId' AS receipt_id,s.* FROM digital_production_task_events e
 JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=e.payload->>'snapshotId'
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='garment_receipt_registered'`,[orderId])).rows;
 const applications=await slaApplications(db,orderId);
 const windows=quality.map(r=>{
  const saved=snapshots.find(s=>s.receipt_id===r.receiptId),base=saved?validateDigitalSlaSnapshot({ruleVersion:saved.rule_version,parameters:saved.parameters_json}):null,applied=base?appliedSlaWindow(base,'garment_inspection',`receipt:${r.receiptId}`,applications):null,parameters=applied?.snapshot.parameters;
  const value=parameters?.garment_inspection?.value,warning=parameters?.warning_ratio?.value;
  const minutes=value?.kind==='duration'?value.minutes:null;
  return {lineId:r.lineId,receiptId:r.receiptId,startedAt:r.receivedAt,completedAt:r.completedAt,complete:r.inspected,
   deadline:r.receivedAt&&minutes!==null?new Date(Date.parse(r.receivedAt)+minutes*60000).toISOString():null,
   warningAt:r.receivedAt&&minutes!==null&&warning?.kind==='ratio'?new Date(Date.parse(r.receivedAt)+minutes*60000*warning.percent/100).toISOString():null,
   evidence:`receipt:${r.receiptId}:quantity:${r.quantityVersion}:qc:${r.eventId??'unknown'}`,snapshotId:applied?.snapshotId??saved?.snapshot_id??null,precision:r.precision};
 });
 const expected=(await db.query('SELECT line.line_id,sum(size.quantity)::bigint AS quantity FROM digital_production_po_lines line JOIN digital_production_po_sizes size USING(line_id) WHERE line.production_order_id=$1 GROUP BY line.line_id',[orderId])).rows;
 const facts:Record<string,SlaNodeFact>={};
 for(const lineId of new Set(windows.map(r=>r.lineId))){const parts=windows.filter(r=>r.lineId===lineId),covered=quality.filter(r=>r.lineId===lineId).reduce((n,r)=>n+r.quantity,0)>=Number(expected.find(r=>r.line_id===lineId)?.quantity??Infinity),complete=covered&&parts.every(r=>r.complete);
  facts[`garment_inspection:${lineId}`]={businessCompleted:complete,batchCoverageComplete:covered,batchWindows:parts,evidence:parts.map(r=>r.evidence).join(','),
   ...(parts.every(r=>r.startedAt)?{startedAt:new Date(Math.min(...parts.map(r=>Date.parse(r.startedAt!)))).toISOString()}:{}),
   ...(complete&&parts.every(r=>r.completedAt)?{completedAt:new Date(Math.max(...parts.map(r=>Date.parse(r.completedAt!)))).toISOString()}:{}),};
 }
 return {quality,windows,facts};
}
