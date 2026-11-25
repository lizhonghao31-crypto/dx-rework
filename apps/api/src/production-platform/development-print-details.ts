import type {PoolClient} from 'pg';
import type {DevelopmentPrintDetails,DevelopmentSheet} from '@dx-rework/contracts/digital-development';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {developmentRecordedTime} from './development-occurrence.js';

type DB=Pick<PoolClient,'query'>;
type PrintSelection={sourceId:string;round:number;documentVersion:number;designerId:string;asOf:string};
type RoundBasis={
 document_version:number;based_on_round?:number;origin?:string;customer_comment?:string;output_kind?:string;
};
type NativeRound={round_id:string;order_id:string;dispatched_at:Date|string|null;document_version_confirmed:boolean};

async function originalRoundBasis(db:DB,{sourceId,round}:PrintSelection){
 if(round===1)return (await db.query<RoundBasis>(`SELECT version AS document_version
  FROM digital_development_documents WHERE source_id=$1 AND status='published'`,[sourceId])).rows[0];
 return (await db.query<RoundBasis>(`SELECT document_version,based_on_round,origin,customer_comment,output_kind
  FROM digital_development_rounds WHERE source_id=$1 AND round_number=$2`,[sourceId,round])).rows[0];
}

/** Unlike execution lookup, this must not walk inherited task/native rounds. */
async function exactDispatch(db:DB,{sourceId,round}:PrintSelection,basisVersion:number):Promise<NativeRound|undefined>{
 const rework=round>1?`
   OR (r.round_type='rework' AND e.action='pattern_room.order.rework_requested' AND EXISTS(
    SELECT 1 FROM pattern_room_rounds prior WHERE prior.order_id=o.order_id AND prior.round_id<>r.round_id
     AND prior.round_id::text=e.after_state->'value'->>'previousRoundId'
   ) AND EXISTS(
    SELECT 1 FROM audit_events publication
    WHERE publication.entity_type='digital_development' AND publication.entity_id=l.source_id::text
     AND publication.action='development_round_published' AND publication.after_state->>'roundNumber'=$2::integer::text
     AND publication.after_state->>'nativeRoundId'=r.round_id::text
     AND publication.request_id=e.request_id AND publication.actor_id=e.actor_id
   ) AND NOT EXISTS(
    SELECT 1 FROM audit_events older JOIN digital_development_rounds earlier
     ON earlier.source_id=l.source_id AND older.after_state->>'roundNumber'=earlier.round_number::text
    WHERE older.entity_type='digital_development' AND older.entity_id=l.source_id::text
     AND older.action='development_round_published' AND older.after_state->>'nativeRoundId'=r.round_id::text
     AND earlier.round_number<$2
   ))`:'';
 const candidates=(await db.query<NativeRound>(`SELECT r.round_id,o.order_id,pending.entered_at AS dispatched_at,
  (e.action='pattern_room.order.rework_requested' OR EXISTS(
   SELECT 1 FROM audit_events publication
   WHERE publication.entity_type='digital_development' AND publication.entity_id=l.source_id::text
    AND publication.action='development_publish' AND publication.after_state->>'version'=$3::integer::text
    AND publication.request_id=e.request_id AND publication.actor_id=e.actor_id
  )) AS document_version_confirmed
  FROM digital_development_pattern_links l JOIN pattern_room_orders o USING(order_id)
  JOIN pattern_room_rounds r USING(order_id)
  JOIN operation_events e ON e.entity_type='pattern_room_order' AND e.entity_id=o.order_id::text
   AND e.after_state->>'orderId'=o.order_id::text AND e.after_state->>'roundId'=r.round_id::text
   AND e.action IN ('pattern_room.order.submitted','pattern_room.order.rework_requested')
  LEFT JOIN pattern_room_node_times pending ON pending.round_id=r.round_id AND pending.stage='pending_assignment'
  WHERE l.source_id=$1 AND o.kind='pattern' AND o.deleted_at IS NULL AND r.cancelled_at IS NULL
   AND ((r.round_type='initial' AND e.action='pattern_room.order.submitted'
    AND e.after_state->'value'->>'developmentSourceId'=l.source_id::text
    AND e.after_state->'value'->>'developmentRound'=$2::integer::text)${rework})
  LIMIT 2`,[sourceId,round,basisVersion])).rows;
 return candidates.length===1?candidates[0]:undefined;
}

const observedDate=(value:Date|string|null|undefined,asOf:string)=>{
 const at=value&&new Date(value);
 return at&&Number.isFinite(at.getTime())&&at.getTime()<=Date.parse(asOf)?beijingCalendarDate(at):undefined;
};

