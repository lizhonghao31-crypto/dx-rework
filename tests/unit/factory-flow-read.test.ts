// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import type {FactoryFlowSheet} from '@dx-rework/contracts/factory-flow';
import {useFactoryFlowRead} from '../../apps/web/src/factory-flow-read.js';
const {request}=vi.hoisted(()=>({request:vi.fn()}));
vi.mock('../../apps/web/src/digital-production-api.js',()=>({digitalRequest:request}));
let root:ReturnType<typeof createRoot>,container:HTMLDivElement,value:ReturnType<typeof useFactoryFlowRead>;
const sheet=(orderId:string,canManage=false)=>({orderId,canManage,lines:[],tasks:[],revision:1}) as unknown as FactoryFlowSheet;
function Harness({id='TEST-a',enabled=true}:{id?:string;enabled?:boolean}){value=useFactoryFlowRead(id,enabled);return createElement('span',null,value.readError||value.sheet?.orderId||'');}
const render=(id='TEST-a',enabled=true)=>act(async()=>root.render(createElement(Harness,{id,enabled})));
const deferred=<T,>()=>{let resolve!:(v:T)=>void,reject!:(v:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
beforeEach(()=>{Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});request.mockReset();container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();});
it('ends denied loading and retries the original factory read without retaining the old error',async()=>{
 request.mockRejectedValueOnce(Error('资料不存在或不在授权范围'));await render();
 expect(value).toMatchObject({sheet:null,people:[],loading:false,readError:'资料不存在或不在授权范围'});
 request.mockResolvedValueOnce(sheet('TEST-a'));await act(async()=>{await value.reload();});
 expect(value).toMatchObject({sheet:{orderId:'TEST-a'},loading:false,readError:''});
});
it('clears a previous authorized snapshot while a new read is pending and after revocation',async()=>{
 request.mockResolvedValueOnce(sheet('TEST-a'));await render();const next=deferred<FactoryFlowSheet>();request.mockReturnValueOnce(next.promise);
 let reading!:Promise<void>;await act(async()=>{reading=value.reload().catch(()=>undefined);});
 expect(value).toMatchObject({sheet:null,people:[],loading:true});
 await act(async()=>{next.reject(Error('无权访问'));await reading;});expect(value).toMatchObject({sheet:null,loading:false,readError:'无权访问'});
});
it('keeps an authorized factory sheet when only optional personnel loading fails',async()=>{
 request.mockResolvedValueOnce(sheet('TEST-a',true)).mockRejectedValueOnce(Error('人员资料读取失败'));await render();
 expect(value).toMatchObject({sheet:{orderId:'TEST-a'},people:[],loading:false,readError:'',peopleError:'人员资料读取失败'});
});
it('ignores a late former-order response and rejects a mismatched current-order DTO',async()=>{
 const old=deferred<FactoryFlowSheet>();request.mockReturnValueOnce(old.promise).mockResolvedValueOnce(sheet('TEST-b'));await render();await render('TEST-b');
 await act(async()=>old.resolve(sheet('TEST-a',true)));expect(value.sheet?.orderId).toBe('TEST-b');expect(request).toHaveBeenCalledTimes(2);
 request.mockResolvedValueOnce(sheet('TEST-a'));await act(async()=>{await value.reload().catch(()=>undefined);});expect(value).toMatchObject({sheet:null,loading:false,readError:'工厂资料回执不完整'});
});
it('does not let an older read overwrite an acknowledged native write or load unauthorized people',async()=>{
 const old=deferred<FactoryFlowSheet>();request.mockReturnValueOnce(old.promise);await render();
 await act(async()=>value.accept({...sheet('TEST-a'),revision:2}));await act(async()=>old.resolve(sheet('TEST-a',true)));
 expect(value.sheet?.revision).toBe(2);expect(value.people).toEqual([]);expect(request).toHaveBeenCalledTimes(1);
});
it('does not fetch factory metadata for the dedicated washing route or after unmount',async()=>{
 await render('TEST-a',false);expect(request).not.toHaveBeenCalled();expect(value).toMatchObject({sheet:null,loading:false,readError:''});
 const old=deferred<FactoryFlowSheet>();request.mockReturnValueOnce(old.promise);await render();await act(async()=>root.unmount());await act(async()=>old.resolve(sheet('TEST-a',true)));expect(request).toHaveBeenCalledTimes(1);
 root=createRoot(container);
});
