import type {PreparationMaterialFact,ProductionReadinessState,WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {businessNow} from '../acceptance-clock/business-time.js';
import {demandForWarehouseReceipt} from './warehouse-instruction-demand.js';
import {currentWarehouseReceiptQuantity,scopedWarehouseReceiptQuantity,warehouseMaterialBalance,warehouseReceiptTaskBasis,
 type WarehouseReceiptBasis,type WarehouseReceiptMovement} from './warehouse-material-balance.js';
export const warehouseReceiptScopePrefix='warehouse-receipt/';
export const warehouseReceiptScope=(materialId:string,lineId:string|null)=>warehouseReceiptScopePrefix+materialId+'/'+(lineId??'shared');
const receiptKey=(ref:WarehouseReceiptMovement['original'])=>JSON.stringify([ref.recordId,ref.version]);

export function warehouseReceiptMovements(history:readonly PreparationMaterialFact[],basis:WarehouseReceiptBasis):WarehouseReceiptMovement[]{
 const scope=warehouseReceiptScope(basis.materialId,basis.lineId);
 return history.filter(row=>row.kind===basis.kind&&row.scopeRef===scope&&row.resource.kind===basis.resource.kind&&row.resource.id===basis.resource.id)
  .sort((left,right)=>left.version-right.version).flatMap(fact=>{
   const evidence=fact.warehouseReceipt;
   if(!evidence||evidence.kind!==basis.kind||evidence.materialId!==basis.materialId||evidence.lineId!==basis.lineId||
    evidence.scopeRef!==basis.scopeRef||evidence.supplierId!==basis.supplierId||evidence.materialFingerprint!==basis.adoptedRef)return [];
   return [{basis:{...basis,unit:evidence.unit},original:{recordId:fact.recordId,version:fact.version},
    ...(evidence.replaces?{replaces:evidence.replaces}:{}),quantity:{unit:evidence.unit,quantity:evidence.quantity},
    occurredAt:fact.occurredAt,valid:fact.valid}];
  });
}

function receivedAtBasis(fact:PreparationMaterialFact){
 // The native preparation reader set valid using the captured material basis.
 // Old facts without that stored basis remain original history, not proven
 // contributions to a changed current material specification.
 return typeof (fact as PreparationMaterialFact&{materialBasis?:unknown}).materialBasis==='string';
}

export function deriveWarehouseReceiptWork(original:Pick<ProductionReadinessState,'history'|'facts'|'lines'>,asOf=businessNow().toISOString(),demand?:Parameters<typeof demandForWarehouseReceipt>[0]):WarehouseReceiptWorkItem[]{
 return original.facts.flatMap(investment=>{
  if(investment.kind!=='material_investment'||!investment.investmentScopeBasis)return [];
  const scope=investment.investmentScopeBasis;
  const matches=(fact:PreparationMaterialFact)=>fact.kind==='design_handover'&&fact.scopeRef===investment.scopeRef&&
   fact.resource.kind===investment.resource.kind&&fact.resource.id===investment.resource.id&&(fact.valid||fact.preorderApplicability)&&fact.state==='ready'&&
   fact.recordId===scope.handoverRecordId&&fact.version===scope.handoverVersion&&fact.investmentScopeBasis?.fingerprint===scope.fingerprint;
  const handover=original.facts.find(matches)??original.history.find(fact=>fact.preorderApplicability&&matches(fact));
  if(!handover)return [];
  return investment.quantities.flatMap(row=>{
   if(!row.materialId||row.lineId&&!original.lines.some(line=>line.lineId===row.lineId)||
    handover.preorderApplicability&&handover.preorderApplicability.originalFingerprints[row.materialId]!==scope.materialFingerprints[row.materialId])return [];
   const materials=handover.handoverMaterials?.filter(material=>material.materialId===row.materialId)??[];
   if(materials.length!==1||!materials[0]?.category)return [];
   const material=materials[0];
   const kind=material.category==='辅料'?'accessories_ready' as const:'fabric_receipt' as const;
   const basis={resource:investment.resource,kind,scopeRef:investment.scopeRef,materialId:row.materialId,lineId:row.lineId,
    adoptedRef:scope.materialFingerprints[row.materialId]??'',supplierId:material.supplierId??null,unit:row.unit};
   const purchase=warehouseReceiptTaskBasis(basis,investment);
   if(!purchase)return [];
   const receipt=original.facts.find((fact):fact is PreparationMaterialFact&{kind:typeof kind}=>fact.kind===kind&&fact.scopeRef===basis.scopeRef&&
    fact.resource.kind===basis.resource.kind&&fact.resource.id===basis.resource.id&&receivedAtBasis(fact));
   const raw=warehouseReceiptMovements(original.history,basis);
   const receiptScope=warehouseReceiptScope(basis.materialId,basis.lineId);
   const receiptVersion=original.history.reduce((version,row)=>row.warehouseReceipt&&row.kind===basis.kind&&
    row.scopeRef===receiptScope&&row.resource.kind===basis.resource.kind&&row.resource.id===basis.resource.id?Math.max(version,row.version):version,0);
   const typedBalance=raw.length?scopedWarehouseReceiptQuantity(basis,raw,asOf):null;
   const replaced=new Set(raw.flatMap(row=>row.replaces?[receiptKey(row.replaces)]:[]));
   const activeBatches=typedBalance?raw.flatMap(row=>row.occurredAt&&!replaced.has(receiptKey(row.original))?
    [{ref:row.original,quantity:row.quantity,occurredAt:row.occurredAt}]:[]):[];
   // A separate, explicitly recorded batch cannot be mixed with old numeric
   // snapshots whose physical lots cannot be matched to the batch.
   const received=raw.length?(receipt?null:typedBalance):
    currentWarehouseReceiptQuantity(receipt??null,basis);
   const productionRequired=demandForWarehouseReceipt(demand,basis,original.lines);
   const balance=warehouseMaterialBalance({unit:basis.unit,invested:purchase.invested,received,productionRequired,
    usableAfterOccupancy:null,dispatchRequired:null,dispatched:null});
   return [{kind,materialId:basis.materialId,name:material.name,scopeRef:basis.scopeRef,lineId:basis.lineId,
    supplier:material.supplier||null,basis,purchase,received,productionRequired,balance,receiptVersion,activeBatches}];
  });
 });
}
