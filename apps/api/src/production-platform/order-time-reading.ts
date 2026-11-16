import {developmentResponsibilityWindow,developmentReadyCorrectionSql,type ReadyCorrection} from './development-responsibility-window.js';
import type {FrozenTimeFramework} from '@dx-rework/contracts/order-time-framework';
import {frameworkNodeTargets,frameworkTargetPrecision} from './framework-node-targets.js';
import {journeyWashingFact} from './journey-washing-facts.js';
import {readBulkWashing} from './bulk-washing-service.js';
import {washingPlans} from './bulk-washing-repository.js';
import type {SeriesObservedFact} from '@dx-rework/contracts/digital-series-plan';
import {readSeriesPlanFacts} from './series-plan-facts.js';
import {frameworkJourneyBasis} from './journey-time-framework.js';
import {orderTimeCompletionTarget,inheritedSourcePolicyAt,isInheritedSourceWork,type InheritedOrderTimeHistory} from './order-time-completion-target.js';
import {currentPreparationMaterial} from './preparation-material-repository.js';
import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {BusinessTime,BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {SlaNodeFact} from '@dx-rework/domain/digital-sla-plan';
import type {OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import {orderTimeRule} from '@dx-rework/contracts/order-time-plan';
import type {ScheduleOccurrence} from '@dx-rework/contracts';
import {OrderTimePlanRepository,type StoredOrderTimePlan} from './order-time-plan-repository.js';
import {buildOrderTimeWork,type OrderTimeWork} from './order-time-schedule.js';
import {orderTimeWorkDefinition} from './fixed-work-definition.js';
import {requiredFixedTimelineWork} from './fixed-timeline-targets.js';
import {nativeTaskReadiness,nativeCuttingReadiness,type NativeCuttingReadiness} from './task-readiness-facts.js';
import {nativeCuttingCompletions,type NativeCuttingCompletion} from './cutting-completion-facts.js';
import type {FixedScheduleBasis} from './fixed-schedule-basis.js';
import type {ScheduleFact,ScheduleWork} from './fixed-schedule-progress.js';
import {journeyTermination} from './journey-termination.js';
import {orderTimeCreated} from './order-time-created.js';
import {orderTimePolicyHistory} from './order-time-native-timing.js';
import {shiftFixedTimeline} from './fixed-timeline-targets.js';

type DB=Pick<PoolClient,'query'>;
const unknown:ScheduleOccurrence={precision:'unknown'};
const instant=(value:unknown):ScheduleOccurrence=>value instanceof Date?{precision:'instant',at:value.toISOString()}:typeof value==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?{precision:'instant',at:new Date(value).toISOString()}:unknown;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliases:Record<string,string>={production_sheet:'production_instruction',warehouse_accessories:'accessories_ready',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',customer_confirmation:'customer_sample',source_confirmation:'development_confirmation',external_pattern:'development_external_pattern',development_craft_return:'development_craft_confirmation',factory_production_work:'production_reporting',factory_production:'factory_production_qc',garment_inspection:'receiving_inspection',garment_packing:'packing',return_logistics:'receipts'};
const keyOf=(work:OrderTimeWork)=>work.parameterKey.startsWith('development_special_')?'development_printing':aliases[work.parameterKey]??work.parameterKey;
const empty=():ScheduleFact=>({ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:[]});
type NativeTask={ready_correction?:ReadyCorrection|null;task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;route_version:number;state:string;entered_at:Date|null;entered_quality:string;completed_at:Date|null;completed_quality:string;step_id:string|null;returned:boolean;rejected:boolean;sla_basis:{seconds?:number|null;calendarRef?:ScheduleWork['calendar'];enteredAt?:string|null;timeQuality?:string;basis?:string[]}|null;native_entered_at:Date|null;warning_at:Date|null};
type Evidence={tasks:NativeTask[];readiness:Awaited<ReturnType<typeof nativeTaskReadiness>>;cutting:NativeCuttingReadiness[];cutCompletions:NativeCuttingCompletion[];created?:{reference:string;at:string;evidence:string}|null;policies?:Awaited<ReturnType<typeof orderTimePolicyHistory>>;inheritedPolicies?:InheritedOrderTimeHistory;washing?:Record<string,ScheduleFact>;frameworkFacts?:SeriesObservedFact[];commercial?:{completed:boolean;at:string|null;evidence:string}};

/** Current native task identities, not labels or a newly generated adoption ID.
 * The authorized caller already owns the original RR client and resource. */
async function taskEvidence(db:DB,resource:BusinessTimeScope,item:OrderJourney):Promise<Evidence>{
 const tasks=(await db.query<NativeTask>(`SELECT t.task_id,${developmentReadyCorrectionSql('t.task_id')} AS ready_correction,a.task_kind,a.source_id,a.production_order_id,t.route_version,t.state,
  t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,position.step_id,d.sla_basis,d.entered_at AS native_entered_at,d.warning_at,
  EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned,
  EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS rejected
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN digital_timeline_task_positions position USING(task_id)
  LEFT JOIN LATERAL(SELECT r.sla_basis,r.entered_at,r.warning_at FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id
   ORDER BY CASE WHEN a.source_id IS NULL AND t.state='completed' AND r.reason='completion' THEN 0 ELSE 1 END,r.revision_id DESC LIMIT 1) d ON true
  WHERE ($1::uuid IS NOT NULL AND a.production_order_id=$1) OR ($2::uuid IS NOT NULL AND a.source_id=$2)
  ORDER BY t.route_version,t.created_at,t.task_id`,[resource.kind==='order'?resource.id:null,resource.kind==='source'?resource.id:item.sourceId])).rows;
 const ids=tasks.map(task=>task.task_id),readiness=await nativeTaskReadiness(db,ids);
 return {tasks,readiness,cutting:resource.kind==='order'?await nativeCuttingReadiness(db,ids):[],cutCompletions:resource.kind==='order'?await nativeCuttingCompletions(db,resource.id):[]};
}

function nativeFor(work:OrderTimeWork,scope:{lineId:string|null},resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,evidence:Evidence):{fact:ScheduleFact;task:NativeTask|null;native?:SlaNodeFact}{
 if(work.canonicalWorkRef?.startsWith('creation:')){
  const created=evidence.created?.reference===work.canonicalWorkRef?evidence.created:null,at=created?instant(created.at):unknown;
  return {fact:{...empty(),ready:at,clockStart:at,completed:at,businessCompleted:Boolean(created),evidenceRefs:created?[created.evidence]:[]},task:null};
 }
 const shared=work.id.startsWith('source:'),raw=shared?work.id.slice(7):work.id,key=keyOf(work);
 const declared=work.canonicalWorkRef?.match(/^source:([^:]+):round:(\d+):/),round=declared?Number(declared[2]):resource.kind==='source'?item.selectedRound??1:shared?item.adoptedRound:null;
 const sourceId=resource.kind==='source'?resource.id:item.sourceId;
 // A stored source reference may never borrow another resource or latest round.
 if(declared&&declared[1]!==sourceId)return {fact:empty(),task:null};
 const step=work.canonicalWorkRef?.match(/:step:([^:]+):/)?.[1];
 const tasks=evidence.tasks.filter(task=>task.state!=='cancelled'&&(task.task_kind===key||key==='bulk_cutting'&&task.task_kind==='bulk_cutting_external')
  &&(resource.kind==='source'||shared?task.source_id===sourceId&&round!==null&&task.route_version===round:task.production_order_id===resource.id)
  &&(!step||task.step_id===step));
 const task=tasks.length===1?tasks[0]!:null;
 const perPo=scope.lineId!==null&&work.id.endsWith(':'+scope.lineId);
 const nodes=item.stages.flatMap(stage=>stage.nodes).filter(node=>node.current&&node.state!=='unavailable'&&node.key===key
  &&(!scope.lineId||!node.records.some(record=>record.lineId)||node.records.some(record=>record.lineId===scope.lineId))
  &&(!perPo||new Set(node.records.flatMap(record=>record.lineId?[record.lineId]:[])).size===1)
  &&(!step||Boolean(task&&node.records.some(record=>record.domain==='task'&&record.id===task.task_id)))
  &&(round===null||node.round===round||node.round===null));
 const node=nodes.length===1?nodes[0]:undefined;
 const matchesReadRound=round===null||round===(resource.kind==='source'?item.selectedRound??1:item.adoptedRound);
 const direct=matchesReadRound?(native[work.id]??native[raw]??(!shared&&resource.kind==='order'&&!scope.lineId?native[work.parameterKey]:undefined)):undefined;
 // Task-based native evidence is exact even when its map key includes task ID.
 const facts=task?Object.values(native).filter(fact=>fact.evidence.includes(`task:${task.task_id}`)):[];
 const value=facts.length===1?facts[0]:direct;
 let fact:ScheduleFact=value?{...empty(),ready:instant(value.startedAt),clockStart:instant(value.startedAt),completed:value.completedDate?{precision:'date',date:value.completedDate}:instant(value.completedAt),businessCompleted:value.businessCompleted===true||Boolean(value.completedAt||value.completedDate),evidenceRefs:[value.evidence]}:empty();
 if(task){
  const readiness=evidence.readiness.get(task.task_id),accepted=task.state==='completed'&&!task.returned&&!task.rejected;
  const responsibility=task.source_id?developmentResponsibilityWindow(task,task.native_entered_at??task.entered_at,task.sla_basis,evidence.tasks):null;
  const ready=readiness?.tracked?instant(readiness.firstReadyAt):responsibility?instant(responsibility.at):['现场登记','已核实'].includes(task.entered_quality)?instant(task.entered_at):unknown;
  fact={...fact,ownTaskId:task.task_id,ready,clockStart:ready,completed:accepted&&['现场登记','已核实'].includes(task.completed_quality)?instant(task.completed_at):unknown,businessCompleted:accepted,
   notYetReady:readiness?.tracked===true&&readiness.eventId===null&&!accepted,
   evidenceRefs:[`task:${task.task_id}:round:${task.route_version}`,...readiness?.basis??[]]};
 }else if(node&&!value){
  const actual=node.state==='inherited'?node.inheritedResult?.adoptedAt:node.actualAt;
  const trusted=node.state==='inherited'?Boolean(node.inheritedResult?.adoptionSourceRef&&node.inheritedResult.adoptedRound===node.round):node.actualQuality!=='missing'&&node.actualQuality!=='unavailable';
  const completed=node.state==='completed'||node.state==='inherited';
  fact={...fact,ready:instant(node.enteredAt),clockStart:instant(node.enteredAt),businessCompleted:completed,
   completed:completed&&trusted?(node.actualDate?{precision:'date',date:node.actualDate}:instant(actual)):unknown,
   notYetReady:['uncreated','pending'].includes(node.state)&&!node.enteredAt,evidenceRefs:[...fact.evidenceRefs,...node.records.map(record=>`${record.domain}:${record.id}`)]};
 }
 // A timing policy can have no completion metadata while the exact current
 // authorized business record already has a verified occurrence. Keep its
 // original clock/window, and fill only that missing completion.
 if(!task&&node&&fact.completed.precision==='unknown'&&node.state==='completed'&&node.actualQuality==='verified'&&node.actualAt){
  fact={...fact,businessCompleted:true,completed:instant(node.actualAt),evidenceRefs:[...new Set([...fact.evidenceRefs,...node.records.map(record=>`${record.domain}:${record.id}`)])]};
 }
 if(node&&!task&&!fact.businessCompleted&&fact.ready.precision==='unknown'&&['uncreated','pending'].includes(node.state))fact.notYetReady=true;
 if(key==='bulk_cutting'&&scope.lineId){
  const cuts=evidence.cutting.filter(cut=>cut.lineId===scope.lineId&&(!task||cut.taskId===task.task_id)),cut=cuts.length===1?cuts[0]:null;
  const completed=evidence.cutCompletions.filter(event=>event.payload.lineId===scope.lineId&&(!cut||event.payload.cuttingOrderId===cut.cuttingOrderId));
  const completion=completed.length===1?completed[0]:null;
  const ready=cut?instant(cut.firstReadyAt):unknown;
  fact={...fact,ready,clockStart:ready,businessCompleted:Boolean(completion),completed:completion&&['现场登记','已核实'].includes(completion.time_quality)?instant(completion.occurred_at):unknown,
   notYetReady:!cut&&!completion&&Boolean(task&&evidence.readiness.get(task.task_id)?.tracked),evidenceRefs:[...fact.evidenceRefs,...cut?.basis??[],...(completion?[`digital_production_task_events:${completion.event_id}`]:[])]};
 }
 return {fact,task,...(value?{native:value}:{})};
}

/** Pure mapping of explicit frozen work, retained B and already-scoped facts.
 * Legacy windows remain authoritative for begun responsibility, even after an
 * order arrangement changes. No current-company lookup or implicit adoption. */
export function orderTimeReadingBasis(saved:StoredOrderTimePlan,resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,evidence:Evidence,legacy:FixedScheduleBasis|null):FixedScheduleBasis{
 const definitions=buildOrderTimeWork(saved.input.plan,saved.input.work),byId=new Map(saved.input.work.map(work=>[work.id,work]));
 const completionTargets=new Map<FrozenTimeFramework,ReturnType<typeof frameworkNodeTargets>>();
 const scopes=saved.input.scopes.map(scope=>{
  const original=legacy?.scopes.find(value=>value.scopeRef===scope.scopeRef||scope.lineId&&value.lineId===scope.lineId);
  const framework=saved.input.frameworkPlans?.[scope.scopeRef],frameworkTargets=framework?frameworkNodeTargets(framework):null;
  const required=requiredFixedTimelineWork(definitions,scope.terminalIds),facts:Record<string,ScheduleFact>={};
  const work:ScheduleWork[]=required.map(definition=>{
   const source=byId.get(definition.id)!,target=framework?framework.arranged.find(row=>row.id===source.id):saved.targets[scope.scopeRef]?.[source.id],policy=orderTimeWorkDefinition(saved.input.plan,source.parameterKey,source.craftStep);
   const old=original?.work.find(value=>source.canonicalWorkRef?value.canonicalWorkRef===source.canonicalWorkRef:value.id===source.id);
   const own=nativeFor(source,scope,resource,item,native,evidence),previous=old&&original?.facts[old.id];
   // An empty legacy placeholder is not a conflicting historical event. It
   // cannot hide this exact scope's already verified native completion.
   const emptyPrevious=previous&&!previous.businessCompleted&&!previous.evidenceRefs.length&&[previous.ready,previous.clockStart,previous.completed].every(value=>value.precision==='unknown');
   let fact=previous&&!(emptyPrevious&&own.fact.businessCompleted&&own.fact.completed.precision!=='unknown')?structuredClone(previous):own.fact;
   // Current exact-task R can invalidate a stale legacy clock. Keep the
   // existing completion/date mapping and original target history separate.
   if(own.task&&own.task.source_id)fact={...fact,ready:own.fact.ready,clockStart:own.fact.clockStart,notYetReady:own.fact.notYetReady===true,ownTaskId:own.task.task_id,evidenceRefs:[...new Set([...fact.evidenceRefs,...own.fact.evidenceRefs])]};
   if(evidence.washing?.[source.id])fact=structuredClone(evidence.washing[source.id]!);
   if(framework){
    const names:Record<string,string>={fabric_receipt_a:'fabric_receipt',fabric_receipt_b:'fabric_receipt',warehouse_accessories:'accessories_ready',warehouse_dispatch:'processing_dispatch'};
    const rows=evidence.frameworkFacts?.filter(row=>row.key===(names[source.parameterKey]??source.parameterKey))??[];
    const exact=rows.filter(row=>row.scopeRef===scope.scopeRef),selected=exact.length?exact:rows.filter(row=>row.scopeRef==='whole');
    const observed=selected.length===1?selected[0]:null;
    // Partial whole-order dispatch cannot erase a completed PO; the native
    // task's ready/clock/windows stay intact when completion is overlaid.
    if(observed&&!(observed.scopeRef==='whole'&&scope.lineId&&source.id.endsWith(':'+scope.lineId)&&fact.businessCompleted&&!observed.completed)){
     fact.businessCompleted=observed.completed;
     fact.completed=!observed.completed?unknown:observed.precision==='instant'?instant(observed.occurredAt):observed.precision==='date'&&observed.occurredDate?{precision:'date',date:observed.occurredDate}:unknown;
     fact.evidenceRefs=[...new Set([...fact.evidenceRefs,`${observed.sourceDomain}:${observed.sourceRecordId}:v${observed.sourceVersion}`])];
    }
    if(source.parameterKey==='customer_confirmation'){
     // Commercial acceptance is not the client's final sample approval.
     fact.businessCompleted=evidence.commercial?.completed===true;
     fact.completed=fact.businessCompleted?instant(evidence.commercial?.at):unknown;
     fact.ready=unknown;fact.clockStart=unknown;
     fact.evidenceRefs=evidence.commercial?[evidence.commercial.evidence]:[];
    }
   }
   // A genuine zero-duration event occurs once. Its own occurrence can anchor
   // that event's position without inventing an enteredAt for a human task.
   const rule=orderTimeRule(saved.input.plan,source.parameterKey)?.rule;
   if(rule?.kind==='event'&&fact.ready.precision==='unknown'&&fact.businessCompleted&&fact.completed.precision!=='unknown')fact.ready=structuredClone(fact.completed);
   if(own.task)fact.ownTaskId=own.task.task_id;
   facts[source.id]=fact;
   const begun=fact.clockStart.precision!=='unknown'||fact.businessCompleted||Boolean(own.task?.native_entered_at);
   if(own.native?.batchWindows?.length&&(policy.responsibilitySlaRef||old?.responsibilitySlaRef))fact.ownWindows=own.native.batchWindows.map(window=>({sourceRef:window.evidence,started:instant(window.startedAt),completed:instant(window.completedAt),complete:window.complete,deadline:window.deadline,warningAt:window.warningAt,
    calendar:'calendarRef'in window&&['continuous','natural_days','beijing_sunday_excluded'].includes(String(window.calendarRef))?window.calendarRef as ScheduleWork['calendar']:old?.responsibilityCalendar??'continuous'}));
   const taskOwn=begun&&typeof own.task?.sla_basis?.seconds==='number'?{responsibilitySlaRef:`task:${own.task.task_id}:original-window`,responsibilityMinutes:own.task.sla_basis.seconds/60,responsibilityCalendar:own.task.sla_basis.calendarRef??'continuous' as const}:null;
   // An original adopted task window owns its established responsibility R.
   // A legacy planning counterpart can lack readiness without erasing that
   // verified native clock. This does not invent availability/ready evidence.
   if(taskOwn&&fact.clockStart.precision==='unknown'&&fact.notYetReady!==true&&!own.native?.batchWindows?.length&&!(source.parameterKey==='bulk_cutting'&&scope.lineId!==null)&&own.task?.native_entered_at&&own.fact.clockStart.precision!=='unknown')fact.clockStart=instant(own.task.native_entered_at);
   const nativeOwn=begun&&typeof own.native?.standardMinutes==='number'?{responsibilitySlaRef:own.native.evidence,responsibilityMinutes:own.native.standardMinutes,responsibilityCalendar:own.native.standardCalendar??'continuous' as const}:null;
   const start=fact.clockStart.precision==='instant'?fact.clockStart.at:null;
   const captured=start?evidence.policies?.find(version=>Date.parse(version.at)<=Date.parse(start))??inheritedSourcePolicyAt(source,evidence.inheritedPolicies,start,saved.time.scenarioId):undefined;
   const capturedRule=captured?orderTimeRule(captured.plan,source.parameterKey)?.rule:null;
   const atStart=begun&&captured&&capturedRule?.kind==='work'?{responsibilitySlaRef:`order-time:${captured.id}:${source.parameterKey}`,responsibilityMinutes:capturedRule.minutes,responsibilityCalendar:capturedRule.calendar}:null;
   // Exact native task/batch windows own their clocks. Other original events
   // select this order's confirmed policy at R, never a later arrangement.
   const originalOwn=taskOwn??(own.native?.standardCalendar||own.native?.batchWindows?.length?nativeOwn:null)??atStart??nativeOwn??(begun&&old?{responsibilitySlaRef:old.responsibilitySlaRef,responsibilityMinutes:old.responsibilityMinutes,responsibilityCalendar:old.responsibilityCalendar}:begun?{responsibilitySlaRef:null,responsibilityMinutes:null,responsibilityCalendar:null}:policy);
   const capturedWarning=atStart&&start&&capturedRule?.minutes!==null&&capturedRule?.calendar&&capturedRule.reminder.enabled?shiftFixedTimeline(start,capturedRule.minutes*capturedRule.reminder.percent/100,capturedRule.calendar):null;
   const reminder=orderTimeRule(saved.input.plan,source.parameterKey)?.rule.reminder;
   const goal=!framework&&scope.customerGoalIds.includes(source.id),anchor=scope.goals[source.id];
   const eventConstraint=frameworkTargets?.get(source.id),eventTarget=eventConstraint&&eventConstraint!==target?{end:eventConstraint.end.at,...frameworkTargetPrecision(eventConstraint),exclusive:eventConstraint.end.exclusive}:undefined;
   return {...definition,stage:source.stage,canonicalWorkRef:source.canonicalWorkRef??`${resource.kind}:${resource.id}:work:${source.id}`,
    start:target?.start.at??null,end:target?.end.at??null,...(target?{startExclusive:target.start.exclusive,endExclusive:target.end.exclusive}:{}),...originalOwn,...(eventTarget?{eventTarget}:{}),
    responsibilitySlaRef:originalOwn.responsibilitySlaRef,responsibilityMinutes:originalOwn.responsibilityMinutes??null,responsibilityCalendar:originalOwn.responsibilityCalendar??null,
    ...(begun?{responsibilityWarningAt:own.task?.warning_at?.toISOString()??(atStart?capturedWarning:old?.responsibilityWarningAt??null)}:{responsibilityReminderPercent:reminder?.enabled?reminder.percent:null}),
    ...(framework?frameworkTargetPrecision(target):{targetPrecision:goal&&anchor?.precision==='date'?'date' as const:'instant' as const,targetDate:goal&&anchor?.precision==='date'?anchor.value:null})};
  });
  // Native accepted redo remains real work even when it was not in the
  // original route. Preserve its original handoff/clock and reconnect only
  // those native additions; never restore a superseded planned route.
  const ids=new Set(work.map(node=>node.id)),added=original?.work.filter(node=>node.accountingRole==='added_work'&&!ids.has(node.id))??[];
  // A craft's processing report does not close its parent window. Reconcile
  // only that frozen work's included return, so another craft/round cannot
  // supply its completion when there is no matching legacy basis.
  for(const parent of saved.input.work.filter(node=>(['development_printing','development_embroidery'].includes(node.parameterKey)||node.parameterKey.startsWith('development_special_')))){
   const fact=facts[parent.id];if(!fact)continue;
   const returns=saved.input.work.filter(node=>node.includedIn===parent.id&&node.parameterKey==='development_craft_return');
   const receipt=returns.length===1?(facts[returns[0]!.id]??nativeFor(returns[0]!,scope,resource,item,native,evidence).fact):undefined;
   fact.businessCompleted=fact.businessCompleted&&receipt?.businessCompleted===true;
   fact.completed=fact.businessCompleted?receipt!.completed:unknown;
   fact.evidenceRefs=[...new Set([...fact.evidenceRefs,...receipt?.evidenceRefs??[]])];
  }
  const addedIds=new Set(added.map(node=>node.id));
  for(const node of added){work.push(structuredClone(node));facts[node.id]=structuredClone(original!.facts[node.id]??empty());}
  for(const node of work){const old=original?.work.find(previous=>previous.id===node.id);if(old)node.dependsOn=[...new Set([...node.dependsOn,...old.dependsOn.filter(id=>addedIds.has(id))])];}
  for(const node of work){const fact=facts[node.id]!;
   const source=byId.get(node.id);
   if(source&&fact.businessCompleted&&(evidence.policies?.some(version=>version.history)||evidence.inheritedPolicies))node.completionTarget=orderTimeCompletionTarget(source,scope,fact.completed,evidence.policies??[],saved.time.scenarioId,evidence.inheritedPolicies,completionTargets);
   fact.waitingForPredecessors=fact.ready.precision==='unknown'&&node.dependsOn.length>0&&node.dependsOn.some(id=>!facts[id]?.businessCompleted);}
  const end=scope.customerGoal.precision==='instant'?scope.customerGoal.value:scope.customerGoal.precision==='date'?new Date(Date.parse(scope.customerGoal.value+'T00:00:00+08:00')+86400000).toISOString():null;
  return {...(saved.input.frameworkPlans?.[scope.scopeRef]?{plannedReadiness:true}:{}),scopeRef:scope.scopeRef,lineId:scope.lineId,targetRevision:`${saved.id}:${saved.revision}`,work,facts,terminalIds:[...(scope.customerGoalIds.length?scope.customerGoalIds:scope.terminalIds)],customerGoal:end};
 });
 // A complete saved production route is the applicability authority even
 // before a formal instruction exists. Missing targets alone prove nothing.
 const framework=frameworkJourneyBasis(saved,scopes,evidence.policies??[],item.asOf??saved.time.now);
 const noSecondary=resource.kind==='order'&&saved.input.route.complete&&!saved.input.work.some(work=>(['bulk_printing','bulk_embroidery','bulk_print_embroidery','bulk_qc'].includes(work.parameterKey)||work.parameterKey.startsWith('bulk_special_')));
 return {...(framework?{framework}:{}),version:'fixed-schedule-basis-v1',policyVersion:'order-time-plan-v1',...(noSecondary?{notApplicableNodes:['process_logistics','bulk_qc'] as Array<'process_logistics'|'bulk_qc'>}:{}),scopeRevision:saved.identityHash,factRevision:hash(scopes.map(scope=>scope.facts)),scopes,termination:legacy?.termination??null,
  pending:!saved.input.route.complete||scopes.some(scope=>{const required=new Set(requiredFixedTimelineWork(scope.work,scope.terminalIds).map(work=>work.id));return scope.work.some(work=>required.has(work.id)&&(!work.start||!work.end));})};
}

export async function readOrderTimeBasis(db:DB,resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,asOf:string,legacy:FixedScheduleBasis|null,time?:BusinessTime):Promise<FixedScheduleBasis|null>{
 const saved=await new OrderTimePlanRepository(db).current(resource);if(!saved)return legacy;
 if(time&&saved.time.scenarioId!==time.scenarioId)throw Error('本单时间方案与当前业务时钟范围不一致');
 const evidence=await taskEvidence(db,resource,item),root=saved.input.work.find(work=>work.canonicalWorkRef?.startsWith('creation:'))?.canonicalWorkRef?.match(/^creation:(source|order):([0-9a-f-]{36})$/);
 evidence.policies=await orderTimePolicyHistory(db,resource);
 // item.sourceId was resolved under the caller's original order authorization.
 // Read once on that same RR proxy, not per PO/work and not via a new connection.
 if(resource.kind==='order'&&item.sourceId&&saved.input.work.some(work=>isInheritedSourceWork(work,item.sourceId!)))evidence.inheritedPolicies={sourceId:item.sourceId,versions:await orderTimePolicyHistory(db,{kind:'source',id:item.sourceId})};
 if(root&&((root[1]==='source'&&root[2]===item.sourceId)||(root[1]==='order'&&resource.kind==='order'&&root[2]===resource.id))){const created=await orderTimeCreated(db,{kind:root[1] as 'source'|'order',id:root[2]!});evidence.created=created&&Date.parse(created.at)<=Date.parse(asOf)?{...created,reference:root[0]}:null;}
 const currentNative={...native};
 // This existing read is already under the caller's full-resource/field scope
 // and RR client. Accessory receipt has no digital human task: use its own
 // current valid material record, never the registration time or another PO.
 if(resource.kind==='order'&&saved.input.work.some(work=>work.parameterKey==='warehouse_accessories')){
  const material=await currentPreparationMaterial(db,resource.id,'accessories_ready');
  const known=material?.valid&&material.state==='ready'&&material.occurredAt&&Date.parse(material.occurredAt)<=Date.parse(asOf);
  currentNative.warehouse_accessories={evidence:material?`preparation-material:${material.recordId}:v${material.version}`:`preparation-material:${resource.id}:missing`,businessCompleted:Boolean(known),...(known?{completedAt:material.occurredAt!}:{})};
 }
 if(resource.kind==='order'&&saved.input.frameworkPlans){
  const order=(await db.query('SELECT customer_code FROM digital_production_orders WHERE production_order_id=$1',[resource.id])).rows[0];
  if(!order)throw Error('本单时间事实缺少原订单');
  evidence.frameworkFacts=(await readSeriesPlanFacts(db,resource.id,item.sourceId,order.customer_code,Number(saved.input.work.map(work=>work.canonicalWorkRef?.match(/^source:[^:]+:round:(\d+):/)?.[1]).find(Boolean)??item.adoptedRound??1))).facts;
  const commercial=(await db.query(`SELECT q.quote_id,q.confirmed_version,v.confirmation->>'confirmedAt' AS confirmed_at
   FROM digital_quotation_documents q JOIN digital_quotation_versions v ON v.quote_id=q.quote_id AND v.version=q.confirmed_version
   WHERE q.production_order_id=$1`,[resource.id])).rows[0];
  evidence.commercial={completed:Boolean(commercial),at:commercial?.confirmed_at&&Date.parse(commercial.confirmed_at)<=Date.parse(asOf)?commercial.confirmed_at:null,evidence:commercial?`quotation:${commercial.quote_id}:v${commercial.confirmed_version}`:`quotation:${resource.id}:unconfirmed`};
  const work=saved.input.work.filter(w=>/^bulk_(factory|return)_washing/.test(w.parameterKey));
  if(work.length){
   const sheet=await readBulkWashing(db,resource.id,null,asOf),plans=await washingPlans(db,resource.id);
   const quantities=(await db.query(`SELECT po.line_id,r.actual_cut_count::int AS quantity FROM digital_production_po_lines po
    LEFT JOIN digital_production_child_lines l ON l.module='cutting' AND l.line_id=po.line_id
    LEFT JOIN current_cutting_records r ON r.cutting_order_id=l.child_id WHERE po.production_order_id=$1`,[resource.id])).rows;
   evidence.washing={};
   for(const w of work){const lineId=saved.input.scopes.find(s=>s.lineId&&w.id.endsWith(':'+s.lineId))?.lineId;if(!lineId)continue;
    const rows=quantities.filter(q=>q.line_id===lineId),quantity=rows.length===1&&rows[0].quantity!==null?Number(rows[0].quantity):null;
    evidence.washing[w.id]=journeyWashingFact(sheet.scopes,plans,lineId,w.parameterKey,quantity,asOf);
   }
  }

 }
 const result=orderTimeReadingBasis(saved,resource,item,currentNative,evidence,legacy);
 result.termination=await journeyTermination(db,resource,asOf);return result;
}

/** Existing authorized missing-time KPI, from this exact policy/fact scope.
 * Unperformed actuals are not missing history and do not become fake dates. */
export function attachOrderTimeCoverage(item:OrderJourney,basis:FixedScheduleBasis){
 if(basis.policyVersion!=='order-time-plan-v1'||!item.supervision)return;
 const issuedFactoryCommitment=item.stages.flatMap(stage=>stage.nodes).some(node=>node.current&&node.key==='sourcing_owner'&&node.state==='completed');
 const coverage=item.supervision.coverage.filter(value=>value.key!=='plan'&&(!basis.framework||!['customer_date','fabric_date'].includes(value.key)&&!(value.key==='factory_date'&&!issuedFactoryCommitment)));
 // A new frozen framework already has its approved customer date and material
 // planning basis. A factory promise is required only once actually issued;
 // old legacy date warnings cannot turn an adopted route into missing input.
 const missing=basis.pending||basis.scopes.some(scope=>scope.work.some(work=>work.minutes===null||work.calendar===null&&work.minutes!==0));
 if(missing)coverage.push({key:'plan',message:'本单适用流程或所需时间还没设置完整'});
 if(basis.scopes.some(scope=>Object.values(scope.facts).some(fact=>fact.businessCompleted&&fact.completed.precision==='unknown'))&&!coverage.some(value=>value.key==='fact_time'))coverage.push({key:'fact_time',message:'已有完成记录的真实时间还需核对'});
 item.supervision.coverage=coverage;
}
