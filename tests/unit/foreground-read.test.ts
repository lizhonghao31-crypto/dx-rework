// @vitest-environment jsdom
import {act,createElement} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach,expect,it,vi} from 'vitest';
import {useForegroundRead} from '../../apps/web/src/use-foreground-read.js';
import {invalidateSession} from '../../apps/web/src/auth-session.js';

afterEach(()=>vi.unstubAllGlobals());

it('only preserves data within the same authorization scope and keeps write-triggered rereads silent',async()=>{
 vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);
 const pending:Array<{signal:AbortSignal;resolve:(value:string)=>void}>=[];
 const load=vi.fn((signal:AbortSignal)=>new Promise<string>(resolve=>pending.push({signal,resolve})));
 const element=document.createElement('div'),root=createRoot(element);
 let latest:ReturnType<typeof useForegroundRead<string>>;
 const Render=({scope,target}:{scope:string;target:string|null})=>{
  latest=useForegroundRead(scope,target,load,true);
  return null;
 };
 const render=async(scope:string,target:string|null)=>await act(async()=>root.render(createElement(Render,{scope,target})));
 const resolve=async(index:number,value:string)=>await act(async()=>pending[index]!.resolve(value));
 try{
  await render('private','first');
  expect(latest!.foregroundKey).toBeDefined();
  await resolve(0,'first authorized data');
  expect(latest!.foregroundKey).toBeUndefined();
  expect(latest!.value).toBe('first authorized data');

  await render('private','second');
  await render('private','second');
  expect(load).toHaveBeenCalledTimes(2);
  expect(latest!.value).toBe('first authorized data');
  expect(latest!.foregroundKey).toBeDefined();
  expect(latest!.loadedTarget).toBe('first');
  await render('private',null);
  expect(pending[1]!.signal.aborted).toBe(true);
  expect(latest!.value).toBe('first authorized data');
  expect(latest!.loadedTarget).toBe('first');
  expect(latest!.foregroundKey).toBeUndefined();
  await render('restricted','second');
  expect(pending[1]!.signal.aborted).toBe(true);
  expect(latest!.value).toBeNull();
  await resolve(1,'late private data');
  expect(latest!.value).toBeNull();

  await resolve(2,'second authorized data');
  await act(async()=>latest!.refreshSilently());
  expect(latest!.waiting).toBe(true);
  expect(latest!.foregroundKey).toBeUndefined();
  expect(latest!.value).toBe('second authorized data');
  await act(async()=>invalidateSession());
  expect(pending[3]!.signal.aborted).toBe(true);
  expect(latest!.value).toBeNull();
  await resolve(3,'discard invalidated response');
  expect(latest!.value).toBeNull();
  await resolve(4,'verified current response');
  expect(latest!.waiting).toBe(false);
  expect(latest!.value).toBe('verified current response');
 }finally{await act(async()=>root.unmount());}
});
