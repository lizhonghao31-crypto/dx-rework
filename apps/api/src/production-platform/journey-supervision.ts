import {ContextBusinessClock} from "../acceptance-clock/business-time.js";
import {ApplicationError} from "../platform/errors.js";
import type {Pool,PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {JourneySupervision,JourneyTiming,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {JOURNEY_STAGES} from '@dx-rework/contracts/digital-production-journey';
import {calculateSlaPlan,evaluateSlaPlan,type SlaNodeEvaluation,type SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {SlaOrderService} from './sla-order-service.js';
import {developmentSlaPlan} from './development-sla-enrollment.js';
import {developmentEvaluationPlan,developmentSlaEvidence} from './development-sla-evidence.js';

const aliases:Record<string,string>={production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',development_craft_return:'development_craft_confirmation',external_pattern:'development_external_pattern',bulk_printing:'process_logistics',bulk_embroidery:'process_logistics',bulk_print_embroidery:'process_logistics',factory_production:'factory_production_qc',ship_sample_advance:'bulk_ship_sample',garment_inspection:'receiving_inspection',garment_rework:'rework',garment_packing:'packing',receiving_span:'receipts'};
const open=(state:string)=>!['completed','inherited','cancelled','not_applicable','unavailable'].includes(state);
/** No new event or risk formula: adapt the canonical evaluation inside Journey's authorized snapshot. */
export function attachJourneySupervision(item:OrderJourney,plan:SlaPlan|null,original:SlaPlan|null,nodes:SlaNodeEvaluation[],time:BusinessTime,revisions:{original:number|null;current:number|null},external=false) {
 const definitions=new Map(plan?.nodes.map(n=>[n.id,n])??[]),originals=new Map(original?calculateSlaPlan(original).map(n=>[n.id,n.end]):[]);
 const timing:JourneyTiming[]=nodes.flatMap(n=>{const definition=definitions.get(n.id);if(!definition||definition.applicable==='no'||definition.kind==='unlimited'||definition.parameterKey==='bulk_cutting'&&external)return [];
  return [{id:n.id,label:definition.label,stage:JOURNEY_STAGES[definition.stage-1]!.key,kind:definition.kind,status:n.status,actualStart:n.actualStart,actualEnd:n.actualEnd,target:n.deadline,forecast:n.forecast,forecastBasis:n.forecastBasis,original:originals.get(n.id)??{at:null,exclusive:false,reasons:['没有首版目标']},current:n.end}];});
 const coverage:JourneySupervision['coverage']=[];
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
 item.supervision={asOf:time.now,status:plan?'planned':'legacy_unenrolled',originalRevision:revisions.original,currentRevision:revisions.current,nodes:timing,coverage,customerReminderDate:reminder};
 for(const stage of item.stages)for(const node of stage.nodes){
  if(!node.current)continue;
  const matches=timing.filter(t=>(aliases[t.id.split(':')[0]!]??t.id.split(':')[0])===node.key);
  // Multiple PO/batch windows share the existing aggregate's risk, never invent a single aggregate target.
  if(!matches.length)continue;
  if(matches.length===1){const t=matches[0]!;node.timing=t;
   if(!(['estimate','included'].includes(t.kind)&&!t.target.at)){
    node.expectedAt=t.target.at;node.expectedPrecision=t.target.at?'instant':'missing';node.expectedKind=t.target.at?'sla':'unset';
   }
  }
  if(open(node.state)){
   node.risks=node.risks.filter(r=>r!=='overdue'&&(r!=='due_soon'||matches.every(t=>['offset','order_date'].includes(t.kind))));
   if(matches.some(t=>t.status==='overdue'))node.risks.push('overdue');else if(matches.some(t=>t.status==='warning'))node.risks.push('due_soon');
   if(matches.some(t=>t.status==='unknown')&&!node.risks.includes('unknown'))node.risks.push('unknown');
  }
 }
}
export async function readJourneySupervision(database:Pool,db:PoolClient,actor:TrustedActorContext,item:OrderJourney,time:BusinessTime,external=false){
 if(item.orderId){const read=await new SlaOrderService(database,{read:async()=>time}).readWithClient(actor,item.orderId,db);
  if(read.status==='planned')attachJourneySupervision(item,read.evaluationPlan,read.original.plan,read.nodes,read.time,{original:read.original.revision,current:read.current.revision},external);
  else attachJourneySupervision(item,null,null,[],read.time,{original:null,current:null});
 }else if(item.sourceId){const saved=await developmentSlaPlan(db,item.sourceId);
  if(!saved){attachJourneySupervision(item,null,null,[],time,{original:null,current:null});}
  else {
  const evidence=await developmentSlaEvidence(db,item.sourceId,time),plan=developmentEvaluationPlan(saved.plan_json,evidence?.facts??{});
  attachJourneySupervision(item,plan,saved.plan_json,evaluateSlaPlan(plan,evidence?.facts??{},time),time,{original:1,current:saved.revision});
  }
 }
 if(time.scenarioId){const current=await new ContextBusinessClock(database).read(item.orderId?{kind:'order',id:item.orderId}:{kind:'source',id:item.sourceId!});
  if(current.scenarioId!==time.scenarioId||current.revision!==time.revision)throw new ApplicationError('CONFLICT','测试时钟在读取期间已变化，请刷新原页面',409);
 }
}
