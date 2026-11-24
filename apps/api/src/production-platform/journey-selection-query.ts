import {cockpitLegacyOrderTimeSql,orderTimeCreatedMany} from './order-time-created.js';
import type {WorkspaceNodeFact} from './journey-workspace-facts.js';
import type {Pool,PoolClient} from 'pg';
import type {JourneyFilter,JourneyCoverage} from '@dx-rework/contracts/digital-production-journey';
import {JOURNEY_NODES} from '@dx-rework/contracts/digital-production-journey';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import {businessScopeKey,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {JOURNEY_FACT_CALCULATION_VERSION} from './journey-fact-model.js';
import {styleLabelModelVersionSql} from './style-label-model-compatibility.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';
import {developmentReadTables} from './development-amendment-repository.js';
import {canReadProductionReporting,productionVisibilityFor,productionVisibilityArgs} from '../sourcing/production-reporting-service.js';
import {cockpitCreationTime,cockpitIsActivated,journeyOrderState} from './journey-display.js';
import {journeyMatchesSearch,type JourneySelection,type JourneySelectionSignals} from './journey-projection.js';

export type JourneySelectionCandidate={source:{source_id:string}|null;order:{production_order_id:string}|null};
export type JourneySelectionRead={status:'missing'|'pending'|'obsolete'|'failed'|'ready';resource:BusinessTimeScope;selection:JourneySelection;workspaceNodes?:WorkspaceNodeFact[]};
/** Full-scope light facts only. PostgreSQL reduces native node/clock flags;
 * no complete model, SLA graph or node collection is transported to Node.
 * The caller still hydrates only its selected IDs in the same read snapshot. */
export async function readJourneySelections(database:Pool,db:PoolClient,actor:TrustedActorContext,candidates:readonly JourneySelectionCandidate[],filter:JourneyFilter,asOf:string,options:{workspaceNodes?:'designer'|'pattern';workspaceKinds?:readonly string[]}={}){
 const scopes=candidates.flatMap(row=>[...(row.source?[{kind:'source' as const,id:row.source.source_id}]:[]),...(row.order?[{kind:'order' as const,id:row.order.production_order_id}]:[])]);
 const access=await readJourneySelectionAccess(db,actor,[...new Map(scopes.map(scope=>[businessScopeKey(scope),scope])).values()]);
 const resources=candidates.map(row=>row.order?{kind:'order' as const,id:row.order.production_order_id}:{kind:'source' as const,id:row.source!.source_id});
 const observations=await new ContextBusinessClock(database,db).readManyObservations(resources,{now:()=>new Date(asOf),mode:'live'});
 const clocks=new Map([...observations].map(([key,value])=>[key,value.time])),observationMode=[...observations.values()].some(value=>value.mode==='live')?'live' as const:'fixed' as const;
 if(!resources.length)return {items:[] as JourneySelectionRead[],clocks,observationMode};
 const requested=candidates.map((row,index)=>{
  const resource=resources[index]!,time=clocks.get(businessScopeKey(resource))!;
  const source=row.source?access.resources.get(businessScopeKey({kind:'source',id:row.source.source_id})):null;
  const order=row.order?access.resources.get(businessScopeKey({kind:'order',id:row.order.production_order_id})):null;
  return {...resource,sourceAccess:source?.technical??false,orderAccess:order?.technical??false,fullOrder:order?.fullOrder??false,
   timing:options.workspaceNodes?false:row.order?Boolean(order?.fullOrder&&order.timing):Boolean(source?.technical&&source.timing),budget:order?.budget??false,
   now:time.now,scenario:time.scenarioId,revision:time.revision};
 });
 const root=actor.actorRoles.includes('root_superuser'),canSourcing=root||(actor.authorizationCapabilities??[]).includes('sourcing:view');
 const canRework=actor.actorRoles.some(role=>['root_superuser','owner_group','production_management','pmc','quality_control','order_merchandiser'].includes(role));
 const closureLinks=canRework||actor.actorRoles.some(role=>['warehouse_receiver','warehouse_supervisor'].includes(role));
 const canCutting=root||(actor.authorizationCapabilities??[]).includes('cutting:orders:view');
 const production=canReadProductionReporting(actor)?(await db.query<{production_order_id:string}>(`SELECT production.production_order_id
  FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id)
  WHERE ${productionVisibilityFor(actor)} AND EXISTS(SELECT 1 FROM digital_production_child_links l
   WHERE l.module='production' AND l.child_id=production.production_order_id AND l.production_order_id=ANY($5::uuid[]))`,[...productionVisibilityArgs(actor),resources.filter(scope=>scope.kind==='order').map(scope=>scope.id)])).rows.map(row=>row.production_order_id):[];
 const tables=await developmentReadTables(db),roles=[...access.liveRoles];if(access.liveRoles.has('warehouse_supervisor'))roles.push('warehouse_receiver');
 // Static SQL only. Complete-view eligibility is recomputed from current
 // permissions, linked-domain scope and filters; never saved as a grant.
 const fullView=`((r."fullOrder" OR o.production_order_id IS NULL AND r."sourceAccess") AND (s.source_id IS NULL OR r."sourceAccess")
  AND r.timing AND r.budget AND (sourcing.child_id IS NULL OR $7) AND $8
  AND (production.child_id IS NULL OR production.child_id=ANY($9::uuid[]))
  AND nullif($3::jsonb->>'stage','') IS NULL AND nullif($3::jsonb->>'node','') IS NULL
  AND nullif($3::jsonb->>'state','') IS NULL AND nullif($3::jsonb->>'risk','') IS NULL)`;
 const selection=`CASE WHEN ${fullView} THEN m.selection_full_json ELSE m.selection_json END`;
 type Row={creationKind:'source'|'order'|null;creationId:string|null;cockpitRangeComplete:boolean;sourcePublished:boolean;sourceReserved:boolean;sourceCreationId:string|null;orderCreationId:string|null;legacyPublishedAt:string|null;legacyOrderAt:string|null;kind:'source'|'order';resource_id:string;status:JourneySelectionRead['status'];id:string;sourceId:string|null;orderId:string|null;designStyleNo:string;temporaryStyleNo:string|null;customer:string|null;category:string|null;designer:string|null;styleName:string|null;
  merchandisers:JourneySelection['merchandisers'];orderNumbers:string[];createdAt:string;specialClosed:boolean;closed:boolean;activated:boolean;cancelled:boolean;closedAt:string|null;earliestShipmentDate:string|null;reminder:string|null;coverage:JourneyCoverage[];signals:JourneySelectionSignals;search_values:string[];workspace_nodes:WorkspaceNodeFact[];scheduleSelection:JourneySelection['scheduleSelection']};
 const rows=(await db.query<Row>(`WITH requested AS (
  SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(kind text,id uuid,"sourceAccess" boolean,"orderAccess" boolean,"fullOrder" boolean,timing boolean,budget boolean,now timestamptz,scenario uuid,revision bigint)
 ), native AS MATERIALIZED (
  SELECT r.*,o.source_id AS order_source_id,s.source_id AS sid,o.production_order_id AS oid,
   coalesce(s.source_id,o.production_order_id) AS default_id,${selection} AS facts,${fullView} AS full_view,
   CASE WHEN $12::boolean THEN m.payload->'nodes' END AS workspace_facts,
   CASE WHEN m.resource_id IS NULL THEN CASE WHEN EXISTS(SELECT 1 FROM digital_journey_fact_retries retry JOIN digital_journey_fact_changes change USING(resource_kind,resource_id) WHERE retry.resource_kind=r.kind AND retry.resource_id=r.id) THEN 'failed' ELSE 'missing' END
    WHEN EXISTS(SELECT 1 FROM digital_journey_fact_changes c WHERE c.resource_kind=r.kind AND c.resource_id=r.id)
     OR m.source_version IS DISTINCT FROM m.applied_source_version OR m.clock_scenario_id IS DISTINCT FROM r.scenario OR m.clock_revision<>r.revision THEN CASE WHEN EXISTS(SELECT 1 FROM digital_journey_fact_retries retry JOIN digital_journey_fact_changes change USING(resource_kind,resource_id) WHERE retry.resource_kind=r.kind AND retry.resource_id=r.id) THEN 'failed' ELSE 'pending' END
    WHEN NOT ${styleLabelModelVersionSql('m.calculation_version','$2','r.kind','r.id')} THEN 'obsolete'
    WHEN (${selection}) IS NULL OR (${selection})->>'version' IS DISTINCT FROM 'journey-selection-v2' OR m.selection_expires_at<=r.now THEN 'pending'
    WHEN (CASE WHEN ${fullView} THEN m.selection_full_integrity ELSE m.selection_integrity END) IS DISTINCT FROM md5((${selection})::text||m.selection_fingerprint)
     OR jsonb_typeof((${selection})->'frames') IS DISTINCT FROM 'array' THEN 'failed' ELSE 'ready' END AS status,
   coalesce(o.design_style_no,s.design_style_no) AS order_style,s.design_style_no AS source_style,
   o.temporary_style_no AS order_temporary,s.temporary_style_no AS source_temporary,
   coalesce(o.customer_code,s.customer_code) AS order_customer,s.customer_code AS source_customer,
   s.created_at AS source_created,o.created_at AS order_created,${cockpitLegacyOrderTimeSql('o')} AS legacy_order_business_time,(coalesce((to_jsonb(s)->>'order_time_managed')::boolean,false) OR coalesce((to_jsonb(s)->>'draft_reserved')::boolean,false)) AS source_managed,coalesce((to_jsonb(o)->>'order_time_managed')::boolean,false) AS order_managed,o.product_group,o.primary_merchandiser_id,
   designer.display_name AS designer,primary_person.display_name AS primary_name,
   sourcing.child_id AS sourcing_id,production.child_id AS production_id,source_case.style_name_snapshot,source_case.erp_order_no,
   additional.people AS secondary_merchandisers,source_case.sourcing_case_id AS visible_sourcing_id,
   CASE WHEN coalesce(round.round_number,1)>1 THEN round.document->>'template' ELSE document.document->>'template' END AS category_template,
   CASE WHEN document.status='published' THEN document.published_at END AS legacy_published_at,
   coalesce(document.status='published',false) AS source_published,
   coalesce((to_jsonb(s)->>'draft_reserved')::boolean,false) AS source_reserved,
   EXISTS(SELECT 1 FROM audit_events e WHERE e.entity_type='digital_production' AND e.entity_id=o.production_order_id::text AND e.action='digital_source_attached' AND e.after_state->>'sourceId'=s.source_id::text) AS attached,
   EXISTS(SELECT 1 FROM digital_production_task_access a WHERE a.task_kind<>'factory_material_count' AND (a.source_id=s.source_id OR a.production_order_id=o.production_order_id) AND a.assignee_id=$6 AND a.required_role=ANY($5::text[])) AS direct
  FROM requested r
  LEFT JOIN digital_production_orders o ON r.kind='order' AND o.production_order_id=r.id
  LEFT JOIN digital_production_sources s ON s.source_id=CASE WHEN r.kind='source' THEN r.id ELSE o.source_id END
  LEFT JOIN digital_journey_fact_models m ON m.resource_kind=r.kind AND m.resource_id=r.id
  LEFT JOIN app_users designer ON designer.id=coalesce(s.created_by,o.created_by)
  LEFT JOIN app_users primary_person ON primary_person.id=o.primary_merchandiser_id
  LEFT JOIN ${tables.documents} document ON document.source_id=s.source_id
  LEFT JOIN LATERAL (SELECT d.round_number,d.document FROM ${tables.rounds} d WHERE d.source_id=s.source_id ORDER BY d.round_number DESC LIMIT 1) round ON true
  LEFT JOIN LATERAL (SELECT l.child_id FROM digital_production_child_links l WHERE l.production_order_id=o.production_order_id AND l.module='sourcing' ORDER BY l.child_id LIMIT 1) sourcing ON true
  LEFT JOIN LATERAL (SELECT l.child_id FROM digital_production_child_links l WHERE l.production_order_id=o.production_order_id AND l.module='production' ORDER BY l.child_id LIMIT 1) production ON true
  LEFT JOIN (sourcing_cases source_case JOIN current_sourcing_cases current_case USING(sourcing_case_id))
   ON source_case.sourcing_case_id=sourcing.child_id AND source_case.deleted_at IS NULL AND r."fullOrder" AND $7
  LEFT JOIN LATERAL (SELECT jsonb_agg(jsonb_build_object('id',p.id,'name',p.display_name) ORDER BY ids.position,p.id) AS people FROM (
   SELECT user_id,min(position) AS position FROM (
    SELECT t.user_id,t.position FROM digital_order_secondary_merchandisers t WHERE t.production_order_id=o.production_order_id
    UNION ALL SELECT selected.user_id,1000+selected.position::int FROM unnest(sourcing_additional_merchandiser_ids(source_case.sourcing_case_id)) WITH ORDINALITY selected(user_id,position)
   ) related GROUP BY user_id
  ) ids JOIN app_users p ON p.id=ids.user_id WHERE p.id IS DISTINCT FROM o.primary_merchandiser_id) additional ON r."fullOrder" AND $7
 ), clocked AS (
  SELECT n.*,frame.value AS frame FROM native n
  LEFT JOIN LATERAL (SELECT f.value FROM jsonb_array_elements(CASE WHEN n.status='ready' THEN n.facts->'frames' ELSE '[]'::jsonb END) f(value)
   WHERE (f.value->>'from')::timestamptz<=n.now ORDER BY (f.value->>'from')::timestamptz DESC LIMIT 1) frame ON true
  WHERE n."sourceAccess" OR n."orderAccess" OR n.direct
 ), framed AS (
  SELECT n.*,(n.status='ready' AND n.full_view
   AND jsonb_typeof(n.frame->'fullSignals')='object' AND NOT $12::boolean) AS fast FROM clocked n
 ), selected_nodes AS (
  SELECT n.kind,n.id,nodes.value AS node,risk.value->'risks' AS risks FROM framed n
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN n.status='ready' AND NOT coalesce(n.fast,false) THEN
   CASE WHEN n."fullOrder" OR n.oid IS NULL AND n."sourceAccess" THEN CASE WHEN n.timing THEN n.facts->'nodes' ELSE n.facts->'untimedNodes' END ELSE n.facts->'nativeNodes' END ELSE '[]'::jsonb END) nodes(value)
  LEFT JOIN LATERAL (SELECT r.value FROM jsonb_array_elements(coalesce(n.frame->CASE WHEN n.timing THEN 'risks' WHEN n."fullOrder" THEN 'untimedRisks' ELSE 'nativeRisks' END,'[]'::jsonb)) r(value) WHERE r.value->>'id'=nodes.value->>'instanceId') risk ON true
  WHERE (
   (nodes.value->>'stage'='creation' AND CASE WHEN nodes.value->>'key'='order_information' THEN n."fullOrder" ELSE n."sourceAccess" END)
   OR (nodes.value->>'stage'='development' AND (n."sourceAccess" OR n."fullOrder" AND n.sid IS NULL))
   OR (nodes.value->>'stage' NOT IN ('creation','development') AND n."fullOrder")
   OR EXISTS(SELECT 1 FROM digital_production_task_access t WHERE t.task_id::text=nodes.value->>'instanceId' AND t.assignee_id=$6 AND t.required_role=ANY($5::text[]))
  ) AND NOT (nodes.value->>'key'='budget' AND NOT n.budget)
   AND NOT (nodes.value->>'key'=ANY(ARRAY['sourcing_ie','sourcing_director','sourcing_owner']) AND n.sourcing_id IS NOT NULL AND NOT $7)
   AND NOT (nodes.value->>'key'='sourcing_preparation' AND n.sourcing_id IS NOT NULL AND NOT $7)
   AND NOT (nodes.value->>'key'=ANY(ARRAY['rework_review','responsibility']) AND NOT $8)
   AND NOT (nodes.value->>'key'='production_reporting' AND n.production_id IS NOT NULL AND NOT n.production_id=ANY($9::uuid[]))
  UNION ALL
  SELECT n.kind,n.id,nodes.value AS node,risk.value->'risks' AS risks FROM framed n
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN n.status='ready' AND NOT coalesce(n.fast,false) THEN n.facts->'nativeNodes' ELSE '[]'::jsonb END) nodes(value)
  LEFT JOIN LATERAL (SELECT r.value FROM jsonb_array_elements(coalesce(n.frame->'nativeRisks','[]'::jsonb)) r(value) WHERE r.value->>'id'=nodes.value->>'instanceId') risk ON true
  WHERE n."fullOrder" AND n.sourcing_id IS NOT NULL AND NOT $7 AND nodes.value->>'key'='sourcing_preparation'
 ), scoped AS (
  SELECT n.kind,n.id,node->>'key' AS key,node->>'stage' AS stage,node->>'state' AS state,
   coalesce((node->>'completesOrder')::boolean,true) AS completes_order,
   coalesce((node->>'planningOnly')::boolean,false) AS planning,coalesce((node->>'entered')::boolean,false) AS entered,coalesce((node->>'recorded')::boolean,false) AS recorded,
   coalesce(risks,node->'risks','[]'::jsonb) AS risks FROM selected_nodes n WHERE NOT $12::boolean
  UNION ALL
  SELECT n.kind,n.id,c.value->>'key',c.value->>'stage',
   CASE WHEN n.oid IS NULL AND c.value->>'stage' NOT IN ('creation','development') THEN 'not_applicable'
    WHEN c.value->>'key'='budget' AND NOT n.budget OR c.value->>'key'=ANY(ARRAY['rework_review','responsibility']) AND NOT $8
    OR c.value->>'key'=ANY(ARRAY['sourcing_ie','sourcing_director','sourcing_owner']) AND n.sourcing_id IS NOT NULL AND NOT $7
    OR c.value->>'key'='production_reporting' AND n.production_id IS NOT NULL AND NOT n.production_id=ANY($9::uuid[]) THEN 'unavailable'
    WHEN c.value->>'key'='order_information' AND n.oid IS NULL THEN 'uncreated'
    WHEN c.value->>'stage'='creation' AND (n."sourceAccess" OR n."fullOrder") OR c.value->>'stage'='development' AND (n."sourceAccess" OR n."fullOrder" AND n.sid IS NULL) OR c.value->>'stage' NOT IN ('creation','development') AND n."fullOrder" THEN 'uncreated' ELSE 'unavailable' END,
   true,false,false,false,'[]'::jsonb FROM framed n CROSS JOIN jsonb_array_elements($4::jsonb) c(value)
   WHERE NOT $12::boolean AND NOT coalesce(n.fast,false) AND NOT coalesce((c.value->>'planningOnly')::boolean,false) AND NOT EXISTS(SELECT 1 FROM selected_nodes v WHERE v.kind=n.kind AND v.id=n.id AND v.node->>'key'=c.value->>'key')
 ), reduced AS (
  SELECT s.*,((nullif($3::jsonb->>'stage','') IS NULL OR stage=$3::jsonb->>'stage') AND (nullif($3::jsonb->>'node','') IS NULL OR key=$3::jsonb->>'node')
   AND (nullif($3::jsonb->>'state','') IS NULL OR state=$3::jsonb->>'state') AND (nullif($3::jsonb->>'risk','') IS NULL OR risks ? ($3::jsonb->>'risk'))) AS matches FROM scoped s
 ),
flags AS (SELECT kind,id,bool_or(key='packing' AND state='completed' AND completes_order) AS closed,bool_or(key='special_closure' AND state='completed') AS special_closed,
  bool_or(NOT planning AND stage<>'creation' AND (entered OR state IN ('active','completed') AND recorded)) AS activated,
  bool_or(NOT planning AND state IN ('active','pending','blocked')) AS ongoing,bool_or(matches) AS matched,
  bool_or(risks ? 'overdue') AS overdue,bool_or(risks ? 'due_soon') AS warning,bool_or(risks ? 'blocked') AS blocked,
  bool_or(matches AND state='blocked') AS scoped_blocked,
  bool_or(matches AND state NOT IN ('completed','inherited','cancelled','not_applicable','unavailable') AND risks ? 'overdue') AS scoped_overdue,
  bool_or(matches AND state NOT IN ('completed','inherited','cancelled','not_applicable','unavailable') AND risks ? 'due_soon') AS scoped_warning
  FROM reduced GROUP BY kind,id
  UNION ALL SELECT n.kind,n.id,(n.frame->'fullSignals'->>'completed')::boolean,coalesce((n.frame->'fullSignals'->>'specialClosed')::boolean,false),(n.frame->'fullSignals'->>'activated')::boolean,
   (n.frame->'fullSignals'->>'ongoing')::boolean,(n.frame->'fullSignals'->>'nodeMatched')::boolean,
   (n.frame->'fullSignals'->'risks'->>'overdue')::boolean,(n.frame->'fullSignals'->'risks'->>'due_soon')::boolean,(n.frame->'fullSignals'->'risks'->>'blocked')::boolean,
   (n.frame->'fullSignals'->>'scopedBlocked')::boolean,(n.frame->'fullSignals'->>'scopedOverdue')::boolean,(n.frame->'fullSignals'->>'scopedDueSoon')::boolean FROM framed n WHERE n.fast),
 delivery AS (
 SELECT n.kind,n.id,bool_or(true) AS matched,bool_or(d.value->>'risk'='overdue') AS overdue,bool_or(d.value->>'risk'='due_soon') AS warning
 FROM framed n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN n."orderAccess" AND NOT coalesce(n.fast,false) THEN coalesce(n.frame->CASE WHEN n."fullOrder" THEN 'deliveryRisks' ELSE 'partialDeliveryRisks' END,'[]'::jsonb) ELSE '[]'::jsonb END) d(value)
 JOIN scoped s ON s.kind=n.kind AND s.id=n.id AND s.key=d.value->>'nodeKey'
 WHERE NOT $12::boolean AND (nullif($3::jsonb->>'risk','') IS NULL OR d.value->>'risk'=$3::jsonb->>'risk')
  AND (nullif($3::jsonb->>'stage','') IS NULL OR s.stage=$3::jsonb->>'stage') AND (nullif($3::jsonb->>'node','') IS NULL OR s.key=$3::jsonb->>'node')
  AND (nullif($3::jsonb->>'state','') IS NULL OR s.state=$3::jsonb->>'state') GROUP BY n.kind,n.id
 UNION ALL SELECT n.kind,n.id,(n.frame->'fullSignals'->>'deliveryMatched')::boolean,
  false,false FROM framed n WHERE n.fast AND n."orderAccess"
 )
 SELECT n.kind,n.id AS resource_id,CASE WHEN n.status='ready' AND n.frame IS NULL THEN 'failed' ELSE n.status END AS status,
  CASE WHEN n.attached THEN n.oid ELSE n.default_id END::text AS id,n.sid::text AS "sourceId",CASE WHEN n."orderAccess" THEN n.oid::text END AS "orderId",
  CASE WHEN n."orderAccess" THEN n.order_style ELSE coalesce(n.source_style,n.order_style) END AS "designStyleNo",
  CASE WHEN n."orderAccess" OR n.sid IS NULL THEN n.order_temporary ELSE n.source_temporary END AS "temporaryStyleNo",
  CASE WHEN n."orderAccess" OR n.sid IS NULL THEN n.order_customer ELSE n.source_customer END AS customer,
  coalesce(CASE WHEN n."sourceAccess" THEN n.category_template END,CASE WHEN n."orderAccess" THEN n.product_group END) AS category,
  n.designer,n.style_name_snapshot AS "styleName",
  (CASE WHEN n."orderAccess" AND n.primary_merchandiser_id IS NOT NULL THEN jsonb_build_array(jsonb_build_object('id',n.primary_merchandiser_id,'name',n.primary_name)) ELSE '[]'::jsonb END)
   ||coalesce(n.secondary_merchandisers,'[]'::jsonb) AS merchandisers,
  CASE WHEN n.erp_order_no IS NOT NULL AND n.erp_order_no<>'' THEN ARRAY[n.erp_order_no] ELSE ARRAY[]::text[] END AS "orderNumbers",
  CASE WHEN n."sourceAccess" THEN CASE WHEN n.source_managed THEN 'source' END WHEN n."orderAccess" AND n.order_managed THEN 'order' END AS "creationKind",
  CASE WHEN n."sourceAccess" THEN CASE WHEN n.source_managed THEN n.sid::text END WHEN n."orderAccess" AND n.order_managed THEN n.oid::text END AS "creationId",
  n.source_published AS "sourcePublished",n.source_reserved AS "sourceReserved",
  (n."fullOrder" OR n.oid IS NULL AND n."sourceAccess") AND (n.sid IS NULL OR n."sourceAccess") AS "cockpitRangeComplete",
  CASE WHEN n."sourceAccess" AND n.source_managed THEN n.sid::text END AS "sourceCreationId",
  CASE WHEN n."orderAccess" AND n.order_managed THEN n.oid::text END AS "orderCreationId",
  CASE WHEN n."sourceAccess" AND NOT n.source_managed THEN n.legacy_published_at END AS "legacyPublishedAt",
  CASE WHEN n."orderAccess" AND NOT n.order_managed THEN n.legacy_order_business_time END AS "legacyOrderAt",
  coalesce(CASE WHEN n."sourceAccess" THEN n.source_created WHEN n."orderAccess" THEN n.order_created END,n.source_created,n.order_created)::text AS "createdAt",
  coalesce(flags.closed,false) AS closed,coalesce(flags.special_closed,false) AS "specialClosed",coalesce(flags.activated,false) AS activated,
  n."orderAccess" AND coalesce((n.facts->>'cancelled')::boolean,false) OR n.oid IS NULL AND n."sourceAccess" AND coalesce((n.facts->>'cancelled')::boolean,false) AS cancelled,
  CASE WHEN flags.closed OR flags.special_closed THEN n.facts->>'closedAt' END AS "closedAt",
  (SELECT min(l.customer_warehouse_arrival_date)::text FROM digital_production_po_lines l WHERE n."orderAccess" AND l.production_order_id=n.oid) AS "earliestShipmentDate",
  CASE WHEN n.timing THEN n.frame->>'customerReminderDate' END AS reminder,
  CASE WHEN n.timing THEN n.frame->'schedule' END AS "scheduleSelection",
  CASE WHEN n.timing THEN coalesce(n.frame->'coverage','[]'::jsonb) ELSE '[{"key":"scope","message":"仅有本岗位节点权限，整单SLA未计入；已授权节点照常监督"}]'::jsonb END AS coverage,
  jsonb_build_object('specialClosed',coalesce(flags.special_closed,false),'completed',coalesce(flags.closed,false),'ongoing',NOT coalesce(flags.closed,false) AND NOT coalesce(flags.special_closed,false) AND coalesce(flags.ongoing,false),
   'nodeMatched',coalesce(flags.matched,false),'deliveryMatched',coalesce(delivery.matched,false),
   'risks',jsonb_build_object('overdue',coalesce(flags.overdue,false) OR coalesce(delivery.overdue,false),'due_soon',coalesce(flags.warning,false) OR coalesce(delivery.warning,false),'blocked',coalesce(flags.blocked,false)),
   'scopedBlocked',coalesce(flags.scoped_blocked,false),'scopedOverdue',coalesce(flags.scoped_overdue,false),'scopedDueSoon',coalesce(flags.scoped_warning,false)) AS signals,
  CASE WHEN coalesce($3::jsonb->>'search','')<>'' THEN ARRAY(
   SELECT term FROM digital_production_po_lines l CROSS JOIN LATERAL unnest(ARRAY[l.po_number,l.formal_style_no,l.temporary_style_no]) term WHERE n."orderAccess" AND l.production_order_id=n.oid
   UNION ALL SELECT l.child_id::text FROM digital_production_child_links l WHERE n."fullOrder" AND l.production_order_id=n.oid
    AND (l.module='sourcing' AND n.visible_sourcing_id IS NOT NULL OR l.module='production' AND l.child_id=ANY($9::uuid[]) OR l.module='cutting' AND $11 OR l.module IN ('receiving','rework') AND $10)
  ) ELSE ARRAY[]::text[] END AS search_values,
  CASE WHEN $12::boolean THEN coalesce((SELECT jsonb_agg(jsonb_build_object(
   'key',sn.node->>'key','instanceId',sn.node->>'instanceId','stage',sn.node->>'stage','state',sn.node->>'state','current',true,
   'planningOnly',coalesce((sn.node->>'planningOnly')::boolean,false),'risks',coalesce(sn.risks,sn.node->'risks','[]'::jsonb),
   'countsInProgress',coalesce((fact.value->>'countsInProgress')::boolean,false),
   'nativeTask',EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(fact.value->'scopes','[]'::jsonb)) scope WHERE scope->>'domain'='task' AND scope->>'id'=sn.node->>'instanceId'),
   'owner',CASE WHEN person.id IS NOT NULL THEN jsonb_build_object('id',person.id,'name',person.display_name) END)
   ORDER BY fact.ordinality,sn.node->>'instanceId')
   FROM selected_nodes sn LEFT JOIN LATERAL (SELECT f.value,f.ordinality FROM jsonb_array_elements(coalesce(n.workspace_facts,'[]'::jsonb)) WITH ORDINALITY f(value,ordinality)
    WHERE f.value->>'instanceId'=sn.node->>'instanceId' AND coalesce((f.value->>'current')::boolean,false) LIMIT 1) fact ON true
   LEFT JOIN app_users person ON person.id=NULLIF(fact.value->>'ownerId','')::uuid
   WHERE sn.kind=n.kind AND sn.id=n.id AND (
    $13::text='pattern' AND sn.node->>'key'=ANY($14::text[]) AND sn.node->>'state' NOT IN ('cancelled','unavailable','not_applicable','inherited','uncreated')
     AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(fact.value->'scopes','[]'::jsonb)) scope WHERE scope->>'domain'='task' AND scope->>'id'=sn.node->>'instanceId')
    OR $13::text='designer' AND (NOT n."orderAccess" OR n.oid IS NULL) AND (
     sn.node->>'key' IN ('product_development','development_publish') OR sn.node->>'stage'='development'
      AND ((fact.value->>'countsInProgress')::boolean OR sn.node->>'state'='inherited')
      AND EXISTS(SELECT 1 FROM selected_nodes published WHERE published.kind=n.kind AND published.id=n.id AND published.node->>'key'='development_publish' AND published.node->>'state'='completed')
    )
   )),'[]'::jsonb) ELSE '[]'::jsonb END AS workspace_nodes
 FROM framed n
 LEFT JOIN flags ON flags.kind=n.kind AND flags.id=n.id
 LEFT JOIN delivery ON delivery.kind=n.kind AND delivery.id=n.id`,
 [JSON.stringify(requested),JOURNEY_FACT_CALCULATION_VERSION,JSON.stringify(filter),JSON.stringify(JOURNEY_NODES),roles,actor.actorId,canSourcing,canRework,production,closureLinks,canCutting,Boolean(options.workspaceNodes),options.workspaceNodes??null,options.workspaceKinds??[]])).rows;
 const created=await orderTimeCreatedMany(db,rows.flatMap(row=>[
  ...(row.sourceCreationId?[{kind:'source' as const,id:row.sourceCreationId}]:[]),
  ...(row.orderCreationId?[{kind:'order' as const,id:row.orderCreationId}]:[])
 ]));
 const items:JourneySelectionRead[]=rows.map(row=>{
  const resource={kind:row.kind,id:row.resource_id},clock=clocks.get(businessScopeKey(resource))!;
  const cockpitCreation={
   developmentCreatedAt:cockpitCreationTime(row.sourcePublished||row.sourceReserved?created.get('source:'+row.sourceCreationId)?.at:null,row.legacyPublishedAt,clock.now),
   orderCreatedAt:cockpitCreationTime(created.get('order:'+row.orderCreationId)?.at,row.legacyOrderAt,clock.now)
  };
  const cockpitActivated=cockpitIsActivated(row.orderId,cockpitCreation);
  const selection:JourneySelection={cockpitRangeComplete:row.cockpitRangeComplete,cockpitActivated,cockpitAsOf:clock.now,id:row.id,sourceId:row.sourceId,orderId:row.orderId,designStyleNo:row.designStyleNo,temporaryStyleNo:row.temporaryStyleNo,customer:row.customer,category:row.category,designer:row.designer,styleName:row.styleName,
   merchandisers:row.merchandisers,orderNumbers:row.orderNumbers,createdAt:created.get(row.creationKind+':'+row.creationId)?.at??new Date(row.createdAt).toISOString(),links:[],lines:[],stages:[],supervision:{coverage:row.coverage},
   ...(row.scheduleSelection?{scheduleSelection:row.scheduleSelection}:{}),display:{mainState:journeyOrderState({cancelled:row.cancelled,closed:row.closed,specialClosed:row.specialClosed,activated:filter.scope?cockpitActivated:row.activated,earliestShipmentDate:row.earliestShipmentDate,reminderDate:row.reminder},clock.now),earliestShipmentDate:row.earliestShipmentDate,closedAt:row.closedAt},selectionSignals:row.signals};
  selection.selectionSignals!.searchMatched=journeyMatchesSearch(selection,filter.search.toLocaleLowerCase())||row.search_values.some(value=>value?.toLocaleLowerCase().includes(filter.search.toLocaleLowerCase()));
  return {resource,status:row.creationKind&&!created.get(row.creationKind+':'+row.creationId)?'failed':row.status,selection,...(options.workspaceNodes?{workspaceNodes:row.workspace_nodes}:{})};
 });
 return {items,clocks,observationMode};
}
