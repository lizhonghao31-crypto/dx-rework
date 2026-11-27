import type {WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {warehouseFabricInspectionThreshold,warehouseReceiptBatches} from './warehouse-material-balance.js';

type Material={materialId:string;name:string;poLineIds:readonly string[]};
type Scope=Pick<WarehouseReceiptWorkItem,'materialId'|'lineId'|'name'|'purchase'|'activeBatches'|'balance'|'received'>;

/** The quantity threshold is calculated separately for every required material
 * and applicable procurement range. It neither determines quality nor picks
 * the lot that was inspected. Absent or mixed native evidence stays unknown. */
export function warehouseFabricInspectionEligibility(required:readonly Material[],scopes:readonly Scope[],asOf:string){
 const cutoff=Date.parse(asOf),reasons:string[]=[];
 if(!Number.isFinite(cutoff)||!required.length)return {eligible:false,reasons:['尚无可核的主料及采购应收依据'],firstReceiptAt:null};
 let firstReceiptAt:string|null=null;
 for(const material of required){
  const rows=scopes.filter(row=>row.materialId===material.materialId),seen=new Set(rows.map(row=>row.lineId));
  const covered=seen.has(null)?seen.size===1:material.poLineIds.length>0&&seen.size===material.poLineIds.length&&material.poLineIds.every(id=>seen.has(id));
  if(!rows.length||seen.size!==rows.length||!covered){
   reasons.push(`${material.name}：采购应收或共享/PO范围尚无唯一有效依据`);continue;
  }
  for(const scope of rows){
   const {unit}=scope.purchase.invested;
   if(!scope.received){reasons.push(`${scope.name}：尚无可核的同范围实际实收`);continue;}
   const lots=scope.activeBatches.filter(batch=>Date.parse(batch.occurredAt)<=cutoff);
   const actual=warehouseReceiptBatches(unit,lots.map(batch=>({
    id:JSON.stringify([batch.ref.recordId,batch.ref.version,'quantityRowKey' in batch?batch.quantityRowKey:null]),quantity:batch.quantity,
   })));
   const started=warehouseFabricInspectionThreshold(unit,scope.purchase.invested,actual);
   if(started!==true)reasons.push(started===false?`${scope.name}：本范围实际实收未达到采购应收90%`:
    `${scope.name}：实际到仓批次、单位或采购应收尚无可核依据`);
   for(const lot of lots)if(Number(lot.quantity.quantity)>0&&(!firstReceiptAt||Date.parse(lot.occurredAt)<Date.parse(firstReceiptAt)))firstReceiptAt=lot.occurredAt;
  }
 }
 return {eligible:reasons.length===0,reasons,firstReceiptAt};
}
