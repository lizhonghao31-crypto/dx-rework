import {it,expect} from 'vitest';
import type {BulkWashingFact,BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
import {bulkWashingLedger} from '../../apps/api/src/production-platform/bulk-washing-ledger.js';
import {washingActionRecords} from '../../apps/web/src/bulk-washing-actions.js';
const scope={scopeId:'receipt:one',lineId:'red',factoryDecisionId:null,quantityVersion:'v1',quantity:4};
const at='2026-11-15T00:00:00Z';
const facts:BulkWashingFact[]=[
 {...scope,id:'send',kind:'send',quantity:4,occurredAt:at},
 {...scope,id:'return',kind:'return',sendId:'send',quantity:4,occurredAt:at},
 {...scope,id:'qc',kind:'inspection',completionId:'return',quantity:4,qualifiedQuantity:3,occurredAt:at},
];
const view=(rows:BulkWashingFact[]=facts):BulkWashingScopeView=>({...scope,planId:'p',mode:'after_receipt',label:'TEST',revision:rows.length,receivedAt:at,availableAt:at,canLogistics:true,canInspect:false,canCorrect:false,windows:[],ledger:bulkWashingLedger(scope,'after_receipt',rows),facts:rows.map(f=>({...f,recordedAt:at,operator:'TEST',note:'',voided:false}))});
it('offers only the rejected remainder, never a second inspection or an exhausted first send',()=>{
 const own=view();expect(washingActionRecords(own,'return')).toEqual([]);expect(washingActionRecords(own,'inspection')).toEqual([]);
 expect(washingActionRecords(own,'rework')).toEqual([{id:'qc',quantity:1,label:'返洗第1轮 · 原不合格1件 · 尚可返洗1件',at}]);
 const rewash:BulkWashingFact={...scope,id:'again',kind:'send',quantity:1,occurredAt:at,reworkOfInspectionId:'qc'};
 const active=view([...facts,rewash]);expect(washingActionRecords(active,'rework')).toEqual([]);
 expect(washingActionRecords(active,'return')).toEqual([{id:'again',quantity:1,label:'返洗第1轮 · 送洗',at}]);
});
it('retains the separate original and rewash qualified allocations for factory receipt linkage',()=>{
 const rows:BulkWashingFact[]=[{...scope,id:'start',kind:'factory_start',quantity:4,occurredAt:at},{...scope,id:'complete',kind:'factory_complete',startId:'start',quantity:4,occurredAt:at},{...facts[2]!,id:'qc',kind:'inspection',completionId:'complete',quantity:4,qualifiedQuantity:3}];
 const own={...view(),mode:'factory' as const,ledger:bulkWashingLedger(scope,'factory',rows),facts:rows.map(f=>({...f,recordedAt:at,operator:'TEST',note:'',voided:false}))};
 expect(washingActionRecords(own,'receipt_link')).toEqual([{id:'complete',quantity:3,label:'工厂洗好',at}]);
});
