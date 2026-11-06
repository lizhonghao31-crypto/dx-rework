import type {PoolClient} from 'pg';
import type {StatisticsAllocation,StatisticsMaterialRequirement,StatisticsTime} from '@dx-rework/contracts/production-statistics';
import type {BulkPreparationService} from './bulk-preparation-service.js';

type Gates=Awaited<ReturnType<BulkPreparationService['gates']>>;
const time=(value:Date|string|null,ref:string,verified:boolean):StatisticsTime=>value?{at:new Date(value).toISOString(),date:null,precision:'instant',quality:verified?'verified':'unverified',sourceRefs:[ref]}:{at:null,date:null,precision:'unknown',quality:'unknown',sourceRefs:[ref]};
const rows=(value:unknown):Array<{lineId:string;quantity:number}>=>Array.isArray(value)?value.filter((row):row is {lineId:string;quantity:number}=>Boolean(row&&typeof row.lineId==='string'&&Number.isSafeInteger(row.quantity)&&row.quantity>=0)):[];

/** Read original requirements and immutable issue records. Never infer a BOM from consumption text. */
export async function productionMaterialFacts(db:PoolClient,orderId:string,gates:Gates){
 const cutting=(await db.query(`SELECT link.line_id,record.cutting_record_id,record.version,record.actual_cut_count
  FROM digital_production_child_lines link LEFT JOIN current_cutting_records record ON record.cutting_order_id=link.child_id
  WHERE link.production_order_id=$1 AND link.module='cutting'`,[orderId])).rows;
 const issues=(await db.query(`SELECT fact.*,preparation.instruction_version,coalesce(preparation.approval_snapshot_id,execution.sourcing_approval_snapshot_id) AS approval_snapshot_id,approval.sourcing_decision_id
  FROM digital_factory_facts fact JOIN digital_bulk_preparations preparation USING(preparation_id)
  LEFT JOIN digital_production_child_links native ON native.module='production' AND native.production_order_id=preparation.production_order_id
  LEFT JOIN sourcing_production_orders execution ON execution.production_order_id=native.child_id
  LEFT JOIN sourcing_approval_snapshots approval ON approval.sourcing_approval_snapshot_id=coalesce(preparation.approval_snapshot_id,execution.sourcing_approval_snapshot_id)
  WHERE preparation.production_order_id=$1 AND fact.kind='仓库实际发厂' ORDER BY fact.sequence,fact.fact_id`,[orderId])).rows;
 const approved=issues.length?(await db.query(`SELECT approval.sourcing_decision_id,mapping.line_id,line.quantity FROM sourcing_approval_snapshots approval
  JOIN sourcing_approval_snapshot_lines line USING(sourcing_approval_snapshot_id)
  JOIN digital_production_child_lines mapping ON mapping.module='sourcing' AND mapping.child_id=approval.sourcing_case_id AND mapping.child_line_key=line.position::text
  WHERE approval.sourcing_approval_snapshot_id=ANY($1::uuid[])`,[issues.map(issue=>issue.approval_snapshot_id)])).rows:[];
 const accessoryIssues=(await db.query(`SELECT event_id,occurred_at,time_quality,payload FROM digital_production_task_events
  WHERE resource_kind='order' AND resource_id=$1 AND event_kind='bulk_materials_dispatched' ORDER BY recorded_at,event_id`,[orderId])).rows;
 const instruction=gates.instructionValid?gates.instruction:null,accessories:StatisticsMaterialRequirement[]=[];
 if(instruction){
  for(const material of instruction.document.accessories){
   const related=accessoryIssues.filter(event=>event.payload.instructionVersion===instruction.version);
   const units=[...new Set(related.flatMap(event=>(event.payload.items??[]).filter((item:{materialId:string})=>item.materialId===material.id).map((item:{unit:string})=>item.unit)))];
   // An original accessory row describes the requirement, but its free-text
   // consumption is not an approved numeric denominator. Keep each actual unit.
   for(const unit of units.length?units:['单位待核']){
    const events:StatisticsMaterialRequirement['events']=[];
    for(const event of related)for(const item of event.payload.items??[])if(item.materialId===material.id&&item.unit===unit)events.push({id:event.event_id+':'+material.id,scopeVersion:'instruction:'+instruction.version,effectiveQuantity:Number(item.quantity),time:time(event.occurred_at,'material-issue:'+event.event_id,['现场登记','已核实'].includes(event.time_quality)),sourceRefs:['material-issue:'+event.event_id]});
    const factories=[...new Set(related.filter(event=>(event.payload.items??[]).some((item:{materialId:string;unit:string})=>item.materialId===material.id&&item.unit===unit)).map(event=>event.payload.supplierId as string))];
    // Whole-order material stays whole-order. More than one factory cannot be
    // merged into a single factory-specific numerator.
    const factoryIds=factories.length?factories:[gates.approval?.supplier_id??null];
    for(const factoryId of factoryIds)accessories.push({requirementId:`accessory:${orderId}:${material.id}:${unit}:${factoryId??'unmapped'}`,scopeVersion:'instruction:'+instruction.version,lineId:null,factoryId,kind:'辅料：'+material.name,unit,required:null,applicability:'unknown',eventsComplete:true,events:events.filter(event=>related.some(issue=>event.id.startsWith(issue.event_id+':')&&issue.payload.supplierId===factoryId)),sourceRefs:[`instruction:${orderId}:v${instruction.version}:accessory:${material.id}`]});
   }
  }
 }
 return {
  whole:accessories,
  forPo(lineId:string,demand:number|null,allocations:StatisticsAllocation[]):StatisticsMaterialRequirement[]{
   const current=allocations.filter(scope=>scope.current&&scope.quantity>0),cut=cutting.find(row=>row.line_id===lineId),result:StatisticsMaterialRequirement[]=[];
   if(!current.length){result.push({requirementId:`cut-pieces:${orderId}:${lineId}:unmapped`,scopeVersion:cut?`${cut.cutting_record_id}:v${cut.version}`:'missing-cutting-scope',lineId,factoryId:null,kind:'裁片',unit:'件',required:null,applicability:'unknown',eventsComplete:false,events:[],sourceRefs:[`PO:${lineId}:cutting-requirement-missing`]});return result;}
   for(const scope of current){
    const relevant=issues.filter(issue=>issue.payload.supplierId===scope.factoryId&&issue.sourcing_decision_id===scope.version&&issue.instruction_version===instruction?.version),version=`cut:${cut?.cutting_record_id??'missing'}:v${cut?.version??'missing'}:allocation:${scope.version}`;
    const cutQuantity=cut?.actual_cut_count==null?null:Number(cut.actual_cut_count),allAllocated=current.reduce((n,row)=>n+row.quantity,0),required=cutQuantity!==null&&demand!==null&&cutQuantity===demand?scope.quantity:cutQuantity!==null&&current.length===1&&demand!==null&&allAllocated===demand?cutQuantity:null;
    const unmappedIssue=issues.some(issue=>issue.payload.supplierId===scope.factoryId&&(!Array.isArray(issue.payload.lines)||rows(issue.payload.lines).some(row=>row.lineId===lineId))&&!relevant.some(current=>current.fact_id===issue.fact_id)),legacyIncomplete=relevant.some(issue=>!Array.isArray(issue.payload.lines)),originalQuantity=approved.find(row=>row.sourcing_decision_id===scope.version&&row.line_id===lineId)?.quantity,stableScope=!relevant.length||originalQuantity!==undefined&&Number(originalQuantity)===scope.quantity,scopeReadable=scope.origin!=='transfer'||relevant.length>0;
    result.push({requirementId:`cut-pieces:${orderId}:${lineId}:${scope.factoryId}`,scopeVersion:version,lineId,factoryId:scope.factoryId,kind:'裁片',unit:'件',required,applicability:required===null?'unknown':'required',eventsComplete:!legacyIncomplete&&!unmappedIssue&&stableScope&&scopeReadable,...(unmappedIssue?{missingReason:'原发厂记录的需求或批准版本与当前范围未核齐'}:!stableScope?{missingReason:'当前份额已变，原发出数量属于历史范围，不能分摊签当前范围'}:!scopeReadable?{missingReason:'转厂当前份额尚无可核裁片发料关联'}:legacyIncomplete?{missingReason:'旧整款发厂记录缺逐PO有效数量'}:{}),historyMatchesScope:Number(cut?.version??0)===1,events:relevant.flatMap(issue=>rows(issue.payload.lines).filter(row=>row.lineId===lineId).map(row=>({id:issue.fact_id+':'+lineId,scopeVersion:stableScope?version:'historical:'+issue.approval_snapshot_id+':'+lineId,effectiveQuantity:row.quantity,time:time(issue.occurred_at,'factory-issue:'+issue.fact_id,true),sourceRefs:['factory-issue:'+issue.fact_id]}))),sourceRefs:[...scope.sourceRefs,`cutting:${cut?.cutting_record_id??'missing'}:v${cut?.version??'missing'}`]});
   }
   return result;
  },
 };
}
