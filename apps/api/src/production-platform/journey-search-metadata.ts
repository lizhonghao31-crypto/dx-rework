import type {PoolClient} from 'pg';
import type {BusinessTimeScope} from '@dx-rework/domain/business-clock';
import type {JourneyRecord,OrderJourney} from '@dx-rework/contracts/digital-production-journey';
import type {TrustedActorContext} from '../tools/repositories.js';
import {canReadProductionReporting,productionVisibilityArgs,productionVisibilityFor} from '../sourcing/production-reporting-service.js';
import {DigitalProductionAccessPolicy,isDigitalManagementReader,isDigitalTechnicalManager} from './access-policy.js';
import {developmentReadTables} from './development-amendment-repository.js';
import {readOrderSecondaryMerchandisers} from './order-merchandisers.js';

export type JourneyCandidate={
 has_order_time_plan?:boolean;
 cockpit_legacy_order_at?:string|null;
 source:{order_time_managed?:boolean;draft_reserved?:boolean|null;workbench_generated_number?:boolean;workbench_number_root_id?:string|null;development_type:string;source_id:string;created_by:string;design_style_no:string;temporary_style_no:string|null;customer_code:string|null;created_at:string}|null;
 order:{order_time_managed?:boolean;production_order_id:string;source_id:string|null;created_by:string;primary_merchandiser_id:string|null;design_style_no:string;temporary_style_no:string|null;customer_code:string;product_group:string;contract_delivery_date:string|null;created_at:string}|null;
};
type Visibility={sourceAccess:boolean;orderAccess:boolean;fullOrder:boolean};
type Merchandisers=ReadonlyMap<string,OrderJourney['merchandisers']>;
type Child={module:string;child_id:string};
type SourcingFields={style_name_snapshot:string|null;erp_order_no:string|null;status:string};
type Commercial=Pick<OrderJourney,'lines'|'links'|'merchandisers'|'orderNumbers'|'styleName'>&{
 children:Child[];sourcing:Child|undefined;sourcingAllowed:boolean;sourcingFields:SourcingFields|null|undefined;
};

export function journeyCandidateClock({source,order}:JourneyCandidate):BusinessTimeScope{
 return order?{kind:'order',id:order.production_order_id}:{kind:'source',id:source!.source_id};
}

type VisibilityCandidate = {
 source: Pick<NonNullable<JourneyCandidate['source']>, 'source_id'> | null;
 order: Pick<NonNullable<JourneyCandidate['order']>, 'production_order_id' | 'created_by' | 'primary_merchandiser_id'> | null;
};

export async function readJourneyCandidateVisibility(policy:DigitalProductionAccessPolicy,actor:TrustedActorContext|null,{source,order}:VisibilityCandidate):Promise<Visibility>{
 const sourceAccess=Boolean(source&&(!actor||await policy.allowed(actor,'source',source.source_id,'technical')));
 const orderAccess=Boolean(order&&(!actor||await policy.allowed(actor,'order',order.production_order_id,'technical')));
 // An assigned technical task may grant a view without the other order tasks.
 const fullOrder=orderAccess&&(!actor||isDigitalManagementReader(actor)||isDigitalTechnicalManager(actor)
  ||actor.actorRoles.includes('sample_designer')&&order?.created_by===actor.actorId
  ||actor.actorRoles.includes('order_merchandiser')&&order?.primary_merchandiser_id===actor.actorId
  ||actor.actorRoles.includes('development_clerk'));
 return {sourceAccess,orderAccess,fullOrder};
}

export async function readJourneyDisplayId(db:PoolClient,{source,order}:JourneyCandidate){
 const sid=source?.source_id??null,oid=order?.production_order_id??null;
 const attached=Boolean(sid&&oid&&(await db.query("SELECT 1 FROM audit_events WHERE entity_type='digital_production' AND entity_id=$1 AND action='digital_source_attached' AND after_state->>'sourceId'=$2 LIMIT 1",[oid,sid])).rowCount);
 return attached?oid!:(sid??oid!);
}

export async function readJourneyStyleIdentity(db:PoolClient,{source,order}:JourneyCandidate,orderAccess:boolean){
 const sid=source?.source_id??null,oid=order?.production_order_id??null;
 const id=await readJourneyDisplayId(db,{source,order});
 const chosen=orderAccess?order!:(source??order!),creator=source?.created_by??order!.created_by;
 const designer=(await db.query<{display_name:string|null}>('SELECT display_name FROM app_users WHERE id=$1',[creator])).rows[0]?.display_name??null;
 return {id,sourceId:sid,orderId:orderAccess?oid:null,designStyleNo:chosen.design_style_no,
  temporaryStyleNo:chosen.temporary_style_no,customer:chosen.customer_code,creator,designer};
}

