import {describe,expect,it} from 'vitest';
import type {BatchFact} from '../../apps/api/src/production-platform/factory-batch-ledger.js';
import {checkedExternalCraftRepairFact,externalCraftRepairProgress} from '../../apps/api/src/production-platform/warehouse-craft-rework-return.js';

const scope={reworkId:'original-rework',originalReturnFactId:'original-return',stepRef:'step',lineId:'po',factoryId:'original-factory',quantity:20};
const motion={factoryId:scope.factoryId,reworkId:scope.reworkId};
const send:BatchFact={fact_id:'outbound',kind:'工艺发出',occurred_at:'2026-11-24T01:00:00Z',payload:{stepRef:scope.stepRef,fromReturnId:scope.originalReturnFactId,warehouseMotion:motion,lines:[{lineId:scope.lineId,quantity:20}]}};
const incoming=(id:string,at:string,quantity:number):BatchFact=>({fact_id:id,kind:'工艺回仓',occurred_at:at,payload:{stepRef:scope.stepRef,sendFactId:send.fact_id,warehouseMotion:motion,lines:[{lineId:scope.lineId,quantity}]}});
const first=incoming('back-a','2026-11-24T02:00:00Z',10),last=incoming('back-b','2026-11-24T03:00:00Z',10);

describe('actual external rework movement in the original craft ledger',()=>{
 it('uses the last real return only when exactly all twenty pieces came back',()=>{
  expect(externalCraftRepairProgress(scope,[send,first])).toEqual({sent:20,returned:10,remainingToSend:0,remainingToReturn:10,physicalCompletedAt:null});
  expect(externalCraftRepairProgress(scope,[send,first,last])).toEqual({sent:20,returned:20,remainingToSend:0,remainingToReturn:0,physicalCompletedAt:'2026-11-24T03:00:00.000Z'});
 });
 it('does not count a different rework, unbound shipment, another plant, or a reused outbound reference',()=>{
  expect(externalCraftRepairProgress(scope,[send,first,{...last,payload:{...last.payload,warehouseMotion:{...motion,reworkId:'other'}}}])?.returned).toBe(10);
  expect(externalCraftRepairProgress(scope,[send,first,{...last,payload:{...last.payload,sendFactId:'unrelated'}}])).toBeNull();
  expect(externalCraftRepairProgress(scope,[send,first,{...last,payload:{...last.payload,warehouseMotion:{...motion,factoryId:'other-plant'}}}])).toBeNull();
  expect(externalCraftRepairProgress(scope,[send,first,first])).toBeNull();
  expect(externalCraftRepairProgress(scope,[send,first,incoming('extra','2026-11-24T03:00:00Z',11)])).toBeNull();
 });
 it('does not start from a draft or cancel a physical movement out of the ledger',()=>{
  const active={...scope,orderId:'order',preparationId:'prep',checkId:'original-qc',status:'in_progress'};
  expect(checkedExternalCraftRepairFact({...active,status:'draft'},[],send)).toBeNull();
  expect(checkedExternalCraftRepairFact({...active,status:'pending_process_configuration'},[],send)).toBeNull();
  expect(checkedExternalCraftRepairFact(active,[],send)).toMatchObject({sent:20,remainingToReturn:20});
  expect(checkedExternalCraftRepairFact({...active,status:'cancelled'},[],send)).toBeNull();
  expect(checkedExternalCraftRepairFact({...active,status:'cancelled'},[send],first)).toMatchObject({returned:10,remainingToReturn:10,physicalCompletedAt:null});
  expect(checkedExternalCraftRepairFact({...active,status:'cancelled'},[],first)).toBeNull();
 });
});
