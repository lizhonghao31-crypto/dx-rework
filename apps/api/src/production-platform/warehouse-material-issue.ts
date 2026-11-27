import {BulkMaterialIssueAllocationSchema,type BulkFabricBatchRef,type BulkMaterialsView} from '@dx-rework/contracts/bulk-preparation';
import type {PreparationMaterialFact,ProductionReadinessState,WarehouseReceiptWorkItem} from '@dx-rework/contracts/production-readiness';
import {z} from 'zod';
import type {PreparationDB} from './preparation-material-repository.js';
import type {ActiveWarehouseInstructionDemand} from './warehouse-instruction-demand.js';
import {deriveWarehouseReceiptWork,warehouseReceiptMovements} from './warehouse-receipt-projection.js';
import {availableWarehouseIssue,projectWarehouseIssueAllocation,restrictWarehouseIssueLots,type WarehouseLotIssue} from './warehouse-issue-allocation.js';
import type {WarehouseReceiptBasis} from './warehouse-material-balance.js';
import {factoryProductionScopes} from './factory-production-facts.js';

const savedScope=z.object({sourceId:z.uuid(),materialId:z.uuid(),supplierId:z.uuid().nullable(),fingerprint:z.string(),scopeRef:z.string(),lineId:z.uuid().nullable()});
const savedAllocation=z.object({warehouseBasis:savedScope,scope:z.object({allocations:z.array(BulkMaterialIssueAllocationSchema).min(1)}),unit:z.string()});
type StoredMaterialIssue=BulkMaterialsView['history'][number]['items'][number]&{warehouseBasis?:unknown;scope?:unknown};
export type MaterialIssueEvent={occurred_at:Date;payload:{items:StoredMaterialIssue[];note:string}};

export async function originalMaterialIssueHistory(db:PreparationDB,orderId:string){
 const {rows}=await db.query<MaterialIssueEvent&{event_id:string;display_name:string}>(`SELECT e.event_id,e.occurred_at,e.payload,u.display_name
  FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id
  WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='bulk_materials_dispatched' ORDER BY e.recorded_at,e.event_id`,[orderId]);
 return rows;
}

export function freezeMaterialIssueBasis(basis:WarehouseReceiptBasis){
 return {sourceId:basis.resource.id,materialId:basis.materialId,supplierId:basis.supplierId,fingerprint:basis.adoptedRef,scopeRef:basis.scopeRef,lineId:basis.lineId};
}

/** An unknown previous issue of the same instruction material prevents
 * claiming exact available stock. A known separate PO does not occupy this lot. */
export function materialIssuesOnScope(history:readonly MaterialIssueEvent[],instructionMaterialId:string,basis:WarehouseReceiptBasis):WarehouseLotIssue[]|null{
 const key=freezeMaterialIssueBasis(basis),out:WarehouseLotIssue[]=[];
 for(const event of history)for(const row of event.payload.items){
  if(row.materialId!==instructionMaterialId)continue;
  const value=savedAllocation.safeParse(row);
  if(!value.success)return null;
  const source=value.data.warehouseBasis;
  if(source.sourceId!==key.sourceId||source.materialId!==key.materialId)return null;
  if(source.fingerprint!==key.fingerprint||source.supplierId!==key.supplierId)continue;
  if(source.scopeRef!==key.scopeRef||source.lineId!==key.lineId){
   if(source.lineId&&key.lineId&&source.lineId!==key.lineId)continue;
   return null; // cannot count a shared and PO-specific physical stream independently
  }
  if(value.data.unit!==basis.unit)return null;
  out.push({occurredAt:event.occurred_at.toISOString(),allocations:value.data.scope.allocations});
 }
 return out;
}

/** Reconciled historical quantities do not share the root of another row
 * on the same document. Replacing their comparison batch invalidates the
 * binding, so the correction cannot silently lose recorded occupations. */
export function legacyMaterialIssueMovements(item:WarehouseReceiptWorkItem,replaces?:WarehouseLotIssue['allocations'][number]['receipt']){
 const reconciliation=item.reconciliation;
 if(!reconciliation?.received)return [];
 return reconciliation.activeBatches.flatMap(row=>{
  const quantityRowKey=row.quantityRowKey;
  if(!quantityRowKey||replaces&&reconciliation.confirmed.some(binding=>binding.quantityRowKey===quantityRowKey&&
   binding.ref.recordId===row.ref.recordId&&binding.ref.version===row.ref.version&&
   binding.batch.recordId===replaces.recordId&&binding.batch.version===replaces.version))return [];
  return [{basis:item.basis,original:{...row.ref,quantityRowKey},quantity:row.quantity,occurredAt:row.occurredAt,valid:true}];
 });
}

