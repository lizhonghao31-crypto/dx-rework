// @vitest-environment jsdom
import {act,createElement,type ReactNode} from 'react';
import {createRoot} from 'react-dom/client';
import {expect,it,vi} from 'vitest';
import {ProductionDashboardPage} from '../../apps/web/src/production-dashboard-page.js';

vi.mock('../../apps/web/src/auth.js',()=>({verifySession:async()=>'denied'}));
vi.mock('../../apps/web/src/components.js',()=>({
 Header:()=>null, Shell:({children}:{children:ReactNode})=>children,
}));
vi.mock('../../apps/web/src/todo-content-read.js',()=>({
 TodoReadBoundary:({children}:{children:ReactNode})=>children, useTodoContentRead:()=>null,
}));

it('accepts one settled search, rejects a late result, and refreshes only the same filter',async()=>{
 vi.useFakeTimers();
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 vi.stubGlobal('matchMedia',()=>({matches:false,addEventListener:()=>{},removeEventListener:()=>{}}));
 const host=document.createElement('div');document.body.append(host);
 const root=createRoot(host);
 const calls:Array<{query:URLSearchParams;signal:AbortSignal}>=[];
 const start='2026-11-20T04:00:00.000Z', stale='2026-11-20T05:00:00.000Z', current='2026-11-20T06:00:00.000Z';
 const response=(asOf:string)=>Response.json({asOf,items:[],page:1,pageSize:15,totalCount:0,
  counts:{inProduction:0,completed:0,shipped:0,attention:0},suppliers:[],events:[]});
 let finishOld!:(value:Response)=>void,finishRefresh!:(value:Response)=>void;
 const old=new Promise<Response>(resolve=>{finishOld=resolve;}),refresh=new Promise<Response>(resolve=>{finishRefresh=resolve;});
 vi.stubGlobal('fetch',vi.fn((input:string,init:RequestInit)=>{
  const query=new URL(input,'http://localhost').searchParams;
  calls.push({query,signal:init.signal!});
  if(query.has('previousAsOf'))return refresh;
  if(query.get('q')==='OLD')return old;
  return Promise.resolve(response(query.get('q')==='NEW'?current:start));
 }));
 try{
  await act(async()=>root.render(createElement(ProductionDashboardPage,{})));
  expect(calls).toHaveLength(1);
  const input=host.querySelector<HTMLInputElement>('input[placeholder="款号或供应商"]')!;
  const enter=async(value:string)=>act(async()=>{
   Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!.set!.call(input,value);
   input.dispatchEvent(new Event('input',{bubbles:true}));
  });
  const advance=(ms:number)=>act(async()=>{await vi.advanceTimersByTimeAsync(ms);});
  await enter('O');await advance(100);await enter('OLD');await advance(249);
  expect(calls).toHaveLength(1);
  await advance(1);expect(calls.map(call=>call.query.get('q'))).toEqual([null,'OLD']);
  await enter('NEW');
  expect(calls[1]!.signal.aborted).toBe(true);
  await advance(250);
  expect(calls.map(call=>call.query.get('q'))).toEqual([null,'OLD','NEW']);
  await act(async()=>{finishOld(response(stale));});
  expect(host.querySelector('time')?.dateTime).toBe(current);
  await enter('NEW ');await advance(400);
  expect(calls).toHaveLength(3);
  const refreshButton=[...host.querySelectorAll('button')].find(button=>button.textContent?.includes('刷新'))!;
  await act(async()=>{refreshButton.click();refreshButton.click();});
  expect(calls).toHaveLength(4);
  expect(calls[3]!.query.get('q')).toBe('NEW');
  expect(calls[3]!.query.get('previousAsOf')).toBe(current);
  await act(async()=>{finishRefresh(response(current));});
 }finally{
  await act(async()=>root.unmount());host.remove();
  vi.unstubAllGlobals();vi.useRealTimers();
 }
});
