import type {BulkFabricBatchRef} from '@dx-rework/contracts/bulk-preparation';
import {currentPreparationMaterials,preparationContext,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {deriveWarehouseReceiptWork} from './warehouse-receipt-projection.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {warehouseFabricInspectionEligibility} from './warehouse-fabric-inspection-eligibility.js';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';

async function fabricScope(db:PreparationDB,orderId:string,asOf:string){
 const ctx=await preparationContext(db,{kind:'order',id:orderId}),history=await preparationMaterialHistory(db,ctx);
 const lines=ctx.lines.map(line=>({lineId:String(line.line_id),orderQuantity:Number(line.order_quantity),color:String(line.color)}));
 const facts=currentPreparationMaterials(history,orderId);
 const work=deriveWarehouseReceiptWork({history,facts,lines},asOf).filter(item=>item.kind==='fabric_receipt');
 return {ctx,lines,facts,work};
}

/** The numbered flow and the adopted scoped purchase flow must use native
 * quantities even before a formal instruction or preparation task exists. */
export async function readWarehouseFabricInspection(db:PreparationDB,orderId:string,inspectionAt:string,asOf:string){
 const {ctx,lines,facts,work}=await fabricScope(db,orderId,asOf);
 const handover=facts.find(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole');
 if(!ctx.source?.workbench_generated_number&&!handover?.investmentScopeBasis?.preorder)return null;
 const document=ctx.sourceId?await developmentDocumentRow(db,ctx.sourceId):null;
 const sourceMaterials=(document?.document.materials??[]) as DevelopmentMaterial[];
 const required=sourceMaterials.filter(material=>material.category!=='辅料'&&material.name.trim()).map(material=>({
  materialId:material.materialId,name:material.name,
  poLineIds:lines.filter(line=>!material.garmentColor||line.color===material.garmentColor).map(line=>line.lineId),
 }));
 const evidence=warehouseFabricInspectionEligibility(required,work,inspectionAt);
 const scopes=new Set(work.filter(item=>required.some(material=>material.materialId===item.materialId)).map(item=>JSON.stringify([item.materialId,item.lineId])));
 return {evidence,scopes};
}

export function warehouseFabricScopesCovered(required:ReadonlySet<string>,selected:readonly {materialId:string;lineId:string|null}[]){
 const actual=new Set(selected.map(row=>JSON.stringify([row.materialId,row.lineId])));
 return required.size>0&&actual.size===required.size&&[...required].every(key=>actual.has(key));
}

/** Coverage is exact and remains current only while the same physical lot
 * versions are active. This does not provide a whole-order arrival, pass
 * inspection, or authorize writing the original report or decision. */
export async function warehouseFabricReportLots(db:PreparationDB,orderId:string,refs:readonly BulkFabricBatchRef[],inspectedAt:string,asOf:string){
 const cutoff=Date.parse(inspectedAt);
 if(!Number.isFinite(cutoff)||!refs.length||new Set(refs.map(ref=>JSON.stringify(ref.receipt))).size!==refs.length)return null;
 const {work}=await fabricScope(db,orderId,asOf);
 const selected=[];
 for(const requested of refs){
  const candidates=work.filter(item=>item.materialId===requested.materialId).flatMap(item=>item.activeBatches.filter(batch=>
   batch.ref.recordId===requested.receipt.recordId&&batch.ref.version===requested.receipt.version&&Date.parse(batch.occurredAt)<=cutoff&&Number(batch.quantity.quantity)>0)
   .map(batch=>({...batch,lineId:item.lineId})));
  if(candidates.length!==1)return null;
  selected.push({materialId:requested.materialId,lineId:candidates[0]!.lineId,receipt:candidates[0]!.ref,actualAt:candidates[0]!.occurredAt});
 }
 return selected;
}
