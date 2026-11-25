import type {Pool} from 'pg';
import type {QualityDirectoryItem,QualityDirectoryQuery} from '@dx-rework/contracts/production-readiness';
import {isRootActor} from '../access/business-authority.js';
import {acceptanceBusinessContext,businessScopeKey} from '../acceptance-clock/business-time.js';
import type {TrustedActorContext} from '../tools/repositories.js';
import {digitalForbidden} from './access-policy.js';
import {garmentInspectionTiming} from './garment-sla-evidence.js';
import {readJourneySelectionAccess} from './journey-selection-access.js';
import {slaApplicationsByOrder} from './sla-applied-window.js';
import {receiptTime} from './receiving-summary.js';

type ReceiptState={order_id:string;receipt_id:string;quantity:string;quantity_version:string;received_at:Date;after_state:Record<string,unknown>;
 qualified_quantity:unknown;snapshot_id:string|null;rule_version:string;parameters_json:unknown};

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
     AND ($2 OR NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id))
     AND ($3='' OR EXISTS(SELECT 1 FROM unnest(ARRAY[o.design_style_no,o.customer_code,p.po_number,ship.supplier_name_snapshot]) field
       WHERE strpos(lower(field),lower($3))>0))`,[context?.scenarioId??null,input.status==='completed',input.search])).rows;
  const scopes=[...new Set(candidates.map(row=>row.order_id))].map(id=>({kind:'order' as const,id}));
  const access=await readJourneySelectionAccess(db,actor,scopes);
  if(!root&&(!actor.actorRoles.includes('quality_control')||!access.liveRoles.has('quality_control')))return digitalForbidden();
  const selected=candidates.filter(row=>access.resources.get(businessScopeKey({kind:'order',id:row.order_id}))?.technical);
  const completed=input.status==='completed';
  // The status filter is over the latest effective quantity correction and
  // latest actual QC for the very same original receipt. Read only scalar
  // list facts and its immutable starting standard, never its detail history.
  const states=selected.length?(await db.query<ReceiptState>(`WITH candidates AS (
     SELECT DISTINCT * FROM unnest($1::uuid[],$2::uuid[]) AS scope(order_id,receipt_id)
   ) SELECT scope.order_id,r.receipt_id,r.received_at,jsonb_build_object('backfilled',op.after_state->'backfilled') AS after_state,
      quantity.value AS quantity,quantity.version AS quantity_version,q.payload->'qualifiedQuantity' AS qualified_quantity,
      snapshot.snapshot_id,snapshot.rule_version,snapshot.parameters_json
   FROM candidates scope JOIN receiving_receipts r USING(receipt_id)
   JOIN operation_events op ON op.event_id=r.operation_event_id
   LEFT JOIN LATERAL (SELECT correction_id,actual_quantity FROM receiving_receipt_corrections
     WHERE receipt_id=r.receipt_id ORDER BY created_at DESC,correction_id DESC LIMIT 1) c ON true
   CROSS JOIN LATERAL (SELECT coalesce(c.actual_quantity,r.actual_quantity)::bigint AS value,
     coalesce(c.correction_id,r.receipt_id)::text AS version) quantity
   LEFT JOIN LATERAL (SELECT payload FROM digital_production_task_events e WHERE e.resource_kind='order' AND e.resource_id=scope.order_id
     AND e.event_kind='garment_receipt_qc' AND e.payload->>'receiptId'=r.receipt_id::text ORDER BY recorded_at DESC,event_id DESC LIMIT 1) q ON true
   LEFT JOIN LATERAL (SELECT s.snapshot_id,s.rule_version,s.parameters_json FROM digital_production_task_events e
     JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=e.payload->>'snapshotId'
     WHERE e.resource_kind='order' AND e.resource_id=scope.order_id AND e.event_kind='garment_receipt_registered'
       AND e.payload->>'receiptId'=r.receipt_id::text ORDER BY e.recorded_at,e.event_id LIMIT 1) snapshot ON true
   WHERE quantity.value>0 AND COALESCE(q.payload->>'quantityVersion'=quantity.version AND q.payload->'quantity'=to_jsonb(quantity.value),false)=$3`,
   [selected.map(row=>row.order_id),selected.map(row=>row.receipt_id),completed])).rows:[];
  const applications=await slaApplicationsByOrder(db,[...new Set(states.filter(row=>row.snapshot_id).map(row=>row.order_id))]);
  const byReceipt=new Map(states.map(row=>[`${row.order_id}:${row.receipt_id}`,row]));
  const items=selected.flatMap((row):QualityDirectoryItem[]=>{
   const actual=byReceipt.get(`${row.order_id}:${row.receipt_id}`);
   if(!actual)return [];
   const quantity=Number(actual.quantity),qualifiedQuantity=completed?Number(actual.qualified_quantity):null;
   const snapshot=actual.snapshot_id?{snapshot_id:actual.snapshot_id,rule_version:actual.rule_version,parameters_json:actual.parameters_json}:undefined;
   const timing=garmentInspectionTiming(row.receipt_id,receiptTime(actual.received_at,actual.after_state).receivedAt,snapshot,applications.get(row.order_id)??[]);
   return [{id:row.receipt_id,orderId:row.order_id,designStyleNo:row.design_style_no,customerCode:row.customer_code,poNumber:row.po_number,
    supplierName:row.supplier_name,quantity,qualifiedQuantity,dueAt:timing.deadline,inspected:completed,
    result:completed?(qualifiedQuantity===quantity?'passed':'problem'):null,source:{kind:'garment',receiptId:row.receipt_id,quantityVersion:actual.quantity_version}}];
  });
  items.sort((a,b)=>(a.dueAt??'9999').localeCompare(b.dueAt??'9999')||a.id.localeCompare(b.id));
  await db.query('COMMIT');
  return {page:input.page,total:items.length,items:items.slice((input.page-1)*15,input.page*15)};
 }catch(error){await db.query('ROLLBACK');throw error;}finally{db.release();}
}
