import type {PoolClient} from 'pg';
import {ApplicationError} from '../platform/errors.js';
import {pendingReceivingForAuthorizedOrders} from './pending-receiving-original-allocation.js';
import {assertWholeOrderActive} from '../production-platform/whole-order-visibility.js';

type NativeInput={cuttingOrderId?:string;productionOrderId?:string;factoryDecisionId?:string|null;styleNo:string;receivedAt:string};
type Association={orderId:string;productionOrderId:string;factoryDecisionId:string|null;lineId:string};

const conflict=(message:string):never=>{throw new ApplicationError('CONFLICT',message,409);};

/** Classify from existing native relationships before creating a receipt. A
 * style match can force re-selection but can never grant an order association. */
export async function admitNativeReceipt(db:PoolClient,input:NativeInput):Promise<Association|null>{
 if(!(await db.query("SELECT to_regclass('digital_production_child_links') AS relation")).rows[0]?.relation)return null;
 const roots=(await db.query<{id:string;managed:boolean;cut_link:boolean}>(`WITH candidate AS (
  SELECT l.production_order_id,l.module='cutting' AND l.child_id=$1 AS cut_link
   FROM digital_production_child_links l
   WHERE (l.module='cutting' AND l.child_id=$1) OR (l.module='sourcing' AND EXISTS(
    SELECT 1 FROM cutting_orders cutting WHERE cutting.cutting_order_id=$1 AND cutting.sourcing_case_id=l.child_id))
   OR (l.module='production' AND l.child_id=$2)
  UNION ALL
   SELECT l.production_order_id,false FROM sourcing_style_aliases a
    JOIN digital_production_child_links l ON l.module='sourcing' AND l.child_id=a.sourcing_case_id
    WHERE $1::uuid IS NULL AND upper(btrim(a.style_no))=upper(btrim($3))
  UNION ALL
   SELECT p.production_order_id,false FROM digital_production_po_lines p
    WHERE $1::uuid IS NULL AND (upper(btrim(p.formal_style_no))=upper(btrim($3)) OR
       upper(btrim(to_jsonb(p)->>'po_number'))=upper(btrim($3)))
 ), candidates AS (SELECT production_order_id,bool_or(cut_link) AS cut_link FROM candidate GROUP BY production_order_id)
 SELECT o.production_order_id AS id,candidates.cut_link,
   (COALESCE((to_jsonb(o)->>'order_time_managed')::boolean,false) OR
    NULLIF(to_jsonb(s)->>'workbench_generated_number','') IS NOT NULL OR EXISTS(
      SELECT 1 FROM digital_factory_routes route JOIN digital_factory_facts f USING(preparation_id)
      WHERE route.production_order_id=o.production_order_id AND f.kind='仓库实际发厂' AND f.payload ? 'dispatchEvidence') OR EXISTS(
      SELECT 1 FROM digital_factory_routes route WHERE route.production_order_id=o.production_order_id
       AND (to_jsonb(route)->>'workflow_version')::int>=2)) AS managed
   FROM candidates JOIN digital_production_orders o USING(production_order_id)
   LEFT JOIN digital_production_sources s ON s.source_id=o.source_id`,
  [input.cuttingOrderId??null,input.productionOrderId??null,input.styleNo])).rows;
 const eligible=roots.filter(row=>row.managed);
 if(!eligible.length){
  if(!roots.length&&input.cuttingOrderId&&(await db.query(`SELECT 1 FROM cutting_orders c JOIN sourcing_cases s USING(sourcing_case_id)
   WHERE c.cutting_order_id=$1 AND s.workflow_generation='digital_production_v1'`,[input.cuttingOrderId])).rowCount)
   return conflict('该原裁单属于数字生产，但母单关联待核，不能按旧单收货');
  return null;
 }
 const root=eligible[0];
 if(roots.length!==1||eligible.length!==1||!root?.cut_link||!input.cuttingOrderId)
  return conflict('当前数字单需要准确母单、款色及原裁单，请从原待收货选择，不按款号推断');
 await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`cutting:${input.cuttingOrderId}`]);
 await db.query('SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE',[root.id]);
 await assertWholeOrderActive(db,'order',root.id);
 const actual=Date.parse(input.receivedAt);
 const matches=(await pendingReceivingForAuthorizedOrders(db,[root.id])).filter(row=>
  row.identity.cuttingOrderId===input.cuttingOrderId&&(!input.productionOrderId||row.identity.productionId===input.productionOrderId)&&
  (input.factoryDecisionId===undefined||row.factoryDecisionId===input.factoryDecisionId)&&row.factoryShipmentRecorded&&
  row.balance.status!=='unresolved'&&row.balance.remaining!==null&&row.balance.remaining>0&&
  row.balance.dispatches.some(dispatch=>dispatch.dispatchedQuantity>0&&Date.parse(dispatch.actualDispatchedAt)<=actual));
 if(matches.length!==1)return conflict('该裁单尚无唯一有效的仓库发厂、工厂发回或当前收货余量，请返回原待收货核对');
 const selected=matches[0]!;
 return {orderId:root.id,productionOrderId:selected.identity.productionId,factoryDecisionId:selected.factoryDecisionId,lineId:selected.identity.lineId};
}
