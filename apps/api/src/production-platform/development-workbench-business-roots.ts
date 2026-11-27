import type {PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import type {DesignerBusinessKind} from '@dx-rework/contracts/digital-development-workspace';
import {developmentReadTables} from './development-amendment-repository.js';
import type {ProductionReadinessService} from './production-readiness-service.js';
import {formalDevelopmentHandoverAvailable} from './development-formal-handover-evidence.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';

type BusinessRow={id:string;rootId:string;rootRow:boolean;kind:DesignerBusinessKind;formalSourceId:string|null;orderId:string|null;mayBeComplete:boolean};
export type DesignerBusinessProjection={byId:Map<string,{kind:DesignerBusinessKind;handoverComplete:boolean}>;representatives:Set<string>;
 counts:Record<DesignerBusinessKind|'handover',number>};

/** Legacy list fallback still reads the same effective source version, not sourcing's old name. */
export async function readDesignerStyleNames(db:PoolClient,actor:TrustedActorContext,ids:readonly string[]){
 if(!ids.length)return new Map<string,string>();
 const access=await readJourneySelectionAccess(db,actor,[...new Set(ids)].map(id=>({kind:'source' as const,id})));
 const visible=[...new Set(ids)].filter(id=>access.resources.get(`source:${id}`)?.technical);
 if(!visible.length)return new Map<string,string>();
 const tables=await developmentReadTables(db);
 const {rows}=await db.query<{source_id:string;name:string|null}>(`SELECT s.source_id,
   nullif(btrim((CASE WHEN latest.round_number>1 THEN latest.document ELSE d.document END)->'workbenchSheet'->>'styleName'),'') AS name
  FROM digital_production_sources s LEFT JOIN ${tables.documents} d USING(source_id)
  LEFT JOIN LATERAL(SELECT r.round_number,r.document FROM ${tables.rounds} r WHERE r.source_id=s.source_id ORDER BY round_number DESC LIMIT 1) latest ON true
  WHERE s.source_id=ANY($1::uuid[])`,[visible]);
 return new Map(rows.flatMap(row=>row.name?[[row.source_id,row.name] as const]:[]));
}

/** Scope has already passed the signed journey selection. SQL batches the
 * identity and classification independent from SLA/node projections. */
export async function readDesignerBusinessRoots(db:PoolClient,actor:TrustedActorContext,scope:readonly {id:string;sourceId:string|null;orderId:string|null}[],
 readiness:Pick<ProductionReadinessService,'currentFormalHandoversInSnapshot'>,resolveRootFacts=true):Promise<DesignerBusinessProjection|null>{
 const migrated=(await db.query("SELECT to_regclass('digital_development_preorder_publications') AS preorders")).rows[0]?.preorders;
 if(!migrated)return null;
 const out:DesignerBusinessProjection={byId:new Map(),representatives:new Set(),counts:{pure:0,preorder:0,ordered:0,handover:0}};
 if(!scope.length)return out;
 const tables=await developmentReadTables(db),formal=await formalDevelopmentHandoverAvailable(db);
 const requested=scope.map(({id,sourceId,orderId})=>({id,sourceId,orderId}));
 const {rows}=await db.query<BusinessRow>(`WITH authorized AS (
   SELECT * FROM jsonb_to_recordset($1::jsonb) AS x(id text,"sourceId" uuid,"orderId" uuid)
  )
  SELECT x.id,coalesce(r.root_source_id,s.source_id,o.production_order_id)::text AS "rootId",
    r.source_id IS NULL AS "rootRow",CASE WHEN o.production_order_id IS NOT NULL THEN 'ordered'
    WHEN p.source_id IS NOT NULL THEN 'preorder' ELSE 'pure' END AS kind,
    CASE WHEN o.production_order_id IS NOT NULL AND s.source_id IS NOT NULL THEN s.source_id::text END AS "formalSourceId",
    o.production_order_id AS "orderId",
    ${formal?'formal_history.event_id IS NOT NULL':'false'} AS "mayBeComplete"
  FROM authorized x
  LEFT JOIN digital_production_sources s ON s.source_id=x."sourceId"
  LEFT JOIN digital_production_orders o ON o.production_order_id=x."orderId"
  LEFT JOIN digital_development_revision_sources r ON r.source_id=s.source_id
  LEFT JOIN digital_development_preorder_publications p ON p.source_id=s.source_id
  LEFT JOIN ${tables.documents} d ON d.source_id=s.source_id
  LEFT JOIN digital_production_resource_lifecycle sr ON sr.resource_kind='source' AND sr.resource_id=s.source_id
  LEFT JOIN digital_production_resource_lifecycle oro ON oro.resource_kind='order' AND oro.resource_id=o.production_order_id
  ${formal?`LEFT JOIN LATERAL (
    SELECT se.event_id FROM digital_development_formal_handover_enrollments enroll
    JOIN digital_series_source_events se USING(production_order_id)
    WHERE enroll.production_order_id=o.production_order_id AND enroll.source_id=s.source_id
     AND se.node_key='design_handover' AND se.scope_ref='whole' AND se.source_domain='development' AND NOT se.voided AND se.business_completed
    LIMIT 1
  ) formal_history ON true`:''}
  WHERE (o.production_order_id IS NOT NULL OR p.source_id IS NOT NULL OR d.status='published')
   AND (s.source_id IS NULL OR digital_whole_order_active('source',s.source_id))
   AND (o.production_order_id IS NULL OR digital_whole_order_active('order',o.production_order_id))
   AND sr.state IS DISTINCT FROM 'cancelled' AND oro.state IS DISTINCT FROM 'cancelled'
  ORDER BY r.source_id IS NULL DESC,o.production_order_id IS NOT NULL DESC,x.id`,[JSON.stringify(requested)]);
 const groups=new Map<string,BusinessRow[]>();
 for(const row of rows){const items=groups.get(row.rootId)??[];items.push(row);groups.set(row.rootId,items);}
 // Search may match only the independent revision. Its authorized original
 // remains the order identity, but knowing the lineage never grants access.
 const childOnlyRootIds=resolveRootFacts?[...groups].flatMap(([id,members])=>members.some(row=>row.rootRow)?[]:[id]):[];
 const rootFacts=new Map<string,{kind:DesignerBusinessKind;handoverComplete:boolean}>();
 if(childOnlyRootIds.length){
  const rootRows=(await db.query<{sourceId:string;orderId:string|null}>(`SELECT s.source_id AS "sourceId",o.production_order_id AS "orderId"
   FROM digital_production_sources s LEFT JOIN digital_production_orders o USING(source_id)
   WHERE s.source_id=ANY($1::uuid[])`,[childOnlyRootIds])).rows;
  const resources=rootRows.flatMap(row=>[{kind:'source' as const,id:row.sourceId},...(row.orderId?[{kind:'order' as const,id:row.orderId}]:[])]);
  const policy=await readJourneySelectionAccess(db,actor,resources);
  const allowed=rootRows.filter(row=>policy.resources.get(`source:${row.sourceId}`)?.technical&&
   (!row.orderId||policy.resources.get(`order:${row.orderId}`)?.technical));
  const roots=await readDesignerBusinessRoots(db,actor,allowed.map(row=>({id:row.sourceId,...row})),readiness,false);
  for(const [id,fact] of roots?.byId??[])rootFacts.set(id,fact);
 }
 const chosen=[...groups].map(([rootId,members])=>{
  const hasRoot=members.some(row=>row.rootRow);
  const identity=hasRoot?members.find(row=>row.kind==='ordered')??members.find(row=>row.kind==='preorder')??members[0]!:null;
  return {rootId,members,identity};
 });
 // Historical completion only prefilters. Read the exact current proof for
 // all eligible roots once, not their detailed readiness view before paging.
 const candidates=chosen.flatMap(({identity})=>identity?.mayBeComplete&&identity.formalSourceId&&identity.orderId?
  [{sourceId:identity.formalSourceId,orderId:identity.orderId}]:[]);
 const completed=await readiness.currentFormalHandoversInSnapshot(db,actor,[...new Map(candidates.map(row=>[row.orderId,row])).values()]);
 for(const {rootId,members,identity} of chosen){
  const representative=members[0]!;
  out.representatives.add(representative.id);
  if(!identity){
   const root=rootFacts.get(rootId);
   if(!root)continue;
   out.counts[root.kind]++;if(root.handoverComplete)out.counts.handover++;
   for(const member of members)out.byId.set(member.id,root);
   continue;
  }
  const handoverComplete=Boolean(identity.mayBeComplete&&identity.orderId&&completed.has(identity.orderId));
  out.counts[identity.kind]++;
  if(handoverComplete)out.counts.handover++;
  for(const member of members)out.byId.set(member.id,{kind:identity.kind,handoverComplete});
 }
 return out;
}
