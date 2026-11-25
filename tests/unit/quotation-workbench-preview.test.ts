// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {QuotationWorkbenchPreviewSchema} from '@dx-rework/contracts/digital-quotation';
import {QuotationWorkbenchPricing} from '../../apps/web/src/quotation-workbench-pricing.js';
import {digitalRequest,DigitalRequestError} from '../../apps/web/src/digital-production-api.js';
import type * as DigitalProductionApi from '../../apps/web/src/digital-production-api.js';

vi.mock('../../apps/web/src/digital-production-api.js',async importOriginal=>({
 ...await importOriginal<typeof DigitalProductionApi>(),digitalRequest:vi.fn(),
}));
vi.mock('../../apps/web/src/system-dialog.js',()=>({alertInApp:vi.fn(async()=>{}),confirmInApp:vi.fn(async()=>false)}));

const resource={kind:'source',id:'20fda092-7502-4612-8af4-251bc206a13c'} as const;
const quoteId='7cd3f988-a895-4cbb-8a3a-bf9d0fbac507';
const path=`sources/${resource.id}/quotation`;
const preview=QuotationWorkbenchPreviewSchema.parse({resource,quoteId,version:1,unitCost:'1.23456789',
 status:'awaiting_customer_confirmation',counts:{returned:0,resubmitted:0,incomplete:0,pendingCraftApproval:0},
 reviews:[],saved:{input:{field:'multiplier',value:'137.5'},version:1},confirmation:'joint_release_ready'});

function mountPricing(){
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const element=document.createElement('div');
 document.body.append(element);
 const root=createRoot(element),onAdopt=vi.fn();
 const read=vi.mocked(digitalRequest);
 const render=async(value=preview,refresh=0)=>{
  read.mockResolvedValue(value);
  await act(async()=>root.render(createElement(QuotationWorkbenchPricing,{path,quoteId,version:value.version,refresh,
   disabled:false,rowNames:new Map(),onAdopt})));
 };
 const inputs=()=>[...element.querySelectorAll('input')] as [HTMLInputElement,HTMLInputElement];
 const adoptButton=()=>[...element.querySelectorAll('button')].find(button=>button.textContent==='用于本单客户确认');
 const close=async()=>{
  await act(async()=>root.unmount());
  element.remove();
  vi.unstubAllGlobals();
 };
 return {element,onAdopt,read,render,inputs,adoptButton,close};
}

async function fill(input:HTMLInputElement,value:string){
 await act(async()=>input.focus());
 await act(async()=>{
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
  input.dispatchEvent(new Event('input',{bubbles:true}));
 });
}

it('shows a compact calculation and conveys only the exact saved basis to the existing confirmation action',async()=>{
 const h=mountPricing();
 try{
  await h.render();
  const [rate,price]=h.inputs();
  expect(h.element.textContent).toContain('成本合计 1.2 元/件');
  expect(h.element.querySelector('[title="精确成本 1.23456789 元/件"]')).not.toBeNull();
  expect(rate.value).toBe('137.5');
  expect(price.value).toBe('1.7');
  await act(async()=>price.focus());
  expect(price.value).toBe('1.697531');
  await act(async()=>price.blur());
  expect(price.value).toBe('1.7');
  await act(async()=>h.adoptButton()!.click());
  expect(h.onAdopt).toHaveBeenCalledExactlyOnceWith({field:'multiplier',value:'137.5'},'1.697531');
  expect(h.read.mock.calls.map(call=>[call[0],call[1]])).toEqual([[`${path}/workbench-pricing`,'GET']]);
 }finally{await h.close();}
});

it('keeps the last precisely typed amount and updates just its counterpart when authorized cost changes',async()=>{
 const h=mountPricing();
 try{
  await h.render({...preview,unitCost:'100'});
  const [,price]=h.inputs();
  await fill(price,'80.000001');
  expect(h.inputs().map(input=>input.value)).toEqual(['80','80.000001']);
  await act(async()=>price.blur());
  expect(price.value).toBe('80');
  await h.render({...preview,unitCost:'160'},1);
  expect(h.inputs().map(input=>input.value)).toEqual(['50','80']);
  expect(h.element.textContent).toContain('成本版本已更新，已按原输入重新测算。');
  const [rate,retainedPrice]=h.inputs();
  await act(async()=>retainedPrice.focus());
  expect(retainedPrice.value).toBe('80.000001');
  await act(async()=>h.adoptButton()!.click());
  expect(h.onAdopt).toHaveBeenLastCalledWith({field:'customerUnitPrice',value:'80.000001'},'80.000001');
  await fill(rate,'130');
  expect(retainedPrice.value).toBe('208');
  expect(h.element.textContent).not.toContain('成本版本已更新');
  await act(async()=>h.adoptButton()!.click());
  expect(h.onAdopt).toHaveBeenLastCalledWith({field:'multiplier',value:'130'},'208');
  expect(h.read.mock.calls.map(call=>call[1])).toEqual(['GET','GET']);
 }finally{await h.close();}
});

