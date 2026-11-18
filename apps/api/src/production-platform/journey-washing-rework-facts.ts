import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import type {OrderTimeWashingReworkPlan} from '@dx-rework/contracts/order-time-washing-rework';
import type {ScheduleFact,ScheduleResponsibilityWindow,ScheduleWork} from './fixed-schedule-progress.js';
import type {WashingPlan} from './bulk-washing-repository.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';
const unknown={precision:'unknown'} as const;
const instant=(value:string|null,asOf:string)=>value&&Number.isFinite(Date.parse(value))&&Date.parse(value)<=Date.parse(asOf)?{precision:'instant' as const,at:value}:unknown;

/** One explicitly arranged round. Original/other-round quality, receipts and P
 * never complete this work; failed inspection still completes its real work,
 * while the original whole-scope quality gate continues to prevent delivery. */
export function journeyWashingReworkFact(row:OrderTimeWashingReworkPlan,scope:BulkWashingScopeView|undefined,inspection:boolean,asOf:string):ScheduleFact{
 return washingRoundFact({...row,reference:`washing-rework:${row.intentId}`,evidenceRef:row.introducedEventRef??'返洗安排尚未正式生效'},scope,inspection,asOf);
}

type RoundFactBasis=Pick<OrderTimeWashingReworkPlan,'quantityVersion'|'planId'|'factoryDecisionId'|'quantity'|'arrangement'>
 &{intentId?:string;nativeStartId?:string;reference:string;evidenceRef:string};
function washingRoundFact(row:RoundFactBasis,scope:BulkWashingScopeView|undefined,inspection:boolean,asOf:string):ScheduleFact{
 const base:ScheduleFact={ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,
  evidenceRefs:[row.evidenceRef,row.reference]};
 if(!scope||scope.quantityVersion!==row.quantityVersion||scope.planId!==row.planId||scope.factoryDecisionId!==row.factoryDecisionId)return base;
 const effective=scope.facts.filter(fact=>!fact.voided),starts=effective.filter(fact=>(fact.kind==='send'||fact.kind==='factory_start')
  &&(row.nativeStartId?fact.id===row.nativeStartId:Boolean(row.intentId&&fact.rewashWorkId===row.intentId)));
 const startIds=new Set(starts.map(fact=>fact.id));
 const completions=effective.filter(fact=>fact.kind==='return'?startIds.has(fact.sendId):fact.kind==='factory_complete'&&startIds.has(fact.startId));
 const completionIds=new Set(completions.map(fact=>fact.id));
 const windows:ScheduleResponsibilityWindow[]=scope.windows.filter(window=>window.state!=='voided'
  &&(inspection?window.kind==='inspection'&&completionIds.has(window.id.replace(/:qc$/,'')):window.kind==='washing'&&startIds.has(window.id)))
  .map(window=>{const policy=row.arrangement.mode==='none'?null:inspection?row.arrangement.inspection:row.arrangement.washing,started=instant(window.startedAt,asOf);
   return {sourceRef:`washing:${scope.scopeId}:${window.id}`,nativeWashingWindow:{scopeId:scope.scopeId,windowId:window.id},started,completed:instant(window.completedAt,asOf),complete:window.state==='completed',
    deadline:window.dueAt,warningAt:policy?.reminder.enabled&&started.precision==='instant'?shiftFixedTimeline(started.at,policy.minutes*policy.reminder.percent/100,policy.calendar):null,calendar:policy?.calendar??null};});
 const started=starts.reduce((sum,fact)=>sum+fact.quantity,0),returned=completions.reduce((sum,fact)=>sum+fact.quantity,0);
 const checks=effective.filter(fact=>fact.kind==='inspection'&&completionIds.has(fact.completionId));
 const checked=checks.reduce((sum,fact)=>sum+fact.quantity,0);
 const complete=!scope.ledger.conflict&&started===row.quantity&&returned===row.quantity&&(!inspection||checked===row.quantity)
  &&windows.length>0&&windows.every(window=>window.complete);
 const ready=windows.length&&windows.every(window=>window.started.precision==='instant')
  ?{precision:'instant' as const,at:new Date(Math.min(...windows.map(window=>window.started.precision==='instant'?Date.parse(window.started.at):NaN))).toISOString()}:unknown;
 const completed=complete&&windows.every(window=>window.completed.precision==='instant')
  ?{precision:'instant' as const,at:new Date(Math.max(...windows.map(window=>window.completed.precision==='instant'?Date.parse(window.completed.at):NaN))).toISOString()}:unknown;
 return {...base,ready,clockStart:ready,businessCompleted:complete,completed,notYetReady:starts.length===0,
  ownWindows:windows,evidenceRefs:[...base.evidenceRefs,...starts.map(fact=>`digital_bulk_washing_events:${fact.id}`)]};
}

/** Original native rounds without a prior formal P are read-only history.
 * Their real R/D/A remains exact; no arrangement, terminal dependency or extra
 * garment denominator is generated from an already recorded occurrence. */
export function journeyUnplannedWashingRework(orderId:string,scope:BulkWashingScopeView,plan:WashingPlan,asOf:string):Array<{lineId:string;work:ScheduleWork;fact:ScheduleFact}>{
 if(plan.id!==scope.planId||plan.orderId!==orderId||plan.lineId!==scope.lineId||plan.document.arrangement.mode==='none')return [];
 const arrangement=plan.document.arrangement,prefix=arrangement.mode==='factory'?'bulk_factory_washing':'bulk_return_washing';
 const effective=scope.facts.filter(fact=>!fact.voided),rows:Array<{lineId:string;work:ScheduleWork;fact:ScheduleFact}>=[];
 for(const start of effective){
  if((start.kind!=='send'&&start.kind!=='factory_start')||!start.reworkOfInspectionId||start.rewashWorkId)continue;
  const origin=effective.find(fact=>fact.id===start.reworkOfInspectionId&&fact.kind==='inspection'),round=scope.ledger.rework?.rounds[start.id];
  if(!origin||!Number.isSafeInteger(round)||!round||start.quantityVersion!==scope.quantityVersion)continue;
  const washingId=`${prefix}:rewash-history:${start.id}:${scope.lineId}`;
  for(const inspection of [false,true]){
   const kind=inspection?'inspection':'washing',policy=arrangement[kind];
   rows.push({lineId:scope.lineId,work:{id:inspection?`${prefix}_inspection:rewash-history:${start.id}:${scope.lineId}`:washingId,
    canonicalWorkRef:`order:${orderId}:line:${scope.lineId}:native-rewash:${start.id}:${kind}`,
    stage:arrangement.mode==='factory'?6:7,rewashRound:round,accountingRole:'added_work',dependsOn:inspection?[washingId]:[],
    start:null,end:null,minutes:policy.minutes,calendar:policy.calendar,targetPrecision:'instant',targetDate:null,targetRevision:'unknown:unplanned-rewash',
    responsibilitySlaRef:`bulk-washing-plan:${plan.id}:${kind}`,responsibilityMinutes:policy.minutes,responsibilityCalendar:policy.calendar},
    fact:washingRoundFact({quantityVersion:scope.quantityVersion,planId:plan.id,factoryDecisionId:scope.factoryDecisionId,quantity:start.quantity,
     arrangement,nativeStartId:start.id,reference:`digital_bulk_washing_events:${start.id}`,evidenceRef:'历史返洗未登记正式计划P'},scope,inspection,asOf)});
  }
 }
 return rows;
}
