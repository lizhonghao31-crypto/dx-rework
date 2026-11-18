import {BulkWashingArrangementSchema,type BulkWashingArrangement} from '@dx-rework/contracts/bulk-washing';
import {frameworkScopeInputs} from './order-time-framework-route.js';
import {evaluateTimeFrameworkCandidate} from './order-time-framework.js';
import {orderTimeInputFromRoute} from './order-time-request-plan.js';
import {hasBothBuiltinCrafts,craftStepIdentity} from '@dx-rework/contracts/digital-craft';
import {FRAMEWORK_TIME_NODES,ORDER_TIME_NODES,OrderTimeCalculationSchema,type OrderTimeCalculation,type OrderTimeCalculationResult} from '@dx-rework/contracts/order-time-settings';
import {CraftStepChoicesSchema,craftLegacyLabel} from '@dx-rework/contracts/digital-craft';
import {isCalendarDate} from '@dx-rework/contracts/series-calendar';
import {slaAnchorTime} from '@dx-rework/domain/digital-sla-plan';
import {fixedDevelopmentWork} from './fixed-development-work.js';
import {fixedOrderWork} from './fixed-order-work.js';
import {developmentSlaRoute} from './development-sla-enrollment.js';
import {fixedConsumerTargets} from './fixed-timeline-adoptions.js';
import {fixedTimelineForward,requiredFixedTimelineWork} from './fixed-timeline-targets.js';
import type {FixedWorkInputs} from './fixed-work-definition.js';

/** The very same adopted native graph and R5-04 calendar engine. Temporary
 * inputs do not create orders, actual events, drafts or standard versions.
 */
