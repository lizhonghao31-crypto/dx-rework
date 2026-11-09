import {randomUUID} from 'node:crypto';
import type {PoolClient} from 'pg';
import type {SlaTime} from '@dx-rework/domain/digital-sla-plan';
import type {FixedTimelineAdoption} from './fixed-timeline-adoptions.js';
import {fixedTimelineTargets,type FixedTimelineTarget} from './fixed-timeline-targets.js';
import {readFixedOrderRoute} from './fixed-order-route.js';

/** Runs in the existing bounded per-order build, after its original H replay.
 * Only new work is solved against the unchanged original handoff. This never
 * propagates an inserted obligation's duration into the old order's targets.
 */
export async function buildFixedOrderRouteTargets(db:Pick<PoolClient,'query'>,saved:FixedTimelineAdoption){
 if(saved.input.resource.kind!=='order')return;
 const rows=(await db.query('SELECT route_ref,identity_hash FROM digital_timeline_order_routes WHERE adoption_id=$1 ORDER BY recorded_at,route_ref',[saved.adoptionId])).rows;
 for(const row of rows){
  const scope=(await readFixedOrderRoute(db,saved,row.route_ref))!;
  for(const consumer of saved.input.consumers){
   const base=(await db.query('SELECT target_revision_id,revision,targets_json,source_event_ref,business_time FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 ORDER BY revision DESC LIMIT 1',[saved.adoptionId,consumer.scopeRef])).rows[0];
   if(!base)throw Error('新增范围缺少原PO固定交接目标');
   for(const group of scope.groups){
    const scopeRef=`${consumer.scopeRef}:route:${scope.routeRef}:handoff:${group.handoffNodeId}`,eventRef=`${scope.eventRef}|${base.target_revision_id}`;
    if((await db.query('SELECT 1 FROM digital_timeline_target_revisions WHERE adoption_id=$1 AND scope_ref=$2 AND source_event_ref=$3',[saved.adoptionId,scopeRef,eventRef])).rowCount)continue;
    const handoff=(base.targets_json as FixedTimelineTarget[]).find(target=>target.id===group.handoffNodeId)?.start;
    const end:SlaTime=handoff??{at:null,exclusive:false,reasons:['原交接目标尚未确定']};
    const work=scope.work.filter(work=>group.nodeIds.includes(work.id));
    const targets=fixedTimelineTargets(work,{}, {preserveUnknown:true,endTimes:{[group.lastNodeId]:end}});
    const time=Date.parse(base.business_time.now)>Date.parse(scope.time.now)?base.business_time:scope.time;
    await db.query(`INSERT INTO digital_timeline_target_revisions(target_revision_id,adoption_id,identity_hash,scope_ref,line_id,revision,change_kind,goal_anchor,targets_json,source_event_ref,created_by,business_time,request_key)
     SELECT $1,$2,$3,$4,$5,coalesce(max(revision),0)+1,'scope_addition',$6,$7,$8,$9,$10,$11 FROM digital_timeline_target_revisions WHERE adoption_id=$2 AND scope_ref=$4`,
     [randomUUID(),saved.adoptionId,saved.identityHash,scopeRef,consumer.lineId,JSON.stringify({scopeIdentityHash:row.identity_hash,originalHandoff:{targetRevisionId:base.target_revision_id,nodeId:group.handoffNodeId,start:end}}),JSON.stringify(targets),eventRef,scope.actorId,JSON.stringify(time),randomUUID()]);
   }
  }
 }
}
