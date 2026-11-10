import {expect,it} from 'vitest';
import type {OrderClosureSheet} from '../../packages/contracts/src/order-closure.js';
import {packingSlaEvidence} from '../../apps/api/src/production-platform/packing-sla-evidence.js';
const sheet={lines:[{lineId:'po',orderedQuantity:100,actualQuantity:100,documentQuantity:100,packingQuantity:100,packingRevisionId:'packing',packingRecordedAt:'2026-10-23T00:00:00Z',packingActualTime:{precision:'instant',at:'2026-10-22T00:00:00Z'}}],quality:[{receiptId:'receipt1',lineId:'po',quantity:100,qualifiedQuantity:100,inspected:true,completedAt:'2026-10-20T00:00:00Z',eventId:'qc',packingMinutes:1440,warningPercent:70}]} as unknown as OrderClosureSheet;
it('uses frozen 24h only with a reliable single native batch and keeps actual packing independent',()=>{
 expect(packingSlaEvidence(sheet).facts['garment_packing:po']).toMatchObject({businessCompleted:true,completedAt:'2026-10-22T00:00:00Z',batchWindows:[{deadline:'2026-10-21T00:00:00.000Z'}]});
});
it('does not invent FIFO or batch-ready time from cumulative packing quantity',()=>{
 const multiple={...sheet,quality:[{...sheet.quality![0]!,quantity:60,qualifiedQuantity:60},{...sheet.quality![0]!,receiptId:'receipt2',quantity:40,qualifiedQuantity:40,completedAt:'2026-10-21T00:00:00Z'}]};const result=packingSlaEvidence(multiple);
 expect(result.facts['garment_packing:po']).toMatchObject({businessCompleted:true,batchWindows:[{startedAt:null,deadline:null}]});expect(result.limitations).toHaveLength(1);
});
it('retains quantity completion without inventing an actual time, and rejects a packing timestamp before the effective QC',()=>{
 for(const packingActualTime of [{precision:'unknown' as const},{precision:'instant' as const,at:'2026-10-19T00:00:00Z'}]){
  const result=packingSlaEvidence({...sheet,lines:[{...sheet.lines[0]!,packingActualTime}]}).facts['garment_packing:po']!;
  expect(result.businessCompleted).toBe(true);expect(result.completedAt).toBeUndefined();expect(result.batchWindows?.[0]?.completedAt).toBeNull();
 }
});
it('does not turn missing or superseded quality, partial receipts, or duplicate receipt references into physical completion',()=>{
 for(const quality of [[],[{...sheet.quality![0]!,inspected:false}],[{...sheet.quality![0]!,quantity:60,qualifiedQuantity:60}],[{...sheet.quality![0]!,qualifiedQuantity:90}]]){
  expect(packingSlaEvidence({...sheet,quality}).facts['garment_packing:po']?.completedAt).toBeUndefined();
 }
 const half={...sheet.quality![0]!,quantity:50,qualifiedQuantity:50};
 expect(packingSlaEvidence({...sheet,quality:[half,half]}).facts['garment_packing:po']?.completedAt).toBeUndefined();
});

it('keeps a physical date without midnight conversion and never promotes an old registration timestamp to actual completion',()=>{
 const dated=packingSlaEvidence({...sheet,lines:[{...sheet.lines[0]!,packingActualTime:{precision:'date',date:'2026-10-22'}}]}).facts['garment_packing:po']!;
 expect(dated.completedDate).toBe('2026-10-22');expect(dated.completedAt).toBeUndefined();
 const historical=packingSlaEvidence({...sheet,lines:[{...sheet.lines[0]!,packingActualTime:{precision:'unknown'}}]}).facts['garment_packing:po']!;
 expect(historical.businessCompleted).toBe(true);expect(historical.completedAt).toBeUndefined();expect(historical.completedDate).toBeUndefined();
});

it('does not complete a four-piece delivery when two effective receipt checks qualify only one plus two pieces',()=>{
 const original=sheet.quality![0]!;
 const inconsistent={...sheet,lines:[{...sheet.lines[0]!,orderedQuantity:4,actualQuantity:4,documentQuantity:4,packingQuantity:4}],
  quality:[{...original,receiptId:'first',quantity:2,qualifiedQuantity:1},{...original,receiptId:'second',quantity:2,qualifiedQuantity:2}]};
 const evidence=packingSlaEvidence(inconsistent);
 expect(evidence.facts['garment_packing:po']?.businessCompleted).toBe(false);
 expect(evidence.facts['garment_packing:po']?.completedAt).toBeUndefined();
 expect(inconsistent.lines[0]!.packingQuantity).toBe(4);
});