export function orderTimeSettingsCalculation(raw:OrderTimeCalculation):OrderTimeCalculationResult{
 const input=OrderTimeCalculationSchema.parse(raw),developmentSteps=CraftStepChoicesSchema.parse(input.development.craftSteps),bulkSteps=CraftStepChoicesSchema.parse(input.bulk.craftSteps);
 if(new Set(input.lines.map(l=>l.id)).size!==input.lines.length||input.lines.some(l=>l.customerDate!==null&&!isCalendarDate(l.customerDate)))throw Error('请填写不同的PO编号和有效客户交期');
 const initial:FixedWorkInputs={data:{unified:{configurationId:'temporary',snapshotRef:'temporary',values:{ruleVersion:'20261023.1',parameters:{}}},development:null,planning:null,
  orderTimePlan:{version:'order-time-plan-v1',revision:1,overrides:{},company:{version:'order-time-standard-v1',reference:'temporary-calculation',revision:1,...input.values}}}};
 const doc={craft:craftLegacyLabel(developmentSteps),craftSteps:developmentSteps,washing:input.development.washing};
 const development=input.development.enabled?fixedDevelopmentWork(initial,'temporary-source',1,['development_materials',...developmentSlaRoute(doc,'整件样板',2)],developmentSteps.map(s=>({...s,stepId:'temporary-'+craftStepIdentity(s)})),hasBothBuiltinCrafts(developmentSteps),input.development.washing,input.development.accessories):null;
 let washing:BulkWashingArrangement|undefined;
 if(input.bulkWashing&&input.bulkWashing.mode!=='none'){
  if(!input.values.framework)throw Error('大货洗水演算须使用本次三层时间设置');
  const prefix=input.bulkWashing.mode==='factory'?'bulk_factory_washing':'bulk_return_washing';
  const duration=(key:string)=>{const rule=input.values.nodes[key];if(!rule||rule.minutes===null||!rule.calendar)throw Error('请先填写本次所选大货洗水和检查用时');return {minutes:rule.minutes,calendar:rule.calendar,reminder:rule.reminder};};
  washing=BulkWashingArrangementSchema.parse({mode:input.bulkWashing.mode,accounting:input.bulkWashing.mode==='after_receipt'?'additional':input.bulkWashing.accounting,reference:'temporary-calculation',revision:1,washing:duration(prefix),inspection:duration(prefix+'_inspection')});
 }
 const bulk=fixedOrderWork(initial,'temporary-order','temporary-source',1,input.bulk.preshrink?'需要预缩':'不需预缩',bulkSteps.map(s=>({...s,stepId:'temporary-'+craftStepIdentity(s)})),hasBothBuiltinCrafts(bulkSteps),development,input.lines.map(l=>({line_id:l.id,goal:l.customerDate?{precision:'date',value:l.customerDate,source:'本次填写的客户交期'}:{precision:'unknown',reason:'请填写客户交期'},customerDateVersion:0,...(washing?{washing}:{})})),input.frameworkRoute);
 const frameworkInputs=input.values.framework&&input.frameworkRoute&&input.lines.every(line=>line.customerDate)?frameworkScopeInputs(orderTimeInputFromRoute(initial.data.orderTimePlan!,bulk,new Map(bulk.consumers.map(row=>[row.scopeRef,row.ends[row.customerGoalIds![0]!]!])),true),input.frameworkRoute,{precision:'instant',value:input.startAt,source:'本次演算接单时刻'}):[];
 const candidates=new Map(frameworkInputs.map(value=>[value.scopeRef,evaluateTimeFrameworkCandidate(value,{purpose:'settings_preview',observedAt:input.startAt})]));
 const catalog=new Map([...ORDER_TIME_NODES,...FRAMEWORK_TIME_NODES].map(n=>[n.key,n]));
 return {lines:bulk.consumers.map((consumer,index)=>{
  const candidate=candidates.get(consumer.scopeRef);
  const work=bulk.work.filter(w=>consumer.nodeIds.includes(w.id)),targets=candidate?.arranged??fixedConsumerTargets(work,consumer);
  const terminals=consumer.customerGoalIds??[],required=requiredFixedTimelineWork(work,terminals),ids=new Set(required.map(w=>w.id));
  const forward=candidate?.arranged??fixedTimelineForward(required,{precision:'instant',value:input.startAt,source:'本次填写的参考时间'}),ends=terminals.map(id=>forward.find(w=>w.id===id)!.end);
  const expectedEnd=ends.length&&ends.every(e=>e.at)?new Date(Math.max(...ends.map(e=>Date.parse(e.at!)))).toISOString():null;
  const customerDate=input.lines[index]!.customerDate,goal=slaAnchorTime(customerDate?{precision:'date',value:customerDate,source:'本次填写的客户交期'}:{precision:'unknown',reason:'请填写客户交期'},'客户交期');
  const rows=work.map(node=>{const target=targets.find(t=>t.id===node.id)??fixedConsumerTargets(work,consumer).find(t=>t.id===node.id)!,key=node.parameterKey??node.id,meta=catalog.get(key);return {id:node.id,parameterKey:key,label:meta?.label??(key==='source_confirmation'?'开发交接':key==='development_craft_confirmation'?'确认工艺回收':'流程交接'),stage:meta?.stage??2,minutes:node.minutes,calendar:node.calendar,startAt:target.start.at,startExclusive:target.start.exclusive,endAt:target.end.at,endExclusive:target.end.exclusive,includedIn:node.includedIn??null,missing:[...new Set([...target.start.reasons,...target.end.reasons])]};});
  const stages=Array.from({length:7},(_,i)=>{const stage=i+1,nodes=rows.filter(r=>r.stage===stage&&ids.has(r.id)&&!r.includedIn),times=nodes.map(n=>forward.find(f=>f.id===n.id)!);return {stage,spanMinutes:times.length&&times.every(t=>t.start.at&&t.end.at)?(Math.max(...times.map(t=>Date.parse(t.end.at!)))-Math.min(...times.map(t=>Date.parse(t.start.at!))))/60000:null};});
  const difference=expectedEnd&&goal.at?(Date.parse(goal.at)-Date.parse(expectedEnd))/60000:null;
  const closedEnd=ends.some(end=>end.at===expectedEnd&&!end.exclusive);
  const deliveryStatus=difference===null?'unknown' as const:difference<0||difference===0&&goal.exclusive&&closedEnd?'insufficient' as const:'sufficient' as const;
  return {...(candidate?{milestones:candidate.milestones}:{}),id:input.lines[index]!.id,customerDate:input.lines[index]!.customerDate,totalSpanMinutes:expectedEnd?(Date.parse(expectedEnd)-Date.parse(input.startAt))/60000:null,expectedEnd,marginMinutes:difference,deliveryStatus,stages,rows};
 })};
}