export async function readJourneyCommercialMetadata(db:PoolClient,actor:TrustedActorContext|null,{order}:JourneyCandidate,{orderAccess,fullOrder}:Visibility,people?:Merchandisers):Promise<Commercial>{
 const oid=order?.production_order_id;
 const lines=orderAccess&&oid?(await db.query<OrderJourney['lines'][number]>(`SELECT l.line_id AS id,l.po_number AS po,l.color,l.formal_style_no AS "formalStyleNo",l.temporary_style_no AS "temporaryStyleNo",coalesce(sum(s.quantity),0)::int AS "orderedQuantity"
  FROM digital_production_po_lines l LEFT JOIN digital_production_po_sizes s USING(line_id) WHERE l.production_order_id=$1 GROUP BY l.line_id ORDER BY l.position`,[oid])).rows:[];
 const links:JourneyRecord[]=[],merchandisers:OrderJourney['merchandisers']=[],orderNumbers:string[]=[];
 const sourcingAllowed=!actor||actor.actorRoles.includes('root_superuser')||(actor.authorizationCapabilities??[]).includes('sourcing:view');
 if(fullOrder&&oid&&sourcingAllowed)merchandisers.push(...(people?.get(oid)??await readOrderSecondaryMerchandisers(db,oid,true)));
 else if(orderAccess&&order?.primary_merchandiser_id){
  const name=(await db.query<{display_name:string|null}>('SELECT display_name FROM app_users WHERE id=$1',[order.primary_merchandiser_id])).rows[0]?.display_name??null;
  merchandisers.push({id:order.primary_merchandiser_id,name});
 }
 let styleName:string|null=null;
 let children:Child[]=[],sourcing:Child|undefined,sourcingFields:SourcingFields|null|undefined;
 if(fullOrder&&oid){
  children=(await db.query<Child>('SELECT module,child_id FROM digital_production_child_links WHERE production_order_id=$1 ORDER BY module,child_id',[oid])).rows;
  sourcing=children.find(child=>child.module==='sourcing');
  sourcingFields=sourcing&&sourcingAllowed?(await db.query<SourcingFields>(`SELECT source.style_name_snapshot,source.erp_order_no,current.status
   FROM sourcing_cases source JOIN current_sourcing_cases current USING(sourcing_case_id) WHERE source.sourcing_case_id=$1 AND source.deleted_at IS NULL`,[sourcing.child_id])).rows[0]:null;
  const closureAllowed=!actor||actor.actorRoles.some(role=>['root_superuser','owner_group','production_management','pmc','order_merchandiser','warehouse_receiver','warehouse_supervisor','quality_control'].includes(role));
  const childLines=(await db.query<{module:string;child_id:string;line_id:string}>('SELECT module,child_id,line_id FROM digital_production_child_lines WHERE production_order_id=$1 ORDER BY module,line_id,child_id',[oid])).rows;
  for(const child of children){
   let url:string|null=null;
   if(child.module==='sourcing'&&sourcingFields&&child.child_id===sourcing?.child_id)url=`/ui/sourcing/orders/${child.child_id}`;
   if(child.module==='cutting'&&(!actor||actor.actorRoles.includes('root_superuser')||(actor.authorizationCapabilities??[]).includes('cutting:orders:view')))url=`/ui/cutting/orders/${child.child_id}`;
   if(child.module==='production'&&(!actor||canReadProductionReporting(actor))){
    const allowed=!actor||(await db.query(`SELECT production.production_order_id FROM sourcing_production_orders production JOIN sourcing_cases source_case USING(sourcing_case_id) WHERE production.production_order_id=$5 AND ${productionVisibilityFor(actor)}`,[...productionVisibilityArgs(actor),child.child_id])).rowCount;
    if(allowed)url=`/ui/production-dashboard/${child.child_id}`;
   }
   if(child.module==='rework'&&closureAllowed)url=`/ui/tasks/${child.child_id}`;
   if(child.module==='receiving'&&closureAllowed)url=`/ui/digital-production?closure=${oid}#receipt-${child.child_id}`;
   if(!url)continue;
   const ids=childLines.filter(line=>line.module===child.module&&line.child_id===child.child_id).map(line=>line.line_id);
   for(const lineId of ids.length?ids:[null])links.push({domain:child.module,id:child.child_id,url,version:null,lineId,mode:'read'});
  }
  if(sourcingFields){styleName=sourcingFields.style_name_snapshot;if(sourcingFields.erp_order_no)orderNumbers.push(sourcingFields.erp_order_no);}
 }
 return {lines,links,merchandisers,orderNumbers,styleName,children,sourcing,sourcingAllowed,sourcingFields};
}

export type JourneySearchMetadata={
 visibility:Visibility;
 identity:Awaited<ReturnType<typeof readJourneyStyleIdentity>>;
 commercial:Commercial;
 category:string|null;
};

/** Original legacy-list identity and link permissions without node/SLA projection. */
export async function readJourneySearchMetadata(db:PoolClient,actor:TrustedActorContext,row:JourneyCandidate,people?:Merchandisers):Promise<JourneySearchMetadata|null>{
 const policy=new DigitalProductionAccessPolicy(db);
 const visibility=await readJourneyCandidateVisibility(policy,actor,row);
 if(!visibility.sourceAccess&&!visibility.orderAccess){
  const roles=(await db.query<{required_role:string}>(`SELECT DISTINCT a.required_role
   FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id)
   WHERE a.task_kind<>'factory_material_count' AND a.assignee_id=$3 AND (a.source_id=$1 OR a.production_order_id=$2)`,[row.source?.source_id??null,row.order?.production_order_id??null,actor.actorId])).rows;
  let direct=false;
  for(const role of roles){if(await policy.activeRole(actor.actorId,role.required_role)){direct=true;break;}}
  if(!direct)return null;
 }
 const identity=await readJourneyStyleIdentity(db,row,visibility.orderAccess);
 const commercial=await readJourneyCommercialMetadata(db,actor,row,visibility,people);
 let category:string|null=null;
 if(row.source&&visibility.sourceAccess){
  const tables=await developmentReadTables(db);
  category=(await db.query<{template:string|null}>(`SELECT CASE WHEN latest.round_number>1 THEN latest.document->'template' ELSE original.document->'template' END AS template
   FROM (SELECT $1::uuid AS source_id) AS candidate
   LEFT JOIN ${tables.documents} original USING(source_id)
   LEFT JOIN LATERAL (SELECT round_number,document FROM ${tables.rounds} WHERE source_id=candidate.source_id ORDER BY round_number DESC LIMIT 1) latest ON true`,[row.source.source_id])).rows[0]?.template??null;
 }
 return {visibility,identity,commercial,category:category??(visibility.orderAccess?row.order?.product_group:null)??null};
}
