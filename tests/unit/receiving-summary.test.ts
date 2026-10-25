import {describe,it,expect} from 'vitest';
import {receivingSummary,receiptTime} from '../../apps/api/src/production-platform/receiving-summary.js';
describe('native receiving/packing projection',()=>{
 it('uses mother total for collected, preserves PO differences and keeps packing separate',()=>{
  const lines=[{lineId:'a',orderedQuantity:60,actualQuantity:70,packingQuantity:40},{lineId:'b',orderedQuantity:40,actualQuantity:30,packingQuantity:null}];
  expect(receivingSummary(lines)).toMatchObject({expected:100,received:100,status:'已收齐',shipmentQuantity:40,remaining:0});
  expect(lines[1]!.actualQuantity).toBe(30);
  expect(receivingSummary([...lines,lines[0]!]).received).toBe(100);
  expect(receivingSummary([{...lines[0]!,actualQuantity:50},lines[1]!])).toMatchObject({received:80,status:'待收齐',remaining:20,shipmentQuantity:40});
 });
 it('does not turn backfilled date plus current clock into actual arrival time',()=>{
  expect(receiptTime('2026-10-20T07:31:00Z',{backfilled:true,receivedDate:'2026-10-20'})).toEqual({receivedAt:null,receivedDate:'2026-10-20',precision:'date'});
  expect(receiptTime('2026-10-20T07:31:00Z',{})).toMatchObject({receivedAt:'2026-10-20T07:31:00.000Z',precision:'instant'});
 });
});
