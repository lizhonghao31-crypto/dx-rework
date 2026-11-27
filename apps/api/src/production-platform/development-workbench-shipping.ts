import type {PoolClient} from 'pg';
import type {DevelopmentShippingDisplay} from '@dx-rework/contracts/digital-development-workspace';
import type {TrustedActorContext} from '../tools/repositories.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';

// The list only needs the exact current source/round's original route facts,
// not the complete execution view or a new record for each list row.
export async function readWorkbenchShipping(db:PoolClient,actor:TrustedActorContext,items:readonly {id:string;sourceId:string|null;round?:number}[]){
 const result=new Map<string,DevelopmentShippingDisplay>();
 const scopes=[...new Set(items.flatMap(item=>item.sourceId?[item.sourceId]:[]))].map(id=>({kind:'source' as const,id}));
 if(!scopes.length)return result;
 const access=await readJourneySelectionAccess(db,actor,scopes);
 const visible=items.filter(item=>item.sourceId&&access.resources.get(`source:${item.sourceId}`)?.taskParentTechnical);
 if(!visible.length)return result;
 type Row={id:string;round:number;published:boolean;state:string|null;assigned:boolean;lifecycle:'paused'|'cancelled'|null;tailDone:boolean;designDone:boolean;swatch:boolean;sentDate:string|null;trackingNo:string|null};
 const {rows}=await db.query<Row>(`WITH input AS (
   SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,"sourceId" uuid,"round" int)
  ), requested AS (
   SELECT x.id,x."sourceId",coalesce(x.round,(SELECT max(round_number) FROM digital_development_rounds r WHERE r.source_id=x."sourceId"),1) AS round,
   coalesce(d.status='published',false) AS published FROM input x LEFT JOIN digital_development_documents d ON d.source_id=x."sourceId"
  ) SELECT x.id,x.round,x.published,task.state,
   EXISTS(SELECT 1 FROM app_users p JOIN user_role_assignments a ON a.user_id=p.id AND a.revoked_at IS NULL
    JOIN business_roles role ON role.role_code=a.role_code AND role.enabled
    WHERE p.id=task.assignee_id AND p.enabled AND role.role_code='sample_designer'
    AND NOT coalesce((to_jsonb(p)->>'manual_access_disabled')::boolean,false)
    AND EXISTS(SELECT 1 FROM identity_mappings m WHERE m.user_id=p.id AND m.active AND m.employed)) AS assigned,
   CASE WHEN l.state IN ('paused','cancelled') THEN l.state END AS lifecycle,coalesce(r.output_kind,revision.output_kind) IS NOT DISTINCT FROM '工艺布片' AS swatch,
   EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
    WHERE a.source_id=x."sourceId" AND t.route_version=x.round AND t.state='completed' AND a.task_kind=ANY($2::text[])) AS "tailDone",
   EXISTS(SELECT 1 FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
    WHERE a.source_id=x."sourceId" AND t.route_version=x.round AND t.state='completed' AND a.task_kind=ANY($3::text[])) AS "designDone",
   f.payload->>'sentDate' AS "sentDate",f.payload->>'trackingNo' AS "trackingNo"
  FROM requested x LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind='source' AND l.resource_id=x."sourceId"
  LEFT JOIN digital_development_revision_sources revision ON revision.source_id=x."sourceId"
  LEFT JOIN digital_development_rounds r ON r.source_id=x."sourceId" AND r.round_number=x.round
  LEFT JOIN LATERAL (SELECT t.task_id,t.state,a.assignee_id FROM digital_production_task_access a
    JOIN digital_production_tasks t USING(task_id) WHERE a.source_id=x."sourceId" AND t.route_version=x.round
    AND a.task_kind='development_shipping' ORDER BY (t.state<>'cancelled') DESC,t.created_at DESC,t.task_id DESC LIMIT 1) task ON true
  LEFT JOIN digital_development_route_facts f ON f.source_id=x."sourceId" AND f.route_version=x.round AND f.task_id=task.task_id
    AND f.kind='寄出' AND task.state='completed'`,[JSON.stringify(visible),['development_tail_check','development_patch_tail_check'],['development_confirmation','development_patch_confirmation']]);
 for(const row of rows){
  if(row.sentDate&&row.trackingNo)result.set(row.id,{state:'sent',sentDate:row.sentDate,trackingNo:row.trackingNo,round:row.round});
  else result.set(row.id,{state:row.lifecycle??(row.state==='cancelled'?'cancelled':row.state==='completed'?'unknown':row.swatch&&!row.state?'not_applicable':
   !row.published?'unknown':!row.designDone?(row.tailDone?'wait_design':'wait_tail'):
   row.state==='ready'?(row.assigned?'ready':'unassigned'):'unknown')});
 }
 return result;
}
