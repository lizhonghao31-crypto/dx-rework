import type {WarehouseNativeTaskQuery} from '@dx-rework/contracts/production-readiness';
import {digitalForbidden} from './access-policy.js';
import type {PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {acceptanceBusinessContext,businessScopeKey} from '../acceptance-clock/business-time.js';
import {isDigitalManagementReader,isDigitalTechnicalManager} from './access-policy.js';
import {isRootActor} from '../access/business-authority.js';
import {wholeOrderActiveSql} from './whole-order-visibility.js';
import {retiredBulkPreshrinkTaskIds} from './bulk-preshrink-requirement.js';

const activeRole=(roles:ReadonlySet<string>,role:string)=>roles.has(role)||role==='warehouse_receiver'&&roles.has('warehouse_supervisor');

/** Native, request-local inputs to the existing technical read policy. These
 * are not saved in the shared model. Batch loading avoids per-mother policy
 * queries while a role, assignment or preparation change remains live. */
export async function readJourneySelectionAccess(db:PoolClient,actor:TrustedActorContext,resources:readonly BusinessTimeScope[]){
 const context=acceptanceBusinessContext(),accepted=!context||await context.acceptsActor(actor.actorId);
 const liveRoles=new Set<string>(accepted?(await db.query<{role_code:string}>(`SELECT DISTINCT a.role_code FROM app_users u
  JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
  JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
  WHERE u.id=$1 AND u.enabled AND NOT coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)
  AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)`,[actor.actorId])).rows.map(row=>row.role_code):[]);
 const active=(role:string)=>activeRole(liveRoles,role);
 const result=new Map<string,{technical:boolean;taskParentTechnical:boolean;fullOrder:boolean;timing:boolean;budget:boolean}>();
 if(!resources.length)return {resources:result,liveRoles};
 const relations=(await db.query(`SELECT to_regclass('digital_preparation_responsibilities') IS NOT NULL AS preparation,
  to_regclass('digital_bulk_preparations') IS NOT NULL AS bulk,
  to_regclass('digital_qc_supervision_settings') IS NOT NULL AS qc`)).rows[0] as {preparation:boolean;bulk:boolean;qc:boolean};
 const activeSources=await wholeOrderActiveSql(db,'source','s.source_id'),activeOrders=await wholeOrderActiveSql(db,'order','o.production_order_id');
 type NativeScope={kind:'source'|'order';id:string;source_id:string|null;created_by:string;primary_merchandiser_id:string|null;
  linked_primary:boolean;dispatch_worker:string|null;warehouse_worker:string|null;color_worker:string|null;color_role:string|null;
  handover_recipient:string|null;handover_current:boolean;quality_lead:string|null;bulk_roles:string[]};
 // Optional relations mirror the original policy's migration/fixture guards.
 // Every inserted SQL fragment below is static; no user-controlled SQL text.
 const rows=(await db.query<NativeScope>(`WITH requested AS (SELECT * FROM unnest($1::text[],$2::uuid[]) AS r(kind,id)),
  resources AS (
   SELECT r.kind,r.id,s.source_id,s.created_by,NULL::uuid AS primary_merchandiser_id FROM requested r JOIN digital_production_sources s ON r.kind='source' AND r.id=s.source_id WHERE ${activeSources}
   UNION ALL SELECT r.kind,r.id,o.source_id,o.created_by,o.primary_merchandiser_id FROM requested r JOIN digital_production_orders o ON r.kind='order' AND r.id=o.production_order_id WHERE ${activeOrders}
  ) SELECT r.*,EXISTS(SELECT 1 FROM digital_production_orders o WHERE r.kind='source' AND o.source_id=r.id AND o.primary_merchandiser_id=$3) AS linked_primary,
  ${relations.preparation?`dispatch.warehouse_worker_id AS dispatch_worker,preparation.warehouse_worker_id AS warehouse_worker,
   preparation.color_confirmation_worker_id AS color_worker,preparation.color_confirmation_role AS color_role,
   handover.body->>'recipientId' AS handover_recipient,
   handover.state='ready' AND handover.body->'sourceDocumentVersion'=to_jsonb(document.version) AS handover_current`:`NULL::uuid AS dispatch_worker,NULL::uuid AS warehouse_worker,NULL::uuid AS color_worker,NULL::text AS color_role,NULL::text AS handover_recipient,false AS handover_current`},
  ${relations.qc?'qc.quality_lead_id':'NULL::uuid'} AS quality_lead,
  ${relations.bulk?`ARRAY(SELECT a.required_role FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
   JOIN digital_bulk_preparations p ON p.preparation_id=t.route_instance_id AND p.production_order_id=a.production_order_id
   JOIN digital_instruction_documents effective ON effective.production_order_id=p.production_order_id AND effective.published_version=p.instruction_version
   WHERE r.kind='order' AND a.production_order_id=r.id AND t.state<>'cancelled' AND a.assignee_id=$3
   AND p.source_round=coalesce((SELECT max(round_number) FROM digital_development_rounds WHERE source_id=p.source_id),1)
   AND a.task_kind IN ('bulk_pattern','warehouse_preshrink','bulk_cutting','bulk_cutting_external','process_logistics','bulk_qc','factory_production_qc','warehouse_dispatch','bulk_ship_sample'))`:'ARRAY[]::text[]'} AS bulk_roles
  FROM resources r
  ${relations.preparation?`LEFT JOIN digital_bulk_dispatch dispatch ON r.kind='order' AND dispatch.production_order_id=r.id
   LEFT JOIN LATERAL (SELECT p.* FROM digital_preparation_responsibilities p WHERE
    (p.resource_kind='order' AND p.resource_id=CASE WHEN r.kind='order' THEN r.id END)
    OR (p.resource_kind='source' AND p.resource_id=r.source_id) ORDER BY (p.resource_kind='order') DESC,p.version DESC LIMIT 1) preparation ON true
   LEFT JOIN digital_development_documents document ON r.kind='source' AND document.source_id=r.id
   LEFT JOIN LATERAL (SELECT m.state,m.body FROM digital_preparation_material_versions m WHERE r.kind='source' AND m.resource_kind='source'
    AND m.resource_id=r.id AND m.kind='design_handover' AND m.scope_ref='whole' ORDER BY m.version DESC LIMIT 1) handover ON true`:''}
  ${relations.qc?`LEFT JOIN LATERAL (SELECT q.quality_lead_id FROM digital_qc_supervision_settings q WHERE r.kind='order' AND q.production_order_id=r.id ORDER BY q.version DESC LIMIT 1) qc ON true`:''}`,
 [resources.map(scope=>scope.kind),resources.map(scope=>scope.id),actor.actorId])).rows;
 const management=isDigitalManagementReader(actor),technicalManager=isDigitalTechnicalManager(actor),has=(role:string)=>actor.actorRoles.includes(role);
 const timingAuthority=isRootActor(actor)||['production_management','owner_group','pmc','pattern_room_supervisor','development_clerk'].some(role=>has(role)&&active(role));
 for(const row of rows){
  const own=has('sample_designer')&&row.created_by===actor.actorId;
  const primary=row.kind==='order'&&has('order_merchandiser')&&row.primary_merchandiser_id===actor.actorId&&active('order_merchandiser');
  const preparation=(row.dispatch_worker===actor.actorId||row.warehouse_worker===actor.actorId)&&active('warehouse_receiver')
   ||row.color_worker===actor.actorId&&Boolean(row.color_role)&&active(row.color_role!);
  const sourcePrimary=row.kind==='source'&&has('order_merchandiser')&&active('order_merchandiser')&&row.linked_primary;
  const handover=row.kind==='source'&&has('order_merchandiser')&&active('order_merchandiser')&&row.handover_current&&row.handover_recipient===actor.actorId;
  const quality=row.kind==='order'&&has('quality_control')&&active('quality_control')&&row.quality_lead===actor.actorId;
  const clerk=row.kind==='order'&&has('development_clerk')&&active('development_clerk')&&Boolean(row.source_id);
  // Scoped participation can authorize a parent's documents without granting
  // permission over a sibling's task. Expose both existing policy decisions.
  const taskParentTechnical=management||technicalManager||own||primary||sourcePrimary||clerk;
  const technical=taskParentTechnical||preparation||handover||quality||row.bulk_roles.some(active);
  const fullOrder=row.kind==='order'&&technical&&(management||technicalManager||own||has('order_merchandiser')&&row.primary_merchandiser_id===actor.actorId||has('development_clerk'));
  result.set(businessScopeKey(row),{technical,taskParentTechnical,fullOrder,
   timing:timingAuthority||own&&active('sample_designer')||primary,
   budget:management||own||primary});
 }
 return {resources:result,liveRoles};
}

type NativeTaskAccess={task_id:string;task_kind:string;source_id:string|null;production_order_id:string|null;required_role:string;assignee_id:string|null};
const TASK_READ_BATCH_SIZE=256;
export function* taskReadBatches(taskIds:readonly string[]){
 const unique=[...new Set(taskIds)];
 for(let offset=0;offset<unique.length;offset+=TASK_READ_BATCH_SIZE)yield unique.slice(offset,offset+TASK_READ_BATCH_SIZE);
}

/** Scope to final-page IDs on the caller's repeatable-read client. Native
 * technical access and execution assignment stay separate from parent access. */
export async function readTaskAccessForPage(db:PoolClient,actor:TrustedActorContext,taskIds:readonly string[]){
 const result=new Map<string,{technical:boolean;execute:boolean;parentTechnical:boolean}>();
 for(const ids of taskReadBatches(taskIds))await authorizeTaskBatch(db,actor,ids,result);
 return result;
}

async function authorizeTaskBatch(db:PoolClient,actor:TrustedActorContext,taskIds:readonly string[],result:Map<string,{technical:boolean;execute:boolean;parentTechnical:boolean}>){
 const active=await wholeOrderActiveSql(db,'task','a.task_id');
 const rows=(await db.query<NativeTaskAccess>(`SELECT a.task_id,a.task_kind,a.source_id,a.production_order_id,a.required_role,a.assignee_id
  FROM digital_production_task_access a WHERE a.task_id=ANY($1::uuid[]) AND ${active}`,[taskIds])).rows;
 if(!rows.length)return;
 const parent=(row:NativeTaskAccess):BusinessTimeScope|null=>row.production_order_id?{kind:'order',id:row.production_order_id}:row.source_id?{kind:'source',id:row.source_id}:null;
 const scopes=new Map<string,BusinessTimeScope>();
 for(const row of rows){const scope=parent(row);if(scope)scopes.set(businessScopeKey(scope),scope);}
 const {resources,liveRoles}=await readJourneySelectionAccess(db,actor,[...scopes.values()]);
 const root=isRootActor(actor),global=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor),clerk=actor.actorRoles.includes('development_clerk');
 for(const row of rows){
  const scope=parent(row),policy=scope?resources.get(businessScopeKey(scope)):undefined;
  const assigned=row.assignee_id===actor.actorId&&activeRole(liveRoles,row.required_role);
  const technical=global||clerk&&row.task_kind.startsWith('development_')||assigned||policy?.taskParentTechnical===true;
  result.set(row.task_id,{technical,execute:root||assigned,parentTechnical:policy?.technical??false});
 }
}

