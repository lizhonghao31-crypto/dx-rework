import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {FixedTimelineAdoption} from './fixed-timeline-adoptions.js';
import {reworkSlaEvidence} from './rework-sla-evidence.js';
import {shiftFixedTimeline,type FixedTimelineTarget} from './fixed-timeline-targets.js';
type DB=Pick<PoolClient,'query'>;
/** Rework approval starts organization impact; the original assignment event
 * alone starts its worker SLA. Ordinary corrections do not mint another budget. */
export async function fixedReworkProgressFacts(db:DB,saved:FixedTimelineAdoption){
 if(saved.input.resource.kind!=='order')return [];
 const rows=(await db.query(`SELECT DISTINCT map.line_id,r.rework_order_id,approval.event_id,
  (SELECT (assigned.after_state->>'version')::integer>(current_review.after_state->>'version')::integer
   FROM operation_events assigned CROSS JOIN LATERAL(SELECT review.after_state FROM operation_events review
    JOIN rework_process_configurations configuration ON configuration.configuration_id::text=review.after_state->'configuration'->>'configurationId'
    WHERE configuration.rework_order_id=r.rework_order_id AND configuration.status='approved' AND review.entity_type='rework_order'
     AND review.entity_id=r.rework_order_id::text AND review.action='rework.process_configuration.review' AND review.after_state->'configuration'->>'status'='approved'
    ORDER BY (review.after_state->>'version')::integer DESC LIMIT 1) current_review
   WHERE assigned.entity_type='rework_order' AND assigned.entity_id=r.rework_order_id::text AND assigned.action='rework.work_task.assignment_confirm'
   ORDER BY (assigned.after_state->>'version')::integer DESC LIMIT 1) AS assignment_current,
  coalesce((approval.after_state->'acceptanceClock'->>'now')::timestamptz,approval.created_at) AS approved_at
  FROM digital_production_child_lines map JOIN rework_orders r ON r.rework_order_id=map.child_id
  JOIN LATERAL(SELECT event.* FROM operation_events event WHERE event.entity_type='rework_order' AND event.entity_id=r.rework_order_id::text
   AND event.action='rework.process_configuration.review' AND event.after_state->'configuration'->>'status'='approved'
   AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(event.after_state->'configuration'->'items','[]'::jsonb)) item WHERE item->>'executionKind'='worker')
   ORDER BY (event.after_state->>'version')::integer,event.event_id LIMIT 1) approval ON true
  WHERE map.module='rework' AND map.production_order_id=$1 AND r.status NOT IN ('deleted','cancelled')`,[saved.input.resource.id])).rows;
 if(!rows.length)return [];
 const native=await reworkSlaEvidence(db,saved.input.resource.id);
 return rows.map(row=>({lineId:row.line_id as string,reworkId:row.rework_order_id as string,eventRef:`operation_events:${row.event_id}`,approvedAt:row.approved_at?new Date(row.approved_at).toISOString():null,
  windows:native.windows.filter(window=>window.reworkId===row.rework_order_id&&window.lineId===row.line_id).map(window=>row.assignment_current?window:{...window,startedAt:null,deadline:null,warningAt:null,completedAt:null,complete:false})}));
}
/** Append only this added obligation's B, against unchanged original handoff.
 * Executed by the existing single-object RR worker; never from a GET. */
export async function buildFixedReworkTargets(db:DB,saved:FixedTimelineAdoption){
 if(saved.input.resource.kind!=='order')return;
 const facts=await fixedReworkProgressFacts(db,saved);
 const policy=saved.input.unified.values.parameters.garment_rework?.value,minutes=policy?.kind==='duration'?policy.minutes:null;
 for(const fact of facts){
  const consumer=saved.input.consumers.find(scope=>scope.lineId===fact.lineId);if(!consumer)continue;
  const base=(await db.query('SELECT target_revision_id,targets_json,business_time FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 ORDER BY revision DESC LIMIT 1',[saved.adoptionId,consumer.scopeRef])).rows[0];if(!base)continue;
  const handoffId=`garment_packing:${fact.lineId}`,handoff=(base.targets_json as FixedTimelineTarget[]).find(target=>target.id===handoffId)?.start;
  if(!handoff)continue;
  const scopeRef=`${consumer.scopeRef}:rework:${fact.reworkId}`,eventRef=`${fact.eventRef}|${base.target_revision_id}`,id=`garment_rework:${fact.lineId}:${fact.reworkId}`;
  if((await db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 AND source_event_ref=$3',[saved.adoptionId,scopeRef,eventRef])).rowCount)continue;
  const start=handoff.at&&minutes!==null?{...handoff,at:shiftFixedTimeline(handoff.at,-minutes,'continuous')}:{at:null,exclusive:false,reasons:['新增返工作业规划时长或原交接目标待核']};
  await db.query(`INSERT INTO digital_timeline_target_revisions(target_revision_id,adoption_id,identity_hash,scope_ref,line_id,revision,change_kind,goal_anchor,targets_json,source_event_ref,created_by,business_time,request_key)
   SELECT $1,$2,$3,$4,$5,coalesce(max(revision),0)+1,'scope_addition',$6,$7,$8,$9,$10,$11 FROM digital_timeline_target_revisions WHERE adoption_id=$2 AND scope_ref=$4`,[randomUUID(),saved.adoptionId,saved.identityHash,scopeRef,fact.lineId,JSON.stringify({reworkId:fact.reworkId,originalHandoff:{targetRevisionId:base.target_revision_id,nodeId:handoffId,start:handoff}}),JSON.stringify([{id,start,end:handoff}]),eventRef,saved.createdBy,JSON.stringify(base.business_time),randomUUID()]);
 }
}
