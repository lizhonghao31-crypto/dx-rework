import {cancelledTaskHistory,cancelledWorkTaskKind,linkedSourceTaskCancellation,sourceTaskCancellationEventsSql} from './cancelled-task-history.js';
import {evaluateJourneyFramework,type JourneyFrameworkBasis} from './journey-time-framework.js';
import {attachFrameworkEvents} from './journey-framework-events.js';
import {attachJourneyWashing,journeyWashingInstanceId} from './journey-washing-projection.js';
import {nativeCuttingCompletions} from './cutting-completion-facts.js';
import {fixedReworkProgressFacts} from './fixed-rework-progress.js';
import {receivingSpan} from './receiving-span.js';
import {factoryBatchTiming} from './factory-batch-timing.js';
import {factoryReturnLogistics} from './factory-return-logistics.js';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {OrderClosureSheet} from '@dx-rework/contracts/order-closure';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {FixedScheduleProgress,ScheduleOccurrence} from '@dx-rework/contracts';
import {FixedTimelineAdoptionRepository,type FixedTimelineAdoption,type FixedTimelineInput} from './fixed-timeline-adoptions.js';
import {shiftFixedTimeline,type FixedTimelineTarget} from './fixed-timeline-targets.js';
import {readFixedOrderRoute} from './fixed-order-route.js';
import {nativeTaskReadiness,nativeCuttingReadiness} from './task-readiness-facts.js';
import {nativeFactoryTimeline} from './factory-production-facts.js';
import {journeyTermination,type JourneyTermination} from './journey-termination.js';
import {evaluateFixedScheduleScope,fixedDurationSummary,type ScheduleScopeInput,type ScheduleFact,type ScheduleWork} from './fixed-schedule-progress.js';
import {readOrderTimeBasis,attachOrderTimeCoverage} from './order-time-reading.js';
import type {StoredOrderTimePlan} from './order-time-plan-repository.js';
import {fixedScheduleStages} from './fixed-schedule-stages.js';

export type FixedScheduleBasis={materialInvestmentTiming?:{dueAt:string;warningAt:string|null;exclusive:boolean};framework?:JourneyFrameworkBasis;version:'fixed-schedule-basis-v1';policyVersion?:'order-time-plan-v1';scopeRevision:string;factRevision:string;scopes:ScheduleScopeInput[];termination:JourneyTermination|null;pending:boolean;notApplicableNodes?:Array<'process_logistics'|'bulk_qc'>};
type DB=Pick<PoolClient,'query'>;
const unknown:ScheduleOccurrence={precision:'unknown'};
const occurrence=(at:unknown):ScheduleOccurrence=>at instanceof Date?{precision:'instant',at:at.toISOString()}:typeof at==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(at)&&Number.isFinite(Date.parse(at))?{precision:'instant',at:new Date(at).toISOString()}:unknown;
const fromFact=(fact:SlaNodeFact|undefined):ScheduleFact=>({ready:occurrence(fact?.startedAt),clockStart:occurrence(fact?.startedAt),completed:fact?.completedDate?{precision:'date',date:fact.completedDate}:occurrence(fact?.completedAt),businessCompleted:fact?.businessCompleted===true||Boolean(fact?.completedAt||fact?.completedDate),waitingForPredecessors:false,evidenceRefs:fact?.evidence?[fact.evidence]:[]});
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const latest=(values:ScheduleOccurrence[]):ScheduleOccurrence=>{
 if(!values.length||values.some(value=>value.precision==='unknown'))return unknown;
 const dates=values.filter(value=>value.precision==='date'),instants=values.filter(value=>value.precision==='instant');
 const exact=instants.sort((a,b)=>Date.parse(b.at)-Date.parse(a.at))[0];
 if(exact&&dates.every(date=>Date.parse(exact.at)>=Date.parse(date.date+'T00:00:00+08:00')+86400000))return exact;
 if(!dates.length)return exact!;
 return {precision:'date',date:values.map(value=>value.precision==='date'?value.date:value.precision==='instant'?new Date(Date.parse(value.at)+28800000).toISOString().slice(0,10):'').sort().at(-1)!};
};

/** Internal factual basis only. The existing Journey/SLA caller first checks
 * live full-resource/field scope and owns the RR snapshot. No extra connection,
 * transaction, Root actor, current settings or GET target reconstruction. */
