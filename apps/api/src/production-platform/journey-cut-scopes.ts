import type {PoolClient} from 'pg';

export type JourneyCutScope={
 lineId:string;status:'missing'|'verified'|'unresolved';
 cuts:Array<{cuttingOrderId:string;sourcingCaseId:string|null;sourcingLinePosition:number|null;approvalSnapshotId:string|null;sourceLineId:string|null}>;
};

/** Stable native identities only. Multiple cuts do not establish disjoint
 * allocation: retain the references, but never sum them or match style/PO text.
 */
export async function journeyCutScopes(db:Pick<PoolClient,'query'>,orderId:string):Promise<JourneyCutScope[]>{
 const rows=(await db.query(`SELECT po.line_id,map.child_id,cut.sourcing_case_id,cut.sourcing_line_position,
   cut.approval_snapshot_id,source.line_id AS source_line_id
  FROM digital_production_po_lines po
  LEFT JOIN digital_production_child_lines map ON map.module='cutting' AND map.production_order_id=po.production_order_id AND map.line_id=po.line_id
  LEFT JOIN cutting_orders cut ON cut.cutting_order_id=map.child_id AND map.child_line_key='record'
  LEFT JOIN digital_production_child_lines source ON source.module='sourcing' AND source.production_order_id=po.production_order_id
   AND source.child_id=cut.sourcing_case_id AND source.child_line_key=cut.sourcing_line_position::text
  WHERE po.production_order_id=$1 ORDER BY po.position,map.child_id,map.child_line_key`,[orderId])).rows;
 const scopes=new Map<string,JourneyCutScope>();
 for(const row of rows){
  let scope=scopes.get(row.line_id);
  if(!scope){scope={lineId:row.line_id,status:'missing',cuts:[]};scopes.set(row.line_id,scope);}
  if(row.child_id)scope.cuts.push({cuttingOrderId:row.child_id,sourcingCaseId:row.sourcing_case_id??null,
   sourcingLinePosition:row.sourcing_line_position??null,approvalSnapshotId:row.approval_snapshot_id??null,sourceLineId:row.source_line_id??null});
 }
 for(const scope of scopes.values())scope.status=!scope.cuts.length?'missing':scope.cuts.length===1&&scope.cuts[0]!.sourceLineId===scope.lineId?'verified':'unresolved';
 return [...scopes.values()];
}
