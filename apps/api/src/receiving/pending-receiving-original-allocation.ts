import type {PoolClient} from 'pg';
import {factoryProductionScopesForOrders} from '../production-platform/factory-production-facts.js';
import {readWarehouseFactoryDispatchScopesForOrders} from '../production-platform/warehouse-factory-dispatch-evidence.js';
import {readPendingReceivingNativeReceipts,receivingFactoryAllocationKey} from './pending-receiving-native-receipts.js';
import {projectPendingReceivingScope,type PendingReceivingIdentity} from './pending-receiving-scope.js';
import {readNativeReceiptExceptions} from './native-receipt-qualification.js';

/** Builds the new receiving view from the original facts, within the caller's
 * already-authorized repeatable snapshot. Before a factory sends garments it
 * can be listed as in production, but not as actually shipped or receivable. */
export async function pendingReceivingForAuthorizedOrders(db:Pick<PoolClient,'query'>,authorizedOrderIds:readonly string[]){
 if(!authorizedOrderIds.length)return [];
 const dispatches=await readWarehouseFactoryDispatchScopesForOrders(db,authorizedOrderIds);
 if(!dispatches.length)return [];
 const masters=[...new Set(dispatches.map(row=>row.orderId))];
 const allocations=await factoryProductionScopesForOrders(db,masters);
 const receipts=await readPendingReceivingNativeReceipts(db,masters);
 const pendingQualification=await readNativeReceiptExceptions(db,{orderIds:masters},dispatches);
 const excluded=new Set(pendingQualification.map(row=>row.receiptId));
 const dispatchGroups=new Map<string,{identity:PendingReceivingIdentity;facts:typeof dispatches}>();
 const cutIds=new Map<string,Set<string>>();
 const allocationKey=(scope:PendingReceivingIdentity)=>JSON.stringify([scope.orderId,scope.factoryAllocationKey,scope.lineId]);
 for(const fact of dispatches){
  const identity={orderId:fact.orderId,productionId:fact.productionId,lineId:fact.lineId,cuttingOrderId:fact.cuttingOrderId,
   factoryAllocationKey:receivingFactoryAllocationKey(fact.productionId,fact.factoryDecisionId)};
  const allocation=allocationKey(identity),cutScope=JSON.stringify([allocation,fact.cuttingOrderId]);
  const grouped=dispatchGroups.get(cutScope)??{identity,facts:[]};grouped.facts.push(fact);dispatchGroups.set(cutScope,grouped);
  const cuts=cutIds.get(allocation)??new Set<string>();cuts.add(fact.cuttingOrderId);cutIds.set(allocation,cuts);
 }
 return [...dispatchGroups.values()].flatMap(({identity,facts})=>{
  const factoryDecisionId=facts[0]!.factoryDecisionId;
  const matched=(allocations.get(identity.orderId)??[]).filter(row=>row.production_order_id===identity.productionId&&
   row.factory_decision_id===factoryDecisionId&&row.line_id===identity.lineId);
  if(!matched.length)return [];
  const expectedQuantity=matched.length===1&&cutIds.get(allocationKey(identity))?.size===1?Number(matched[0].quantity):null;
  const balance=projectPendingReceivingScope({identity,expectedQuantity,effectiveReceipts:(receipts.get(identity.orderId)??[]).filter(row=>!excluded.has(row.receiptId)),
   dispatches:facts.map(fact=>({identity,factId:fact.factId,kind:'仓库实际发厂',actualDispatchedAt:fact.dispatchedAt,dispatchedQuantity:fact.quantity}))});
  if(!balance)return [];
  const needsQualification=pendingQualification.some(row=>row.orderId===identity.orderId&&row.lineId===identity.lineId&&
   (row.cuttingId===null||row.cuttingId===identity.cuttingOrderId)&&(!row.productionId||
    row.productionId===identity.productionId&&row.factoryDecisionId===factoryDecisionId));
  return [{identity,factoryDecisionId,expectedQuantity,balance:needsQualification?{...balance,status:'unresolved' as const,received:null,remaining:null,difference:null}:balance,
   supplierId:matched.length===1?matched[0].supplier_id as string:null,
   supplierName:matched.length===1?matched[0].supplier_name_snapshot as string|null:null,
   poNumber:matched.length===1?matched[0].po_number as string|null:null,
   color:matched.length===1?matched[0].color as string|null:null,
   factoryShipmentRecorded:matched.length===1&&matched[0].execution_status==='shipped'}];
 });
}
