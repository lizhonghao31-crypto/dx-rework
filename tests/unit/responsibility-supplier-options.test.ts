import {randomUUID} from 'node:crypto';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {loadResponsibilitySuppliers,responsibilitySupplierField} from '../../apps/web/src/responsibility-supplier-options.js';

const url='/api/rework-orders/fixture/responsibility-determinations/supplier-options';
const supplier={supplierId:randomUUID(),supplierType:'factory',supplierName:'TEST isolated correct factory'};
const respond=(body:unknown,status=200)=>vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}})));

describe('N07 supplier load states',()=>{
 afterEach(()=>vi.unstubAllGlobals());
 it('keeps a contract-valid factory and the authenticated read-only request',async()=>{
  respond({items:[supplier]});const controller=new AbortController();
  expect(await loadResponsibilitySuppliers(url,controller.signal)).toEqual({kind:'ready',items:[supplier]});
  expect(fetch).toHaveBeenCalledExactlyOnceWith(url,{credentials:'include',headers:{accept:'application/json'},signal:controller.signal});
 });
 it('represents an actual successful empty catalog separately from failure',async()=>{
  respond({items:[]});const state=await loadResponsibilitySuppliers(url);
  expect(state).toEqual({kind:'ready',items:[]});
  expect(responsibilitySupplierField(state,0)).toMatchObject({disabled:false,placeholder:'没有可用的该类供应商'});
 });
 it.each([401,403])('represents HTTP %s as no permission, not an empty catalog',async status=>{
  respond({error:{message:'denied'}},status);const state=await loadResponsibilitySuppliers(url);
  expect(state).toMatchObject({kind:'forbidden'});expect(state).not.toHaveProperty('items');
  expect(responsibilitySupplierField(state,0)).toMatchObject({disabled:true,placeholder:'无权读取供应商'});
 });
 it.each([404,500,503])('represents HTTP %s as a loading failure',async status=>{
  respond({error:{message:'unavailable'}},status);const state=await loadResponsibilitySuppliers(url);
  expect(state).toMatchObject({kind:'error'});expect(state).not.toHaveProperty('items');
  expect(responsibilitySupplierField(state,0)).toMatchObject({disabled:true,placeholder:'供应商加载失败'});
 });
 it('does not present network errors as no matching factory',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('connection failed')));
  expect(await loadResponsibilitySuppliers(url)).toMatchObject({kind:'error'});
 });
 it('does not silently coerce the out-of-contract other supplier type into a factory or an empty list',async()=>{
  respond({items:[supplier,{supplierId:randomUUID(),supplierType:'other',supplierName:'TEST unrelated catalog type'}]});
  expect(await loadResponsibilitySuppliers(url)).toMatchObject({kind:'error'});
 });
 it('does not interpret a malformed body as an empty catalog',async()=>{
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('not json',{status:200})));
  expect(await loadResponsibilitySuppliers(url)).toMatchObject({kind:'error'});
 });
 it('disables loading selectors and distinguishes a ready type-specific empty result',()=>{
  expect(responsibilitySupplierField({kind:'loading'},0)).toMatchObject({disabled:true,placeholder:'正在加载供应商…'});
  expect(responsibilitySupplierField({kind:'ready',items:[]},0)).toMatchObject({disabled:false,placeholder:'没有可用的该类供应商'});
  expect(responsibilitySupplierField({kind:'ready',items:[]},1)).toMatchObject({disabled:false,placeholder:'选择供应商'});
 });
});
