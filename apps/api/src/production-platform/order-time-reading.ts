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

type DB=Pick<PoolClient,'query'>;
const unknown:ScheduleOccurrence={precision:'unknown'};
const instant=(value:unknown):ScheduleOccurrence=>value instanceof Date?{precision:'instant',at:value.toISOString()}:typeof value==='string'&&/T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)&&Number.isFinite(Date.parse(value))?{precision:'instant',at:new Date(value).toISOString()}:unknown;
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aliases:Record<string,string>={production_sheet:'production_instruction',sourcing_selection:'sourcing_director',sourcing_approval:'sourcing_owner',customer_confirmation:'customer_sample',source_confirmation:'development_confirmation',external_pattern:'development_external_pattern',development_craft_return:'development_craft_confirmation',factory_production_work:'production_reporting',factory_production:'factory_production_qc',garment_inspection:'receiving_inspection',garment_packing:'packing',return_logistics:'receipts'};
const keyOf=(work:OrderTimeWork)=>aliases[work.parameterKey]??work.parameterKey;
const empty=():ScheduleFact=>({ready:unknown,clockStart:unknown,completed:unknown,businessCompleted:false,waitingForPredecessors:false,evidenceRefs:[]});
type NativeTask={task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;route_version:number;state:string;entered_at:Date|null;entered_quality:string;completed_at:Date|null;completed_quality:string;step_id:string|null;returned:boolean;rejected:boolean;sla_basis:{seconds?:number|null;calendarRef?:ScheduleWork['calendar']}|null;native_entered_at:Date|null;warning_at:Date|null};
type Evidence={tasks:NativeTask[];readiness:Awaited<ReturnType<typeof nativeTaskReadiness>>;cutting:NativeCuttingReadiness[];cutCompletions:NativeCuttingCompletion[]};

/** Current native task identities, not labels or a newly generated adoption ID.
 * The authorized caller already owns the original RR client and resource. */
async function taskEvidence(db:DB,resource:BusinessTimeScope,item:OrderJourney):Promise<Evidence>{
 const tasks=(await db.query<NativeTask>(`SELECT t.task_id,a.task_kind,a.source_id,a.production_order_id,t.route_version,t.state,
  t.entered_at,t.entered_quality,t.completed_at,t.completed_quality,position.step_id,d.sla_basis,d.entered_at AS native_entered_at,d.warning_at,
  EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='material_returned') AS returned,
  EXISTS(SELECT 1 FROM digital_development_route_facts f WHERE f.task_id=t.task_id AND f.kind='尾查退回') AS rejected
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN digital_timeline_task_positions position USING(task_id)
  LEFT JOIN LATERAL(SELECT r.sla_basis,r.entered_at,r.warning_at FROM digital_production_deadline_revisions r WHERE r.task_id=t.task_id
   ORDER BY CASE WHEN t.state='completed' AND r.reason='completion' THEN 0 ELSE 1 END,r.revision_id DESC LIMIT 1) d ON true
  WHERE ($1::uuid IS NOT NULL AND a.production_order_id=$1) OR ($2::uuid IS NOT NULL AND a.source_id=$2)
  ORDER BY t.route_version,t.created_at,t.task_id`,[resource.kind==='order'?resource.id:null,resource.kind==='source'?resource.id:item.sourceId])).rows;
 const ids=tasks.map(task=>task.task_id),readiness=await nativeTaskReadiness(db,ids);
 return {tasks,readiness,cutting:resource.kind==='order'?await nativeCuttingReadiness(db,ids):[],cutCompletions:resource.kind==='order'?await nativeCuttingCompletions(db,resource.id):[]};
}

