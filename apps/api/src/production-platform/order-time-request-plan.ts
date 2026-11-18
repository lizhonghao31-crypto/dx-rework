import {craftStepLabel} from '@dx-rework/contracts/digital-craft';
import {frozenCraftChoice} from './fixed-work-definition.js';
import type {OrderTimeRule} from '@dx-rework/contracts/order-time-plan';
import {createHash} from 'node:crypto';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {slaAnchorTime,slaDateBoundary,type SlaAnchor,type SlaTime} from '@dx-rework/domain/digital-sla-plan';
import {orderTimeNodeStage,ORDER_TIME_NODES,FRAMEWORK_TIME_NODES} from '@dx-rework/contracts/order-time-settings';
import {orderTimeRule,type FrozenOrderTimePlan} from '@dx-rework/contracts/order-time-plan';
import type {OrderTimeCheckResult} from '@dx-rework/contracts/order-time-requests';
import type {FixedTimelineInput} from './fixed-timeline-adoptions.js';
import type {OrderTimeInput} from './order-time-plan-repository.js';
import {buildOrderTimeWork} from './order-time-schedule.js';
import {fixedMinutesToMilliseconds,fixedTimelineElapsedMilliseconds,fixedTimelineForward,requiredFixedTimelineWork,shiftFixedTimelineMilliseconds,type FixedTimelineCalendar} from './fixed-timeline-targets.js';

export type OrderTimeNativeProgress={completed:boolean;actualAt:string|null;actualDate?:string|null;readyAt:string|null;deadline:string|null;calendar?:FixedTimelineCalendar|null;unresolvedOverrun?:boolean};
/** Scheduling upper bound for a completed date, never its actual timestamp.
 * Completed evidence is known by this observation; retain date precision in facts. */
export function orderTimeCompletionBound(fact:Pick<OrderTimeNativeProgress,'actualAt'|'actualDate'>,asOf?:string):SlaTime{
 if(fact.actualAt)return {at:fact.actualAt,exclusive:false,reasons:[]};
 if(fact.actualDate){const end=slaDateBoundary(fact.actualDate),upper=asOf?Math.min(Date.parse(end.at!),Date.parse(asOf)):Date.parse(end.at!);return {at:new Date(upper).toISOString(),exclusive:upper===Date.parse(end.at!),reasons:[]};}
 return {at:null,exclusive:false,reasons:['已完成但缺少可信完成时间']};
}

const digest=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** The parameter can still serve a future PO while a sibling keeps its old
 * native R/D. Determine applicability from the actual dependency graph, not
 * from labels or the last displayed row. */
export function orderTimeBegunStates(input:OrderTimeInput,progress:ReadonlyMap<string,OrderTimeNativeProgress>){
 const byId=new Map(input.work.map(work=>[work.id,work])),states=new Map(input.work.map(work=>[work.id,{any:false,all:true,seen:false}]));
 for(const scope of input.scopes){
  const ids=new Set<string>();const visit=(id:string)=>{if(ids.has(id))return;const work=byId.get(id);if(!work)return;ids.add(id);for(const prior of work.dependsOn)visit(prior);if(work.includedIn)visit(work.includedIn);};
  for(const id of new Set([...scope.terminalIds,...Object.keys(scope.goals)]))visit(id);
  for(const work of input.work)if(work.includedIn&&ids.has(work.includedIn))ids.add(work.id);
  for(const id of ids){const work=byId.get(id)!,ref=work.canonicalWorkRef??id,fact=progress.get(scope.scopeRef+'|'+ref)??progress.get(ref),begun=Boolean(fact?.readyAt||fact?.completed),state=states.get(id)!;state.any||=begun;state.all&&=begun;state.seen=true;}
 }
 return new Map([...states].map(([id,value])=>[id,{any:value.any,all:value.seen&&value.all}]));
}
/** Original route builders supply the graph. This adapter changes neither
 * dependency order nor the identity of a real task/step/PO. */
