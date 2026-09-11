import { afterEach, describe, expect, it, vi } from "vitest";
afterEach(()=>{vi.unstubAllGlobals();vi.resetModules();});
const session=(id:string)=>({status:"authorized",user:{id,displayName:id,capabilities:[],businessRoles:[]}});
describe("uncached task identity restoration",()=>{
 it("refreshes cached identity and prevents late old requests replacing it",async()=>{
  let completeOld:(value:unknown)=>void=()=>{};
  const old=new Promise(resolve=>{completeOld=resolve;});
  const fetcher=vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce({ok:true,json:async()=>session('new')});vi.stubGlobal('fetch',fetcher);
  const {verifySession}=await import('../../apps/web/src/auth.js');
  const pending=verifySession();expect(await verifySession(true)).toEqual(session('new'));
  completeOld({ok:true,json:async()=>session('old')});await pending;
  expect(await verifySession()).toEqual(session('new'));expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({cache:'no-store'});
 });
 it("performs a fresh request after a previously resolved identity",async()=>{
  const fetcher=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>session('old')}).mockResolvedValueOnce({ok:true,json:async()=>session('new')});vi.stubGlobal('fetch',fetcher);
  const {verifySession}=await import('../../apps/web/src/auth.js');
  expect(await verifySession()).toEqual(session('old'));expect(await verifySession(true)).toEqual(session('new'));
 });
});
