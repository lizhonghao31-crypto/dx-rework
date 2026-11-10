import {evaluateFixedJourneyBasis,nextFixedScheduleClassification} from './fixed-schedule-basis.js';
import type {BusinessTime} from '@dx-rework/domain/business-clock';
import {evaluateSlaPlan,slaDateBoundary} from '@dx-rework/domain/digital-sla-plan';
import {poDeliveryRisks} from '@dx-rework/contracts';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {attachJourneySupervision,type JourneyTimingInputs} from './journey-supervision.js';
import {journeyObservedDay,journeyPlanDateOverdue,journeyTaskTimeRisks} from './journey-risk-clock.js';
import {journeySelectionNodes,type JourneySelectionFacts,type JourneySelectionTask} from './journey-selection-facts.js';
import {journeyUnfilteredSignals,type JourneySelectionSignals} from './journey-projection.js';
import {journeyActivated} from './journey-display.js';

export type JourneySelectionClockFrame={
 from:string;
 schedule:{state:'normal'|'late'|'unknown'|'terminated';lagLineIds:string[];dueLineIds:string[];unknownLineIds:string[]}|null;
 /** Only time-dependent flags, never copies of documents, grants or plans. */
 risks:Array<{id:string;risks:JourneySelectionFacts['nodes'][number]['risks']}>;
 nativeRisks:JourneySelectionClockFrame['risks'];
 untimedRisks:JourneySelectionClockFrame['risks'];
 coverage:JourneySelectionFacts['coverage'];
 deliveryRisks:JourneySelectionFacts['deliveryRisks'];
 partialDeliveryRisks:JourneySelectionFacts['deliveryRisks'];
 customerReminderDate:string|null;
 fullSignals:JourneySelectionSignals&{activated:boolean};
};
export type JourneySelectionDelivery={finished:boolean;terminal?:boolean;factoryFinished:boolean;sampleFinished:boolean;sentLineIds:string[]};
/** Compile the finite warning/deadline/date transitions once per changed
 * mother. Ordinary reads select a frame; midnight never requires rebuilding
 * all mothers. The canonical engine still defines every SLA boundary/risk.
 * Actual events ahead of the observation are a separate recheck boundary:
 * crossing one must re-read its native evidence, not invent a new event. */
