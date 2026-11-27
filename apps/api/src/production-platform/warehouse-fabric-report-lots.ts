import type {BulkFabricBatchRef,BulkPreparationSheet} from '@dx-rework/contracts/bulk-preparation';
import type {PreparationResource} from '@dx-rework/contracts/production-readiness';
import {currentPreparationMaterials,preparationContext,preparationHash,preparationMaterialHistory,type PreparationDB} from './preparation-material-repository.js';
import {deriveWarehouseReceiptWork,warehouseReceiptCommonView} from './warehouse-receipt-projection.js';
import {developmentDocumentRow} from './development-round-repository.js';
import {warehouseFabricInspectionEligibility} from './warehouse-fabric-inspection-eligibility.js';
import type {DevelopmentMaterial} from '@dx-rework/contracts/digital-development';
import {readWarehouseReceiptReconciliations,reconciliationResourceKey} from './warehouse-receipt-reconciliation-repository.js';
import {readWarehouseCutover,type WarehouseCutover,warehouseCutoverPaused,warehouseCutoverResources,warehouseCutoverScopesCurrent} from './warehouse-receipt-cutover-repository.js';

export async function readWarehouseFabricReceiptBasis(db:PreparationDB,resource:PreparationResource,asOf:string,preview=false,cutoverAsOf=asOf){
 const ctx=await preparationContext(db,resource),history=await preparationMaterialHistory(db,ctx);
 const lines=ctx.lines.map(line=>({lineId:String(line.line_id),orderQuantity:Number(line.order_quantity),color:String(line.color)}));
 const facts=currentPreparationMaterials(history,ctx.orderId);
 const subject=ctx.orderId?{kind:'order' as const,id:ctx.orderId}:resource;
 const cutover=await readWarehouseCutover(db,subject,ctx.sourceId);
 const resources=warehouseCutoverResources(subject,ctx.sourceId);
 const proof=preview||cutover?await readWarehouseReceiptReconciliations(db,resources):null;
 const bindings=proof?resources.flatMap(scope=>proof.get(reconciliationResourceKey(scope))??[]):undefined;
 const work=deriveWarehouseReceiptWork({history,facts,lines},cutover?cutoverAsOf:asOf,undefined,bindings).filter(item=>item.kind==='fabric_receipt');
 const scopesCurrent=!cutover||warehouseCutoverScopesCurrent(work,cutover);
 return {ctx,lines,facts,work,cutover,scopesCurrent};
}

const receiptId=(ref:BulkFabricBatchRef)=>JSON.stringify([ref.materialId,ref.lineId??null,ref.receipt.recordId,ref.receipt.version,ref.quantityRowKey??null]);

/** Procurement and adoption are independent. A cutover enables shared
 * receipt evidence, never preparation authority, quality or publication. */
