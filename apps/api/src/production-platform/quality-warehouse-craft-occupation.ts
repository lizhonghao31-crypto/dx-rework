import {activeCountedCraftChecks,factoryBatchLedger,factoryBatchReleaseAvailable,scopes,type BatchCheck,type BatchFact} from './factory-batch-ledger.js';
import {fixedCraftSteps} from './fixed-craft-steps.js';
import type {WarehouseCraftOccupationReader} from './warehouse-craft-movement.js';

/** Authoritative X5 disposition for an exact X3 write. The caller owns the
 * existing order lock; reading this projection provides no write authority. */
export const readQualityWarehouseCraftOccupation:WarehouseCraftOccupationReader=async(db,scope)=>{
 const route=(await db.query(`SELECT 1 FROM digital_factory_routes
  WHERE preparation_id=$1 AND production_order_id=$2 AND route_schema_version=2`,[scope.preparationId,scope.orderId])).rowCount;
 if(!route)return null;
 const steps=await fixedCraftSteps(db,scope.preparationId),position=steps.findIndex(step=>step.stepId===scope.stepRef);
 if(position<0)return null;
 if(!scope.sourceFactId)return position===0?{...scope,lines:[]}:null;
 const {rows:facts}=await db.query<BatchFact>(`SELECT fact_id,kind,payload,occurred_at FROM digital_factory_facts
  WHERE preparation_id=$1 AND kind IN ('工艺发出','工艺回仓','仓库实际发厂') ORDER BY sequence`,[scope.preparationId]);
 const source=facts.find(fact=>fact.fact_id===scope.sourceFactId),scopeStep=source?.payload.stepRef;
 if(source?.kind==='工艺发出')return scopeStep===scope.stepRef?{...scope,lines:[]}:null;
 if(source?.kind!=='工艺回仓'||typeof scopeStep!=='string'||(scopeStep!==scope.stepRef&&scopeStep!==steps[position-1]?.stepId))return null;
 const original=scopes(source.payload.lines);
 if(!original.length||new Set(original.map(line=>line.lineId)).size!==original.length)return null;
 const {rows:checks}=await db.query<BatchCheck>(`SELECT check_id,return_fact_id,line_id,result,allow_dispatch,dispatch_reason,checked_at,quantity_scope,supersedes_check_id
  FROM digital_factory_qc WHERE preparation_id=$1 AND return_fact_id=$2 ORDER BY sequence`,[scope.preparationId,source.fact_id]);
 const rows=factoryBatchLedger(original,facts,checks,false).batches.find(batch=>batch.factId===source.fact_id)?.rows;
 if(!rows)return null;
 // A valid exceptional release does not transfer ownership of pieces
 // already reserved for an original rework. The physical ledger has already
 // deducted actual repair issues; hold only the balance still here.
 const {rows:holds}=await db.query<{rework_id:string;check_id:string;line_id:string;quantity:number}>(`SELECT r.rework_order_id AS rework_id,
  q.check_id,q.line_id,r.rework_quantity::int AS quantity FROM rework_orders r JOIN digital_factory_qc q ON q.check_id=r.source_craft_qc_check_id
  WHERE q.preparation_id=$1 AND q.return_fact_id=$2 AND r.status NOT IN ('cancelled','deleted')`,[scope.preparationId,source.fact_id]);
 const lines=rows.flatMap(row=>{
  const active=activeCountedCraftChecks(checks.filter(item=>item.line_id===row.lineId));
  // Whole-batch historical releases stay under their original restrictions.
  if(!active.length)return [];
  const reserved=holds.filter(hold=>hold.line_id===row.lineId&&active.some(check=>check.allow_dispatch&&hold.check_id===check.check_id)).reduce((sum,hold)=>{
   const moved=facts.filter(fact=>fact.kind==='工艺发出'&&fact.payload.fromReturnId===source.fact_id&&
    (fact.payload.warehouseMotion as {reworkId?:string}|undefined)?.reworkId===hold.rework_id)
    .reduce((count,fact)=>count+(scopes(fact.payload.lines).find(line=>line.lineId===row.lineId)?.quantity??0),0);
   return sum+Math.max(0,hold.quantity-moved);
  },0);
  const releasable=Math.max(0,factoryBatchReleaseAvailable(row)-reserved);
  return releasable<row.available?[{lineId:row.lineId,quantity:row.available-releasable}]:[];
 });
 return {...scope,lines};
};