export function orderTimeInputFromRoute(plan:FrozenOrderTimePlan,route:Pick<FixedTimelineInput,'work'|'consumers'>,goals:ReadonlyMap<string,SlaAnchor>,complete:boolean,missing:string[]=[],creation?:{kind:'source'|'order';id:string}):OrderTimeInput{
 const work=route.work.map(node=>({id:node.id,parameterKey:node.parameterKey??node.id,stage:orderTimeNodeStage(node.parameterKey??node.id,node.stage??2),dependsOn:[...node.dependsOn],
  canonicalWorkRef:node.canonicalWorkRef,...(node.craftStep?{craftStep:frozenCraftChoice(node.craftStep)}:{}),...(node.nativeDuration?{nativeDuration:structuredClone(node.nativeDuration)}:{}),...(node.includedIn?{includedIn:node.includedIn,includedPosition:node.includedPosition??'start' as const}:{})}));
 if(creation&&!work.some(node=>node.parameterKey==='order_creation')){
  for(const node of work)if(!node.dependsOn.length&&!node.includedIn)node.dependsOn=['order_creation'];
  work.unshift({id:'order_creation',parameterKey:'order_creation',stage:1,dependsOn:[],canonicalWorkRef:`creation:${creation.kind}:${creation.id}`});
 }
 const scopes=route.consumers.map(consumer=>{
  const terminalIds=consumer.customerGoalIds?.length?[...consumer.customerGoalIds]:Object.keys(consumer.ends).filter(id=>id!=='development_shipping'&&!id.startsWith('ship_sample'));
  const goal=goals.get(consumer.scopeRef)??(terminalIds.length===1?consumer.ends[terminalIds[0]!]:undefined)??{precision:'unknown' as const,reason:'请填写本单交期'};
  return {scopeRef:consumer.scopeRef,lineId:consumer.lineId,customerDateVersion:consumer.customerDateVersion||1,terminalIds,customerGoalIds:consumer.lineId?[...terminalIds]:[],customerGoal:goal,
   goals:{...consumer.ends,...Object.fromEntries(terminalIds.map(id=>[id,goal]))},...(consumer.shipSample?{shipSample:consumer.shipSample}:{})};
 });
 return {version:'order-time-input-v1',plan:structuredClone(plan),work,scopes,route:{complete,missing:[...missing]}};
}

/** A remaining-work estimate is conditional on the actual declared route.
 * Completed work consumes no remaining budget. Begun work retains its original
 * R/D; an exhausted window has only "no earlier than now", never a fake C.
 * These temporary forward inputs are never saved as actuals or fixed B. */
