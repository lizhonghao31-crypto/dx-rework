import type {PoolClient} from 'pg';
import type {MerchandiserOrderResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {acceptanceBusinessContext,businessScopeKey} from '../acceptance-clock/business-time.js';
import {readCockpitFactoryScopes} from './cockpit-home-facts.js';
import {readDevelopmentOrderRush} from './development-order-rush.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';
import {wholeOrderActiveSql} from './whole-order-visibility.js';
import {issuedOrderNumber} from './order-number-repository.js';

type Original={id:string;source_id:string|null;design_style_no:string;temporary_style_no:string|null;customer:string;
 number_source_id:string|null;number_source_style:string|null;workbench_generated_number:boolean|null;po_numbers:string[]};

/** The original order is accessible independently of todos. An assigned row is
 * not an authorization grant: apply the original full-order read before facts,
 * search, totals or pagination. Always require the workbench's own relationship
 * even if the same actor has a second, wider business role. */
export async function readMerchandiserOriginalOrders(db:PoolClient,actor:TrustedActorContext,filter:{page:number;search:string}):Promise<MerchandiserOrderResponse>{
 const context=acceptanceBusinessContext(),scene=context?.scenarioId??null;
 const candidates=(await db.query<{id:string}>(`SELECT o.production_order_id AS id FROM digital_production_orders o
  WHERE ${await wholeOrderActiveSql(db,'order','o.production_order_id')} AND (o.primary_merchandiser_id=$1 OR EXISTS(
    SELECT 1 FROM digital_order_secondary_merchandisers m WHERE m.production_order_id=o.production_order_id AND m.user_id=$1))
   AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM acceptance_sla_clock_resources r WHERE r.scenario_id=$2 AND r.resource_kind='order' AND r.resource_id=o.production_order_id))`,
 [actor.actorId,scene])).rows;
 const {resources}=await readJourneySelectionAccess(db,actor,candidates.map(({id})=>({kind:'order',id})));
 const ids=candidates.flatMap(row=>resources.get(businessScopeKey({kind:'order',id:row.id}))?.fullOrder?[row.id]:[]);
 if(!ids.length)return {items:[],page:filter.page,total:0};
 const asOf=context?.time.now??(await db.query<{now:Date}>('SELECT CURRENT_TIMESTAMP AS now')).rows[0]!.now.toISOString();
 const scopes=await readCockpitFactoryScopes(db,actor,ids.map(id=>({id,asOf})));
 const factories=new Map(ids.map(id=>[id,[...new Set((scopes.get(id)??[]).filter(row=>row.visible&&row.status).map(row=>row.factoryName))].sort()]));
 const originals=(await db.query<Original>(`SELECT o.production_order_id AS id,o.source_id,o.design_style_no,o.temporary_style_no,o.customer_code AS customer,
   s.source_id AS number_source_id,s.design_style_no AS number_source_style,s.workbench_generated_number,
   ARRAY(SELECT po.po_number FROM digital_production_po_lines po WHERE po.production_order_id=o.production_order_id AND po.po_number IS NOT NULL ORDER BY po.position,po.line_id) AS po_numbers
  FROM digital_production_orders o LEFT JOIN digital_production_sources s ON s.source_id=o.source_id
  WHERE o.production_order_id=ANY($1::uuid[])`,[ids])).rows;
 const search=filter.search.toLowerCase();
 const matched=originals.filter(row=>!search||[row.design_style_no,row.temporary_style_no,row.customer,...row.po_numbers,...(factories.get(row.id)??[])]
  .some(value=>value?.toLowerCase().includes(search)));
 const rush=await readDevelopmentOrderRush(db,matched.map(row=>({orderId:row.id,sourceId:row.source_id})));
 const urgent=(row:Original)=>rush.has('order:'+row.id);
 matched.sort((left,right)=>Number(urgent(right))-Number(urgent(left))||left.design_style_no.localeCompare(right.design_style_no)||left.id.localeCompare(right.id));
 const items=await Promise.all(matched.slice((filter.page-1)*15,filter.page*15).map(async row=>({id:row.id,
  orderNumber:await issuedOrderNumber(db,row.number_source_id&&row.number_source_style?{source_id:row.number_source_id,
   design_style_no:row.number_source_style,workbench_generated_number:row.workbench_generated_number===true}:null,row),
  styleNo:row.design_style_no,customer:row.customer,poNumbers:row.po_numbers,factories:factories.get(row.id)??[],urgent:urgent(row)})));
 return {items,page:filter.page,total:matched.length};
}
