import {describe,expect,it} from 'vitest';
import type {DevelopmentSampleHandover} from '@dx-rework/contracts/digital-development-workspace';
import {formalDevelopmentHandoverEvidence} from '../../apps/api/src/production-platform/development-formal-handover-evidence.js';

const date=(day:number)=>`2026-11-${day}T02:00:00.000Z`;
const orderStart={at:date(21),evidence:'TEST-actual-formal-origin'};
function view():DevelopmentSampleHandover {
 return {sourceId:'TEST-original-source',round:2,documentVersion:4,recipient:{id:'TEST-current-merch',name:null},canConfirm:false,history:[],
  electronic:(['materials','order_quantities','quotation'] as const).map((kind,index)=>({kind,version:5+index,state:'shared',
   receipt:{id:`TEST-${kind}`,version:5+index,at:date(22+index),recipientId:'TEST-current-merch'}})),
  current:{eventId:'TEST-original-sample-receipt',round:2,documentVersion:4,recipientId:'TEST-current-merch',recipientName:null,
   confirmedBy:'TEST-original-designer',confirmedByName:null,occurredAt:date(20)}};
}

describe('original formal design handover evidence',()=>{
 it('keeps the actual last receipt time regardless of arrival order and retains original IDs and versions',()=>{
  const original=view();original.electronic.reverse();
  const complete=formalDevelopmentHandoverEvidence(original,orderStart);
  expect(complete).toMatchObject({satisfiedAt:date(24),assessmentEligibleAt:date(24),formalOrigin:orderStart.evidence,
   sampleReceiptId:original.current!.eventId,receipts:[{id:'TEST-materials',version:5},{id:'TEST-order_quantities',version:6},{id:'TEST-quotation',version:7}]});
 });
 it('retains pre-order receipt time separately from the actual formal start, never treating pre-order itself as formal completion',()=>{
  const original=view();
  original.electronic.forEach(item=>{item.receipt!.at=date(20);});
  expect(formalDevelopmentHandoverEvidence(original,null)).toBeNull();
  expect(formalDevelopmentHandoverEvidence(original,orderStart)).toMatchObject({satisfiedAt:date(20),assessmentEligibleAt:date(21)});
 });
 it('does not mistake investment readiness, an unshared quote, an unavailable read or duplicate kind for full handover',()=>{
  const original=view(),quote=original.electronic.pop()!;
  expect(formalDevelopmentHandoverEvidence(original,orderStart)).toBeNull();
  for(const state of ['waiting_share','not_applicable','unavailable'] as const)
   expect(formalDevelopmentHandoverEvidence({...original,electronic:[...original.electronic,{...quote,state}]},orderStart)).toBeNull();
  expect(formalDevelopmentHandoverEvidence({...original,electronic:[...original.electronic,quote,quote]},orderStart)).toBeNull();
 });
 it('rejects the former recipient, old round, replaced sample version and an unknown event time',()=>{
  const original=view(),current=original.current!;
  for(const patch of [{recipientId:'TEST-old-recipient'},{round:1},{documentVersion:3},{occurredAt:'unknown'}])
   expect(formalDevelopmentHandoverEvidence({...original,current:{...current,...patch}},orderStart)).toBeNull();
  original.electronic[0]!.receipt!.recipientId='TEST-old-recipient';
  expect(formalDevelopmentHandoverEvidence(original,orderStart)).toBeNull();
 });
});