export async function readFixedScheduleBasis(db:DB,resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,asOf:string,closure?:OrderClosureSheet,time?:BusinessTime,onSourcePlan?:(saved:StoredOrderTimePlan)=>void):Promise<FixedScheduleBasis|null>{
 const legacy=await readLegacyFixedScheduleBasis(db,resource,item,native,asOf,closure);
 return readOrderTimeBasis(db,resource,item,native,asOf,legacy,time,legacy?legacy.termination:undefined,onSourcePlan);
}
async function readLegacyFixedScheduleBasis(db:DB,resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,asOf:string,closure?:OrderClosureSheet):Promise<FixedScheduleBasis|null>{
 const repository=new FixedTimelineAdoptionRepository(db),current=await repository.currentTargets(resource,resource.kind==='source'?item.adoptedRound??item.selectedRound??undefined:undefined);
 if(!current)return null;
 const termination=await journeyTermination(db,resource,asOf);
 const saved=current.adoption,sourceId=resource.kind==='source'?resource.id:typeof saved.input.sourceVersions.sourceId==='string'?saved.input.sourceVersions.sourceId:null;
 const sourceOrigin=resource.kind==='source'&&saved.input.round>1?await repository.currentTargets(resource,1):null;
 const inherited=resource.kind==='order'&&sourceId?await repository.existing({kind:'source',id:sourceId},Number(saved.input.sourceVersions.sourceRound)):null;
 const inheritedTargets=inherited?await repository.currentTargets(inherited.input.resource,inherited.input.round):null;
 const tasks=(await db.query(`SELECT t.task_id,t.state,t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,t.route_version,t.route_instance_id,a.task_kind,a.source_id,a.production_order_id,
  position.adoption_id,position.route_position,position.route_ref,position.step_id,position.phase,
  ARRAY(SELECT e.event_id::text FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.resource_kind=$3 AND e.resource_id=$4 AND e.event_kind='cancel' ORDER BY e.event_id LIMIT 2) AS cancel_events,
  ${sourceTaskCancellationEventsSql} AS source_cancel_events,
  EXISTS(SELECT 1 FROM digital_production_task_events returned WHERE returned.task_id=t.task_id AND returned.event_kind='material_returned') AS returned,
  EXISTS(SELECT 1 FROM digital_development_route_facts rejected WHERE rejected.task_id=t.task_id AND rejected.kind='尾查退回') AS rejected
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN digital_timeline_task_positions position USING(task_id)
  WHERE ($1::uuid IS NOT NULL AND a.production_order_id=$1) OR ($2::uuid IS NOT NULL AND a.source_id=$2)
  ORDER BY t.route_version,t.created_at,t.task_id`,[resource.kind==='order'?resource.id:null,sourceId,resource.kind,resource.id])).rows;
 const readiness=await nativeTaskReadiness(db,tasks.map(task=>task.task_id)),cuts=resource.kind==='order'?await nativeCuttingReadiness(db,tasks.map(task=>task.task_id)):[],production=resource.kind==='order'?await nativeFactoryTimeline(db,resource.id):[];
 const cutCompletions=resource.kind==='order'?await nativeCuttingCompletions(db,resource.id):[];
 const factory=resource.kind==='order'?await factoryBatchTiming(db,resource.id):null;
 const returnLogistics=resource.kind==='order'?await factoryReturnLogistics(db,resource.id,new Date(asOf)):[];
 const currentPreparation=resource.kind==='order'?(await db.query(`SELECT p.preparation_id FROM digital_instruction_documents d JOIN digital_instruction_versions v ON v.production_order_id=d.production_order_id AND v.version=d.published_version JOIN digital_bulk_preparations p ON p.production_order_id=v.production_order_id AND p.instruction_version=v.version AND p.source_round=v.source_round WHERE d.production_order_id=$1`,[resource.id])).rows[0]?.preparation_id:null;
 const routeTimes=new Map<string,string>();
 const routes=new Map<string,NonNullable<FixedTimelineInput['route']>>([[String(saved.input.sourceVersions.routeRef),saved.input.route??[]]]),routeWorks=new Map<string,FixedTimelineInput['work']>();
 for(const row of (resource.kind==='order'?(await db.query('SELECT route_ref FROM digital_timeline_order_routes WHERE adoption_id=$1 ORDER BY recorded_at,route_ref',[saved.adoptionId])).rows:[])){
  const route=await readFixedOrderRoute(db,saved,row.route_ref);if(route){routes.set(row.route_ref,route.route);routeWorks.set(row.route_ref,route.work);routeTimes.set(row.route_ref,route.time.now);}
 }
 const relevant=(definition:FixedTimelineInput['work'][number],owner:FixedTimelineAdoption)=>{
  const route=owner===inherited?owner.input.route:routes.get(String(owner.input.sourceVersions.routeRef));
  const ownId=definition.id.startsWith('source:')?definition.id.slice(7):definition.id;
  return tasks.filter(task=>(owner.input.resource.kind==='source'?task.source_id===owner.input.resource.id&&task.route_version===owner.input.round:task.production_order_id===resource.id))
   .filter(task=>task.adoption_id?task.adoption_id===owner.adoptionId&&(routes.get(task.route_ref)??route??[]).some(position=>position.position===Number(task.route_position)&&position.nodeId===ownId)
    :task.task_kind===(definition.parameterKey??ownId)||definition.parameterKey==='bulk_cutting'&&task.task_kind==='bulk_cutting_external');
 };
 const scopes:ScheduleScopeInput[]=[];
 for(const consumer of saved.input.consumers){
  const targetsRow=current.scopes.find(row=>row.scope_ref===consumer.scopeRef);if(!targetsRow)continue;
  const targets=targetsRow.targets_json as FixedTimelineTarget[],targetMap=new Map(targets.map(target=>[target.id,target]));
  const definitions=saved.input.work.filter(work=>consumer.nodeIds.includes(work.id)),facts:Record<string,ScheduleFact>={};
  const works:ScheduleWork[]=definitions.map(definition=>{
   const shared=definition.id.startsWith('source:'),sourceScope=inheritedTargets?.scopes.find(row=>row.scope_ref===inherited?.input.consumers[0]?.scopeRef),sourceTarget=shared?(sourceScope?.targets_json as FixedTimelineTarget[]|undefined)?.find(target=>target.id===definition.id.slice(7)):undefined;
   const target=shared?sourceTarget:targetMap.get(definition.id),goal=consumer.customerGoalIds?.includes(definition.id),anchor=goal?targetsRow.goal_anchor?.[definition.id]:null;
   return {...definition,start:target?.start.at??null,end:target?.end.at??null,...(target?{startExclusive:target.start.exclusive,endExclusive:target.end.exclusive}:{}),...(shared&&sourceScope?{targetRevision:`${inherited!.adoptionId}:${sourceScope.revision}`}:{ }),targetPrecision:anchor?.precision==='date'?'date':'instant',targetDate:anchor?.precision==='date'?anchor.value:null};
  });
  for(const definition of definitions){
   const inheritedWork=definition.id.startsWith('source:'),owner=inheritedWork?inherited:saved,ownId=inheritedWork?definition.id.slice(7):definition.id;
   // A shared source fact must be the adopted source round, not today's new round.
   const originalFact=inheritedWork?undefined:native[ownId]??native[definition.parameterKey??ownId];
   let fact=fromFact(originalFact);
   const candidates=owner?relevant(definition,owner):[];
   const cancellations=new Map<string,JourneyTermination>();
   const matches=candidates.filter(task=>{
    if(task.state!=='cancelled')return true;
    const route=owner===inherited?owner?.input.route:routes.get(String(owner?.input.sourceVersions.routeRef));
    const positions=(routes.get(task.route_ref)??route??[]).filter(position=>position.position===Number(task.route_position)&&position.nodeId===ownId);
    if(task.adoption_id&&positions.length!==1)return false;
    const kind=cancelledWorkTaskKind(definition.parameterKey??ownId,ownId,positions[0]?.kind);
    const stop=linkedSourceTaskCancellation(task,resource,item,kind,asOf,consumer.lineId,definition.canonicalWorkRef);
    if(stop){cancellations.set(task.task_id,stop);return true;}
    return cancelledTaskHistory(task,resource,item,termination,kind,consumer.lineId,definition.canonicalWorkRef);
   });
   if(matches.length!==1&&termination?.kind==='cancelled'&&candidates.some(task=>task.state==='cancelled'))fact=fromFact(undefined);
   if(matches.length===1){const task=matches[0]!,ready=readiness.get(task.task_id),stop=cancellations.get(task.task_id);
    const accepted=task.state==='completed'&&!task.returned&&!task.rejected;
    const completed=accepted&&['现场登记','已核实'].includes(task.completed_quality)?occurrence(task.completed_at):unknown;
    const first=ready?.tracked?occurrence(ready.firstReadyAt):task.state==='cancelled'?['现场登记','已核实'].includes(task.entered_quality)?occurrence(task.entered_at):unknown:fact.ready;
    fact={...fact,...(task.state==='cancelled'?{ownTaskId:task.task_id}:{}),ready:first,clockStart:first,completed,businessCompleted:accepted,...(stop?{terminated:true,terminationAt:stop.at}:{}),evidenceRefs:[`task:${task.task_id}:round:${task.route_version}`,...(task.cancel_events??[]).map((id:string)=>`digital_production_task_events:${id}`),...(stop?.originEventRef?[stop.originEventRef]:[]),...ready?.basis??[]]};
    // Factory task entry can be empty while its real step/batch obligation
    // has already begun. Retain only this original route's scoped windows;
    // neither a kind aggregate nor another step may authenticate its R/D.
    if(task.state==='cancelled'&&factory&&factory.preparationId===task.route_instance_id&&['process_logistics','bulk_qc','warehouse_dispatch'].includes(task.task_kind)){
     const windows=factory.windows.filter(window=>window.kind===task.task_kind&&(task.step_id?window.stepRef===task.step_id:!window.stepRef)&&(!window.lineId||window.lineId===consumer.lineId));
     if(windows.length){
      const starts=windows.map(window=>window.enteredAt),first=starts.every((at):at is string=>Boolean(at))?occurrence([...starts].sort()[0]):unknown;
      fact.ready=first;fact.clockStart=first;
      fact.ownWindows=windows.map(window=>({sourceRef:window.evidence,started:occurrence(window.enteredAt),completed:occurrence(window.completedAt),complete:window.complete,deadline:window.dueAt,warningAt:window.warningAt,calendar:window.calendarRef??null}));
      fact.evidenceRefs=[...fact.evidenceRefs,...windows.map(window=>window.evidence)];
     }
    }
   }
   if(definition.parameterKey==='bulk_cutting'&&consumer.lineId){const own=cuts.filter(cut=>cut.lineId===consumer.lineId);if(own.length===1){fact.ready=occurrence(own[0]!.firstReadyAt);fact.clockStart=fact.ready;fact.evidenceRefs=[...fact.evidenceRefs,...own[0]!.basis];const complete=cutCompletions.find(event=>event.payload.lineId===consumer.lineId&&event.payload.cuttingOrderId===own[0]!.cuttingOrderId);if(complete){fact.businessCompleted=true;fact.completed=['现场登记','已核实'].includes(complete.time_quality)?occurrence(complete.occurred_at):unknown;fact.evidenceRefs=[...fact.evidenceRefs,`digital_production_task_events:${complete.event_id}`];}}}
   if(ownId.startsWith('factory_work:')&&consumer.lineId){const rows=production.filter(row=>row.lineId===consumer.lineId),complete=rows.length>0&&rows.every(row=>row.completedDate);fact={...fact,ready:latest(rows.map(row=>occurrence(row.dispatchedAt))),clockStart:unknown,businessCompleted:complete,completed:complete?latest(rows.map(row=>({precision:'date',date:row.completedDate!}))):unknown,evidenceRefs:rows.flatMap(row=>[row.startTransitionRef,row.completionTransitionRef].filter((ref):ref is string=>Boolean(ref)))};}
   if(ownId.startsWith('factory_production:')&&consumer.lineId){
    // The QC task has its own native entry. Production business completion is
    // another fact and must not be fabricated into QC's start (QC can be early).
    const rows=tasks.filter(task=>task.production_order_id===resource.id&&task.task_kind==='factory_production_qc'&&(task.state!=='cancelled'||cancelledTaskHistory(task,resource,item,termination,'factory_production_qc',consumer.lineId,definition.canonicalWorkRef))),task=rows.length===1?rows[0]:null;
    const ready=task&&['现场登记','已核实'].includes(task.entered_quality)?occurrence(task.entered_at):unknown;
    fact={...fact,ready,clockStart:ready,evidenceRefs:[...fact.evidenceRefs,...(task?[`task:${task.task_id}:native-entry`]:[])]};
   }
   if(ownId.startsWith('return_logistics:')&&consumer.lineId&&closure){const line=closure.lines.find(line=>line.lineId===consumer.lineId),valid=line?.cutScope!=='unresolved'&&line?.actualQuantity!==undefined&&line.actualQuantity>=line.orderedQuantity,records=line?.receipts??[];
    const span=line?await receivingSpan(db,resource.id,line.orderedQuantity,line.actualQuantity,{lineId:line.lineId,position:item.lines.findIndex(po=>po.id===line.lineId)+1}):null;
    const shipments=returnLogistics.filter(shipment=>production.some(row=>row.lineId===consumer.lineId&&row.productionId===shipment.productionId&&row.factoryDecisionId===shipment.factoryDecisionId)),first=shipments.map(shipment=>shipment.shippedOn).sort()[0];
    fact={...fact,ready:first?{precision:'date',date:first}:unknown,clockStart:unknown,businessCompleted:Boolean(valid&&records.length),completed:valid&&span?span.collectedDate?{precision:'date',date:span.collectedDate}:occurrence(span.collectedAt):unknown,evidenceRefs:[...shipments.map(shipment=>shipment.evidence),...records.map(row=>`receipt:${row.receiptId}`)]};
   }
   // The independent QC step ID must not borrow the aggregate of both crafts.
   if(ownId.startsWith('bulk_qc:')){const windows=factory?.windows.filter(window=>window.kind==='bulk_qc'&&window.stepRef===ownId.slice(8))??[];fact={...fact,ready:latest(windows.map(window=>occurrence(window.enteredAt))),clockStart:latest(windows.map(window=>occurrence(window.enteredAt))),completed:latest(windows.map(window=>occurrence(window.completedAt))),businessCompleted:windows.length>0&&windows.every(window=>window.complete),evidenceRefs:[...fact.evidenceRefs,...windows.map(window=>window.evidence)]};}
   facts[definition.id]=fact;
  }
  // Each adopted craft window includes its own return confirmation. A
  // processing report closes only that task, not the parent craft window.
  for(const parent of definitions.filter(work=>(['development_printing','development_embroidery'].includes(work.parameterKey??'')||work.parameterKey?.startsWith('development_special_')))){
   const confirmations=definitions.filter(work=>work.includedIn===parent.id&&work.parameterKey==='development_craft_return');
   const receipt=confirmations.length===1?facts[confirmations[0]!.id]:null,fact=facts[parent.id]!;
   fact.businessCompleted=fact.businessCompleted&&receipt?.businessCompleted===true;
   fact.completed=fact.businessCompleted?receipt!.completed:unknown;
   fact.evidenceRefs=[...fact.evidenceRefs,...receipt?.evidenceRefs??[]];
  }
  for(const work of works){const fact=facts[work.id]!;fact.waitingForPredecessors=fact.ready.precision==='unknown'&&work.dependsOn.length>0&&work.dependsOn.some(id=>!facts[id]?.businessCompleted);}
  const goalIds=consumer.customerGoalIds?.length?consumer.customerGoalIds:Object.keys(consumer.ends).filter(id=>!id.includes('ship_sample')&&id!=='development_shipping');
  // Development's own adopted goal is not a customer's PO delivery promise.
  const customerGoal=resource.kind==='order'?goalIds.map(id=>targetMap.get(id)?.end.at).filter((at):at is string=>Boolean(at)).sort().at(-1)??null:null;
  if(resource.kind==='source'&&saved.input.round>1){
   const original=sourceOrigin?.adoption,originScope=sourceOrigin?.scopes[0],originalEnds=original?Object.keys(original.input.consumers[0]!.ends).filter(id=>id!=='development_shipping'):[],originGoal=originalEnds.length===1?originalEnds[0]:null;
   const target=(originScope?.targets_json as FixedTimelineTarget[]|undefined)?.find(target=>target.id===originGoal),handoff=target?.end.at??null,originId=`prior_source_completion:${resource.id}:round:1`;
   const position=original?.input.route?.find(position=>position.nodeId===originGoal),candidates=tasks.filter(task=>task.adoption_id===original?.adoptionId&&task.route_position===position?.position),task=candidates.length===1?candidates[0]:null,complete=Boolean(task&&task.state==='completed'&&!task.returned&&!task.rejected);
   works.unshift({id:originId,canonicalWorkRef:original?.input.work.find(work=>work.id===originGoal)?.canonicalWorkRef??originId,dependsOn:[],start:handoff,end:handoff,minutes:0,calendar:'continuous',accountingRole:'shared_reference',responsibilitySlaRef:null});
   facts[originId]={ready:unknown,clockStart:unknown,completed:complete&&['现场登记','已核实'].includes(task!.completed_quality)?occurrence(task!.completed_at):unknown,businessCompleted:complete,waitingForPredecessors:false,evidenceRefs:task?[`task:${task.task_id}:round:1`]:[]};
   for(const work of works.filter(work=>work.accountingRole==='added_work')){
    work.originalHandoffAt=handoff;if(!work.dependsOn.length)work.dependsOn=[originId];
    facts[work.id]={...facts[work.id]!,impactStartedAt:saved.time.now};
   }
  }
  scopes.push({scopeRef:consumer.scopeRef,lineId:consumer.lineId,targetRevision:`${saved.adoptionId}:${targetsRow.revision}`,work:works,facts,terminalIds:goalIds,customerGoal});
 }
 // Added route targets stay constrained to their original handoff. They do not
 // replace the base targets or add their own planning SLA to the old budget.
 for(const scope of scopes)for(const row of current.scopes.filter(row=>row.line_id===scope.lineId&&row.goal_anchor?.originalHandoff)){
  const nodeId=row.goal_anchor.originalHandoff.nodeId as string,routeRef=String(row.scope_ref).split(':route:')[1]?.split(':handoff:')[0],definitions=routeRef?routeWorks.get(routeRef)??[]:[],targets=row.targets_json as FixedTimelineTarget[],handoff=scope.work.find(work=>work.id===nodeId);
  if(!handoff||!definitions.length||routeRef!==currentPreparation)continue;
  const replaced=new Set(nodeId==='warehouse_dispatch'?(saved.input.route??[]).filter(position=>position.phase==='logistics'||position.phase==='qc').map(position=>position.nodeId):[]);
  const originalDependencies=handoff.dependsOn.filter(id=>!replaced.has(id));
  for(const replacedId of replaced)if(scope.facts[replacedId]&&!scope.facts[replacedId]!.businessCompleted)scope.facts={...scope.facts,[replacedId]:{...scope.facts[replacedId]!,terminated:true,terminationAt:routeTimes.get(routeRef!)??null}};
  let previous=[...originalDependencies];
  for(const definition of definitions.filter(work=>targets.some(target=>target.id===work.id))){const target=targets.find(target=>target.id===definition.id)!;
   scope.work=[...scope.work,{...definition,dependsOn:definition.dependsOn.length?definition.dependsOn:previous,start:target.start.at,end:target.end.at,originalHandoffAt:row.goal_anchor.originalHandoff.start?.at??null}];
   let fact=fromFact(native[definition.id]??native[definition.parameterKey??definition.id]);
   const routePosition=(routes.get(routeRef!)??[]).find(position=>position.nodeId===definition.id),ownTasks=tasks.filter(task=>task.adoption_id===saved.adoptionId&&task.route_ref===routeRef&&task.route_position===routePosition?.position&&(task.state!=='cancelled'||cancelledTaskHistory(task,resource,item,termination,cancelledWorkTaskKind(definition.parameterKey??definition.id,definition.id,routePosition?.kind),scope.lineId,definition.canonicalWorkRef)));
   fact.evidenceRefs=[...fact.evidenceRefs,...ownTasks.map(task=>`task:${task.task_id}:round:${task.route_version}`)];
   if(definition.id.startsWith('bulk_qc:')){
    const windows=factory?.windows.filter(window=>window.kind==='bulk_qc'&&window.stepRef===definition.id.slice(8))??[];
    fact={...fact,ready:latest(windows.map(window=>occurrence(window.enteredAt))),clockStart:latest(windows.map(window=>occurrence(window.enteredAt))),completed:latest(windows.map(window=>occurrence(window.completedAt))),businessCompleted:windows.length>0&&windows.every(window=>window.complete),evidenceRefs:[...fact.evidenceRefs,...windows.map(window=>window.evidence)]};
   }
   fact.impactStartedAt=routeRef?routeTimes.get(routeRef)??null:null;scope.facts={...scope.facts,[definition.id]:fact};previous=[definition.id];
  }
  handoff.dependsOn=[...new Set([...originalDependencies,...previous])];
 }
 const repairs=await fixedReworkProgressFacts(db,saved);
 for(const scope of scopes){
  const handoff=scope.work.find(work=>work.id===`garment_packing:${scope.lineId}`);if(!handoff)continue;
  const predecessors=[...handoff.dependsOn],required:string[]=[];
  for(const repair of repairs.filter(repair=>repair.lineId===scope.lineId)){
   const id=`garment_rework:${scope.lineId}:${repair.reworkId}`,row=current.scopes.find(row=>row.scope_ref===`${scope.scopeRef}:rework:${repair.reworkId}`),target=(row?.targets_json as FixedTimelineTarget[]|undefined)?.find(target=>target.id===id);
   const window=repair.windows,policy=saved.input.unified.values.parameters.garment_rework?.value,own=window.length===1?window[0]:null,minutes=policy?.kind==='duration'?policy.minutes:null;
   scope.work=[...scope.work,{id,canonicalWorkRef:`rework:${repair.reworkId}`,dependsOn:predecessors,start:target?.start.at??null,end:target?.end.at??null,minutes,calendar:'continuous',accountingRole:'added_work',originalHandoffAt:row?.goal_anchor.originalHandoff.start?.at??null,responsibilitySlaRef:own?.snapshotId?`snapshot:${own.snapshotId}:garment_rework`:null,responsibilityMinutes:own?.startedAt&&own.deadline?(Date.parse(own.deadline)-Date.parse(own.startedAt))/60000:null,responsibilityCalendar:'continuous',...(row?{targetRevision:`${saved.adoptionId}:rework:${row.revision}`}:{})}];
   scope.facts={...scope.facts,[id]:{ready:occurrence(repair.approvedAt),clockStart:occurrence(own?.startedAt),completed:occurrence(own?.completedAt),businessCompleted:own?.complete===true,waitingForPredecessors:false,evidenceRefs:[repair.eventRef,...window.map(window=>window.evidence)],impactStartedAt:repair.approvedAt}};required.push(id);
  }
  if(required.length)handoff.dependsOn=[...predecessors,...required];
 }
 return {version:'fixed-schedule-basis-v1',scopeRevision:hash([current.scopes.map(row=>[row.scope_ref,row.revision,row.source_event_ref]),inheritedTargets?.scopes.map(row=>[row.scope_ref,row.revision,row.source_event_ref])??[]]),factRevision:hash(scopes.map(scope=>scope.facts)),scopes,termination,pending:scopes.length!==saved.input.consumers.length||Boolean(inherited&&!inheritedTargets?.scopes.length)};
}

