import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {SlaAnchor} from '@dx-rework/domain/digital-sla-plan';
import {slaAnchorTime} from '@dx-rework/domain/digital-sla-plan';
import {FrozenOrderTimePlanSchema,orderTimeRule,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import {FrameworkNativeDurationSchema} from '@dx-rework/contracts/order-time-framework';
import {orderTimeWorkDefinition,orderTimeDependencyReserves} from './fixed-work-definition.js';
import {fixedTimelineForward,requiredFixedTimelineWork,type FixedTimelineTarget,type FixedTimelineWork,type FixedTimelineCalendar} from './fixed-timeline-targets.js';
import {fixedConsumerTargets,type ShipSampleTarget} from './fixed-consumer-targets.js';

export type OrderTimeWork={id:string;parameterKey:string;stage:number;dependsOn:readonly string[];includedIn?:string;includedPosition?:'start'|'end';canonicalWorkRef?:string;craftStep?:CraftStepChoice;nativeDuration?:{reference:string;minutes:number|null;calendar:FixedTimelineCalendar|null}};
export type OrderTimeScope={scopeRef:string;terminalIds:readonly string[];goals:Readonly<Record<string,SlaAnchor>>;customerGoal:SlaAnchor;shipSample?:ShipSampleTarget};
export type OrderTimeScenario={plan:FrozenOrderTimePlan;work:readonly OrderTimeWork[];scopes:readonly OrderTimeScope[];
 route:{complete:boolean;missing:readonly string[]};start:SlaAnchor;notBefore?:Readonly<Record<string,SlaAnchor>>;
 fixedTargets?:Readonly<Record<string,FixedTimelineTarget>>};

/** One order's explicit applicable graph, with no task IDs or current settings
 * lookup. Missing route/time inputs stay unknown; none become zero-duration work.
 */
export function buildOrderTimeWork(plan:FrozenOrderTimePlan,work:readonly OrderTimeWork[]):FixedTimelineWork[]{
 const saved=FrozenOrderTimePlanSchema.parse(plan),byId=new Map(work.map(node=>[node.id,node]));
 if(byId.size!==work.length)throw Error('本单节点身份重复');
 const buffer=saved.stageBufferMinutes??saved.company.stageBufferMinutes;
 return work.map(node=>{
  if(!Number.isInteger(node.stage)||node.stage<1||node.stage>7)throw Error('本单节点阶段无效');
  const definition=orderTimeWorkDefinition(saved,node.parameterKey,node.craftStep);
  if(node.nativeDuration){
   if(!/^(bulk_(factory|return)_washing(_inspection)?|factory_production_work)$/.test(node.parameterKey))throw Error('原生范围用时不属于洗水或工厂内含分解');
   Object.assign(definition,FrameworkNativeDurationSchema.parse(node.nativeDuration));
  }
  const rule=orderTimeRule(saved,node.parameterKey)?.rule;
  if(rule&&(rule.kind==='included')!==Boolean(node.includedIn))throw Error('内含交接必须沿真实所属窗口，不能重复计入路径');
  const parent=node.includedIn?byId.get(node.includedIn):null;
  if(node.includedIn&&!parent)throw Error('内含工序缺少原所属窗口');
  const calendar=parent?orderTimeWorkDefinition(saved,parent.parameterKey,parent.craftStep).calendar:definition.calendar;
  const reserves=orderTimeDependencyReserves(node,byId,buffer);
  return {id:node.id,dependsOn:[...node.dependsOn],minutes:definition.minutes,calendar,
   ...(node.includedIn?{includedIn:node.includedIn,includedPosition:node.includedPosition??'start'}:{}),
   ...(buffer&&Object.keys(reserves).length?{dependencyReserves:reserves}:{})};
 });
}

export function evaluateOrderTimeScenario(input:OrderTimeScenario){
 const work=buildOrderTimeWork(input.plan,input.work),missingRoute=input.route.complete?[]:input.route.missing.length?[...input.route.missing]:['本单适用路线尚未明确'];
 const start=slaAnchorTime(input.start,'本次安排开始');
 return input.scopes.map(scope=>{
  const required=requiredFixedTimelineWork(work,scope.terminalIds),ids=new Set(required.map(node=>node.id));
  const visible=work.filter(node=>ids.has(node.id)||node.includedIn&&ids.has(node.includedIn)||node.id===scope.shipSample?.nodeId),visibleById=new Map(visible.map(node=>[node.id,node]));
  const goals=Object.fromEntries(Object.entries(scope.goals).filter(([id])=>visibleById.has(id)));
  const targets=fixedConsumerTargets(visible,{ends:goals,...(scope.shipSample?{shipSample:scope.shipSample}:{})},goals,input.fixedTargets);
  const arranged=fixedTimelineForward(required,input.start,input.notBefore),terminal=scope.terminalIds.map(id=>arranged.find(node=>node.id===id)!);
  const end=terminal.length&&terminal.every(node=>node.end.at)?terminal.reduce((a,b)=>Date.parse(a.end.at!)>=Date.parse(b.end.at!)?a:b).end:null;
  const goal=slaAnchorTime(scope.customerGoal,'本PO客户交期');
  const roots=targets.filter(node=>visibleById.get(node.id)!.dependsOn.length===0&&!visibleById.get(node.id)!.includedIn);
  const planStart=roots.length&&roots.every(node=>node.start.at)?roots.reduce((a,b)=>Date.parse(a.start.at!)<=Date.parse(b.start.at!)?a:b).start:null;
  const coverage=[...new Set([...missingRoute,...targets.filter(node=>ids.has(node.id)).flatMap(node=>[...node.start.reasons,...node.end.reasons]),...arranged.flatMap(node=>[...node.start.reasons,...node.end.reasons]),...goal.reasons])];
  const known=coverage.length===0&&end?.at&&goal.at&&start.at;
  const boundary=known&&goal.exclusive&&!end.exclusive&&Date.parse(end.at!)===Date.parse(goal.at!);
  const difference=known?(Date.parse(end.at!)-Date.parse(goal.at!)+(boundary?1:0))/60000:null;
  return {scopeRef:scope.scopeRef,targets,arranged,expectedEnd:known?end:null,customerGoal:goal,
   feasibility:difference===null?'unknown' as const:difference>0?'insufficient' as const:'sufficient' as const,
   lateMinutes:difference===null?null:Math.max(0,difference),marginMinutes:difference===null?null:difference===0?0:-difference,
   requiredSpanMinutes:known?(Date.parse(end.at!)-Date.parse(start.at!))/60000:null,
   planSpanMinutes:!missingRoute.length&&planStart?.at&&goal.at?(Date.parse(goal.at)-Date.parse(planStart.at))/60000:null,
   coverage};
 });
}