export function compileJourneySelectionClock(item:OrderJourney,untimed:OrderJourney,inputs:JourneyTimingInputs,tasks:readonly JourneySelectionTask[],nativeNodes:JourneySelectionFacts['nodes'],delivery:JourneySelectionDelivery,time:BusinessTime):{frames:JourneySelectionClockFrame[];expiresAt:string|null}{
 if(item.asOf!==time.now||untimed.asOf!==time.now)throw Error('Journey clock compilation requires one observation');
 const taskById=new Map(tasks.map(task=>[task.id,task]));
 const baseNodes=untimed.stages.flatMap(stage=>stage.nodes).filter(node=>node.current);
 const originalNative=structuredClone(nativeNodes);
 let hardBoundary:number|null=null;
 for(const fact of Object.values(inputs.facts))for(const actual of [fact,...fact.batchWindows??[]])for(const at of [actual.startedAt,actual.completedAt]){
  if(!at)continue;const value=Date.parse(at);
  if(value>Date.parse(time.now)&&(hardBoundary===null||value<hardBoundary))hardBoundary=value;
 }
 for(const scope of inputs.fixedSchedule?.scopes??[])for(const fact of Object.values(scope.facts))for(const point of [fact.ready,fact.completed,fact.clockStart]){
  const future=point.precision==='instant'?Date.parse(point.at):point.precision==='date'?Date.parse(point.date+'T00:00:00+08:00'):NaN;
  if(future>Date.parse(time.now)&&(hardBoundary===null||future<hardBoundary))hardBoundary=future;
 }
 const frames:JourneySelectionClockFrame[]=[];
 let at=time.now,previous='';
 for(;;){
  const now=Date.parse(at);let next:number|null=null;
  const reconsider=(value:string|null|undefined,strict=false)=>{
   if(!value)return;const parsed=Date.parse(value);if(!Number.isFinite(parsed))throw Error('Invalid Journey clock boundary');
   const boundary=parsed+(strict?1:0);if(boundary>now&&(next===null||boundary<next))next=boundary;
  };
  const dateBoundary=(value:string|null|undefined)=>{
   if(!value)return;const end=slaDateBoundary(value).at!;
   reconsider(new Date(Date.parse(end)-86400000).toISOString());reconsider(end);
  };
  const day=journeyObservedDay(at);
  const taskRisks=(node:JourneySelectionFacts['nodes'][number])=>{
   const task=taskById.get(node.instanceId);
   if(!task||['not_applicable','unavailable','cancelled'].includes(node.state))return [...node.risks];
   if(['active','blocked'].includes(task.state)){reconsider(task.dueAt,task.deadlineExclusive===false);reconsider(task.warningAt);}
   return [...journeyTaskTimeRisks(task,at),...node.risks.filter(risk=>risk!=='overdue'&&risk!=='due_soon')];
  };
  const projected=structuredClone(untimed);projected.asOf=at;
  for(const node of projected.stages.flatMap(stage=>stage.nodes)){
   if(!node.current)continue;
   node.risks=taskRisks({...journeySelectionNodes([node])[0]!});
   if(node.key==='development_material_supply'||node.planningOnly){
    const active=!['completed','inherited','not_applicable','unavailable','cancelled'].includes(node.state);
    if(active&&node.expectedPrecision==='date'&&node.expectedAt){
     dateBoundary(node.expectedAt);node.risks=node.risks.filter(risk=>risk!=='overdue');
     if(journeyPlanDateOverdue(node.expectedAt,day))node.risks.push('overdue');
    }
   }
  }
  const untimedRisks=projected.stages.flatMap(stage=>stage.nodes).filter(node=>node.current).map(node=>({id:node.instanceId,risks:[...node.risks]}));
  const nativeRisks=originalNative.map(node=>({id:node.instanceId,risks:taskRisks(node)}));
  // Material nodes exist before domain substitution too; use their freshly
  // evaluated original date flags rather than the build-time day.
  for(const node of originalNative)if(node.key==='development_material_supply'){
   const fresh=untimedRisks.find(value=>value.id===node.instanceId);if(fresh)nativeRisks.find(value=>value.id===node.instanceId)!.risks=[...fresh.risks];
  }
  const evaluation=inputs.plan?evaluateSlaPlan(inputs.plan,inputs.facts,{...time,now:at},{mode:'read_projection',onNextChange:reconsider}):[];
  attachJourneySupervision(projected,inputs.plan,inputs.original,evaluation,{...time,now:at},
   {original:item.supervision?.originalRevision??null,current:item.supervision?.currentRevision??null},
   tasks.some(task=>task.kind==='bulk_cutting_external'),{facts:inputs.facts},new Set(tasks.map(task=>task.id)));
  const deliveryRisks=poDeliveryRisks(item.poDeliveryDates??[],day,delivery).filter(risk=>risk.kind!=='sample'||!delivery.sentLineIds.includes(risk.lineId))
   .map(risk=>({nodeKey:risk.nodeKey,risk:risk.risk,lineId:risk.lineId}));
  const partialDeliveryRisks=poDeliveryRisks(item.poDeliveryDates??[],day,{...delivery,finished:delivery.terminal??delivery.finished})
   .filter(risk=>risk.kind!=='sample'||!delivery.sentLineIds.includes(risk.lineId)).map(risk=>({nodeKey:risk.nodeKey,risk:risk.risk,lineId:risk.lineId}));
  if(!delivery.finished||delivery.terminal===false){
   for(const line of item.poDeliveryDates??[]){dateBoundary(line.customerWarehouseArrivalDate);if(!delivery.factoryFinished)dateBoundary(line.factoryDeliveryDate);if(!delivery.sampleFinished&&!delivery.sentLineIds.includes(line.lineId))dateBoundary(line.sampleTargetDate);}
   dateBoundary(projected.supervision?.customerReminderDate);
  }
  const fixed=inputs.fixedSchedule?evaluateFixedJourneyBasis(inputs.fixedSchedule,at,false):null;
  if(inputs.fixedSchedule)reconsider(nextFixedScheduleClassification(inputs.fixedSchedule,at));
  const schedule=fixed?{state:fixed.state,lagLineIds:fixed.scopes.filter(scope=>scope.state==='late').flatMap(scope=>scope.lineId?[scope.lineId]:[]),dueLineIds:fixed.scopes.filter(scope=>scope.customerDuePassed).flatMap(scope=>scope.lineId?[scope.lineId]:[]),unknownLineIds:fixed.scopes.filter(scope=>scope.state==='unknown').flatMap(scope=>scope.lineId?[scope.lineId]:[])}:null;
  const value:Omit<JourneySelectionClockFrame,'from'>={schedule,
   risks:projected.stages.flatMap(stage=>stage.nodes).filter(node=>node.current).map(node=>({id:node.instanceId,risks:[...node.risks]})),
   nativeRisks,untimedRisks,coverage:projected.supervision?.coverage??[],deliveryRisks,partialDeliveryRisks,customerReminderDate:projected.supervision?.customerReminderDate??null,
   fullSignals:{...journeyUnfilteredSignals({...projected,deliveryRisks}),activated:journeyActivated(projected)}};
  const fingerprint=JSON.stringify(value);
  if(fingerprint!==previous){frames.push({from:at,...value});previous=fingerprint;}
  if(next===null||hardBoundary!==null&&next>=hardBoundary)break;
  at=new Date(next).toISOString();
 }
 // Guard the compiler against silently missing any already-visible native
 // behaviour. A disagreement fails only this object's background build.
 const first=frames[0]!;
 const actual=baseNodes.map(node=>({id:node.instanceId,risks:item.stages.flatMap(stage=>stage.nodes).find(value=>value.current&&value.instanceId===node.instanceId)?.risks??[]}));
 if(JSON.stringify(first.risks)!==JSON.stringify(actual))throw Error('Journey selection clock differs from canonical observation');
 return {frames,expiresAt:hardBoundary===null?null:new Date(hardBoundary).toISOString()};
}