export function evaluateFixedJourneyBasis(basis:FixedScheduleBasis,asOf:string,legacyOverdue:boolean,includeStages=true):FixedScheduleProgress{
 const scopes=basis.scopes.map(scope=>evaluateFixedScheduleScope(scope,asOf,basis.termination));
 const unfinished=basis.scopes.some(scope=>scope.terminalIds.some(id=>!scope.facts[id]?.businessCompleted));
 const state=basis.termination&&unfinished?'terminated':scopes.some(scope=>scope.state==='late')?'late':basis.pending||!scopes.length||scopes.some(scope=>scope.state==='unknown')?'unknown':'normal';
 return {...(basis.framework?{framework:evaluateJourneyFramework(basis.framework,basis.scopes,scopes,asOf,basis.termination)}:{}),version:'fixed-schedule-progress-v1',asOf,scopeRevision:basis.scopeRevision,factRevision:basis.factRevision,state,scopes,...(includeStages?{stages:fixedScheduleStages(basis,asOf)}:{}),durationSummary:fixedDurationSummary(basis.scopes,asOf,basis.termination),legacyOverdue,nextChangeAt:null};
}

/** Only finite classification changes are compiled. Numeric display values are
 * evaluated for selected rows; ordinary full-range selection reads flags. */
export function nextFixedScheduleClassification(basis:FixedScheduleBasis,asOf:string):string|null{
 if(basis.termination)return null;
 const now=Date.parse(asOf);let next:number|null=null;
 const consider=(at:number)=>{if(at>now&&(next===null||at<next))next=at;};
 const material=basis.materialInvestmentTiming;
 if(material){
  if(material.warningAt)consider(Date.parse(material.warningAt));
  consider(Date.parse(material.dueAt)+(material.exclusive?0:1));
 }
 for(const scope of basis.scopes){
  const current=evaluateFixedScheduleScope(scope,asOf);
  for(const milestone of basis.framework?.find(row=>row.scopeRef===scope.scopeRef)?.milestones??[])if(milestone.at&&!milestone.workIds.every(id=>scope.facts[id]?.businessCompleted))consider(Date.parse(milestone.at));
  for(const node of current.nodes){if(node.businessCompleted||node.ownSla.state==='terminated')continue;const work=scope.work.find(work=>work.id===node.id)!,fact=scope.facts[node.id];
   const goal=work.eventTarget??work;if(goal.end)consider(Date.parse(goal.end)+(goal.targetPrecision==='date'||('exclusive' in goal?goal.exclusive:goal.endExclusive)?0:1));
   if(node.ownSla.warningAt)consider(Date.parse(node.ownSla.warningAt));
   for(const window of fact?.ownWindows??[])if(!window.complete){if(window.warningAt)consider(Date.parse(window.warningAt));if(window.deadline&&window.calendar)consider(Date.parse(shiftFixedTimeline(window.deadline,1/60000,window.calendar)));}
   if(fact?.clockStart.precision==='instant'&&work.responsibilityMinutes!==undefined&&work.responsibilityMinutes!==null&&work.responsibilityCalendar)consider(Date.parse(shiftFixedTimeline(shiftFixedTimeline(fact.clockStart.at,work.responsibilityMinutes,work.responsibilityCalendar),1/60000,work.responsibilityCalendar)));
  }
  if(current.customerDuePassed===false&&scope.customerGoal)consider(Date.parse(scope.customerGoal));
  if(!current.lagMinutes||current.nodes.every(node=>node.businessCompleted))continue;
  const ends=scope.work.flatMap(work=>work.end?[Date.parse(work.end)]:[]),horizon=Math.max(now,...ends)+366*86400000;
  for(const side of ['minimum','maximum'] as const){
   if(current.lagMinutes[side]>0)continue;
   const late=(time:number)=>(evaluateFixedScheduleScope(scope,new Date(time).toISOString()).lagMinutes?.[side]??-Infinity)>0;
   if(!late(horizon))continue;
   let low=now,high=horizon;
   while(high-low>1){const mid=Math.floor((low+high)/2);if(late(mid))high=mid;else low=mid;}
   consider(high);
  }
 }
 return next===null?null:new Date(next).toISOString();
}

