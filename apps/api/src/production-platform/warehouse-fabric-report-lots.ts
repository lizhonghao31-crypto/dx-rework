import type {BulkFabricBatchRef} from '@dx-rework/contracts/bulk-preparation';
import {currentPreparationMaterials,preparationContext,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {deriveWarehouseReceiptWork} from './warehouse-receipt-projection.js';

/** Coverage is exact and remains current only while the same physical lot
 * versions are active. This does not provide a whole-order arrival, pass
 * inspection, or authorize writing the original report or decision. */
export async function warehouseFabricReportLots(db:PreparationDB,orderId:string,refs:readonly BulkFabricBatchRef[],inspectedAt:string,asOf:string){
 const cutoff=Date.parse(inspectedAt);
 if(!Number.isFinite(cutoff)||!refs.length||new Set(refs.map(ref=>JSON.stringify(ref.receipt))).size!==refs.length)return null;
 const ctx=await preparationContext(db,{kind:'order',id:orderId}),history=await preparationMaterialHistory(db,ctx);
 const lines=ctx.lines.map(line=>({lineId:String(line.line_id),orderQuantity:Number(line.order_quantity),color:String(line.color)}));
 const work=deriveWarehouseReceiptWork({history,facts:currentPreparationMaterials(history,orderId),lines},asOf).filter(item=>item.kind==='fabric_receipt');
 const selected=[];
 for(const requested of refs){
  const candidates=work.filter(item=>item.materialId===requested.materialId).flatMap(item=>item.activeBatches.filter(batch=>
   batch.ref.recordId===requested.receipt.recordId&&batch.ref.version===requested.receipt.version&&Date.parse(batch.occurredAt)<=cutoff&&Number(batch.quantity.quantity)>0));
  if(candidates.length!==1)return null;
  selected.push({materialId:requested.materialId,receipt:candidates[0]!.ref,actualAt:candidates[0]!.occurredAt});
 }
 return selected;
}
