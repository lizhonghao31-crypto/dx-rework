import {ContextBusinessClock} from "../acceptance-clock/business-time.js";
import {ApplicationError} from "../platform/errors.js";
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {JourneySupervision,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {calculateSlaPlan,evaluateSlaPlan,type SlaNodeEvaluation,type SlaPlan,type SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {SlaOrderService} from './sla-order-service.js';
import {developmentSlaPlan} from './development-sla-enrollment.js';
import {developmentEvaluationPlan,developmentNativeFacts,developmentSlaEvidence} from './development-sla-evidence.js';
import {attachJourneyNativeTimes} from './journey-native-times.js';

const aliases:Record<string,string>={production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',development_craft_return:'development_craft_confirmation',external_pattern:'development_external_pattern',bulk_printing:'process_logistics',bulk_embroidery:'process_logistics',bulk_print_embroidery:'process_logistics',factory_production:'factory_production_qc',ship_sample_advance:'bulk_ship_sample',garment_inspection:'receiving_inspection',garment_rework:'rework',garment_packing:'packing',receiving_span:'receipts'};
export const journeyTimingKey=(id:string)=>aliases[id.split(':')[0]!]??id.split(':')[0]!;
export type JourneyTimingEvidence={facts:Record<string,SlaNodeFact>;labels?:ReadonlyMap<string,{scopeLabel:string;snapshotId?:string|null}>};
const open=(state:string)=>!['completed','inherited','cancelled','not_applicable','unavailable'].includes(state);
/** No new event or risk formula: adapt the canonical evaluation inside Journey's authorized snapshot. */
export function attachJourneySupervision(item:OrderJourney,plan:SlaPlan|null,original:SlaPlan|null,nodes:SlaNodeEvaluation[],time:BusinessTime,revisions:{original:number|null;current:number|null},external=false,native?:JourneyTimingEvidence,authorizedTaskIds?:ReadonlySet<string>) {
 const definitions=new Map(plan?.nodes.map(n=>[n.id,n])??[]),originals=new Map(original?calculateSlaPlan(original).map(n=>[n.id,n.end]):[]);
 const timing:JourneyTiming[]=nodes.flatMap(n=>{const definition=definitions.get(n.id);if(!definition||definition.applicable==='no'||definition.kind==='unlimited'||definition.parameterKey==='bulk_cutting'&&external)return [];
  const fact=native?.facts[n.id],line=item.lines.find(line=>line.id===n.id.split(':')[1]);
  const windows=fact?.batchWindows?.map(window=>({...window,...(native?.labels?.get(window.evidence)??{scopeLabel:line?`PO ${line.po??'号码尚未取得'} · ${line.color}`:'本批范围依据尚未取得'})}));
  return [{id:n.id,label:definition.label,stage:JOURNEY_STAGES[definition.stage-1]!.key,kind:definition.kind,status:n.status,...(windows?{windows,coverageComplete:fact?.batchCoverageComplete===true}:{}),...(n.logisticsWindows?{logisticsWindows:n.logisticsWindows}:{}),...(n.assessmentIssue?{assessmentIssue:n.assessmentIssue}:{}),...(n.provenRisk?{provenRisk:n.provenRisk}:{}),actualStart:n.actualStart,actualEnd:n.actualEnd,target:n.deadline,forecast:n.forecast,forecastBasis:n.forecastBasis,original:originals.get(n.id)??{at:null,exclusive:false,reasons:['没有首版目标']},current:n.end}];});
 const coverage:JourneySupervision['coverage']=nodes.flatMap(n=>n.assessmentIssue?[{key:'fact_time' as const,message:`${definitions.get(n.id)?.label??n.id}：${n.assessmentIssue.reason}${n.provenRisk==='overdue'?'；另有可信批次已逾期':n.provenRisk==='warning'?'；另有可信批次已临期':''}`}]:[]);
 if(item.orderId){
  const dates=item.poDeliveryDates??[],missingCustomer=Math.max(item.lines.length-dates.filter(l=>l.customerWarehouseArrivalDate).length,0),missingFactory=Math.max(item.lines.length-dates.filter(l=>l.factoryDeliveryDate).length,0);
  if(missingCustomer)coverage.push({key:'customer_date',message:`${missingCustomer}个PO没填客户要求出货日期，整单交期统计只含已填PO；到原订单补齐`});
  if(missingFactory)coverage.push({key:'factory_date',message:`${missingFactory}个PO没填工厂交货日期，未计入对应工厂交期监督；到原外发申请核对`});
  const fabric=timing.find(n=>n.id==='fabric_inspection');
  if(fabric&&!fabric.actualStart&&!fabric.actualEnd&&!fabric.forecast.at&&plan?.anchors.expected_fabric_arrival?.precision==='unknown')coverage.push({key:'fabric_date',message:'没填预计到布日期，布料线预计无法计算；到原材料计划核对，不影响其它已知节点统计'});
  const cutting=timing.find(n=>n.id==='bulk_cutting'),rawCutting=item.stages.flatMap(s=>s.nodes).find(n=>n.key==='bulk_cutting'&&n.current);
  if(cutting&&!cutting.actualStart&&rawCutting&&['active','completed'].includes(rawCutting.state))coverage.push({key:'cutting_time',message:'没有可信的裁床实际收布时间，24小时时效不能精确评价；保留已知计划，不增加收布填报'});
 }
 if(!plan)coverage.push({key:'plan',message:'此历史单没有首版SLA计划，仍监督原任务截止；不补造历史计划'});
 const reminder=timing.filter(n=>n.id.startsWith('order_shipping_reminder:')&&n.target.at).map(n=>new Date(Date.parse(n.target.at!)-(n.target.exclusive?1:0)).toLocaleDateString('en-CA',{timeZone:'Asia/Shanghai'})).sort()[0]??null;
 item.supervision={assessment:nodes.some(n=>n.assessmentIssue)?'partially_unavailable':'complete',asOf:time.now,status:plan?'planned':'legacy_unenrolled',originalRevision:revisions.original,currentRevision:revisions.current,nodes:timing,coverage,customerReminderDate:reminder};
 if(native){
  const visibleKeys=new Set(item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&!['unavailable','not_applicable'].includes(node.state)).map(node=>node.key));
  item.supervision.nativeFacts=Object.entries(native.facts).filter(([id])=>visibleKeys.has(journeyTimingKey(id)))
   .map(([id,fact])=>({id,sourceRef:fact.evidence,timeRole:'sla_observation',startedAt:fact.startedAt??null,completedAt:fact.completedAt??null,businessCompleted:fact.businessCompleted??null}));
 }
 for(const stage of item.stages)for(const node of stage.nodes){
  if(!node.current)continue;
  const lineIds=new Set(node.records.flatMap(record=>record.lineId?[record.lineId]:[]));
  const matches=timing.filter(t=>journeyTimingKey(t.id)===node.key&&(!lineIds.size
   ||!item.lines.some(line=>line.id===t.id.split(':')[1])||lineIds.has(t.id.split(':')[1]!)));
  // Multiple PO/batch windows share the existing aggregate's risk, never invent a single aggregate target.
  if(!matches.length)continue;
  if(matches.length>1)node.timings=matches;
  if(matches.length===1){const t=matches[0]!;node.timing=t;
   const originalTaskTarget=node.expectedKind==='sla'&&node.expectedAt&&(authorizedTaskIds?.has(node.instanceId)||node.records.some(record=>record.domain==='task'&&record.id===node.instanceId));
   if(!originalTaskTarget&&!(['estimate','included'].includes(t.kind)&&!t.target.at)){
    node.expectedAt=t.target.at;node.expectedPrecision=t.target.at?'instant':'missing';node.expectedKind=t.target.at?'sla':'unset';
   }
  }
  if(open(node.state)){
   node.risks=node.risks.filter(r=>r!=='overdue'&&(r!=='due_soon'||matches.every(t=>['offset','order_date'].includes(t.kind))));
   if(matches.some(t=>t.status==='overdue'||t.provenRisk==='overdue'))node.risks.push('overdue');else if(matches.some(t=>t.status==='warning'||t.provenRisk==='warning'))node.risks.push('due_soon');
   if(matches.some(t=>t.status==='unknown')&&!node.risks.includes('unknown'))node.risks.push('unknown');
  }
 }
}
export async function readJourneySupervision(database:Pool,db:PoolClient,actor:TrustedActorContext,item:OrderJourney,time:BusinessTime,external=false,authorizedTaskIds?:ReadonlySet<string>){
 if(item.orderId){const read=await new SlaOrderService(database,{read:async()=>time}).readWithClient(actor,item.orderId,db,{mode:"read_projection"});
  attachJourneyNativeTimes(item,{orderId:read.receiving.orderId,rework:read.rework.windows,receiving:read.receiving.receivingSpan},read.time.now);
  if(read.status==='planned'){
   const labels=new Map<string,{scopeLabel:string;snapshotId?:string|null}>();
   const scope=(ids:string[])=>ids.length?ids.map(id=>{const line=item.lines.find(line=>line.id===id);return line?`PO ${line.po??'号码尚未取得'} · ${line.color}`:'PO范围依据尚未取得';}).join(' / '):'本批PO范围依据尚未取得';
   for(const window of read.factory?.windows??[])labels.set(window.evidence,{scopeLabel:scope(window.lineIds),snapshotId:window.snapshotId??null});
   for(const window of read.rework.windows){const rework=read.receiving.lines.flatMap(line=>line.reworks).find(row=>row.reworkId===window.reworkId);labels.set(window.evidence,{scopeLabel:`${scope([window.lineId])} · ${rework?.reworkNo??'原做尾或返工记录'}`,snapshotId:window.snapshotId});}
   for(const window of read.garments.windows)labels.set(window.evidence,{scopeLabel:`${scope([window.lineId])} · 本批实收${read.garments.quality.find(row=>row.receiptId===window.receiptId)?.quantity??'范围待核'}件`,snapshotId:window.snapshotId});
   attachJourneySupervision(item,read.evaluationPlan,read.original.plan,read.nodes,read.time,{original:read.original.revision,current:read.current.revision},external,{facts:read.facts,labels},authorizedTaskIds);
  }
  else attachJourneySupervision(item,null,null,[],read.time,{original:null,current:null},external,{facts:read.facts},authorizedTaskIds);
 }else if(item.sourceId){const saved=await developmentSlaPlan(db,item.sourceId);
  if(!saved){attachJourneySupervision(item,null,null,[],time,{original:null,current:null},false,{facts:await developmentNativeFacts(db,item.sourceId,time)},authorizedTaskIds);}
  else {
  const evidence=await developmentSlaEvidence(db,item.sourceId,time),plan=developmentEvaluationPlan(saved.plan_json,evidence?.facts??{});
  attachJourneySupervision(item,plan,saved.plan_json,evaluateSlaPlan(plan,evidence?.facts??{},time,{mode:"read_projection"}),time,{original:1,current:saved.revision},false,{facts:evidence?.facts??{}},authorizedTaskIds);
  }
 }
 if(item.supervision?.assessment==='partially_unavailable')item.supervision.requestId=actor.requestId;
 if(time.scenarioId){const current=await new ContextBusinessClock(database,db).read(item.orderId?{kind:'order',id:item.orderId}:{kind:'source',id:item.sourceId!});
  if(current.scenarioId!==time.scenarioId||current.revision!==time.revision)throw new ApplicationError('CONFLICT','测试时钟在读取期间已变化，请刷新原页面',409);
 }
}
