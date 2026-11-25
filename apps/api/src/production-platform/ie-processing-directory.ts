import type {PoolClient} from 'pg';
import {acceptanceBusinessContext,acceptanceClockReaderEnabled} from '../acceptance-clock/business-time.js';
import type {IeProcessingEntry,IeProcessingQuery} from '@dx-rework/contracts/digital-quotation';
import {prioritizeWithinRushGroups,projectDevelopmentRushResources} from './development-order-rush.js';

const pageSize=15;

/** Uses the current stored IE row. Customer confirmation and external IE quotes have their own identities. */
export async function readIeProcessingDirectory(db:PoolClient,database:object,input:IeProcessingQuery,viewer:{id:string;canPrice:boolean;canReadAll:boolean;isRoot:boolean},
 target?:{quoteId:string;rowId:string}){
 const clockEnabled=acceptanceClockReaderEnabled(database);
 const clockRestriction=clockEnabled?`AND (
  SELECT b.scenario_id FROM acceptance_sla_clock_resources b
  WHERE b.resource_kind=CASE WHEN q.production_order_id IS NULL THEN 'source' ELSE 'order' END
   AND b.resource_id=COALESCE(q.production_order_id,q.source_id)
 ) IS NOT DISTINCT FROM $6::uuid`:'AND $6::uuid IS NULL';
 const {rows}=await db.query<{total:number;items:IeProcessingEntry[]}>(`WITH candidates AS (
  SELECT q.quote_id,q.version,coalesce(o.created_at,s.created_at) AS order_created_at,q.source_id,q.production_order_id,
   coalesce(o.design_style_no,s.design_style_no) AS style_no,coalesce(o.customer_code,s.customer_code) AS customer_code,
   (q.assembly->>'roundNumber')::int AS round, price_row->>'rowId' AS row_id,
   nullif(assignment->>'priceAssigneeId','') AS assignee_id,
   coalesce(lifecycle.state,'active') AS lifecycle_state,coalesce(price_row->>'unitPrice','') AS unit_price
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
   AND ($2::boolean OR $3::boolean AND assignment->>'priceAssigneeId'=$1::text)
   AND ($10::uuid IS NULL OR q.quote_id=$10 AND ref.key=$11::text)
   AND ($4::text='' OR position(lower($4::text) in lower(coalesce(o.design_style_no,s.design_style_no)))>0
    OR position(lower($4::text) in lower(coalesce(o.customer_code,s.customer_code,'')))>0)
   ${clockRestriction}
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
