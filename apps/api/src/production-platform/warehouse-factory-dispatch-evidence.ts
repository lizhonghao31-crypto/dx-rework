import type {PoolClient} from 'pg';
import type {FactoryScope} from './factory-batch-ledger.js';

type CutScope=FactoryScope&{cuttingOrderId:string};
type CutRow={lineId:string;cuttingOrderId:string|null;actual:number|null};
export type WarehouseFactoryDispatchEvidence={
 sourcingCaseId:string;sourcingDecisionId:string;approvalSnapshotId:string;contractDocumentId:string;cuts:CutScope[];
};

/** Capture only certified original line-to-cut links. Do not reconstruct a
 * missing or ambiguous legacy link from style, factory name or PO text. */
export async function warehouseFactoryDispatchEvidence(db:Pick<PoolClient,'query'>,orderId:string,
 approval:Omit<WarehouseFactoryDispatchEvidence,'cuts'>,requested?:readonly FactoryScope[]):Promise<WarehouseFactoryDispatchEvidence|null>{
 const rows=(await db.query<CutRow>(`SELECT po.line_id AS "lineId",cut.cutting_order_id AS "cuttingOrderId",actual.actual_cut_count::int AS actual
  FROM digital_production_po_lines po
  LEFT JOIN digital_production_child_lines link ON link.module='cutting' AND link.production_order_id=po.production_order_id AND link.line_id=po.line_id
  LEFT JOIN cutting_orders cut ON cut.cutting_order_id=link.child_id AND cut.sourcing_case_id=$2
  LEFT JOIN current_cutting_records actual ON actual.cutting_order_id=cut.cutting_order_id
  WHERE po.production_order_id=$1 ORDER BY po.position,cut.cutting_order_id`,[orderId,approval.sourcingCaseId])).rows;
 const scope=requested??rows.map(row=>({lineId:row.lineId,quantity:row.actual??0}));
 if(!scope.length||new Set(scope.map(row=>row.lineId)).size!==scope.length)return null;
 const cuts:CutScope[]=[];
 for(const item of scope){
  const linked=rows.filter(row=>row.lineId===item.lineId);
  if(linked.length!==1||!linked[0]?.cuttingOrderId||linked[0].actual===null||
     !Number.isSafeInteger(item.quantity)||item.quantity<=0||item.quantity>linked[0].actual)return null;
  cuts.push({...item,cuttingOrderId:linked[0].cuttingOrderId});
 }
 if(new Set(cuts.map(row=>row.cuttingOrderId)).size!==cuts.length)return null;
 return {...approval,cuts};
}

type DispatchScopeRow=CutScope&{orderId:string;factId:string;productionId:string;factoryDecisionId:string|null;dispatchedAt:Date};
/** For already-authorized masters, resolve an actual dispatch through its
 * captured decision and execution, not a later approval or replacement factory.
 * The original execution has a real production ID and a native null change ID. */
export async function readWarehouseFactoryDispatchScopesForOrders(db:Pick<PoolClient,'query'>,orderIds:readonly string[]){
 if(!orderIds.length)return [];
 const rows=(await db.query<DispatchScopeRow>(`SELECT route.production_order_id AS "orderId",f.fact_id AS "factId",f.occurred_at AS "dispatchedAt",
  execution.production_order_id AS "productionId",execution.factory_decision_id AS "factoryDecisionId",
  cut.cutting_order_id AS "cuttingOrderId",po.line_id AS "lineId",(lot->>'quantity')::int AS quantity
  FROM digital_factory_routes route JOIN digital_factory_facts f USING(preparation_id)
  JOIN digital_production_child_links link ON link.production_order_id=route.production_order_id AND link.module='production'
  JOIN sourcing_approval_snapshots sent_approval ON sent_approval.sourcing_approval_snapshot_id::text=f.payload#>>'{dispatchEvidence,approvalSnapshotId}'
   AND sent_approval.sourcing_case_id::text=f.payload#>>'{dispatchEvidence,sourcingCaseId}'
   AND sent_approval.sourcing_decision_id::text=f.payload#>>'{dispatchEvidence,sourcingDecisionId}'
   AND sent_approval.supplier_id::text=f.payload->>'supplierId'
  JOIN sourcing_production_factory_orders execution ON execution.production_order_id=link.child_id
   AND execution.sourcing_case_id=sent_approval.sourcing_case_id AND execution.supplier_id=sent_approval.supplier_id
   AND execution.sourcing_decision_id=sourcing_factory_execution_basis(sent_approval.sourcing_case_id,sent_approval.sourcing_decision_id)
  CROSS JOIN LATERAL jsonb_array_elements(f.payload#>'{dispatchEvidence,cuts}') lot
  JOIN digital_production_po_lines po ON po.production_order_id=route.production_order_id AND po.line_id::text=lot->>'lineId'
  JOIN cutting_orders cut ON cut.sourcing_case_id=execution.sourcing_case_id AND cut.cutting_order_id::text=lot->>'cuttingOrderId'
  JOIN digital_production_child_lines allocation ON allocation.module='production' AND allocation.child_id=execution.production_order_id
   AND allocation.production_order_id=route.production_order_id AND allocation.line_id=po.line_id AND allocation.child_line_key=cut.sourcing_line_position::text
  WHERE route.production_order_id=ANY($1::uuid[]) AND f.kind='仓库实际发厂' AND f.occurred_at IS NOT NULL
  ORDER BY route.production_order_id,f.sequence,po.position`,[[...new Set(orderIds)]])).rows;
 return rows.map(row=>({...row,dispatchedAt:row.dispatchedAt.toISOString()}));
}

export async function readWarehouseFactoryDispatchScopes(db:Pick<PoolClient,'query'>,orderId:string){
 return readWarehouseFactoryDispatchScopesForOrders(db,[orderId]);
}