export function ledgerForMaterialIssue(item:WarehouseReceiptWorkItem,history:readonly PreparationMaterialFact[],issues:readonly WarehouseLotIssue[]|null,
 usableFabricLots?:readonly BulkFabricBatchRef[]){
 if(!item.received&&!usableFabricLots)return null;
 const movements=warehouseReceiptMovements(history,item.basis);
 const legacy=legacyMaterialIssueMovements(item);
 const ledger=projectWarehouseIssueAllocation(item.basis.unit,[...movements,...legacy],issues);
 return ledger&&usableFabricLots?restrictWarehouseIssueLots(ledger,usableFabricLots
  .filter(lot=>lot.materialId===item.materialId&&(lot.lineId??null)===item.lineId)
  .map(lot=>({...lot.receipt,...(lot.quantityRowKey?{quantityRowKey:lot.quantityRowKey}:{})}))):ledger;
}

type IssueApproval={sourcing_case_id:string;sourcing_decision_id:string;sourcing_approval_snapshot_id:string;supplier_id:string};
/** Before original factory execution exists, the current approval is the
 * native full-order destination. After a partial factory transfer do not
 * send a shared material or the wrong PO against the replacement decision. */
export async function readMaterialIssueDestination(db:PreparationDB,orderId:string,approval:IssueApproval,poIds:readonly string[]){
 const production=(await db.query(`SELECT child_id FROM digital_production_child_links WHERE module='production' AND production_order_id=$1`,[orderId])).rows;
 const selects=(lineId:string|null)=>lineId===null?poIds:poIds.filter(id=>id===lineId);
 if(!production.length)return (lineId:string|null)=>selects(lineId).length>0;
 const scopes=await factoryProductionScopes(db,orderId);
 const approved=(await db.query<{decision_id:string|null}>(`SELECT sourcing_factory_execution_basis($1,$2) AS decision_id`,[approval.sourcing_case_id,approval.sourcing_decision_id])).rows[0]?.decision_id;
 return (lineId:string|null)=>{
  const selected=selects(lineId);
  return Boolean(approved&&selected.length&&selected.every(id=>{
   const matches=scopes.filter(scope=>scope.line_id===id);
   return matches.length===1&&matches[0].supplier_id===approval.supplier_id&&matches[0].sourcing_decision_id===approved;
  }));
 };
}

/** Only for authorized physical issues. A published demand alone does not
 * make stock ready. Fabrics require the separate, original quality evidence. */
export function materialIssueOptions(state:ProductionReadinessState,active:ActiveWarehouseInstructionDemand,history:readonly MaterialIssueEvent[],asOf:string,
 destination:(lineId:string|null)=>boolean,poLabels?:ReadonlyMap<string,string>,usableFabricLots?:readonly BulkFabricBatchRef[]){
 const view=deriveWarehouseReceiptWork(state,asOf,active).map(item=>{
  if(item.kind!=='fabric_receipt'||!state.warehouseReceiptCutover)return item;
  const projected=state.warehouseReceiptFacts?.find(row=>row.kind==='fabric_receipt'&&row.materialId===item.materialId&&
   row.lineId===item.lineId&&row.scopeRef===item.scopeRef&&row.basis.unit===item.basis.unit&&row.basis.supplierId===item.basis.supplierId&&
   row.basis.adoptedRef===item.basis.adoptedRef&&row.basis.resource.id===item.basis.resource.id);
  if(!projected?.reconciliation)return {...item,received:null};
  return {...item,reconciliation:projected.reconciliation,received:projected.reconciliation.received};
 });
 const result=new Map<string,{item:WarehouseReceiptWorkItem;ledger:NonNullable<ReturnType<typeof ledgerForMaterialIssue>>;
  option:NonNullable<BulkMaterialsView['items'][number]['issueOptions']>[number]}[]>();
 for(const row of active.demand.rows){
  const items=view.filter(item=>item.materialId===row.sourceMaterialId&&(item.kind==='accessories_ready'||usableFabricLots?.some(lot=>lot.materialId===item.materialId)));
  if(!items.length)continue;
  if(new Set(items.map(item=>item.lineId)).size!==items.length||items.some(item=>!item.lineId)&&items.length>1)continue;
  for(const item of items){
   if(!item.productionRequired||!destination(item.lineId))continue;
   const ledger=ledgerForMaterialIssue(item,state.history,materialIssuesOnScope(history,row.instructionMaterialId,item.basis),
    item.kind==='fabric_receipt'?usableFabricLots:undefined);
   if(!ledger)continue;
   const remaining=availableWarehouseIssue(ledger,item.productionRequired);
   if(remaining===null)continue;
   const line=state.lines.find(line=>line.lineId===item.lineId);
   const option={scopeRef:item.scopeRef,lineId:item.lineId,poLabel:line?(poLabels?.get(line.lineId)??line.color):'共享物料',unit:item.basis.unit,
    required:item.productionRequired.quantity,remaining,lots:ledger.lots};
   const list=result.get(row.instructionMaterialId)??[];list.push({item,ledger,option});result.set(row.instructionMaterialId,list);
  }
 }
 return result;
}
