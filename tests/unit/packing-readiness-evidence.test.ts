import {expect,it} from 'vitest';
import type {ClosureLine,ReceiptQualityFact} from '@dx-rework/contracts/order-closure';
import type {BulkWashingScopeView} from '@dx-rework/contracts/bulk-washing';
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

it('binds each factory receipt to its own live linked completions instead of all inspections in the shared factory',()=>{
 const scope={mode:'factory',scopeId:'TEST factory scope',lineId:line.lineId,planId:'TEST frozen',revision:8,ledger:{conflict:false},receipts:checks.map(q=>({receiptId:q.receiptId,quantityVersion:q.quantityVersion,quantity:q.quantity})),facts:[
  ...checks.map((q,i)=>({id:'TEST link'+i,scopeId:'TEST factory scope',kind:'receipt_link',receiptId:q.receiptId,receiptQuantityVersion:q.quantityVersion,completionId:'TEST wash'+i,quantity:2,voided:false})),
  ...checks.map((q,i)=>({id:'TEST wash QC'+i,scopeId:'TEST factory scope',kind:'inspection',completionId:'TEST wash'+i,quantity:2,qualifiedQuantity:2,occurredAt:at(i?15:9),voided:false})),
 ]} as unknown as BulkWashingScopeView;
 const coverage=new Map(checks.map(q=>[q.receiptId,q.quantity]));
 const read=()=>packingReadinessEvidence(line,checks,at(20),coverage,[scope],[]);
 expect(read().receipts.map(r=>r.readiness.ready)).toEqual([{precision:'instant',at:at(9)},{precision:'instant',at:at(15)}]);
 expect(read().whole.ready).toEqual({precision:'instant',at:at(15)});
 const second=scope.facts.find(f=>f.id==='TEST wash QC1')!;second.occurredAt=null;
 expect(read().receipts[0]!.readiness.ready).toEqual({precision:'instant',at:at(9)});expect(read().receipts[1]!.readiness.state).toBe('unknown');
 expect(read().whole.state).toBe('unknown');
 scope.facts.find(f=>f.id==='TEST link0')!.voided=true;
 expect(read().receipts[0]!.readiness.state).toBe('unknown');
});
it('uses all contributing checks of one receipt after washing, but does not use an unrelated failed zero-coverage check as its ready time',()=>{
 const scope={mode:'after_receipt',scopeId:'receipt:'+checks[0]!.receiptId,lineId:line.lineId,planId:'TEST frozen',revision:5,ledger:{conflict:false},facts:[
  {id:'TEST initial',kind:'inspection',completionId:'TEST return1',quantity:2,qualifiedQuantity:1,occurredAt:at(9),voided:false},
  {id:'TEST failed',kind:'inspection',completionId:'TEST rewash1',quantity:1,qualifiedQuantity:0,occurredAt:null,voided:false},
  {id:'TEST rechecked',kind:'inspection',completionId:'TEST rewash2',quantity:1,qualifiedQuantity:1,occurredAt:at(12),voided:false},
 ]} as unknown as BulkWashingScopeView;
 const result=packingReadinessEvidence(line,checks,at(20),new Map([[checks[0]!.receiptId,2]]),[scope],[]);
 expect(result.receipts[0]!.readiness.ready).toEqual({precision:'instant',at:at(12)});
 expect(result.receipts[1]!.readiness.ready).toEqual({precision:'instant',at:at(2)});
});
