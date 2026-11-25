// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {QuotationConfirmationSchema,type QuotationSheet} from '@dx-rework/contracts/digital-quotation';
import {DigitalQuotationPanel} from '../../apps/web/src/digital-quotation-panel.js';
import {digitalRequest} from '../../apps/web/src/digital-production-api.js';
import type * as DigitalProductionApi from '../../apps/web/src/digital-production-api.js';

vi.mock('../../apps/web/src/digital-production-api.js',async importOriginal=>({
 ...await importOriginal<typeof DigitalProductionApi>(),digitalRequest:vi.fn(),
}));

const resource={kind:'source',id:'20fda092-7502-4612-8af4-251bc206a13c'} as const;
const quoteId='7cd3f988-a895-4cbb-8a3a-bf9d0fbac507';
const designerId='504e4952-50c0-4b19-b494-b75a91964470';
const path=`sources/${resource.id}/quotation`;
const historyConfirmation=QuotationConfirmationSchema.parse({customerCode:'TEST',expectedVersion:5,customerConfirmedTotal:'48.123456',
 amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'includes_tax',
 sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',
 evidenceNote:'TEST 第五版原始确认依据',confirmedAt:'2026-07-01T08:00:00.000Z'});
const draft:QuotationSheet={resource,quoteId,productionOrderId:null,sourceId:resource.id,designerId,customerCode:'TEST',
 designStyleNo:'TEST 本单',status:'draft',confirmedVersion:5,version:6,versions:[5],rows:[],assignments:[],document:null,
 confirmation:historyConfirmation,confirmedBy:'TEST 原登记人',fullCost:true,canStructure:false,canConfirm:true,complete:true,
 budget:{state:'waiting_formal_order',version:null}};

function mountPanel(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));
 vi.stubGlobal('ResizeObserver',class {observe(){} disconnect(){}});
 const element=document.createElement('div');
 document.body.append(element);
 const root=createRoot(element);
 const render=async (originalSnapshot?:QuotationSheet)=>await act(async()=>root.render(createElement(DigitalQuotationPanel,
  {resource,originalSnapshot,...(originalSnapshot?{}:{designerWorkbench:{actorId:designerId}})})));
 const click=async(label:string)=>await act(async()=>{
  const button=[...element.querySelectorAll('button')].find(value=>value.textContent===label);
  expect(button,`expected ${label} in the quotation panel`).toBeDefined();
  expect(button!.disabled).toBe(false);
  button!.click();
 });
 const close=async()=>{await act(async()=>root.unmount());element.remove();vi.unstubAllGlobals();};
 return {element,render,click,close};
}

async function fill(input:HTMLInputElement|HTMLTextAreaElement,value:string){
 await act(async()=>{
  const type=input instanceof HTMLTextAreaElement?HTMLTextAreaElement:HTMLInputElement;
  Object.getOwnPropertyDescriptor(type.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
}

it('keeps saved customer-price input and previous confirmation separate until an explicit exact confirmation',async()=>{
 const h=mountPanel(),request=vi.mocked(digitalRequest);
 const input={field:'customerUnitPrice',value:'49.654321'} as const;
 request.mockImplementation(async(endpoint,method='GET',body)=>{
  if(endpoint===path&&method==='GET')return draft;
  if(endpoint===`${path}/workbench-pricing`&&method==='GET')return {resource,quoteId,version:6,unitCost:'40.123456',
   status:'awaiting_customer_confirmation',counts:{returned:0,resubmitted:0,incomplete:0,pendingCraftApproval:0},reviews:[],
   saved:{input,version:5},confirmation:'joint_release_ready'};
  if(endpoint===`${path}/confirm`&&method==='POST')return {...draft,status:'confirmed',confirmedVersion:6,versions:[6,5],canConfirm:false,
   confirmation:QuotationConfirmationSchema.parse(body),commandReceipt:{action:'confirm',appliedVersion:6}};
  throw Error(`Unexpected request ${method} ${endpoint}`);
 });
 try{
  await h.render();
  expect(h.element.textContent).toContain('客户上次确认版：5');
  expect(h.element.textContent).toContain('客户确认单件金额：48.123456 元 · 含税');
  expect(h.element.textContent).toContain('已保存测算 · 报价 v5 · 客户单件报价 49.7 元/件 · 测算不等于客户确认');
  expect(h.element.querySelector('[title="客户单件报价 49.654321 元/件"]')).not.toBeNull();
  const amount=h.element.querySelector<HTMLInputElement>('input[aria-label="客户确认金额"]')!;
  expect(amount.value).toBe('');
  expect(request.mock.calls.every(([,method])=>method===undefined||method==='GET')).toBe(true);
  await h.click('用于本单客户确认');
  expect(amount.value).toBe('49.654321');
  expect(h.element.textContent).toContain('TEST 第五版原始确认依据');
  expect(request.mock.calls.some(([,method])=>method==='POST')).toBe(false);

  await fill(h.element.querySelector<HTMLInputElement>('input[type="datetime-local"]')!,'2026-07-02T10:00');
  await fill(h.element.querySelector<HTMLTextAreaElement>('textarea[aria-label="客户确认依据"]')!,'TEST 第六版实际客户同意');
  await h.click('记录客户报价确认并检查预算生成条件');
  const actions=request.mock.calls.filter(([,method])=>method==='POST');
  expect(actions).toHaveLength(1);
  expect(actions[0]).toEqual([`${path}/confirm`,'POST',expect.objectContaining({expectedVersion:6,customerConfirmedTotal:'49.654321',
   amountScope:'per_piece',taxBasis:'excludes_tax',currency:'人民币',workbenchPricing:input,evidenceNote:'TEST 第六版实际客户同意'}),expect.any(String)]);
  expect(h.element.textContent).toContain('客户确认单件金额：49.654321 元 · 不含税');
  expect(h.element.textContent).not.toContain('已保存测算');
 }finally{await h.close();}
});

it('renders the selected historical confirmation exactly and does not load the current pricing preview',async()=>{
 const h=mountPanel(),request=vi.mocked(digitalRequest);
 request.mockImplementation(async()=>{throw Error('Historical snapshot must not issue a new quotation request');});
 try{
  await h.render({...draft,version:5,status:'confirmed',confirmedVersion:6,versions:[6,5],canConfirm:false});
  expect(h.element.textContent).toContain('v5 · 客户已确认');
  expect(h.element.textContent).toContain('客户确认单件金额：48.123456 元 · 含税');
  expect(h.element.textContent).toContain('TEST 第五版原始确认依据');
  expect(h.element.querySelector('#quote-confirmation')).toBeNull();
  expect(h.element.textContent).not.toContain('已保存测算');
  expect(request).not.toHaveBeenCalled();
 }finally{await h.close();}
});
