import type {Pool} from 'pg';
import type {QualityDirectoryItem,QualityDirectoryQuery} from '@dx-rework/contracts/production-readiness';
import {isRootActor} from '../access/business-authority.js';
import {acceptanceBusinessContext,businessScopeKey} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {digitalForbidden} from './access-policy.js';
import {garmentSlaEvidence} from './garment-sla-evidence.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';

export async function qualityCenterGarmentDirectory(pool:Pool,actor:TrustedActorContext,input:QualityDirectoryQuery){
 const db=await pool.connect();
 try{
  await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const context=acceptanceBusinessContext(),root=isRootActor(actor);
  const candidates=(await db.query<{order_id:string;receipt_id:string;design_style_no:string;customer_code:string;po_number:string|null;supplier_name:string|null}>(`
   SELECT DISTINCT o.production_order_id AS order_id,r.receipt_id,o.design_style_no,o.customer_code,p.po_number,
     ship.supplier_name_snapshot AS supplier_name
   FROM digital_production_orders o JOIN digital_production_child_lines m ON m.production_order_id=o.production_order_id AND m.module='receiving'
   JOIN receiving_receipts r ON r.receipt_id=m.child_id JOIN receiving_batches b USING(receiving_batch_id)
   JOIN digital_production_po_lines p ON p.production_order_id=o.production_order_id AND p.line_id=m.line_id
   JOIN digital_production_task_events e ON e.event_kind='garment_receipt_registered' AND e.resource_kind='order'
       AND e.resource_id=o.production_order_id AND e.payload->>'receiptId'=r.receipt_id::text
   LEFT JOIN sourcing_production_receipt_links link ON link.receipt_id=r.receipt_id
   LEFT JOIN sourcing_production_factory_orders ship ON ship.production_order_id=link.production_order_id AND ship.factory_decision_id IS NOT DISTINCT FROM link.factory_decision_id
   WHERE b.deleted_at IS NULL AND ($1::uuid IS NULL OR EXISTS(SELECT 1 FROM acceptance_sla_clock_resources x
     WHERE x.scenario_id=$1 AND x.resource_kind='order' AND x.resource_id=o.production_order_id))
     AND ($2 OR NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id))`,
   [context?.scenarioId??null,input.status==='completed'])).rows;
  const scopes=[...new Set(candidates.map(row=>row.order_id))].map(id=>({kind:'order' as const,id}));
  const access=await readJourneySelectionAccess(db,actor,scopes);
  if(!root&&(!actor.actorRoles.includes('quality_control')||!access.liveRoles.has('quality_control')))return digitalForbidden();
  const search=input.search.toLowerCase(),items:QualityDirectoryItem[]=[];
  for(const scope of scopes){
   if(!access.resources.get(businessScopeKey(scope))?.technical)continue;
   const selected=candidates.filter(row=>row.order_id===scope.id&&(!search||[row.design_style_no,row.customer_code,row.po_number,row.supplier_name].some(value=>value?.toLowerCase().includes(search))));
   if(!selected.length)continue;
   const state=await garmentSlaEvidence(db,scope.id);
   for(const row of selected){
    const actual=state.quality.find(item=>item.receiptId===row.receipt_id);
    if(!actual||actual.quantity<=0||actual.inspected!==(input.status==='completed'))continue;
    const window=state.windows.find(item=>item.receiptId===actual.receiptId);
    items.push({id:actual.receiptId,orderId:scope.id,designStyleNo:row.design_style_no,customerCode:row.customer_code,poNumber:row.po_number,
     supplierName:row.supplier_name,quantity:actual.quantity,qualifiedQuantity:actual.inspected?actual.qualifiedQuantity:null,dueAt:window?.deadline??null,
     inspected:actual.inspected,result:actual.inspected?(actual.qualifiedQuantity===actual.quantity?'passed':'problem'):null,
     source:{kind:'garment',receiptId:actual.receiptId,quantityVersion:actual.quantityVersion}});
   }
  }
  items.sort((a,b)=>(a.dueAt??'9999').localeCompare(b.dueAt??'9999')||a.id.localeCompare(b.id));
  await db.query('COMMIT');
  return {page:input.page,total:items.length,items:items.slice((input.page-1)*15,input.page*15)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