export async function readWarehouseFabricInspection(db:PreparationDB,orderId:string,inspectionAt:string,asOf:string):Promise<{evidence:NonNullable<NonNullable<BulkPreparationSheet['fabric']>['warehouseInspection']>;scopes:Set<string>;cutover:WarehouseCutover|null}|null>{
 const cutoff=Date.parse(inspectionAt),now=Date.parse(asOf);
 const point=Number.isFinite(cutoff)&&Number.isFinite(now)?new Date(Math.min(cutoff,now)).toISOString():asOf;
 const {ctx,lines,facts,work,cutover,scopesCurrent}=await readWarehouseFabricReceiptBasis(db,{kind:'order',id:orderId},asOf,false,point);
 const handover=facts.find(fact=>fact.kind==='design_handover'&&fact.scopeRef==='whole');
 if(!cutover&&!ctx.source?.workbench_generated_number&&!handover?.investmentScopeBasis?.preorder)return null;
 const document=ctx.sourceId?await developmentDocumentRow(db,ctx.sourceId):null;
 const sourceMaterials=(document?.document.materials??[]) as DevelopmentMaterial[];
 const materials=cutover&&(!sourceMaterials.length||handover?.orderInstructionVersion!=null)
  ?(handover?.handoverMaterials??[]):sourceMaterials;
 const required=materials.flatMap(material=>material.materialId&&material.category!=='辅料'&&material.name.trim()?[{
  materialId:material.materialId,name:material.name,
  poLineIds:lines.filter(line=>!material.garmentColor||line.color===material.garmentColor).map(line=>line.lineId),
 }]:[]);
 const candidates=cutover?work.map(row=>({...warehouseReceiptCommonView(row,scopesCurrent),
  activeBatches:row.reconciliation?.activeBatches??[]})):work;
 const eligible=warehouseFabricInspectionEligibility(required,candidates,inspectionAt);
 const scoped=candidates.filter(item=>required.some(material=>material.materialId===item.materialId));
 const scopes=new Set(scoped.map(item=>JSON.stringify([item.materialId,item.lineId])));
 const lots=scoped.flatMap(item=>item.activeBatches.filter(batch=>Number(batch.quantity.quantity)>0&&Date.parse(batch.occurredAt)<=cutoff)
  .map(batch=>({materialId:item.materialId,lineId:item.lineId,receipt:batch.ref,
   ...('quantityRowKey' in batch&&typeof batch.quantityRowKey==='string'?{quantityRowKey:batch.quantityRowKey}:{}),
   name:item.name,quantity:batch.quantity,occurredAt:batch.occurredAt})));
 const first=lots.filter(lot=>scoped.some(item=>item.received&&item.materialId===lot.materialId&&item.lineId===lot.lineId))
  .sort((a,b)=>Date.parse(a.occurredAt)-Date.parse(b.occurredAt)||receiptId(a).localeCompare(receiptId(b)))[0];
 const paused=cutover&&(cutover.mode==='safe_read'||!scopesCurrent);
 const evidence=cutover?{...eligible,eligible:scopesCurrent&&eligible.eligible,
  reasons:!scopesCurrent?['原采购范围已变化，保持安全读取并核对原件',...eligible.reasons]:eligible.reasons,
  firstReceiptAt:scopesCurrent?first?.occurredAt??null:null,
  firstReceiptRef:scopesCurrent&&first?first.receipt:null,
  cutover:{generation:cutover.generation,mode:paused?'safe_read' as const:'active' as const},
  basisRevision:preparationHash({generation:cutover.generation,scope:work.map(row=>row.reconciliation?.basisRevision).sort()}),lots,
  ...(paused?{writePaused:warehouseCutoverPaused}:{})}:eligible;
 return {evidence,scopes,cutover};
}

export function warehouseFabricScopesCovered(required:ReadonlySet<string>,selected:readonly {materialId:string;lineId:string|null}[]){
 const actual=new Set(selected.map(row=>JSON.stringify([row.materialId,row.lineId])));
 return required.size>0&&actual.size===required.size&&[...required].every(key=>actual.has(key));
}

/** For the current report always recheck the exact original, applicable
 * versions. Historical physical timestamps alone do not redeem invalid lots. */
export async function warehouseFabricReportLots(db:PreparationDB,orderId:string,refs:readonly BulkFabricBatchRef[],inspectedAt:string,asOf:string){
 const cutoff=Date.parse(inspectedAt);
 if(!Number.isFinite(cutoff)||!refs.length||new Set(refs.map(receiptId)).size!==refs.length)return null;
 const {work,cutover,scopesCurrent}=await readWarehouseFabricReceiptBasis(db,{kind:'order',id:orderId},asOf);
 if(cutover&&!scopesCurrent)return null;
 const selected=[];
 for(const requested of refs){
  const candidates=work.filter(item=>item.materialId===requested.materialId&&
   (requested.lineId===undefined||item.lineId===requested.lineId)).flatMap(item=>
    (cutover?item.reconciliation?.activeBatches??[]:item.activeBatches).filter(batch=>
     batch.ref.recordId===requested.receipt.recordId&&batch.ref.version===requested.receipt.version&&
     ('quantityRowKey' in batch?batch.quantityRowKey:undefined)===requested.quantityRowKey&&Date.parse(batch.occurredAt)<=cutoff&&Number(batch.quantity.quantity)>0)
    .map(batch=>({...batch,lineId:item.lineId})));
  if(candidates.length!==1)return null;
  selected.push({materialId:requested.materialId,lineId:candidates[0]!.lineId,receipt:candidates[0]!.ref,actualAt:candidates[0]!.occurredAt});
 }
 return selected;
}
