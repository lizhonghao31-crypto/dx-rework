import type {PoolClient} from 'pg';

export type JourneyCutScope={
 lineId:string;status:'missing'|'verified'|'unresolved';
 cuts:Array<{cuttingOrderId:string;sourcingCaseId:string|null;sourcingLinePosition:number|null;approvalSnapshotId:string|null;sourceLineId:string|null}>;
};

/** Stable native identities only. Multiple cuts do not establish disjoint
 * allocation: retain the references, but never sum them or match style/PO text.
 */
export const NATIVE_CUT_SCOPE_ROWS_SQL=`SELECT po.line_id,map.child_id,cut.sourcing_case_id,cut.sourcing_line_position,
   cut.approval_snapshot_id,source.line_id AS source_line_id
  FROM digital_production_po_lines po
  LEFT JOIN digital_production_child_lines map ON map.module='cutting' AND map.production_order_id=po.production_order_id AND map.line_id=po.line_id
  LEFT JOIN cutting_orders cut ON cut.cutting_order_id=map.child_id AND map.child_line_key='record'
  LEFT JOIN digital_production_child_lines source ON source.module='sourcing' AND source.production_order_id=po.production_order_id
   AND source.child_id=cut.sourcing_case_id AND source.child_line_key=cut.sourcing_line_position::text`;
export async function journeyCutScopes(db:Pick<PoolClient,'query'>,orderId:string):Promise<JourneyCutScope[]>{
 const rows=(await db.query(`${NATIVE_CUT_SCOPE_ROWS_SQL} WHERE po.production_order_id=$1 ORDER BY po.position,map.child_id,map.child_line_key`,[orderId])).rows;
 return cutScopesFromRows(rows);
}
/** Same native identity predicate, batched only after caller authorization. */
export async function journeyCutScopesForOrders(db:Pick<PoolClient,'query'>,orderIds:string[],lineIds?:readonly string[]):Promise<JourneyCutScope[]>{
 if(!orderIds.length)return [];
 const rows=(await db.query(`${NATIVE_CUT_SCOPE_ROWS_SQL} WHERE po.production_order_id=ANY($1::uuid[])${lineIds?' AND po.line_id=ANY($2::uuid[])':''} ORDER BY po.production_order_id,po.position,map.child_id,map.child_line_key`,lineIds?[orderIds,lineIds]:[orderIds])).rows;
 return cutScopesFromRows(rows);
}
type ScopeRow={line_id:string;child_id:string|null;sourcing_case_id:string|null;sourcing_line_position:number|null;approval_snapshot_id:string|null;source_line_id:string|null};
function cutScopesFromRows(rows:ScopeRow[]):JourneyCutScope[]{
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

/** A native creation with complete original PO identity and no production
 * child chain or legacy alias candidate proves no packing yet. Missing links
 * in an existing chain and unconfirmed historical names never prove zero.
 * Callers supply their already-authorized p/o aliases in the same snapshot. */
export const NATIVE_EMPTY_PACKING_SCOPE_SQL=`p.po_number IS NOT NULL AND btrim(p.po_number)<>''
 AND NOT EXISTS(SELECT 1 FROM digital_production_child_links child WHERE child.production_order_id=o.production_order_id AND child.module IN ('sourcing','cutting','receiving','production'))
 AND EXISTS(SELECT 1 FROM audit_events creation WHERE creation.entity_type='digital_production' AND creation.entity_id=o.production_order_id::text
  AND creation.action='digital_order_created' AND coalesce(creation.after_state->'lines'->(p.position-1)->>'formalPoNo',creation.after_state->'lines'->(p.position-1)->>'formalStyleNo',creation.after_state->'lines'->(p.position-1)->>'poNumber') IS NOT NULL
  AND NOT EXISTS(SELECT 1 FROM receiving_batches legacy WHERE legacy.cutting_order_id IS NULL
   AND (legacy.deleted_at IS NULL OR EXISTS(SELECT 1 FROM receiving_packing_revisions revision WHERE revision.receiving_batch_id=legacy.receiving_batch_id))
   AND upper(btrim(legacy.style_no))=ANY(ARRAY[upper(btrim(p.po_number)),upper(btrim(p.formal_style_no)),upper(btrim(p.temporary_style_no)),upper(btrim(o.design_style_no)),upper(btrim(o.temporary_style_no)),
    upper(btrim(creation.after_state->'lines'->(p.position-1)->>'formalPoNo')),upper(btrim(creation.after_state->'lines'->(p.position-1)->>'formalStyleNo')),upper(btrim(creation.after_state->'lines'->(p.position-1)->>'poNumber')),upper(btrim(creation.after_state->'lines'->(p.position-1)->>'temporaryStyleNo'))])))`;
