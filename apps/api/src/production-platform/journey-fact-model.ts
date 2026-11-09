import {createHash} from 'node:crypto';
import type {JourneyNode,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {SlaAnchor,SlaNodeFact,SlaPlan} from '@dx-rework/domain/digital-sla-plan';
import type {JourneyTimingInputs} from './journey-supervision.js';
import type {NativeTaskReadiness} from './task-readiness-facts.js';
import type {JourneyTermination} from './journey-termination.js';
import type {JourneyCutScope} from './journey-cut-scopes.js';
import type {NativeFactoryTimeline} from './factory-production-facts.js';

/** Bump when native mapping, time precision or applicability changes. No user DTO cache. */
export const JOURNEY_FACT_CALCULATION_VERSION='journey-facts-supplychain-p01-v1-selectors-v3';
type FactNode=Pick<JourneyNode,'key'|'instanceId'|'stage'|'state'|'round'|'occurrence'|'current'|'planningOnly'|'progressApplicability'|'expectedAt'|'expectedKind'|'expectedPrecision'|'deadlineMode'|'deadlineExclusive'|'actualAt'|'actualDate'|'actualQuality'|'enteredAt'|'sla'|'countsInProgress'|'inheritedFrom'|'inheritedResult'>&{
 ownerId:string|null;operatorId:string|null;blockers:Array<{key:string;ownerId:string|null}>;
 scopes:Array<{domain:string;id:string;lineId:string|null;version:number|null}>;
};
export type JourneyFactTask={id:string;kind:string;sourceId:string|null;orderId:string|null;assigneeId:string|null;requiredRole:string;routeInstanceId:string;routeVersion:number;policyVersion:number;enteredAt:string|null;dueAt:string|null;warningAt:string|null;deadlineMode:string|null;deadlineExclusive:boolean};
export type JourneyFactModel={
 schemaVersion:1;sourceId:string|null;orderId:string|null;sourceDocumentVersion:number|null;instructionVersion:number|null;
 selectedRound:number|null;adoptedRound:number|null;cancelled:boolean;closedAt:string|null;
 nativeReadiness?:NativeTaskReadiness[];termination?:JourneyTermination|null;cutScopes?:JourneyCutScope[];factoryTimeline?:NativeFactoryTimeline[];
 nodes:FactNode[];tasks:JourneyFactTask[];dependencies:Array<{taskId:string;predecessorId:string}>;
 requirements:Array<Pick<NonNullable<OrderJourney['businessProgress']>['requirements'][number],'id'|'key'|'stage'|'scopeRef'|'applicability'|'completed'|'instanceIds'|'targets'>>;
 quantities:NonNullable<OrderJourney['businessProgress']>['quantities']|null;
 sla:JourneyTimingInputs;revisions:{original:number|null;current:number|null};
};
const anchor=(a:SlaAnchor):SlaAnchor=>a.precision==='unknown'?{precision:a.precision,reason:a.reason}:{precision:a.precision,value:a.value,source:a.source};
const plan=(p:SlaPlan|null):SlaPlan|null=>p?{
 nodes:p.nodes.map(n=>({id:n.id,label:n.label,stage:n.stage,parameterKey:n.parameterKey,applicable:n.applicable,countsProgress:n.countsProgress,kind:n.kind,minutes:n.minutes,offsetDays:n.offsetDays,dependsOn:[...n.dependsOn],anchorKey:n.anchorKey,targetKey:n.targetKey,includedIn:n.includedIn,includedPosition:n.includedPosition})),
 anchors:Object.fromEntries(Object.entries(p.anchors).map(([key,value])=>[key,anchor(value)])),warningPercent:p.warningPercent,stageBufferMinutes:p.stageBufferMinutes,
 ...(p.retainedNodeSnapshots?{retainedNodeSnapshots:{...p.retainedNodeSnapshots}}:{})
}:null;
const fact=(f:SlaNodeFact):SlaNodeFact=>({evidence:f.evidence,
 ...(f.startedAt!==undefined?{startedAt:f.startedAt}:{}),...(f.completedAt!==undefined?{completedAt:f.completedAt}:{}),
 ...(f.businessCompleted!==undefined?{businessCompleted:f.businessCompleted}:{}),...(f.standardMinutes!==undefined?{standardMinutes:f.standardMinutes}:{}),
 ...(f.standardWarningPercent!==undefined?{standardWarningPercent:f.standardWarningPercent}:{}),
 ...(f.batchCoverageComplete!==undefined?{batchCoverageComplete:f.batchCoverageComplete}:{}),
 ...(f.batchWindows?{batchWindows:f.batchWindows.map(w=>({startedAt:w.startedAt,deadline:w.deadline,warningAt:w.warningAt,completedAt:w.completedAt,complete:w.complete,evidence:w.evidence}))}:{}),
 ...(f.completedDeadline?{completedDeadline:{at:f.completedDeadline.at,exclusive:f.completedDeadline.exclusive,reasons:[...f.completedDeadline.reasons]}}:{}),
 ...(f.waitingFor?{waitingFor:{reason:f.waitingFor.reason,source:f.waitingFor.source}}:{}),
 ...(f.remaining?{remaining:{minutes:f.remaining.minutes,asOf:f.remaining.asOf,validUntil:f.remaining.validUntil,source:f.remaining.source}}:{})
});
/** Explicit whitelist: even unexpected fields on a source DTO cannot enter shared storage.
 * Identity/PO labels stay in their existing lightweight tables. Time-sensitive
 * risk, ratios and statuses are deliberately not cached as current results.
 */
export function minimalJourneyFacts(item:OrderJourney,inputs:JourneyTimingInputs,tasks:JourneyFactTask[]=[],dependencies:JourneyFactModel['dependencies']=[],native?:{readiness:NativeTaskReadiness[];termination:JourneyTermination|null;cutScopes?:JourneyCutScope[];factoryTimeline?:NativeFactoryTimeline[]}):JourneyFactModel{
 return {schemaVersion:1,sourceId:item.sourceId,orderId:item.orderId,sourceDocumentVersion:item.sourceVersion,instructionVersion:item.instructionVersion,
  selectedRound:item.selectedRound,adoptedRound:item.adoptedRound,cancelled:item.display?.mainState==='cancelled',closedAt:item.display?.closedAt??null,
  ...(native?{nativeReadiness:native.readiness.filter(r=>r.tracked).map(r=>({taskId:r.taskId,tracked:r.tracked,eventId:r.eventId,effectiveEventId:r.effectiveEventId,firstReadyAt:r.firstReadyAt,quality:r.quality,scopeRef:r.scopeRef,basis:[...r.basis]})).sort((a,b)=>a.taskId.localeCompare(b.taskId,'en')),
   termination:native.termination?{kind:native.termination.kind,at:native.termination.at,precision:native.termination.precision,originEventRef:native.termination.originEventRef,scopeRef:native.termination.scopeRef}:null,
   cutScopes:(native.cutScopes??[]).map(scope=>({lineId:scope.lineId,status:scope.status,cuts:scope.cuts.map(cut=>({cuttingOrderId:cut.cuttingOrderId,sourcingCaseId:cut.sourcingCaseId,sourcingLinePosition:cut.sourcingLinePosition,approvalSnapshotId:cut.approvalSnapshotId,sourceLineId:cut.sourceLineId}))})),
   factoryTimeline:(native.factoryTimeline??[]).map(scope=>({productionId:scope.productionId,factoryDecisionId:scope.factoryDecisionId,lineId:scope.lineId,quantity:scope.quantity,
    dispatchedAt:scope.dispatchedAt,startTransitionRef:scope.startTransitionRef,completedDate:scope.completedDate,completionTransitionRef:scope.completionTransitionRef}))}:{}),
  nodes:item.stages.flatMap(stage=>stage.nodes).map(n=>({key:n.key,instanceId:n.instanceId,stage:n.stage,state:n.state,round:n.round,occurrence:n.occurrence,current:n.current,
   ...(n.planningOnly!==undefined?{planningOnly:n.planningOnly}:{}),...(n.progressApplicability?{progressApplicability:n.progressApplicability}:{}),
   expectedAt:n.expectedAt,expectedKind:n.expectedKind,expectedPrecision:n.expectedPrecision,
   ...(n.deadlineMode?{deadlineMode:n.deadlineMode}:{}),...(n.deadlineExclusive!==undefined?{deadlineExclusive:n.deadlineExclusive}:{}),
   actualAt:n.actualAt,...(n.actualDate!==undefined?{actualDate:n.actualDate}:{}),actualQuality:n.actualQuality,enteredAt:n.enteredAt,sla:n.sla,countsInProgress:n.countsInProgress,
   inheritedFrom:n.inheritedFrom?{taskId:n.inheritedFrom.taskId,round:n.inheritedFrom.round}:null,
   ...(n.inheritedResult?{inheritedResult:{actualAt:n.inheritedResult.actualAt,quality:n.inheritedResult.quality,adoptedAt:n.inheritedResult.adoptedAt,reason:n.inheritedResult.reason,
    ...(n.inheritedResult.adoptedRound!==undefined?{adoptedRound:n.inheritedResult.adoptedRound}:{}),...(n.inheritedResult.adoptionSourceRef?{adoptionSourceRef:n.inheritedResult.adoptionSourceRef}:{})}}:{}),
   ownerId:n.owner?.id??null,operatorId:n.operator?.id??null,blockers:n.blockers.map(b=>({key:b.key,ownerId:b.ownerId})),
   scopes:n.records.map(r=>({domain:r.domain,id:r.id,lineId:r.lineId,version:r.version}))})),
  tasks:tasks.map(t=>({id:t.id,kind:t.kind,sourceId:t.sourceId,orderId:t.orderId,assigneeId:t.assigneeId,requiredRole:t.requiredRole,routeInstanceId:t.routeInstanceId,routeVersion:t.routeVersion,policyVersion:t.policyVersion,enteredAt:t.enteredAt,dueAt:t.dueAt,warningAt:t.warningAt,deadlineMode:t.deadlineMode,deadlineExclusive:t.deadlineExclusive})).sort((a,b)=>a.id.localeCompare(b.id,'en')),
  dependencies:dependencies.map(d=>({taskId:d.taskId,predecessorId:d.predecessorId})).sort((a,b)=>a.taskId.localeCompare(b.taskId,'en')||a.predecessorId.localeCompare(b.predecessorId,'en')),
  requirements:(item.businessProgress?.requirements??[]).map(r=>({id:r.id,key:r.key,stage:r.stage,scopeRef:r.scopeRef,applicability:r.applicability,completed:r.completed,instanceIds:[...r.instanceIds],
   targets:r.targets.map(t=>({source:t.source,planId:t.planId,revision:t.revision,scopeRef:t.scopeRef,at:t.at,precision:t.precision,retainedFromRevision:t.retainedFromRevision}))})),
  quantities:item.businessProgress?.quantities?{revision:item.businessProgress.quantities.revision,factoryAttribution:item.businessProgress.quantities.factoryAttribution,
   lines:item.businessProgress.quantities.lines.map(l=>({lineId:l.lineId,demand:l.demand,received:l.received,inspected:l.inspected,qualified:l.qualified,packed:l.packed,remainingReceipt:l.remainingReceipt,remainingShipment:l.remainingShipment,qualityGap:l.qualityGap,qualityConflict:l.qualityConflict,factoryAttribution:l.factoryAttribution,reasons:[...l.reasons]}))}:null,
  sla:{plan:plan(inputs.plan),original:plan(inputs.original),facts:Object.fromEntries(Object.entries(inputs.facts).map(([key,value])=>[key,fact(value)]))},
  revisions:{original:item.supervision?.originalRevision??null,current:item.supervision?.currentRevision??null}};
}
/** Canonical object key order makes equivalent source facts stable across rebuilds. */
export function journeyFactFingerprint(model:JourneyFactModel):string{
 return journeyValueFingerprint(model);
}
/** Same canonical ordering for native facts and their separately read selector. */
export function journeyValueFingerprint(value:unknown):string{
 const ordered=(value:unknown):unknown=>Array.isArray(value)?value.map(ordered):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([,v])=>v!==undefined).sort(([a],[b])=>a.localeCompare(b,'en')).map(([k,v])=>[k,ordered(v)])):value;
 return createHash('sha256').update(JSON.stringify(ordered(value))).digest('hex');
}
