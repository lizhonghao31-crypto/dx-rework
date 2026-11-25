import type {BatchFact} from './factory-batch-ledger.js';
import type {Pool,PoolClient} from 'pg';

export type WarehouseCraftRepairScope={reworkId:string;originalReturnFactId:string;stepRef:string;lineId:string;factoryId:string;quantity:number};
export type WarehouseCraftRepairLocator=WarehouseCraftRepairScope&{orderId:string;preparationId:string;checkId:string;status:string};
const allocated=(payload:Record<string,unknown>,lineId:string)=>{
 const lines=payload.lines;
 if(!Array.isArray(lines)||lines.length!==1||lines[0]?.lineId!==lineId||!Number.isSafeInteger(lines[0]?.quantity)||lines[0].quantity<1)return null;
 return lines[0].quantity as number;
};

/** A physical return closes only the external work step, never QC, payment
 * or the rework case. Facts remain on the original factory movement ledger. */
export function externalCraftRepairProgress(scope:WarehouseCraftRepairScope,facts:readonly BatchFact[]){
 if(!Number.isSafeInteger(scope.quantity)||scope.quantity<1)return null;
 const sends=new Map<string,{at:number;quantity:number;returned:number}>(),ids=new Set<string>();
 let sent=0,returned=0,latestReturn:number|null=null;
 for(const item of facts){
  const payload=item.payload,motion=payload.warehouseMotion as {reworkId?:string;factoryId?:string}|null|undefined;
  if(motion?.reworkId!==scope.reworkId)continue;
  if(ids.has(item.fact_id)||payload.stepRef!==scope.stepRef||motion.factoryId!==scope.factoryId||item.occurred_at===null)return null;
  ids.add(item.fact_id);
  const at=new Date(item.occurred_at).getTime(),quantity=allocated(payload,scope.lineId);
  if(!Number.isFinite(at)||quantity===null)return null;
  if(item.kind==='工艺发出'){
   if(payload.fromReturnId!==scope.originalReturnFactId||sent+quantity>scope.quantity)return null;
   sends.set(item.fact_id,{at,quantity,returned:0});
   sent+=quantity;
  }else if(item.kind==='工艺回仓'){
   const source=typeof payload.sendFactId==='string'?sends.get(payload.sendFactId):undefined;
   if(!source||at<source.at||source.returned+quantity>source.quantity)return null;
   source.returned+=quantity;returned+=quantity;
   latestReturn=latestReturn===null?at:Math.max(latestReturn,at);
  }else return null;
 }
 return {sent,returned,remainingToSend:scope.quantity-sent,remainingToReturn:sent-returned,
  physicalCompletedAt:returned===scope.quantity&&latestReturn!==null?new Date(latestReturn).toISOString():null};
}

/** Apply inside the caller's original order/warehouse transaction after role
 * checks. The rework order is locked after the native order lifecycle lock. */
export async function lockExternalCraftRepair(db:PoolClient,orderId:string,reworkId:string):Promise<WarehouseCraftRepairLocator|null>{
 return readExternalCraftRepairLocator(db,reworkId,orderId,true);
}

async function readExternalCraftRepairLocator(db:Pick<Pool,'query'>,reworkId:string,orderId:string|null,locked:boolean){
 const {rows}=await db.query<WarehouseCraftRepairLocator>(`SELECT r.rework_order_id AS "reworkId",r.status,r.rework_quantity::int AS quantity,
  q.check_id AS "checkId",q.preparation_id AS "preparationId",q.return_fact_id AS "originalReturnFactId",q.line_id AS "lineId",
  route.production_order_id AS "orderId",f.payload->>'stepRef' AS "stepRef",f.payload#>>'{warehouseMotion,factoryId}' AS "factoryId"
  FROM rework_orders r JOIN digital_factory_qc q ON q.check_id=r.source_craft_qc_check_id
  JOIN digital_factory_routes route USING(preparation_id)
  JOIN digital_factory_facts f ON f.preparation_id=q.preparation_id AND f.fact_id=q.return_fact_id AND f.kind='工艺回仓'
  WHERE r.rework_order_id=$1 AND ($2::uuid IS NULL OR route.production_order_id=$2)
    AND r.craft_rework_execution='factory' AND r.status<>'deleted' AND q.result='需处理'
    AND r.processing_factory_supplier_id::text=f.payload#>>'{warehouseMotion,factoryId}'
    AND q.quantity_scope->>'unit'='片' AND r.rework_quantity<=(q.quantity_scope->>'problemQuantity')::numeric
  ${locked?'FOR UPDATE OF r':''}`,[reworkId,orderId]);
 return rows.length===1?rows[0]!:null;
}

/** Caller enforces the original rework permission. For mutations, acquire the
 * rework lock before reading; warehouse writes also serialize on that row. */
export async function readExternalCraftRepairProof(db:Pick<Pool,'query'>,reworkId:string){
 const locator=await readExternalCraftRepairLocator(db,reworkId,null,false);
 if(!locator)return null;
 const {rows}=await db.query<BatchFact>(`SELECT fact_id,kind,occurred_at,payload FROM digital_factory_facts
   WHERE preparation_id=$1 AND payload#>>'{warehouseMotion,reworkId}'=$2 ORDER BY sequence`,[locator.preparationId,reworkId]);
 if(rows.some(fact=>(fact.payload.warehouseMotion as {checkId?:string}|null|undefined)?.checkId!==locator.checkId))return null;
 const progress=externalCraftRepairProgress(locator,rows);
 return progress?{requiredQuantity:locator.quantity,returnedQuantity:progress.returned,
  physicalCompletedAt:progress.physicalCompletedAt,
  returnFactIds:rows.filter(fact=>fact.kind==='工艺回仓').map(fact=>fact.fact_id)}:null;
}

/** Verify the original named send or return and use the exact same fold for
 * preflight and stored facts. The result is not authorization in itself. */
export function checkedExternalCraftRepairFact(scope:WarehouseCraftRepairLocator,facts:readonly BatchFact[],candidate:BatchFact){
 if(candidate.kind==='工艺发出'&&scope.status!=='in_progress'||
  candidate.kind==='工艺回仓'&&!['in_progress','cancelled'].includes(scope.status))return null;
 if((candidate.payload.warehouseMotion as {reworkId?:string}|undefined)?.reworkId!==scope.reworkId)return null;
 return externalCraftRepairProgress(scope,[...facts,candidate]);
}