it('does not double-round the inverse rate, divide by zero or expose an adopt action before joint release',async()=>{
 const h=mountPricing();
 try{
  const gated={...preview,unitCost:'1000',saved:null,confirmation:'awaiting_joint_release'} as const;
  await h.render(gated);
  await fill(h.inputs()[1],'0.4996');
  expect(h.inputs()[0].value).toBe('<0.1');
  expect(h.adoptButton()).toBeUndefined();
  expect(h.element.textContent).toContain('当前仅供测算');
  await h.render({...gated,unitCost:'0'},1);
  expect(h.inputs().map(input=>input.value)).toEqual(['','0.5']);
  expect(h.element.textContent).toContain('成本为零，报价倍率无法计算。');
  await h.render({...gated,unitCost:null,status:'incomplete'},2);
  expect(h.inputs().map(input=>input.value)).toEqual(['','0.5']);
  expect(h.element.textContent).toContain('成本合计 待补齐');
  expect(h.adoptButton()).toBeUndefined();
  expect(h.onAdopt).not.toHaveBeenCalled();
  expect(h.read.mock.calls.map(call=>call[1])).toEqual(['GET','GET','GET']);
 }finally{await h.close();}
});

it('writes the original precise draft once and retries only the read after a verified save receipt',async()=>{
 const h=mountPricing();
 const button=(label:string)=>[...h.element.querySelectorAll('button')].find(item=>item.textContent===label)!;
 try{
  await h.render({...preview,unitCost:'100'});
  await fill(h.inputs()[1],'81.000001');
  expect(h.read.mock.calls.map(call=>call[1])).toEqual(['GET']);
  h.read.mockImplementation(async(_route,method)=>{
   if(method==='PUT')return {resource,quoteId,version:1,commandReceipt:{action:'workbench-pricing-draft',appliedVersion:1}};
   throw Error('TEST 重新读取失败');
  });
  await act(async()=>button('保存报价测算').click());
  const writes=h.read.mock.calls.filter(call=>call[1]==='PUT');
  expect(writes).toHaveLength(1);
  expect(writes[0]?.slice(0,3)).toEqual([`${path}/workbench-pricing`,'PUT',{
   expectedVersion:1,input:{field:'customerUnitPrice',value:'81.000001'},
  }]);
  expect(writes[0]?.[3]).toBeTruthy();
  expect(h.element.textContent).toContain('报价测算已保存，重新读取失败');
  h.read.mockResolvedValue({...preview,unitCost:'100',saved:{version:1,input:{field:'customerUnitPrice',value:'81.000001'}}});
  await act(async()=>button('重新读取成本').click());
  expect(h.read.mock.calls.map(call=>call[1])).toEqual(['GET','PUT','GET','GET']);
  expect(h.element.textContent).toContain('测算不等于客户确认');
  expect(h.onAdopt).not.toHaveBeenCalled();
 }finally{await h.close();}
});

it('after an unknown draft receipt retries with the exact original request rather than a new save',async()=>{
 const h=mountPricing();
 const button=(label:string)=>[...h.element.querySelectorAll('button')].find(item=>item.textContent===label)!;
 const current={...preview,unitCost:'100'};
 const saved={...current,saved:{version:1,input:{field:'multiplier' as const,value:'130.000001'}}};
 let writes=0;
 try{
  await h.render(current);
  await fill(h.inputs()[0],'130.000001');
  h.read.mockImplementation(async(_route,method)=>{
   if(method!=='PUT')return saved;
   if(++writes===1)throw new DigitalRequestError('TEST lost receipt',null,'NETWORK_ERROR');
   return {resource,quoteId,version:1,commandReceipt:{action:'workbench-pricing-draft',appliedVersion:1}};
  });
  await act(async()=>button('保存报价测算').click());
  expect(button('保存报价测算').getAttribute('aria-disabled')).toBe('true');
  await act(async()=>button('保存报价测算').click());
  expect(writes).toBe(1);
  await act(async()=>button('核对原报价测算保存结果').click());
  const requests=h.read.mock.calls.filter(call=>call[1]==='PUT');
  expect(requests).toHaveLength(2);
  expect(requests[1]).toEqual(requests[0]);
  expect(h.element.textContent).toContain('已保存报价测算，尚未记录客户确认');
  expect(h.onAdopt).not.toHaveBeenCalled();
 }finally{await h.close();}
});
