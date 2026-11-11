import {ORDER_TIME_NODES,OrderTimeCalculationSchema,type OrderTimeCalculation,type OrderTimeCalculationResult} from '@dx-rework/contracts/order-time-settings';
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
 const development=input.development.enabled?fixedDevelopmentWork(initial,'temporary-source',1,['development_materials',...developmentSlaRoute(doc,'整件样板',2)],developmentSteps.map(s=>({...s,stepId:'temporary-'+s.craftKind})),developmentSteps.length===2,input.development.washing,input.development.accessories):null;
 const bulk=fixedOrderWork(initial,'temporary-order','temporary-source',1,input.bulk.preshrink?'需要预缩':'不需预缩',bulkSteps.map(s=>({...s,stepId:'temporary-'+s.craftKind})),bulkSteps.length===2,development,input.lines.map(l=>({line_id:l.id,goal:l.customerDate?{precision:'date',value:l.customerDate,source:'本次填写的客户交期'}:{precision:'unknown',reason:'请填写客户交期'},customerDateVersion:0})));
 const catalog=new Map(ORDER_TIME_NODES.map(n=>[n.key,n]));
 return {lines:bulk.consumers.map((consumer,index)=>{
  const work=bulk.work.filter(w=>consumer.nodeIds.includes(w.id)),targets=fixedConsumerTargets(work,consumer);
  const terminals=consumer.customerGoalIds??[],required=requiredFixedTimelineWork(work,terminals),ids=new Set(required.map(w=>w.id));
  const forward=fixedTimelineForward(required,{precision:'instant',value:input.startAt,source:'本次填写的参考时间'}),ends=terminals.map(id=>forward.find(w=>w.id===id)!.end);
  const expectedEnd=ends.length&&ends.every(e=>e.at)?new Date(Math.max(...ends.map(e=>Date.parse(e.at!)))).toISOString():null;
  const customerDate=input.lines[index]!.customerDate,goal=slaAnchorTime(customerDate?{precision:'date',value:customerDate,source:'本次填写的客户交期'}:{precision:'unknown',reason:'请填写客户交期'},'客户交期');
  const rows=work.map(node=>{const target=targets.find(t=>t.id===node.id)!,key=node.parameterKey??node.id,meta=catalog.get(key);return {id:node.id,parameterKey:key,label:meta?.label??(key==='source_confirmation'?'开发交接':key==='development_craft_confirmation'?'确认工艺回收':'流程交接'),stage:meta?.stage??2,minutes:node.minutes,calendar:node.calendar,startAt:target.start.at,startExclusive:target.start.exclusive,endAt:target.end.at,endExclusive:target.end.exclusive,includedIn:node.includedIn??null,missing:[...new Set([...target.start.reasons,...target.end.reasons])]};});
  const stages=Array.from({length:7},(_,i)=>{const stage=i+1,nodes=rows.filter(r=>r.stage===stage&&ids.has(r.id)&&!r.includedIn),times=nodes.map(n=>forward.find(f=>f.id===n.id)!);return {stage,spanMinutes:times.length&&times.every(t=>t.start.at&&t.end.at)?(Math.max(...times.map(t=>Date.parse(t.end.at!)))-Math.min(...times.map(t=>Date.parse(t.start.at!))))/60000:null};});
  const difference=expectedEnd&&goal.at?(Date.parse(goal.at)-Date.parse(expectedEnd)-(goal.exclusive&&Date.parse(goal.at)===Date.parse(expectedEnd)?1:0))/60000:null;
  return {id:input.lines[index]!.id,customerDate:input.lines[index]!.customerDate,totalSpanMinutes:expectedEnd?(Date.parse(expectedEnd)-Date.parse(input.startAt))/60000:null,expectedEnd,marginMinutes:difference,stages,rows};
 })};
}
