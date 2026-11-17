import type {BulkWashingCommand,BulkWashingScopeView,BulkWashingSheet} from '@dx-rework/contracts/bulk-washing';
import type {StoredOrderTimePlan} from './order-time-plan-repository.js';
import {preparedStoredRewash} from './order-time-washing-rework.js';
import {washingConflict} from './bulk-washing-repository.js';

/** Bind actual logistics to a previously effective work, never approve a P. */
export function assertWashingReworkBinding(saved:StoredOrderTimePlan|null,scope:BulkWashingScopeView,input:BulkWashingCommand){
 if(input.kind!=='send'&&input.kind!=='factory_start')return;
 if(input.rewashWorkId&&!input.reworkOfInspectionId)washingConflict('返洗计划只能关联真实不合格检查');
 if(!input.reworkOfInspectionId)return;
 if(!input.rewashWorkId){if(saved?.input.plan.company.framework)washingConflict('请先由有权人员在本单安排确定本轮返洗计划');return;}
 const work=saved?.input.rewashing?.find(row=>row.intentId===input.rewashWorkId);
 if(!work||!work.introducedAt||!work.introducedEventRef||work.scopeId!==scope.scopeId||work.lineId!==scope.lineId
  ||work.factoryDecisionId!==scope.factoryDecisionId||work.quantityVersion!==scope.quantityVersion||work.planId!==scope.planId
  ||work.inspectionId!==input.reworkOfInspectionId||work.arrangement.mode!==scope.mode)
  washingConflict('返洗计划与本单、工厂、PO或原检查不一致，请重新核对');
 const used=scope.facts.filter(fact=>!fact.voided&&(fact.kind==='send'||fact.kind==='factory_start')&&fact.rewashWorkId===work!.intentId)
  .reduce((sum,fact)=>sum+fact.quantity,0);
 if(used+input.quantity>work!.quantity)washingConflict('本次返洗超过该独立计划尚未开始的范围');
 if(input.occurredAt&&Date.parse(input.occurredAt)<Date.parse(work!.introducedAt!))
  washingConflict('原返洗发生早于该计划生效，不能套用后来计划补写历史P');
}

/** Optional operational read: neither a new approval path nor a clock writer. */
export function attachWashingReworkPlans(sheet:BulkWashingSheet,saved:StoredOrderTimePlan|null){
 for(const scope of sheet.scopes){
  scope.requireRewashPlan=Boolean(saved?.input.plan.company.framework);
  scope.rewashPlans=(saved?.input.rewashing??[]).filter(row=>row.scopeId===scope.scopeId&&row.quantityVersion===scope.quantityVersion).map(row=>{
   const prepared=preparedStoredRewash(row),po=saved!.input.scopes.find(value=>value.lineId===row.lineId);
   const arranged=po?saved!.input.frameworkPlans?.[po.scopeRef]?.arranged:undefined;
   const used=scope.facts.filter(fact=>!fact.voided&&(fact.kind==='send'||fact.kind==='factory_start')&&fact.rewashWorkId===row.intentId)
    .reduce((sum,fact)=>sum+fact.quantity,0);
   return {intentId:row.intentId,inspectionId:row.inspectionId,round:row.round,quantity:row.quantity,remaining:Math.max(0,row.quantity-used),
    washingPlannedAt:arranged?.find(target=>target.id===prepared.work[0]!.id)?.end.at??null,
    inspectionPlannedAt:arranged?.find(target=>target.id===prepared.requiredForDelivery)?.end.at??null};
  });
 }
}
