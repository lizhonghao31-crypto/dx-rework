import {currentPreparationMaterial} from './preparation-material-repository.js';
import type {PoolClient} from 'pg';
export async function bulkFabricFacts(db:Pick<PoolClient,'query'>,orderId:string){
 const report=(await db.query(`SELECT event_id,payload,occurred_at,actor_id,recorded_at,time_quality FROM digital_production_task_events
   WHERE resource_kind='order' AND resource_id=$1 AND event_kind='bulk_fabric_report'
   ORDER BY recorded_at DESC,event_id DESC LIMIT 1`,[orderId])).rows[0];
 if(!report)return {report:null,decision:null,usable:false,usableAt:null as string|null,usableQuality:"缺失"};
 const decision=(await db.query(`SELECT event_id,payload,occurred_at,actor_id,time_quality FROM digital_production_task_events
   WHERE resource_kind='order' AND resource_id=$1 AND event_kind='bulk_fabric_decision' AND payload->>'reportId'=$2
   ORDER BY recorded_at DESC,event_id DESC LIMIT 1`,[orderId,report.event_id])).rows[0]??null;
 let currentReceipt=true;
 if((await db.query("SELECT to_regclass('digital_preparation_material_versions') AS relation")).rows[0]?.relation){
  const receipt=await currentPreparationMaterial(db,orderId,'fabric_receipt');
  if(receipt)currentReceipt=receipt.valid&&receipt.state==='ready'&&report.payload.receiptRef?.recordId===receipt.recordId&&report.payload.receiptRef?.version===receipt.version;
 }
 const usable=currentReceipt&&(report.payload.result==='合格'||report.payload.result==='不合格'&&decision?.payload.allowUse===true);
 const at=usable?(report.payload.result==='合格'?report.payload.inspectedAt:decision?.occurred_at):null;
 return {report:{reportId:report.event_id,...report.payload,operatorId:report.actor_id},
   decision:decision?{decisionId:decision.event_id,...decision.payload,operatorId:decision.actor_id}:null,
   usable,usableAt:at?new Date(at).toISOString():null,usableQuality:at?(report.payload.result==='合格'?report.time_quality:decision?.time_quality):'缺失'};
}