/** Live scoped DTO only; the existing role/field owner decides whether this
 * basis is readable. Shared storage uses the separate explicit whitelist. */
export function attachFixedJourneySchedule(item:OrderJourney,basis:FixedScheduleBasis,asOf:string,options:{progress?:FixedScheduleProgress;nextChange?:boolean}={}){
 attachOrderTimeCoverage(item,basis);
 const progress=options.progress??evaluateFixedJourneyBasis(basis,asOf,item.display?.mainState==='overdue');if(options.nextChange!==false)progress.nextChangeAt=nextFixedScheduleClassification(basis,asOf);item.fixedSchedule=progress;
 const excluded=new Set(basis.notApplicableNodes??[]);
 attachFrameworkEvents(item,basis,progress);
 attachJourneyWashing(item,basis,progress);
 const aliases:Record<string,string>={production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',customer_confirmation:'customer_sample',source_confirmation:'development_confirmation',factory_work:'production_reporting',factory_production:'factory_production_qc',return_logistics:'receipts',garment_inspection:'receiving_inspection',garment_packing:'packing',bulk_printing:'process_logistics',bulk_embroidery:'process_logistics',development_craft_return:'development_craft_confirmation'};
 for(const node of item.stages.flatMap(stage=>stage.nodes)){
  if(!node.current||node.state==='unavailable'||node.unavailableReason==='permission')continue;
  // Only an explicit complete effective route can suppress a legacy unknown.
  // Retain genuine started/completed history even after later route changes.
  if(excluded.has(node.key as 'process_logistics'|'bulk_qc')&&['uncreated','pending','not_applicable'].includes(node.state)&&!node.enteredAt&&!node.actualAt&&!node.actualDate&&!node.nativeWindows?.some(window=>window.startedAt||window.complete)&&![...(node.timings??[]),...(node.timing?[node.timing]:[])].some(timing=>timing.actualStart||timing.actualEnd)){
   node.state='not_applicable';node.progressApplicability='not_applicable';node.countsInProgress=false;node.sla='not_set';
   node.risks=node.risks.filter(risk=>!['unknown','overdue','due_soon'].includes(risk));
   node.expectedAt=null;node.expectedKind='unset';node.expectedPrecision='missing';delete node.timing;delete node.timings;
   if(item.supervision)item.supervision.nodes=item.supervision.nodes.filter(timing=>!(['bulk_printing','bulk_embroidery','bulk_print_embroidery'].includes(timing.id.split(':')[0]!)&&node.key==='process_logistics'||timing.id.split(':')[0]==='bulk_qc'&&node.key==='bulk_qc'));
   continue;
  }
  const ids=new Set(node.records.flatMap(record=>record.lineId?[record.lineId]:[]));
  const inherited=node.state==='inherited'&&node.inheritedFrom&&node.records.some(record=>record.domain==='task'&&record.id===node.inheritedFrom!.taskId)?node.inheritedFrom:null;
  const taskId=inherited?.taskId??node.instanceId,taskRound=inherited?.round??node.round,taskRef=`task:${taskId}:`;
  const nativeTask=node.state==='inherited'||Boolean(node.inheritedFrom)||node.records.some(record=>record.domain==='task'&&record.id===taskId);
  const ownFact=(scope:FixedScheduleBasis['scopes'][number],id:string)=>{
   const canonical=scope.work.find(work=>work.id===id)?.canonicalWorkRef.match(/^source:([^:]+):round:(\d+):/);
   if(canonical&&(canonical[1]!==item.sourceId||taskRound!==null&&Number(canonical[2])!==taskRound))return false;
   const fact=scope.facts[id];return fact?.ownTaskId===taskId||fact?.ownTaskId===undefined&&fact?.evidenceRefs[0]?.startsWith(taskRef);
  };
  const exactTask=basis.scopes.some(scope=>Object.keys(scope.facts).some(id=>ownFact(scope,id)));
  const targets=progress.scopes.flatMap(scope=>ids.size&&scope.lineId&&!ids.has(scope.lineId)?[]:scope.nodes.filter(value=>{
   // Washing rows already identify an exact original/planned/history round.
   // Reattaching by kind would replace that round's P/R/D with the aggregate.
   if(node.instanceId.startsWith('washing-work:'))return node.instanceId===journeyWashingInstanceId(scope.scopeRef,value.id);
   if(exactTask)return ownFact(basis.scopes.find(input=>input.scopeRef===scope.scopeRef)!,value.id);
   // A visible native task is an instance, not a planning placeholder. Without
   // its own fact (or an explicit inherited task) kind equality cannot borrow
   // another source/round's fixed target or completed evidence.
   if(nativeTask)return false;
   const raw=value.id.startsWith('source:')?value.id.slice(7):value.id,key=raw.split(':')[0]!;
   if(basis.framework&&key==='customer_confirmation')return false;
   if(basis.framework&&key==='client_sample_approval')return node.key==='customer_sample';
   return (aliases[key]??key)===node.key;
  }).map(value=>({scopeRef:scope.scopeRef,lineId:scope.lineId,progress:value})));
  if(!targets.length)continue;
  if(node.expectedKind==='sla'&&node.expectedAt&&node.records.some(record=>record.domain==='task'&&record.id===node.instanceId)&&['instant','date'].includes(node.expectedPrecision))node.nativeTaskDeadline={at:node.expectedAt,precision:node.expectedPrecision as 'instant'|'date',mode:node.deadlineMode,exclusive:node.deadlineExclusive};
  node.fixedTargets=targets;
  if(node.state==='cancelled'&&exactTask&&targets.every(({progress})=>progress.state==='terminated')){
   const durations=targets.map(({progress})=>progress.ownSla.overdueMinutes);
   node.overdueSeconds=durations.every(duration=>duration&&duration.minimum===duration.maximum)?Math.max(...durations.map(duration=>duration!.maximum))*60:null;
   node.risks=node.risks.filter(risk=>risk!=='overdue'&&risk!=='due_soon');
  }
  if(basis.policyVersion==='order-time-plan-v1'&&!['completed','inherited','cancelled','not_applicable'].includes(node.state)){
   // Unknown siblings cannot erase a proven own-window risk. Neither can a
   // legacy aggregate deadline replace the current per-PO responsibility.
   node.risks=node.risks.filter(risk=>risk!=='overdue'&&risk!=='due_soon');
   if(targets.some(target=>target.progress.ownSla.state==='overdue'||target.progress.goalDelta.kind==='late'))node.risks.push('overdue');else if(targets.some(target=>target.progress.ownSla.warning))node.risks.push('due_soon');
  }
  const displayed=targets.map(({progress})=>progress.currentTarget??{at:progress.goalDelta.targetAt,date:progress.goalDelta.targetDate,precision:progress.goalDelta.targetPrecision});
  const ends=displayed.map(target=>target.at),same=ends.every(at=>at!==null&&at===ends[0]);
  // Original native timing.target remains independent D. Only the field named
  // expected uses B; never choose one PO deadline as the whole aggregate.
  const date=displayed[0]!.date,sameDay=same&&date!==null&&displayed.every(target=>target.precision==='date'&&target.date===date);
  node.expectedAt=sameDay?date:same?ends[0]!:null;node.expectedPrecision=sameDay?'date':same?'instant':'missing';node.expectedKind=same?'plan':'unset';
 }
}

/** An explicit minimal shared-fact whitelist: no user, names, grants, URLs,
 * complete adopted settings or executable response can enter this snapshot. */
export function fixedScheduleBasisSnapshot(basis:FixedScheduleBasis):FixedScheduleBasis{
 return {...(basis.framework?{framework:structuredClone(basis.framework)}:{}),version:basis.version,...(basis.policyVersion?{policyVersion:basis.policyVersion}:{}),...(basis.notApplicableNodes?{notApplicableNodes:basis.notApplicableNodes.filter(key=>key==='process_logistics'||key==='bulk_qc')}:{}),scopeRevision:basis.scopeRevision,factRevision:basis.factRevision,pending:basis.pending,
  termination:basis.termination?{kind:basis.termination.kind,at:basis.termination.at,precision:basis.termination.precision,originEventRef:basis.termination.originEventRef,scopeRef:basis.termination.scopeRef}:null,
  scopes:basis.scopes.map(scope=>({... (scope.plannedReadiness?{plannedReadiness:true}:{}),scopeRef:scope.scopeRef,lineId:scope.lineId,targetRevision:scope.targetRevision,terminalIds:[...scope.terminalIds],customerGoal:scope.customerGoal,
   work:scope.work.map(work=>({id:work.id,canonicalWorkRef:work.canonicalWorkRef,...(work.completionTarget!==undefined?{completionTarget:work.completionTarget?{end:work.completionTarget.end,...(work.completionTarget.endExclusive!==undefined?{endExclusive:work.completionTarget.endExclusive}:{}),targetRevision:work.completionTarget.targetRevision,targetPrecision:work.completionTarget.targetPrecision,targetDate:work.completionTarget.targetDate}:null}:{}),...(work.stage!==undefined?{stage:work.stage}:{}),dependsOn:[...work.dependsOn],...(work.dependencyReserves?{dependencyReserves:Object.fromEntries(Object.entries(work.dependencyReserves).map(([id,reserve])=>[id,{minutes:reserve.minutes,calendar:reserve.calendar}]))}:{}),start:work.start,end:work.end,...(work.approvedCurrentTarget?{approvedCurrentTarget:{...work.approvedCurrentTarget}}:{}),...(work.eventTarget?{eventTarget:{...work.eventTarget}}:{}),...(work.startExclusive!==undefined?{startExclusive:work.startExclusive}:{}),...(work.endExclusive!==undefined?{endExclusive:work.endExclusive}:{}),minutes:work.minutes,calendar:work.calendar,
    ...(work.rewashRound!==undefined?{rewashRound:work.rewashRound}:{}),...(work.includedIn!==undefined?{includedIn:work.includedIn}:{}),...(work.accountingRole!==undefined?{accountingRole:work.accountingRole}:{}),...(work.originalHandoffAt!==undefined?{originalHandoffAt:work.originalHandoffAt}:{}),responsibilitySlaRef:work.responsibilitySlaRef,...(work.responsibilityMinutes!==undefined?{responsibilityMinutes:work.responsibilityMinutes}:{}),...(work.responsibilityCalendar!==undefined?{responsibilityCalendar:work.responsibilityCalendar}:{}),...(work.responsibilityWarningAt!==undefined?{responsibilityWarningAt:work.responsibilityWarningAt}:{}),...(work.responsibilityReminderPercent!==undefined?{responsibilityReminderPercent:work.responsibilityReminderPercent}:{}),...(work.targetPrecision!==undefined?{targetPrecision:work.targetPrecision}:{}),...(work.targetDate!==undefined?{targetDate:work.targetDate}:{}),...(work.targetRevision!==undefined?{targetRevision:work.targetRevision}:{})})),
   facts:Object.fromEntries(Object.entries(scope.facts).map(([id,fact])=>[id,{...(fact.ownTaskId?{ownTaskId:fact.ownTaskId}:{}),ready:structuredClone(fact.ready),completed:structuredClone(fact.completed),clockStart:structuredClone(fact.clockStart),businessCompleted:fact.businessCompleted,waitingForPredecessors:fact.waitingForPredecessors,evidenceRefs:[...fact.evidenceRefs],...(fact.ownWindows?{ownWindows:fact.ownWindows.map(window=>({sourceRef:window.sourceRef,started:structuredClone(window.started),completed:structuredClone(window.completed),complete:window.complete,deadline:window.deadline,warningAt:window.warningAt,calendar:window.calendar,...(window.nativeWashingWindow?{nativeWashingWindow:{scopeId:window.nativeWashingWindow.scopeId,windowId:window.nativeWashingWindow.windowId}}:{})}))}:{}),...(fact.impactStartedAt!==undefined?{impactStartedAt:fact.impactStartedAt}:{}),...(fact.terminated!==undefined?{terminated:fact.terminated}:{}),...(fact.terminationAt!==undefined?{terminationAt:fact.terminationAt}:{}),...(fact.notYetReady!==undefined?{notYetReady:fact.notYetReady}:{})}]))}))};
}