type RemainingResult={scopes:Array<{scopeRef:string;coverage:string[];expectedEnd:SlaTime|null;feasibility:'unknown'|'insufficient'|'sufficient'|'not_applicable';lateMinutes:number|null;requiredSpanMinutes:number|null}>;lowerBound:boolean};
export function orderTimeRemaining(input:OrderTimeInput,time:BusinessTime,progress:ReadonlyMap<string,OrderTimeNativeProgress>,notBefore:Readonly<Record<string,SlaAnchor>>={},optionalDevelopmentGoal=false):RemainingResult{
 if(input.scopes.length>1||[...progress.keys()].some(key=>key.includes('|'))){
  const results=input.scopes.map(scope=>{
   const scoped=new Map(progress);for(const node of input.work){const ref=node.canonicalWorkRef??node.id,value=progress.get(scope.scopeRef+'|'+ref);if(value)scoped.set(ref,value);}
   for(const key of scoped.keys())if(key.includes('|'))scoped.delete(key);
   return orderTimeRemaining({...input,scopes:[scope]},time,scoped,notBefore,optionalDevelopmentGoal);
  });
  return {scopes:results.flatMap(result=>result.scopes),lowerBound:results.some(result=>result.lowerBound)};
 }
 const remaining=buildOrderTimeWork(input.plan,input.work),byId=new Map(input.work.map(node=>[node.id,node]));let lowerBound=false;
 for(const node of remaining){
  const source=byId.get(node.id)!,actual=progress.get(source.canonicalWorkRef??node.id);if(!actual||node.includedIn)continue;
  if(actual.completed){node.minutes=0;node.calendar='continuous';delete node.dependencyReserves;}
  else if(actual.readyAt){
   if(actual.unresolvedOverrun)lowerBound=true;
   if(!actual.deadline){node.minutes=null;continue;}
   delete node.dependencyReserves;
   const deadline=Date.parse(actual.deadline),now=Date.parse(time.now);
   const calendar=actual.calendar??node.calendar;
   let minutes=0;
   if(deadline>now&&calendar){
    // The native deadline is already on its original counted calendar. Find
    // its remaining counted duration without treating excluded days as work.
    let low=0,high=525600*60000;while(low<high){const mid=Math.floor((low+high)/2);if(shiftFixedTimelineMilliseconds(now,mid,calendar)<deadline)low=mid+1;else high=mid;}minutes=high/60000;
   }else lowerBound=true;
   node.minutes=calendar?minutes:null;node.calendar=calendar;
  }
 }
 for(const node of remaining){
  if(!node.dependencyReserves)continue;
  node.dependencyReserves=Object.fromEntries(Object.entries(node.dependencyReserves).map(([id,reserve])=>{
   const source=byId.get(id)!,prior=progress.get(source.canonicalWorkRef??id);
   if(!prior?.completed||!prior.actualAt)return [id,reserve];
   const original=fixedMinutesToMilliseconds(reserve.minutes);
   const elapsed=Math.max(0,fixedTimelineElapsedMilliseconds(Date.parse(prior.actualAt),Date.parse(time.now),'continuous'));
   return [id,{...reserve,minutes:Math.max(0,original-elapsed)/60000}];
  }));
 }
 // Included work remains inside the same parent and cannot add a second span.
 for(const node of remaining.filter(node=>node.includedIn)){const parent=remaining.find(work=>work.id===node.includedIn)!;node.minutes=0;node.calendar=parent.calendar;}
 const scopes=input.scopes.map(scope=>{
  const required=requiredFixedTimelineWork(remaining,scope.terminalIds),arranged=fixedTimelineForward(required,{precision:'instant',value:time.now,source:'当前进度演算，不是真实完成'},notBefore);
  const ends=scope.terminalIds.map(id=>{const work=byId.get(id)!,actual=progress.get(work.canonicalWorkRef??id);
   return actual?.completed?orderTimeCompletionBound(actual,time.now):arranged.find(node=>node.id===id)!.end;
  }),goal=slaAnchorTime(scope.customerGoal,'客户交期');
  const end=ends.length&&ends.every(value=>value.at)?ends.reduce((a,b)=>{
   const difference=Date.parse(a.at!)-Date.parse(b.at!);
   return difference>0||difference===0&&!a.exclusive?a:b;
  }):null;
  // Only the original independent-development adapter can opt out of an
  // absent optional sample goal. Route, durations, supply and actual evidence
  // still have to be computable; a formal PO can never borrow this exception.
  const goalOptional=optionalDevelopmentGoal&&scope.scopeRef.startsWith('source:')&&scope.customerGoal.precision==='unknown';
  const coverage=[...new Set([...(input.route.complete?[]:input.route.missing),...arranged.flatMap(node=>{const original=byId.get(node.id)!,label=ORDER_TIME_NODES.find(entry=>entry.key===original.parameterKey)?.label??'流程交接';return [...node.start.reasons,...node.end.reasons].map(reason=>`${label}：${reason}`);}),...ends.flatMap(end=>end.reasons),...(goalOptional?[]:goal.reasons)])];
  const known=input.route.complete&&!coverage.length&&end?.at&&(goalOptional||goal.at);
  const difference=known&&goal.at?(Date.parse(end.at!)-Date.parse(goal.at!))/60000:null;
  const insufficient=difference!==null&&(difference>0||difference===0&&goal.exclusive&&!end!.exclusive);
  return {scopeRef:scope.scopeRef,coverage,expectedEnd:known?end:null,feasibility:known&&goalOptional?'not_applicable' as const:difference===null?'unknown' as const:insufficient?'insufficient' as const:'sufficient' as const,
   lateMinutes:difference===null?null:Math.max(0,difference),requiredSpanMinutes:known?Math.max(0,(Date.parse(end.at!)-Date.parse(time.now))/60000):null};
 });
 return {scopes,lowerBound};
}

