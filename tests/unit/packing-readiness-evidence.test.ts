import {expect,it} from 'vitest';
import type {ClosureLine,ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import {ReceiptQualitySchema} from '@dx-rework/contracts/order-closure';
import {packingReadinessEvidence} from '../../apps/api/src/production-platform/packing-readiness-evidence.js';
import {packingAllocationEvidence} from '../../apps/api/src/production-platform/packing-allocation-evidence.js';
const at=(h:number)=>`2026-11-15T${String(h).padStart(2,'0')}:00:00.123Z`;
const line={lineId:'TEST PO',orderedQuantity:4,actualQuantity:4,documentQuantity:4,packingQuantity:4,packingRevisionId:'TEST pack',cutScope:'verified',reworks:[]} as unknown as ClosureLine;
const checks=[0,1].map(index=>({lineId:line.lineId,receiptId:'TEST receipt'+index,quantityVersion:'TEST quantity'+index,quantity:2,qualifiedQuantity:2,inspected:true,completedAt:at(index+1),timeQuality:'现场登记',eventId:'TEST QC'+index,packingMinutes:1440,warningPercent:70})) as ReceiptQualityFact[];
const read=(l=line,q=checks)=>packingReadinessEvidence(l,q,at(20),undefined,[],[]);
it('uses the exact current scope and preserves missing, future, date-only and unverified condition times',()=>{
 expect(read().whole).toMatchObject({scope:'whole_po',state:'ready',ready:{precision:'instant',at:at(2)}});
 for(const quality of ['补报未核实','缺失'] as const)expect(read(line,[checks[0]!,{...checks[1]!,timeQuality:quality}]).whole.state).toBe('unknown');
 expect(read(line,[checks[0]!,{...checks[1]!,completedAt:at(23)}]).whole.state).toBe('unknown');
 expect(read({...line,actualQuantity:5}).whole.state).toBe('unknown');
 expect(read({...line,cutScope:'unresolved'}).whole.state).toBe('unknown');
 expect(read({...line,documentQuantity:5,receivingResolution:null}).whole.state).toBe('not_ready');
 expect(read({...line,documentQuantity:5,receivingResolution:'TEST approved',receivingResolutionAt:at(4),receivingResolutionRef:'TEST original resolution'}).whole.ready).toEqual({precision:'instant',at:at(4)});
});
it('does not borrow an unrelated or incomplete wash or use a financial rework completion as physical readiness',()=>{
 const washed=packingReadinessEvidence(line,checks,at(20),new Map([[checks[1]!.receiptId,null]]),[],[]);expect(washed.whole.state).toBe('not_ready');
 const rework={...line,reworks:[{reworkId:'TEST rework',status:'completed'}]} as ClosureLine;
 expect(read(rework).whole.state).toBe('unknown');
 const physical={reworkId:'TEST rework',lineId:line.lineId,complete:true,completedAt:at(5),evidence:'TEST genuine worker report'} as never;
 const result=packingReadinessEvidence(rework,checks,at(20),undefined,[],[physical]);expect(result.whole.ready).toEqual({precision:'instant',at:at(5)});
 expect(result.receipts.every(row=>row.readiness.state==='unknown')).toBe(true); // PO work is not a per-receipt allocation.
});
it('keeps per-receipt R and true C independent and makes superseded allocations unknown',()=>{
 const current={...line,packingReadiness:read(),packingAllocations:checks.map((q,index)=>({receiptId:q.receiptId,quantityVersion:q.quantityVersion,quantity:2,actualTime:{precision:'instant' as const,at:at(10+index)}}))};
 const known=packingAllocationEvidence(current,checks,true)!;expect(known.completedAt).toBe(at(11));expect(known.batchWindows!.map(w=>w.startedAt)).toEqual([at(1),at(2)]);
 expect(packingAllocationEvidence(current,[checks[0]!,{...checks[1]!,quantityVersion:'TEST corrected'}],false)).toMatchObject({businessCompleted:false,batchCoverageComplete:false});
 const partial={...current,packingQuantity:2,packingAllocations:current.packingAllocations.slice(0,1)};
 const open=packingAllocationEvidence(partial,checks,false)!;expect(open.batchWindows![1]).toMatchObject({startedAt:at(2),completedAt:null,complete:false});expect(open.completedAt).toBeUndefined();
});
it('retains the original reported-QC payload and requires an explicit now choice without a substituted occurredAt',()=>{
 const old={receiptId:'11111111-1111-4111-8111-111111111111',quantityVersion:'22222222-2222-4222-8222-222222222222',qualifiedQuantity:2,problem:'',occurredAt:at(1)};
 expect(ReceiptQualitySchema.parse(old)).toEqual(old);
 const {occurredAt,...current}=old;expect(ReceiptQualitySchema.safeParse(current).success).toBe(false);
 expect(ReceiptQualitySchema.safeParse({...current,timeMode:'now'}).success).toBe(true);
 expect(ReceiptQualitySchema.safeParse({...old,timeMode:'now'}).success).toBe(false);expect(occurredAt).toBe(at(1));
});
