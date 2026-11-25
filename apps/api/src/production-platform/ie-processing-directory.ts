import type {PoolClient} from 'pg';
import {acceptanceBusinessContext,acceptanceClockReaderEnabled} from '../acceptance-clock/business-time.js';
import type {IeProcessingEntry,IeProcessingQuery} from '@dx-rework/contracts/digital-quotation';
import {prioritizeWithinRushGroups,projectDevelopmentRushResources} from './development-order-rush.js';
import {isRootActor} from '../access/business-authority.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import type {IeAuthorizedCandidates} from './ie-authorized-directory.js';

const pageSize=15;
type IeProcessingViewer=Readonly<{id:string;canPrice:boolean;canReadAll:boolean;isRoot:boolean}>;

export async function ieProcessingViewer(db:Pick<PoolClient,'query'>,actor:TrustedActorContext):Promise<IeProcessingViewer|null>{
 const isRoot=isRootActor(actor),access=new DigitalProductionAccessPolicy(db);
 const active=async(role:string)=>actor.actorRoles.includes(role)&&await access.activeRole(actor.actorId,role);
 const canPrice=!isRoot&&await active('ie_reviewer');
 const canManage=!isRoot&&await active('production_management'),canOwn=!isRoot&&await active('owner_group');
 const canReadAll=isRoot||canManage||canOwn;
 return canReadAll||canPrice?{id:actor.actorId,canPrice,canReadAll,isRoot}:null;
}

function processingSource({id,readAll,price,search,clockEnabled,scene,target}:Readonly<{
 id:string;readAll:string;price:string;search:string;clockEnabled:boolean;scene:string;target?:{quote:string;row:string};
}>){
 const clockRestriction=clockEnabled?`AND (
  SELECT b.scenario_id FROM acceptance_sla_clock_resources b
  WHERE b.resource_kind=CASE WHEN q.production_order_id IS NULL THEN 'source' ELSE 'order' END
   AND b.resource_id=COALESCE(q.production_order_id,q.source_id)
 ) IS NOT DISTINCT FROM ${scene}::uuid`:`AND ${scene}::uuid IS NULL`;
 return `SELECT q.quote_id,q.version,coalesce(o.created_at,s.created_at) AS order_created_at,q.source_id,q.production_order_id,
   coalesce(o.design_style_no,s.design_style_no) AS style_no,coalesce(o.customer_code,s.customer_code) AS customer_code,
   (q.assembly->>'roundNumber')::int AS round, price_row->>'rowId' AS row_id,
   nullif(assignment->>'priceAssigneeId','') AS assignee_id,
   coalesce(lifecycle.state,'active') AS lifecycle_state,coalesce(price_row->>'unitPrice','') AS unit_price,price_row->>'unit' AS price_unit,
   q.price_sources->ref.key->>'version' AS price_version
  FROM digital_quotation_documents q
  JOIN digital_production_sources s ON s.source_id=q.source_id
  LEFT JOIN digital_production_orders o ON o.production_order_id=q.production_order_id
  JOIN LATERAL jsonb_each(q.assembly->'rows') ref ON ref.value->>'kind'='ie' AND ref.value->>'sourceRef'='ie:processing'
  JOIN LATERAL jsonb_array_elements(q.document->'rows') price_row ON price_row->>'rowId'=ref.key
  JOIN LATERAL jsonb_array_elements(q.assignments) assignment ON assignment->>'rowId'=ref.key AND assignment->>'priceRole'='ie_reviewer'
  LEFT JOIN digital_production_resource_lifecycle lifecycle
   ON lifecycle.resource_kind=CASE WHEN q.production_order_id IS NULL THEN 'source' ELSE 'order' END
   AND lifecycle.resource_id=COALESCE(q.production_order_id,q.source_id)
  WHERE (q.production_order_id IS NULL OR o.production_order_id IS NOT NULL)
   AND (${readAll}::boolean OR ${price}::boolean AND assignment->>'priceAssigneeId'=${id}::text)
   ${target?`AND (${target.quote}::uuid IS NULL OR q.quote_id=${target.quote} AND ref.key=${target.row}::text)`:''}
   AND (${search}::text='' OR position(lower(${search}::text) in lower(coalesce(o.design_style_no,s.design_style_no)))>0
    OR position(lower(${search}::text) in lower(coalesce(o.customer_code,s.customer_code,'')))>0
    OR position(lower(${search}::text) in coalesce(o.production_order_id,s.source_id)::text)>0
    OR EXISTS (SELECT 1 FROM digital_production_po_lines line WHERE line.production_order_id=o.production_order_id
     AND (nullif(btrim(line.formal_style_no),'') IS NULL OR nullif(btrim(line.po_number),'') IS NULL
      OR normalize_sourcing_style_key(line.formal_style_no)=normalize_sourcing_style_key(line.po_number))
     AND position(lower(${search}::text) in lower(coalesce(nullif(btrim(line.formal_style_no),''),nullif(btrim(line.po_number),''))))>0))
   ${clockRestriction}`;
}