export function orderTimeCheck(input:{value:OrderTimeInput;time:BusinessTime;progress:ReadonlyMap<string,OrderTimeNativeProgress>;sourceVersion:Record<string,unknown>;resource:OrderTimeCheckResult['resource'];styleNo:string;customerDates:OrderTimeCheckResult['customerDates'];canRequest:boolean;canApply:boolean;notBefore?:Readonly<Record<string,SlaAnchor>>;extraSettings?:ReadonlyMap<string,boolean>;optionalDevelopmentGoal?:boolean}):OrderTimeCheckResult{
 const {value,time}=input,{scopes,lowerBound}=orderTimeRemaining(value,time,input.progress,input.notBefore,input.resource.kind==='source'&&input.optionalDevelopmentGoal===true),coverage=[...new Set(scopes.flatMap(scope=>scope.coverage))];
 const computable=scopes.length>0&&scopes.every(scope=>scope.feasibility!=='unknown'),compared=scopes.filter(scope=>scope.feasibility!=='not_applicable'),late=computable&&compared.length?Math.max(...compared.map(scope=>scope.lateMinutes??0)):null;
 const insufficient=compared.some(scope=>scope.feasibility==='insufficient');
 const known=computable&&(!lowerBound||insufficient);if(computable&&lowerBound&&!insufficient)coverage.push('在办节点已超时，剩余工作时间尚未确认');
 const required=computable?Math.max(...scopes.map(scope=>scope.requiredSpanMinutes??0)):null;
 const available=scopes.map(scope=>slaAnchorTime(value.scopes.find(row=>row.scopeRef===scope.scopeRef)!.customerGoal,'客户交期').at).filter((at):at is string=>Boolean(at));
 const catalog=new Map([...ORDER_TIME_NODES,...FRAMEWORK_TIME_NODES].map(node=>[node.key,node]));
 const begun=orderTimeBegunStates(value,input.progress);
 const rows=value.work.map(work=>{
  const special=work.craftStep?.specialCraft?.definition[work.parameterKey.startsWith('development_')?'development':'bulk'];
  const nativeRule:OrderTimeRule|null=special?{kind:'work',...structuredClone(special)}:null;
  return {id:work.id,parameterKey:work.parameterKey,label:work.craftStep?craftStepLabel(work.craftStep):catalog.get(work.parameterKey)?.label??(work.parameterKey==='source_confirmation'?'开发交接':'流程交接'),stage:work.stage,
   rule:orderTimeRule(value.plan,work.parameterKey)?.rule??nativeRule,originalRule:value.plan.company.nodes[work.parameterKey]??nativeRule,
   begun:begun.get(work.id)?.all===true,preserveBegun:begun.get(work.id)?.any===true,includedIn:work.includedIn??null};
 });
 for(const [key,begun]of input.extraSettings??[]){const node=catalog.get(key);if(node&&!rows.some(row=>row.parameterKey===key))rows.push({id:'setting:'+key,parameterKey:key,label:node.label,stage:node.stage,rule:orderTimeRule(value.plan,key)?.rule??null,originalRule:value.plan.company.nodes[key]??null,begun,preserveBegun:begun,includedIn:null});}
 return {enabled:true,fingerprint:digest({operation:input.sourceVersion,company:value.plan.company,work:value.work,scopes:value.scopes,scenario:time.scenarioId,revision:time.revision}),resource:input.resource,styleNo:input.styleNo,customerDates:input.customerDates,plan:value.plan,rows,coverage,
  feasibility:!known?'unknown':!compared.length?'not_applicable':insufficient?'insufficient':'sufficient',availableMinutes:available.length===scopes.length?Math.min(...available.map(at=>(Date.parse(at)-Date.parse(time.now))/60000)):null,
  requiredMinutes:required,lateMinutes:late,expectedEnd:computable?scopes.reduce((at,scope)=>!at||Date.parse(scope.expectedEnd!.at!)>Date.parse(at)?scope.expectedEnd!.at!:at,null as string|null):null,
  forecastQuality:!computable?'unknown':lowerBound?'lower_bound':'conditional',canRequest:input.canRequest,canApply:input.canApply,sourceVersion:input.sourceVersion};
}