/** Keep the legacy task-list membership and the native task read policy
 * ahead of pagination. Return empty pages with the same snapshot's total. */
export async function readTechnicalTaskListPage(db:PoolClient,actor:TrustedActorContext,page:number,warehouse?:WarehouseNativeTaskQuery){
 const {liveRoles}=await readJourneySelectionAccess(db,actor,[]);
 const activeTask=await wholeOrderActiveSql(db,'task','a.task_id');
 const activeOrder=await wholeOrderActiveSql(db,'order','o.production_order_id');
 const activeSource=await wholeOrderActiveSql(db,'source','s.source_id');
 const global=isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor);
 const owns=actor.actorRoles.includes('sample_designer');
 const merch=actor.actorRoles.includes('order_merchandiser');
 const clerk=actor.actorRoles.includes('development_clerk');
 if(warehouse&&!isRootActor(actor)&&!activeRole(liveRoles,'warehouse_receiver'))return digitalForbidden();
 const scene=warehouse?acceptanceBusinessContext()?.scenarioId:null;
 const filter=warehouse?`AND a.task_kind=$9 AND ($10 OR a.assignee_id=$2)
    ${warehouse.kind==='craft'?`AND EXISTS(SELECT 1 FROM digital_factory_routes route
     WHERE route.production_order_id=o.production_order_id AND route.preparation_id=t.route_instance_id
      AND route.route_schema_version=2 AND route.secondary_craft<>'无')`:''}
    AND ($11 AND t.state='completed' OR NOT $11 AND t.state IN ('pending','ready','blocked'))
    AND ($12='' OR strpos(lower(COALESCE(o.design_style_no,s.design_style_no,'')),lower($12))>0 OR EXISTS(
      SELECT 1 FROM digital_production_po_lines po WHERE po.production_order_id=o.production_order_id
       AND strpos(lower(COALESCE(po.po_number,po.formal_style_no,'')),lower($12))>0))
    ${scene?`AND EXISTS(SELECT 1 FROM acceptance_sla_clock_resources scene
       WHERE scene.scenario_id=$13 AND ((scene.resource_kind='order' AND scene.resource_id=a.production_order_id)
        OR (scene.resource_kind='source' AND a.production_order_id IS NULL AND scene.resource_id=a.source_id)))`:''}`:'';
 const {rows}=await db.query<{total:number;ids:string[]}>(`
  WITH eligible AS (
    SELECT t.task_id,t.created_at
    FROM digital_production_tasks t JOIN digital_production_task_access a ON a.task_id=t.task_id
    LEFT JOIN digital_production_orders o ON o.production_order_id=a.production_order_id
    LEFT JOIN digital_production_sources s ON s.source_id=a.source_id
    WHERE ${activeTask} AND t.node_key<>'factory_material_count' AND NOT(t.task_id=ANY($8::uuid[])) ${filter}
      AND ($1 OR a.assignee_id=$2 OR ($3 AND (o.created_by=$2 OR s.created_by=$2))
        OR ($4 AND o.primary_merchandiser_id=$2) OR ($5 AND a.task_kind LIKE 'development_%'))
      AND ($1 OR ($5 AND starts_with(a.task_kind,'development_'))
        OR (a.assignee_id=$2 AND (a.required_role=ANY($6::text[])
          OR a.required_role='warehouse_receiver' AND 'warehouse_supervisor'=ANY($6::text[])))
        OR (o.production_order_id IS NOT NULL AND ${activeOrder}
          AND ($3 AND o.created_by=$2 OR $4 AND o.primary_merchandiser_id=$2 AND 'order_merchandiser'=ANY($6::text[])
            OR $5 AND o.source_id IS NOT NULL AND 'development_clerk'=ANY($6::text[])))
        OR (o.production_order_id IS NULL AND s.source_id IS NOT NULL AND ${activeSource}
          AND ($3 AND s.created_by=$2 OR $4 AND 'order_merchandiser'=ANY($6::text[]) AND EXISTS(
            SELECT 1 FROM digital_production_orders linked WHERE linked.source_id=s.source_id AND linked.primary_merchandiser_id=$2))))
  ), selected AS (
    SELECT task_id,created_at FROM eligible ORDER BY created_at DESC,task_id DESC LIMIT 15 OFFSET $7
  )
  SELECT (SELECT count(*)::int FROM eligible) AS total,
    coalesce(array_agg(task_id ORDER BY created_at DESC,task_id DESC),'{}'::uuid[]) AS ids
  FROM selected`,[global,actor.actorId,owns,merch,clerk,[...liveRoles],(page-1)*15,await retiredBulkPreshrinkTaskIds(db),
  ...(warehouse?[warehouse.kind==='preshrink'?'warehouse_preshrink':'warehouse_dispatch',isRootActor(actor),warehouse.status==='completed',warehouse.search]:[]),
  ...(scene?[scene]:[])]);
 return rows[0]!;
}
