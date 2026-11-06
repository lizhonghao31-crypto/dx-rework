import type {PoolClient} from 'pg';
import type {ProductionPeriodEvent} from '@dx-rework/contracts/production-period';
import type {StatisticsPo,StatisticsTime} from '@dx-rework/contracts/production-statistics';

const missing=(ref:string):StatisticsTime=>({at:null,date:null,precision:'unknown',quality:'unknown',sourceRefs:[ref]});
const at=(value:Date|string|null,ref:string,verified:boolean):StatisticsTime=>value?{at:new Date(value).toISOString(),date:null,precision:'instant',quality:verified?'verified':'unverified',sourceRefs:[ref]}:missing(ref);
const day=(value:string,ref:string):StatisticsTime=>({at:null,date:value,precision:'date',quality:'verified',sourceRefs:[ref]});
const stamp=(value:Date|string)=>new Date(value).toISOString();
/** The caller must first authorize this complete order and its selected original
 * PO facts in the same read transaction. Historical scope comes from the event,
 * including zero-current-share factories; current proportions never redistribute it. */
export async function productionPeriodEvents(db:PoolClient,orderId:string,selected:readonly StatisticsPo[]):Promise<ProductionPeriodEvent[]>{
 const ids=new Set(selected.filter(row=>row.orderId===orderId).map(row=>row.lineId));if(!ids.size)return [];
 const totalPoCount=Number((await db.query('SELECT count(*)::int AS total FROM digital_production_po_lines WHERE production_order_id=$1',[orderId])).rows[0].total),result:ProductionPeriodEvent[]=[],originalInstruction=(await db.query("SELECT version.document->>'category' AS category,version.version FROM digital_factory_routes route JOIN digital_bulk_preparations preparation USING(preparation_id) JOIN digital_instruction_versions version ON version.production_order_id=route.production_order_id AND version.version=preparation.instruction_version WHERE route.production_order_id=$1",[orderId])).rows[0];
 const reports=(await db.query(`SELECT report.*,report.business_date::text AS actual_day,mapping.line_id,factory.supplier_id,factory.sourcing_decision_id FROM effective_sourcing_production_reports report
 JOIN digital_production_child_links link ON link.module='production' AND link.child_id=report.production_order_id AND link.production_order_id=$1
 LEFT JOIN sourcing_production_factory_orders factory ON factory.production_order_id=report.production_order_id AND factory.factory_decision_id IS NOT DISTINCT FROM report.factory_decision_id
 LEFT JOIN digital_production_child_lines mapping ON mapping.production_order_id=link.production_order_id AND mapping.module='production' AND mapping.child_id=report.production_order_id AND mapping.child_line_key=report.position::text ORDER BY report.report_id`,[orderId])).rows;
 for(const row of reports){if(row.line_id&&!ids.has(row.line_id))continue;const ref='production-report:'+row.report_id,mapped=Boolean(row.line_id),whole=ids.size===totalPoCount;
  result.push({id:row.report_id,rootId:row.root_report_id,revision:Number(row.revision),orderId,lineId:row.line_id??null,...mapped?{}:{wholeOrderPoCount:totalPoCount,...whole?{}:{sourceQuantity:Number(row.quantity),unknownReason:'原报工已知数量，但缺选定PO映射，不能把整单量算给本次PO'}},kind:'factory-produced',category:originalInstruction?.category??null,quantity:mapped||whole?Number(row.quantity):null,unit:'件',occurred:day(row.actual_day,ref),recordedAt:stamp(row.created_at),effective:true,factoryId:row.supplier_id??null,factoryScopeVersion:row.sourcing_decision_id?row.production_order_id+':'+(row.factory_decision_id??'original')+':'+row.sourcing_decision_id:null,sourceRefs:[ref,'operation-event:'+row.operation_event_id]});
 }
 const issues=(await db.query(`SELECT fact.*,preparation.production_order_id,preparation.instruction_version,coalesce(preparation.approval_snapshot_id,execution.sourcing_approval_snapshot_id) AS approval_snapshot_id,version.document->>'category' AS category FROM digital_factory_facts fact
 JOIN digital_bulk_preparations preparation USING(preparation_id)
 LEFT JOIN digital_instruction_versions version ON version.production_order_id=preparation.production_order_id AND version.version=preparation.instruction_version
 LEFT JOIN digital_production_child_links link ON link.production_order_id=preparation.production_order_id AND link.module='production'
 LEFT JOIN sourcing_production_orders execution ON execution.production_order_id=link.child_id
 WHERE preparation.production_order_id=$1 AND fact.kind='仓库实际发厂' ORDER BY fact.sequence,fact.fact_id`,[orderId])).rows;
 for(const row of issues){const ref='factory-issue:'+row.fact_id,lines=Array.isArray(row.payload.lines)?row.payload.lines:[];
  for(const line of lines){if(!ids.has(line.lineId))continue;result.push({id:row.fact_id+':'+line.lineId,rootId:row.fact_id+':'+line.lineId,revision:1,orderId,lineId:line.lineId,kind:'cut-pieces-sent',category:row.category??null,quantity:Number.isFinite(line.quantity)?line.quantity:null,unit:'件',occurred:at(row.occurred_at,ref,true),recordedAt:stamp(row.recorded_at),effective:true,factoryId:typeof row.payload.supplierId==='string'?row.payload.supplierId:null,factoryScopeVersion:row.approval_snapshot_id?'approval:'+row.approval_snapshot_id+':instruction:'+row.instruction_version:null,sourceRefs:[ref]});}
  if(!lines.length)result.push({id:row.fact_id,rootId:row.fact_id,revision:1,orderId,lineId:null,kind:'cut-pieces-sent',category:row.category??null,quantity:null,unit:'件',occurred:at(row.occurred_at,ref,true),recordedAt:stamp(row.recorded_at),effective:true,factoryId:typeof row.payload.supplierId==='string'?row.payload.supplierId:null,factoryScopeVersion:row.approval_snapshot_id??null,sourceRefs:[ref,'legacy-whole-order-quantity-not-mapped']});
 }
 const accessories=(await db.query(`SELECT event.*,version.document->>'category' AS category FROM digital_production_task_events event
 LEFT JOIN digital_instruction_versions version ON version.production_order_id=event.resource_id AND version.version::text=event.payload->>'instructionVersion'
 WHERE event.resource_kind='order' AND event.resource_id=$1 AND event.event_kind='bulk_materials_dispatched' ORDER BY event.recorded_at,event.event_id`,[orderId])).rows;
 for(const issue of accessories)for(const item of Array.isArray(issue.payload.items)?issue.payload.items:[]){const ref='accessory-issue:'+issue.event_id+':'+item.materialId;result.push({id:ref,rootId:ref,revision:1,orderId,lineId:null,kind:'accessory-sent:'+item.materialId,label:'原辅料发出（本项原单位）',category:issue.category??null,quantity:Number.isFinite(item.quantity)?item.quantity:null,unit:typeof item.unit==='string'?item.unit:'单位待核',occurred:at(issue.occurred_at,ref,['现场登记','已核实'].includes(issue.time_quality)),recordedAt:stamp(issue.recorded_at),effective:true,factoryId:typeof issue.payload.supplierId==='string'?issue.payload.supplierId:null,factoryScopeVersion:'instruction:'+issue.payload.instructionVersion,sourceRefs:[ref,'instruction:'+orderId+':v'+issue.payload.instructionVersion]});}
 const reportOwners=new Map<string,{orderId:string;lineId:string;reworkId:string;processId:string;processName:string;kind:string}>();
 for(const row of selected)for(const rework of row.reworks??[])for(const process of rework.processes)for(const reportId of process.reportIds)if(!reportOwners.has(reportId))reportOwners.set(reportId,{orderId,lineId:row.lineId,reworkId:rework.reworkId,processId:process.configurationItemId,processName:process.processName,kind:rework.kind});
 if(reportOwners.size){const reports=(await db.query(`SELECT report.work_report_id,report.completed_at,report.created_at,report.source_system,item.pricing_unit,
 rework_work_report_effective_quantity(report.work_report_id) AS effective_quantity,coalesce(correction.revision_version,0) AS quantity_revision
 FROM rework_work_reports report JOIN rework_process_configuration_items item USING(configuration_item_id)
 LEFT JOIN LATERAL(SELECT revision_version FROM rework_work_report_quantity_revisions WHERE work_report_id=report.work_report_id ORDER BY revision_version DESC LIMIT 1)correction ON true
 WHERE report.work_report_id=ANY($1::uuid[]) AND report.status='submitted' AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id) ORDER BY report.work_report_id`,[[...reportOwners.keys()]])).rows;
  for(const report of reports){const owner=reportOwners.get(report.work_report_id)!,ref='rework-report:'+report.work_report_id;result.push({id:report.work_report_id+':effective:'+report.quantity_revision,rootId:report.work_report_id,revision:Number(report.quantity_revision)+1,orderId,lineId:owner.lineId,kind:owner.kind+':'+owner.reworkId+':'+owner.processId,category:originalInstruction?.category??null,label:(owner.kind==='inhouse_finishing'?'原普通做尾':'原返工')+' · '+owner.processName+'（本单本工序，不当跨轮独立不良件）',quantity:Number(report.effective_quantity),unit:report.pricing_unit==='hour'?'小时':'件',occurred:at(report.completed_at,ref,report.source_system==='manual'),recordedAt:stamp(report.created_at),effective:true,factoryId:null,factoryScopeVersion:null,sourceRefs:[ref,'rework:'+owner.reworkId,'configuration-item:'+owner.processId,'effective-quantity-revision:'+report.quantity_revision]});}
 }
 // Current packing is a cumulative native fact. Its registration timestamp is
 // not a business shipment occurrence, and revisions are not additive events.
 for(const row of selected.filter(row=>ids.has(row.lineId)&&row.packingRevision&&row.packing!==0))result.push({id:row.packingRevision!,rootId:'packing:'+row.lineId,revision:1,orderId,lineId:row.lineId,kind:'packed',quantity:row.packing,unit:'件',occurred:missing('packing:'+row.packingRevision),recordedAt:null,effective:true,factoryId:null,factoryScopeVersion:null,sourceRefs:['packing:'+row.packingRevision,'cumulative-current-fact-without-proven-occurrence']});
 return result;
}
