import {expect,it} from 'vitest';
import {replayReceivingSpan,type ReceiptChange} from '../../apps/api/src/production-platform/receiving-span.js';
const receipt=(id:string,hour:number,quantity:number):ReceiptChange=>({id,receiptId:id,recordedAt:`2026-10-20T0${hour}:00:00Z`,quantity,actualAt:`2026-10-20T0${hour}:00:00Z`,date:null,kind:'receipt'});
it('retains first crossing, restores pending after correction and never sums replacement quantities twice',()=>{
 const a=receipt('a',1,60),b=receipt('b',2,40),correction={...b,id:'correct',recordedAt:'2026-10-20T03:00:00Z',quantity:20,actualAt:null,kind:'correction' as const};
 const result=replayReceivingSpan(100,[a,b,correction,receipt('c',4,30)]);
 expect(result.received).toBe(110);expect(result.history.map(h=>[h.state,h.received,h.actualAt])).toEqual([['已收齐',100,b.actualAt],['待收齐',80,null],['已收齐',110,'2026-10-20T04:00:00Z']]);
});
it('correction crossing is a recorded threshold, not an invented physical arrival instant',()=>{
 const a=receipt('a',1,80);const result=replayReceivingSpan(100,[a,{...a,id:'correct',recordedAt:'2026-10-20T02:00:00Z',quantity:100,kind:'correction'}]);
 expect(result.history[0]).toMatchObject({actualAt:null,cause:'correction',received:100});
});
