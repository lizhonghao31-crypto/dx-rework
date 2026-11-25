import type {PoolClient} from 'pg';
import type {CraftCheckQuantityScope} from '@dx-rework/contracts/factory-flow';
import {countedCraftCheck} from './quality-craft-problem-scope.js';

/** Append a cleared subset to the original QC row. Neither paperwork nor
 * finance completion is a substitute for actual original work execution. */
export async function internalCraftReinspection(db:PoolClient,scope:{reworkId:string;orderId:string;preparationId:string;returnFactId:string;stepRef:string;lineId:string;currentCheckId:string},
 input:CraftCheckQuantityScope|undefined,available:number,returned:number,lock=true){
 const {rows}=await db.query<{quantity:number;quantity_scope:unknown;allow_dispatch:boolean;dispatch_reason:string;problem:string;treatment:string}>(`
  SELECT r.rework_quantity::int AS quantity,q.quantity_scope,q.allow_dispatch,q.dispatch_reason,q.problem,q.treatment
  FROM rework_orders r JOIN digital_factory_qc q ON q.check_id=r.source_craft_qc_check_id
  JOIN digital_factory_routes route USING(preparation_id)
  JOIN digital_factory_facts f ON f.preparation_id=q.preparation_id AND f.fact_id=q.return_fact_id AND f.kind='工艺回仓'
  WHERE r.rework_order_id=$1 AND route.production_order_id=$2 AND route.preparation_id=$3 AND f.fact_id=$4
    AND f.payload->>'stepRef'=$5 AND q.line_id=$6 AND q.check_id=$7 AND q.result='需处理' AND r.craft_rework_execution='internal'
    AND r.status IN ('pending_order_review','pending_final_quantity_ie_review','pending_responsibility_determination',
      'pending_owner_signature','pending_responsibility_action','pending_quantity_adjustment_ie_review','completed')
    AND EXISTS(SELECT 1 FROM operation_events e WHERE e.entity_type='rework_order' AND e.entity_id=r.rework_order_id::text
       AND e.action IN ('rework.execution.complete','rework.work_report.submit','rework.tail_inspection.submit')
       AND e.after_state->>'status'='pending_order_review' AND (e.after_state->>'reworkQuantity')::numeric=r.rework_quantity)
  ${lock?'FOR UPDATE OF r':''}`,[scope.reworkId,scope.orderId,scope.preparationId,scope.returnFactId,scope.stepRef,scope.lineId,scope.currentCheckId]);
 const row=rows[0],original=row?countedCraftCheck(row.quantity_scope,returned):null;
 if(!row||!original||!input||row.quantity<=0||row.quantity>available||row.quantity>original.problemQuantity||
    input.inspectedQuantity!==row.quantity||input.qualifiedQuantity!==row.quantity||input.problemQuantity!==0||input.unit!=='片')return null;
 return {count:{...original,qualifiedQuantity:original.qualifiedQuantity+row.quantity,problemQuantity:original.problemQuantity-row.quantity},
  allowDispatch:row.allow_dispatch,dispatchReason:row.dispatch_reason,problem:row.problem,treatment:row.treatment};
}
