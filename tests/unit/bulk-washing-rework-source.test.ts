import {expect,it} from 'vitest';
import type {BulkWashingScope} from '@dx-rework/contracts/bulk-washing';
import type {WashingEvent,WashingPlan} from '../../apps/api/src/production-platform/bulk-washing-repository.js';
import {nativeWashingReworkSources} from '../../apps/api/src/production-platform/bulk-washing-rework-source.js';

const fixture=(mode:'factory'|'after_receipt')=>{
 const scope:BulkWashingScope={scopeId:mode==='factory'?'factory:TEST-production:original:TEST-line':'receipt:TEST-receipt',lineId:'TEST-line',factoryDecisionId:null,quantityVersion:'TEST-quantity',quantity:2};
 const plan:WashingPlan={id:'TEST-plan',orderId:'TEST-order',lineId:scope.lineId,version:1,document:{sourceRef:'TEST original adoption',fee:{kind:'pending'},
  arrangement:{mode,reference:'TEST original standard',revision:1,accounting:'additional',
   washing:{minutes:180,calendar:'continuous',reminder:{enabled:true,percent:80}},
   inspection:{minutes:60,calendar:'continuous',reminder:{enabled:true,percent:80}}}}};
 const event=(id:string,kind:string,sequence:number,payload:Record<string,unknown>):WashingEvent=>({id,kind,sequence,payload,planId:plan.id,
  scopeId:scope.scopeId,quantityVersion:scope.quantityVersion,occurredAt:`2026-11-10T0${sequence}:00:00.000Z`,recordedAt:'2026-11-11T00:00:00.000Z',operator:'TEST operator'});
 const start=mode==='factory'?'factory_start':'send',complete=mode==='factory'?'factory_complete':'return',parent=mode==='factory'?'startId':'sendId';
 const events=[event('TEST-first',start,1,{quantity:2}),event('TEST-first-return',complete,2,{[parent]:'TEST-first',quantity:2}),
  event('TEST-first-check','inspection',3,{completionId:'TEST-first-return',quantity:2,qualifiedQuantity:1}),
  event('TEST-rewash',start,4,{quantity:1,reworkOfInspectionId:'TEST-first-check'}),
  event('TEST-rewash-return',complete,5,{[parent]:'TEST-rewash',quantity:1}),
  event('TEST-rewash-check','inspection',6,{completionId:'TEST-rewash-return',quantity:1,qualifiedQuantity:1})];
 return {plan,events,scope};
};

it.each(['factory','after_receipt'] as const)('identifies the real new %s round without turning native clocks into a formal plan',mode=>{
 const {plan,events,scope}=fixture(mode),before=structuredClone(events),[source]=nativeWashingReworkSources('TEST-order',scope,[plan],events);
 expect(source).toMatchObject({startEventId:'TEST-rewash',originalInspectionId:'TEST-first-check',round:1,quantity:1,planId:plan.id});
 expect(source!.references.washing).not.toBe(source!.references.inspection);
 const later:WashingPlan={...structuredClone(plan),id:'TEST-later-plan',version:9};
 if(later.document.arrangement.mode!=='none')later.document.arrangement.washing.minutes=999;
 expect(nativeWashingReworkSources('TEST-order',scope,[plan,later],events)).toEqual([source]);
 expect(nativeWashingReworkSources('TEST-order',scope,[plan],[...events].reverse())).toEqual([source]);
 expect(source!.adoptedArrangement.washing.minutes).toBe(180);
 expect(source).not.toHaveProperty('expectedAt');expect(source).not.toHaveProperty('deadline');expect(source).not.toHaveProperty('plannedAt');
 expect(events).toEqual(before);
});

it('does not borrow another order, PO, quantity revision or failed inspection',()=>{
 const {plan,events,scope}=fixture('after_receipt');
 expect(()=>nativeWashingReworkSources('TEST-other-order',scope,[plan],events)).toThrow('订单或PO不一致');
 expect(()=>nativeWashingReworkSources('TEST-order',{...scope,lineId:'TEST-other-line'},[plan],events)).toThrow('订单或PO不一致');
 expect(()=>nativeWashingReworkSources('TEST-order',{...scope,quantityVersion:'TEST-new-quantity'},[plan],events)).toThrow('数量已更正');
 const foreign=events.map(event=>event.id==='TEST-first-check'?{...event,scopeId:'TEST-foreign-scope'}:event);
 expect(()=>nativeWashingReworkSources('TEST-order',scope,[plan],foreign)).toThrow('本批此前有效的不合格检查');
 expect(()=>nativeWashingReworkSources('TEST-order',scope,[plan],[...events,events[3]!])).toThrow('身份重复');
});

it('keeps the original factory decision coupled to the exact native scope',()=>{
 const {plan,events,scope}=fixture('factory');
 expect(()=>nativeWashingReworkSources('TEST-order',{...scope,factoryDecisionId:'TEST-other-factory-decision'},[plan],events)).toThrow('工厂身份与原批范围不一致');
});

it('retains identity with unknown occurrence times and does not invent a replacement for voided work',()=>{
 const {plan,events,scope}=fixture('factory'),source=nativeWashingReworkSources('TEST-order',scope,[plan],events);
 expect(nativeWashingReworkSources('TEST-order',scope,[plan],events.map(event=>({...event,occurredAt:null})))).toEqual(source);
 const voids=events.slice(3).reverse().map((event,index):WashingEvent=>({...event,id:`TEST-void-${index}`,kind:'void',sequence:7+index,payload:{factId:event.id}}));
 expect(nativeWashingReworkSources('TEST-order',scope,[plan],[...events,...voids])).toEqual([]);
 expect(events).toHaveLength(6);
});
