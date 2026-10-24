import {expect,it} from 'vitest';
import type {OrderClosureSheet} from '../../packages/contracts/src/order-closure.js';
import {packingSlaEvidence} from '../../apps/api/src/production-platform/packing-sla-evidence.js';
const sheet={lines:[{lineId:'po',orderedQuantity:100,actualQuantity:100,documentQuantity:100,packingQuantity:100,packingRevisionId:'packing',packingRecordedAt:'2026-10-22T00:00:00Z'}],quality:[{lineId:'po',quantity:100,qualifiedQuantity:100,inspected:true,completedAt:'2026-10-20T00:00:00Z',eventId:'qc',packingMinutes:1440,warningPercent:70}]} as unknown as OrderClosureSheet;
it('uses frozen 24h only with a reliable single native batch and keeps actual packing independent',()=>{
 expect(packingSlaEvidence(sheet).facts['garment_packing:po']).toMatchObject({businessCompleted:true,completedAt:'2026-10-22T00:00:00Z',batchWindows:[{deadline:'2026-10-21T00:00:00.000Z'}]});
});
it('does not invent FIFO or batch-ready time from cumulative packing quantity',()=>{
 const multiple={...sheet,quality:[sheet.quality![0]!,sheet.quality![0]!]};const result=packingSlaEvidence(multiple);
 expect(result.facts['garment_packing:po']).toMatchObject({businessCompleted:true,batchWindows:[{startedAt:null,deadline:null}]});expect(result.limitations).toHaveLength(1);
});