export function processingIeCandidates(database:object,viewer:IeProcessingViewer):NonNullable<IeAuthorizedCandidates['processing_quote']>{
 return ({bind,search})=>{
  const clockEnabled=acceptanceClockReaderEnabled(database);
  const source=processingSource({id:bind(viewer.id),readAll:bind(viewer.canReadAll),price:bind(viewer.canPrice),search,
   clockEnabled,scene:bind(clockEnabled?acceptanceBusinessContext()?.scenarioId??null:null)});
  return `SELECT quote_id AS object_id,row_id::uuid AS entry_id,coalesce(production_order_id,source_id) AS resource_id,production_order_id::text AS order_id,
   style_no,customer_code,version,round,lifecycle_state AS native_status,order_created_at AS sort_at,
   (SELECT u.display_name FROM app_users u WHERE u.id=processing.assignee_id::uuid) AS assignee_name,
   CASE WHEN unit_price<>'' AND price_unit<>'' THEN json_build_object('kind','single','amount',unit_price,'unit',price_unit) END AS pricing,
   CASE WHEN lifecycle_state='active' AND EXISTS (SELECT 1 FROM digital_quotation_line_reviews review
    WHERE review.quote_id=processing.quote_id AND review.round_number=processing.round AND review.row_id=processing.row_id::uuid
       AND review.field='unitPrice' AND review.recipient_id::text=processing.assignee_id AND review.resolve_at IS NULL
       AND (review.resubmit_at IS NULL OR review.resubmit_field_version::text IS DISTINCT FROM processing.price_version)) THEN 'returned'
    WHEN unit_price<>'' AND price_version IS NOT NULL THEN 'priced'
    WHEN lifecycle_state='active' AND assignee_id IS NOT NULL THEN 'awaiting_price' ELSE 'not_started' END AS state
   FROM (${source}) processing`;
 };
}

/** Uses the current stored IE row. Customer confirmation and external IE quotes have their own identities. */
export async function readIeProcessingDirectory(db:PoolClient,database:object,input:IeProcessingQuery,viewer:IeProcessingViewer,
 target?:{quoteId:string;rowId:string}){
 const clockEnabled=acceptanceClockReaderEnabled(database);
 const source=processingSource({id:'$1',readAll:'$2',price:'$3',search:'$4',clockEnabled,scene:'$6',target:{quote:'$10',row:'$11'}});
 const {rows}=await db.query<{total:number;items:IeProcessingEntry[]}>(`WITH candidates AS (
  ${source}
 ), classified AS (
  SELECT candidates.*,CASE WHEN unit_price<>'' THEN 'priced' WHEN lifecycle_state<>'active' THEN 'waiting'
   WHEN assignee_id IS NULL THEN 'needs_assignment' ELSE 'awaiting_price' END AS state FROM candidates
 ), filtered AS (
  SELECT * FROM classified WHERE $5::text='all' OR state=$5::text
 ), page AS (
  SELECT * FROM filtered ORDER BY order_created_at DESC,quote_id,row_id LIMIT $7 OFFSET $8
 ) SELECT (SELECT count(*)::int FROM filtered) AS total,
  coalesce((SELECT json_agg(json_build_object('resource',json_build_object(
   'kind',CASE WHEN page.production_order_id IS NULL THEN 'source' ELSE 'order' END,
   'id',coalesce(page.production_order_id,page.source_id)),
   'quoteId',page.quote_id,'rowId',page.row_id,'version',page.version,'round',page.round,
   'styleNo',page.style_no,'customerCode',page.customer_code,'assigneeId',page.assignee_id,'assigneeName',u.display_name,
   'state',page.state,'canEditPrice',page.lifecycle_state='active' AND ($9::boolean OR $3::boolean AND page.assignee_id=$1::text)
  ) ORDER BY page.order_created_at DESC,page.quote_id,page.row_id) FROM page LEFT JOIN app_users u ON u.id=page.assignee_id::uuid),'[]'::json) AS items`,
 [viewer.id,viewer.canReadAll,viewer.canPrice,input.search,input.state,clockEnabled?acceptanceBusinessContext()?.scenarioId??null:null,
  pageSize,(input.page-1)*pageSize,viewer.isRoot,target?.quoteId??null,target?.rowId??null]);
 const items=await projectDevelopmentRushResources(db,rows[0]!.items);
 return {page:input.page,pageSize,total:rows[0]!.total,items:prioritizeWithinRushGroups(items,
  row=>row.state==='awaiting_price'&&row.canEditPrice?'processing_price':null,row=>row.orderRush===true)};
}