function nativeFor(work:OrderTimeWork,scope:{lineId:string|null},resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,evidence:Evidence):{fact:ScheduleFact;task:NativeTask|null;native?:SlaNodeFact}{
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
  const ready=readiness?.tracked?instant(readiness.firstReadyAt):['现场登记','已核实'].includes(task.entered_quality)?instant(task.entered_at):unknown;
  fact={...fact,ready,clockStart:ready,completed:accepted&&['现场登记','已核实'].includes(task.completed_quality)?instant(task.completed_at):unknown,businessCompleted:accepted,
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
 const scopes=saved.input.scopes.map(scope=>{
  const original=legacy?.scopes.find(value=>value.scopeRef===scope.scopeRef||scope.lineId&&value.lineId===scope.lineId);
  const required=requiredFixedTimelineWork(definitions,scope.terminalIds),facts:Record<string,ScheduleFact>={};
  const work:ScheduleWork[]=required.map(definition=>{
   const source=byId.get(definition.id)!,target=saved.targets[scope.scopeRef]?.[source.id],policy=orderTimeWorkDefinition(saved.input.plan,source.parameterKey);
   const old=original?.work.find(value=>source.canonicalWorkRef?value.canonicalWorkRef===source.canonicalWorkRef:value.id===source.id);
   const own=nativeFor(source,scope,resource,item,native,evidence),fact=old&&original?.facts[old.id]?structuredClone(original.facts[old.id]!):own.fact;
   // A genuine zero-duration event occurs once. Its own occurrence can anchor
   // that event's position without inventing an enteredAt for a human task.
   const rule=orderTimeRule(saved.input.plan,source.parameterKey)?.rule;
   if(rule?.kind==='event'&&fact.ready.precision==='unknown'&&fact.businessCompleted&&fact.completed.precision!=='unknown')fact.ready=structuredClone(fact.completed);
   facts[source.id]=fact;
   const begun=fact.clockStart.precision!=='unknown'||fact.businessCompleted||Boolean(own.task?.native_entered_at);
   if(own.native?.batchWindows?.length&&(policy.responsibilitySlaRef||old?.responsibilitySlaRef))fact.ownWindows=own.native.batchWindows.map(window=>({sourceRef:window.evidence,started:instant(window.startedAt),completed:instant(window.completedAt),complete:window.complete,deadline:window.deadline,warningAt:window.warningAt,
    calendar:'calendarRef'in window&&['continuous','natural_days','beijing_sunday_excluded'].includes(String(window.calendarRef))?window.calendarRef as ScheduleWork['calendar']:old?.responsibilityCalendar??'continuous'}));
   const originalOwn=begun&&old?{responsibilitySlaRef:old.responsibilitySlaRef,responsibilityMinutes:old.responsibilityMinutes,responsibilityCalendar:old.responsibilityCalendar}:begun&&own.task?.sla_basis?{responsibilitySlaRef:`task:${own.task.task_id}:original-window`,responsibilityMinutes:typeof own.task.sla_basis.seconds==='number'?own.task.sla_basis.seconds/60:null,responsibilityCalendar:own.task.sla_basis.calendarRef??'continuous' as const}:begun?{responsibilitySlaRef:null,responsibilityMinutes:null,responsibilityCalendar:null}:policy;
   const reminder=orderTimeRule(saved.input.plan,source.parameterKey)?.rule.reminder;
   const goal=scope.customerGoalIds.includes(source.id),anchor=scope.goals[source.id];
   return {...definition,stage:source.stage,canonicalWorkRef:source.canonicalWorkRef??`${resource.kind}:${resource.id}:work:${source.id}`,
    start:target?.start.at??null,end:target?.end.at??null,...originalOwn,
    responsibilitySlaRef:originalOwn.responsibilitySlaRef,responsibilityMinutes:originalOwn.responsibilityMinutes??null,responsibilityCalendar:originalOwn.responsibilityCalendar??null,
    ...(begun?{responsibilityWarningAt:own.task?.warning_at?.toISOString()??old?.responsibilityWarningAt??null}:{responsibilityReminderPercent:reminder?.enabled?reminder.percent:null}),
    targetPrecision:goal&&anchor?.precision==='date'?'date' as const:'instant' as const,targetDate:goal&&anchor?.precision==='date'?anchor.value:null};
  });
  // Native accepted redo remains real work even when it was not in the
  // original route. Preserve its original handoff/clock and reconnect only
  // those native additions; never restore a superseded planned route.
  const ids=new Set(work.map(node=>node.id)),added=original?.work.filter(node=>node.accountingRole==='added_work'&&!ids.has(node.id))??[];
  const addedIds=new Set(added.map(node=>node.id));
  for(const node of added){work.push(structuredClone(node));facts[node.id]=structuredClone(original!.facts[node.id]??empty());}
  for(const node of work){const old=original?.work.find(previous=>previous.id===node.id);if(old)node.dependsOn=[...new Set([...node.dependsOn,...old.dependsOn.filter(id=>addedIds.has(id))])];}
  for(const node of work){const fact=facts[node.id]!;fact.waitingForPredecessors=fact.ready.precision==='unknown'&&node.dependsOn.length>0&&node.dependsOn.some(id=>!facts[id]?.businessCompleted);}
  const end=scope.customerGoal.precision==='instant'?scope.customerGoal.value:scope.customerGoal.precision==='date'?new Date(Date.parse(scope.customerGoal.value+'T00:00:00+08:00')+86400000).toISOString():null;
  return {scopeRef:scope.scopeRef,lineId:scope.lineId,targetRevision:`${saved.id}:${saved.revision}`,work,facts,terminalIds:[...(scope.customerGoalIds.length?scope.customerGoalIds:scope.terminalIds)],customerGoal:end};
 });
 return {version:'fixed-schedule-basis-v1',policyVersion:'order-time-plan-v1',scopeRevision:saved.identityHash,factRevision:hash(scopes.map(scope=>scope.facts)),scopes,termination:legacy?.termination??null,
  pending:!saved.input.route.complete||scopes.some(scope=>{const required=new Set(requiredFixedTimelineWork(scope.work,scope.terminalIds).map(work=>work.id));return scope.work.some(work=>required.has(work.id)&&(!work.start||!work.end));})};
}

export async function readOrderTimeBasis(db:DB,resource:BusinessTimeScope,item:OrderJourney,native:Readonly<Record<string,SlaNodeFact>>,asOf:string,legacy:FixedScheduleBasis|null,time?:BusinessTime):Promise<FixedScheduleBasis|null>{
 const saved=await new OrderTimePlanRepository(db).current(resource);if(!saved)return legacy;
 if(time&&saved.time.scenarioId!==time.scenarioId)throw Error('本单时间方案与当前业务时钟范围不一致');
 const result=orderTimeReadingBasis(saved,resource,item,native,await taskEvidence(db,resource,item),legacy);
 result.termination=await journeyTermination(db,resource,asOf);return result;
}

/** Existing authorized missing-time KPI, from this exact policy/fact scope.
 * Unperformed actuals are not missing history and do not become fake dates. */
export function attachOrderTimeCoverage(item:OrderJourney,basis:FixedScheduleBasis){
 if(basis.policyVersion!=='order-time-plan-v1'||!item.supervision)return;
 const coverage=item.supervision.coverage.filter(value=>value.key!=='plan');
 const missing=basis.pending||basis.scopes.some(scope=>scope.work.some(work=>work.minutes===null||work.calendar===null&&work.minutes!==0));
 if(missing)coverage.push({key:'plan',message:'本单适用流程或所需时间还没设置完整'});
 if(basis.scopes.some(scope=>Object.values(scope.facts).some(fact=>fact.businessCompleted&&fact.completed.precision==='unknown'))&&!coverage.some(value=>value.key==='fact_time'))coverage.push({key:'fact_time',message:'已有完成记录的真实时间还需核对'});
 item.supervision.coverage=coverage;
}
