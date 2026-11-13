import {expect,it} from 'vitest';
import {replayReceivingSpan,type ReceiptChange} from '../../apps/api/src/production-platform/receiving-span.js';
import {firstEffectiveReceipt} from '../../apps/api/src/production-platform/first-effective-receipt.js';
import {factoryDeliveryReadings,type FactoryDeliveryReceipt} from '../../apps/api/src/production-platform/factory-delivery-reading.js';
const receipt=(id:string,hour:number,quantity:number):ReceiptChange=>({id,receiptId:id,recordedAt:`2026-10-20T0${hour}:00:00Z`,quantity,actualAt:`2026-10-20T0${hour}:00:00Z`,date:null,kind:'receipt'});
it('never skips an unknown effective arrival or treats a date midnight as the first instant',()=>{
 const exact={id:'known',receivedAt:'2026-11-12T02:00:00.000Z',receivedDate:null};
 expect(firstEffectiveReceipt([exact,{id:'unknown',receivedAt:null,receivedDate:null}])).toMatchObject({delivered:true,first:null,occurred:{precision:'unknown'}});
 expect(firstEffectiveReceipt([exact,{id:'day',receivedAt:null,receivedDate:'2026-11-12'}])).toMatchObject({delivered:true,first:null,occurred:{precision:'date',date:'2026-11-12'}});
 expect(firstEffectiveReceipt([exact,{id:'later',receivedAt:null,receivedDate:'2026-11-13'}])).toMatchObject({first:exact,occurred:{precision:'instant',at:exact.receivedAt}});
 expect(firstEffectiveReceipt([])).toMatchObject({delivered:false,first:null});
});
it('separates first delivery from collection, factory allocation, PO and zero-corrected receipts',()=>{
 const scope={productionId:'factory-order',factoryDecisionId:null,lineId:'red',expected:100,targetDate:'2026-11-11',commitments:[{at:'2026-11-01T00:00:00Z',date:'2026-11-11',reference:'approved-original',version:1}]};
 const red={id:'first',...scope,quantity:30,receivedAt:'2026-11-12T02:00:00.000Z',receivedDate:null};
 const other={...red,id:'other',lineId:'blue',quantity:100,receivedAt:'2026-11-10T02:00:00.000Z'};
 const read=(rows:FactoryDeliveryReceipt[])=>factoryDeliveryReadings([scope,{...scope,lineId:'blue'},{...scope,factoryDecisionId:'transferred'}],rows,'2026-11-13T02:00:00.000Z');
 expect(read([red,other])[0]).toMatchObject({delivered:true,firstReceipt:{precision:'instant',at:red.receivedAt},received:30,remaining:70,collected:false,status:'late'});
 expect(read([red,other])[1]).toMatchObject({delivered:true,collected:true,status:'on_time'});
 expect(read([red,other])[2]).toMatchObject({delivered:false,received:0,status:'late'});
 expect(read([{...red,quantity:0},other])[0]).toMatchObject({delivered:false,received:0,status:'late'});
 expect(read([red,{...red,id:'later',quantity:70,receivedAt:'2026-11-13T01:00:00Z'}])[0]).toMatchObject({firstReceipt:{precision:'instant',at:red.receivedAt},collected:true,status:'late'});
 expect(read([red,{...red,id:'unknown',receivedAt:null}])[0]).toMatchObject({delivered:true,status:'unknown',firstReceipt:{precision:'unknown'}});
});
it('keeps first-delivery lateness against its effective commitment and restores current assessment after zero correction',()=>{
 const scope={productionId:'factory',factoryDecisionId:null,lineId:'red',expected:10,targetDate:'2026-11-15',commitments:[
  {at:'2026-11-01T00:00:00Z',date:'2026-11-11',reference:'original',version:1},
  {at:'2026-11-13T00:00:00Z',date:'2026-11-15',reference:'approved-change',version:2}
 ]};
 const first={id:'first',productionId:'factory',factoryDecisionId:null,lineId:'red',quantity:2,receivedAt:'2026-11-12T02:00:00Z'};
 const read=(rows:FactoryDeliveryReceipt[])=>factoryDeliveryReadings([scope],rows,'2026-11-14T00:00:00Z')[0];
 expect(read([first])).toMatchObject({delivered:true,status:'late',targetDate:'2026-11-15',assessmentTargetDate:'2026-11-11',assessmentTargetRef:'original',remaining:8});
 expect(read([{...first,quantity:0}])).toMatchObject({delivered:false,status:'pending',assessmentTargetDate:'2026-11-15',remaining:10});
 expect(read([{...first,receivedAt:null,receivedDate:'2026-11-13'}])).toMatchObject({delivered:true,status:'unknown',assessmentTargetDate:null});
 expect(factoryDeliveryReadings([{...scope,expected:0}],[],'2026-11-20T00:00:00Z')[0]).toMatchObject({delivered:false,status:'not_applicable',remaining:0});
 expect(factoryDeliveryReadings([{...scope,expected:0}],[first],'2026-11-20T00:00:00Z')[0]).toMatchObject({delivered:true,status:'late'});
 const unknown={...first,id:'unknown-scope',productionId:null};
 expect(read([unknown])).toMatchObject({delivered:null,status:'unknown',remaining:null,collected:null});
 expect(read([first,unknown])).toMatchObject({delivered:true,status:'unknown',firstReceipt:{precision:'unknown'},remaining:null});
});
it('retains first crossing, restores pending after correction and never sums replacement quantities twice',()=>{
 const a=receipt('a',1,60),b=receipt('b',2,40),correction={...b,id:'correct',recordedAt:'2026-10-20T03:00:00Z',quantity:20,actualAt:null,kind:'correction' as const};
 const result=replayReceivingSpan(100,[a,b,correction,receipt('c',4,30)]);
 expect(result.received).toBe(110);expect(result.history.map(h=>[h.state,h.received,h.actualAt])).toEqual([['已收齐',100,b.actualAt],['待收齐',80,null],['已收齐',110,'2026-10-20T04:00:00Z']]);
});
it('correction crossing is a recorded threshold, not an invented physical arrival instant',()=>{
 const a=receipt('a',1,80);const result=replayReceivingSpan(100,[a,{...a,id:'correct',recordedAt:'2026-10-20T02:00:00.000Z',quantity:100,kind:'correction'}]);
 expect(result.history[0]).toMatchObject({actualAt:null,cause:'correction',received:100});
});

it('Final10 preserves the physical arrival day at collection without inventing midnight from a later recording',()=>{
 const original={...receipt('a',1,100),recordedAt:'2026-10-20T01:00:00Z',actualAt:null,date:'2026-10-18'};
 const result=replayReceivingSpan(100,[original]);
 expect(result.history).toEqual([{recordedAt:original.recordedAt,actualAt:null,actualDate:'2026-10-18',received:100,state:'已收齐',cause:'receipt',evidence:'a'}]);
 expect(original.actualAt).toBeNull();
});

it('Final10 a quantity correction cannot reuse the original arrival day as the corrected collection day',()=>{
 const original={...receipt('a',1,80),actualAt:null,date:'2026-10-18'};
 const correction={...original,id:'correct',recordedAt:'2026-10-20T02:00:00.000Z',quantity:100,kind:'correction' as const};
 const result=replayReceivingSpan(100,[original,correction]);
 expect(result.history[0]).toMatchObject({actualAt:null,cause:'correction',received:100});
 expect(result.history[0]?.actualDate).toBeUndefined();
});
