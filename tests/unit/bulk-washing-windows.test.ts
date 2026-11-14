import {expect,it} from 'vitest';
import {bulkWashingWindows} from '../../apps/api/src/production-platform/bulk-washing-windows.js';
import type {WashingEvent} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import type {BulkWashingArrangement} from '@dx-rework/contracts/bulk-washing';
const policy={minutes:240,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
const plan:BulkWashingArrangement={mode:'after_receipt',reference:'TEST',revision:1,accounting:'additional',washing:policy,inspection:policy};
const at=(hour:number)=>new Date(Date.UTC(2026,10,12,hour)).toISOString();
const event=(id:string,kind:string,payload:Record<string,unknown>,hour:number|null):WashingEvent=>({id,kind,payload,occurredAt:hour===null?null:at(hour),recordedAt:at(20),operator:'TEST',planId:'p',scopeId:'r',quantityVersion:'v',sequence:1});
const send=event('send','send',{quantity:30},0);
it('partial return keeps the actual washing window open; full return freezes it',()=>{
 const returned=event('r','return',{sendId:'send',quantity:20},5);
 expect(bulkWashingWindows(plan,[send,returned],new Set(),at(8))[0]?.overdueMinutes).toBe(240);
 const rest=event('r2','return',{sendId:'send',quantity:10},6);
 expect(bulkWashingWindows(plan,[send,returned,rest],new Set(),at(20))[0]?.overdueMinutes).toBe(120);
});
it('completed quantity without trustworthy completion time stays unknown instead of aging',()=>{
 const returned=event('r','return',{sendId:'send',quantity:30},null);
 for(const hour of [8,20])expect(bulkWashingWindows(plan,[send,returned],new Set(),at(hour))[0]?.overdueMinutes).toBeNull();
 const known=event('r','return',{sendId:'send',quantity:30},5);
 const qc=event('q','inspection',{completionId:'r',quantity:30,qualifiedQuantity:30},null);
 expect(bulkWashingWindows(plan,[send,known,qc],new Set(),at(20))[1]).toMatchObject({state:'completed',completedAt:null,overdueMinutes:null});
});
it('termination freezes only unfinished clocks; unknown termination is not observation time',()=>{
 const termination={kind:'cancelled' as const,at:at(8),precision:'instant' as const,originEventRef:'cancel',scopeRef:'order:p'};
 for(const hour of [8,20])expect(bulkWashingWindows(plan,[send],new Set(),at(hour),termination)[0]?.overdueMinutes).toBe(240);
 expect(bulkWashingWindows(plan,[send],new Set(),at(20),{...termination,at:null,precision:'unknown'})[0]?.overdueMinutes).toBeNull();
});
it('voided evidence remains visible but cannot create a live responsibility window',()=>{
 const row=bulkWashingWindows(plan,[send],new Set(['send']),at(20))[0];
 expect(row?.startedAt).toBe(at(0));expect(row?.overdueMinutes).toBeNull();
});
it('factory washing uses its actual start and never a receipt or planned date',()=>{
 const factory={...plan,mode:'factory' as const};
 const start=event('s','factory_start',{quantity:30},2);
 const done=event('c','factory_complete',{startId:'s',quantity:30},7);
 const row=bulkWashingWindows(factory,[start,done],new Set(),at(20))[0];
 expect(row?.dueAt).toBe(at(6));expect(row?.overdueMinutes).toBe(60);
 expect(bulkWashingWindows({mode:'none'},[start],new Set(),at(20))).toEqual([]);
});
