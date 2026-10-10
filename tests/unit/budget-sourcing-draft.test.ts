import {describe,expect,it} from 'vitest';
import {budgetSourcingDraftKey,saveBudgetSourcingDraft,readBudgetSourcingDraft,recoverBudgetSourcingManual,clearBudgetSourcingDraft,type BudgetSourcingDraft} from '../../apps/web/src/budget-sourcing-draft.js';
import type {BudgetSourcingPreparation} from '@dx-rework/contracts/digital-budget';
const id=(digit:string)=>`${digit.repeat(8)}-${digit.repeat(4)}-4${digit.repeat(3)}-8${digit.repeat(3)}-${digit.repeat(12)}`;
const userId=id('1'),productionOrderId=id('2'),a=id('3'),b=id('4'),photo=id('5');
const storage=()=>{const data=new Map<string,string>();return{getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value);},removeItem:(key:string)=>{data.delete(key);}};};
const draft=():BudgetSourcingDraft=>({userId,productionOrderId,budgetVersion:1,orderVersion:1,savedAt:'2026-10-10T00:00:00.000Z',additionalMerchandiserUserId:'',estimatedCutPieceSendDate:'2026-11-01',deliveryDate:'2026-11-15',lines:[{lineId:a,factoryDeliveryDate:'2026-11-15',styleNo:'MANUAL-OLD',imageAttachmentId:photo},{lineId:b,factoryDeliveryDate:'2026-11-16',styleNo:'',imageAttachmentId:''}],extraImages:[{attachmentId:photo,filename:'TEST.png',mimeType:'image/png'}]});
const prepared=():BudgetSourcingPreparation=>({productionOrderId,budgetVersion:1,orderVersion:1,gender:'男装',styleName:'TEST上衣',contractDeliveryDate:null,daxingUnitPrice:'18.25',lineItems:[{lineId:a,styleNo:'SERVER-PO',alternateStyleNo:'SERVER-TEMP',color:'黑',quantity:100,customerWarehouseArrivalDate:'2026-11-20'},{lineId:b,styleNo:'SERVER-PO2',alternateStyleNo:'SERVER-TEMP2',color:'白',quantity:250,customerWarehouseArrivalDate:'2026-11-25'}],images:[]});
describe('budget sourced manual drafts',()=>{
 it('isolates login user, mother and version, and refuses a forged envelope or source price',()=>{
  const store=storage(),value=draft();saveBudgetSourcingDraft(store,value);
  expect(readBudgetSourcingDraft(store,value)).toEqual(value);expect(recoverBudgetSourcingManual(prepared(),value).lines[0]!.styleNo).toBe('MANUAL-OLD');
  expect(readBudgetSourcingDraft(store,{...value,userId:id('6')})).toBeNull();
  expect(readBudgetSourcingDraft(store,{...value,productionOrderId:id('7')})).toBeNull();
  store.setItem(budgetSourcingDraftKey(value),JSON.stringify({...value,userId:id('6')}));expect(readBudgetSourcingDraft(store,value)).toBeNull();
  store.setItem(budgetSourcingDraftKey(value),JSON.stringify({...value,daxingUnitPrice:'0.01'}));expect(readBudgetSourcingDraft(store,value)).toBeNull();
 });
 it('returns the old version explicitly for review while retaining all current PO identity, quantity and price',()=>{
  const store=storage(),old=draft();saveBudgetSourcingDraft(store,old);
  const current={...prepared(),budgetVersion:2,orderVersion:3,daxingUnitPrice:'28.50',lineItems:prepared().lineItems.map(line=>({...line,quantity:line.quantity+50}))};
  const found=readBudgetSourcingDraft(store,{...old,budgetVersion:2})!,result=recoverBudgetSourcingManual(current,found);
  expect(found.budgetVersion).toBe(1);expect(result.changed).toBe(true);
  expect(result.lines.map(line=>[line.styleNo,line.alternateStyleNo,line.quantity])).toEqual([['SERVER-PO','SERVER-TEMP',150],['SERVER-PO2','SERVER-TEMP2',300]]);
  expect(result.lines[0]!.factoryDeliveryDate).toBe('2026-11-15');expect(current.daxingUnitPrice).toBe('28.50');
 });
 it('drops stale PO and invalid dates and does not guess an old source image onto a new copy',()=>{
  const value=draft();value.lines[0]!.imageAttachmentId=id('8');
  const current={...prepared(),budgetVersion:2,lineItems:[{...prepared().lineItems[0]!,customerWarehouseArrivalDate:'2026-11-10'}],images:[{attachmentId:id('9'),filename:'CURRENT.png',mimeType:'image/png'}]};
  const result=recoverBudgetSourcingManual(current,value);expect(result.discarded).toBe(2);expect(result.lines[0]!.factoryDeliveryDate).toBe('');expect(result.lines[0]!.imageAttachmentId).toBe('');expect(result.images.map(image=>image.attachmentId)).toEqual([id('9'),photo]);
 });
 it('clears only the confirmed scope, preserves other users, and reports failed storage writes',()=>{
  const store=storage(),value=draft(),other={...value,userId:id('6')};saveBudgetSourcingDraft(store,value);saveBudgetSourcingDraft(store,other);clearBudgetSourcingDraft(store,value);expect(readBudgetSourcingDraft(store,value)).toBeNull();expect(readBudgetSourcingDraft(store,other)).toEqual(other);
  expect(()=>saveBudgetSourcingDraft({...store,setItem:()=>{throw Error('quota');}},value)).toThrow('quota');
 });
});