async function actualReturn(db:DB,{sourceId,round,designerId,asOf}:PrintSelection,native:NativeRound){
 // A modern record with an unverified date or a different actual round is
 // evidence of uncertainty, not permission to use the later payroll handoff.
 const facts=(await db.query<{
  payload:Record<string,unknown>;actor_id:string;state:string;correction_id:string|null;
  corrected_at:Date|string|null;correction_quality:string|null;
 }>(`
  SELECT f.payload,f.actor_id,t.state,c.event_id AS correction_id,c.occurred_at AS corrected_at,c.time_quality AS correction_quality
  FROM digital_development_route_facts f
  JOIN digital_production_tasks t USING(task_id) JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN LATERAL(
   SELECT correction.event_id,correction.occurred_at,correction.time_quality
   FROM digital_production_task_events original JOIN digital_production_task_events correction
    ON correction.corrects_event_id=original.event_id AND correction.task_id=original.task_id
   WHERE original.task_id=t.task_id AND original.event_kind='completed' AND original.actor_id=f.actor_id
    AND original.resource_kind='source' AND original.resource_id=f.source_id
    AND correction.event_kind='time_corrected' AND correction.resource_kind='source' AND correction.resource_id=f.source_id
   ORDER BY correction.recorded_at DESC,correction.event_id DESC LIMIT 1
  ) c ON true
  WHERE f.source_id=$1 AND a.source_id=f.source_id AND f.route_version=$2 AND t.route_version=f.route_version
    AND f.kind='最终设计确认' AND a.task_kind='development_confirmation' AND a.required_role='sample_designer'
  LIMIT 2`,[sourceId,round])).rows;
 if(facts.length){
  const fact=facts[0];
  if(facts.length!==1||!fact||fact.state!=='completed'||fact.actor_id!==designerId||fact.payload?.nativeRoundId!==native.round_id)return undefined;
  if(fact.correction_id)return fact.correction_quality==='已核实'?observedDate(fact.corrected_at,asOf):undefined;
  const time=developmentRecordedTime(fact.payload,asOf);
  return time?.quality==='verified'?(time.date??observedDate(time.at,asOf)):undefined;
 }
 // confirmOrder can bulk-populate prior rounds' handed_over_at for wages.
 // The original confirmation event plus the selected round's closed
 // confirmation node prove which physical round the designer confirmed.
 const legacy=(await db.query<{handed_over_at:Date|string}>(`
  SELECT r.handed_over_at FROM pattern_room_rounds r
  JOIN pattern_room_node_times confirm ON confirm.round_id=r.round_id AND confirm.stage='pending_confirmation'
   AND confirm.exit_reason='completed' AND confirm.exited_at>=r.handed_over_at
  JOIN operation_events e ON e.entity_type='pattern_room_order' AND e.entity_id=r.order_id::text
   AND e.action='pattern_room.order.handed_over' AND e.after_state->>'orderId'=r.order_id::text
   AND e.after_state->>'roundId'=r.round_id::text AND e.after_state->'value'->'confirmedReceived'='true'::jsonb
  WHERE r.order_id=$1 AND r.round_id=$2 AND r.handed_over_by=$3 AND e.actor_id=$3
   AND e.actor_roles @> ARRAY['sample_designer']::text[] AND r.handed_over_at>=confirm.entered_at
  LIMIT 2`,[native.order_id,native.round_id,designerId])).rows;
 return legacy.length===1?observedDate(legacy[0]?.handed_over_at,asOf):undefined;
}

/** Call only after authorizing the source and selecting its exact saved version. */
export async function developmentPrintDetails(db:DB,selection:PrintSelection,revision?:DevelopmentSheet['revisionSource']):Promise<DevelopmentPrintDetails>{
 const {round,sourceId,documentVersion,asOf}=selection;
 const details:DevelopmentPrintDetails={};
 if(revision)details.printRevision={sourceRound:revision.parentRound,revisionNumber:revision.revisionNumber};
 const basis=await originalRoundBasis(db,selection);
 // An early preorder snapshot is not the later manufacturing publication.
 if(!basis||basis.document_version>documentVersion)return details;
 if(round===1&&revision&&revision.sourceId===sourceId&&revision.origin!=='内部发现'&&revision.customerComment.trim()){
  details.printFeedback={sourceRound:revision.parentRound,text:revision.customerComment};
 }else if(round>1&&basis.based_on_round){
  if(!revision)details.printRevision={sourceRound:basis.based_on_round};
  if(basis.origin!=='内部发现'&&basis.customer_comment?.trim())details.printFeedback={sourceRound:basis.based_on_round,text:basis.customer_comment};
 }
 if((round===1?revision?.outputKind:basis.output_kind)==='工艺布片')return details;
 const supported=(await db.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation;
 if(!supported)return details;
 const native=await exactDispatch(db,selection,basis.document_version);
 if(!native)return details;
 const dispatchedOn=observedDate(native.dispatched_at,asOf);
 const returnedOn=await actualReturn(db,selection,native);
 if(dispatchedOn||returnedOn)details.printTiming={
  executionRoundId:native.round_id,
  ...(dispatchedOn?{dispatchedOn,...(native.document_version_confirmed?{dispatchedDocumentVersion:basis.document_version}:{})}:{}),
  ...(returnedOn&&(!dispatchedOn||returnedOn>=dispatchedOn)?{returnedOn}:{}),
 };
 return details;
}
