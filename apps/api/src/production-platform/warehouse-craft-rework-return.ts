import type {BatchFact} from './factory-batch-ledger.js';

export type WarehouseCraftRepairScope={reworkId:string;originalReturnFactId:string;stepRef:string;lineId:string;factoryId:string;quantity:number};
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
