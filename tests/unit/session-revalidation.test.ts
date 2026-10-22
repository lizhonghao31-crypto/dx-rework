import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";

const session=(id="same",roles=["development_clerk"],capabilities=["todo:view"])=>({status:"authorized",user:{id,displayName:id,businessRoles:roles,capabilities}});
beforeEach(()=>vi.resetModules());
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();});

describe("task-entry identity revalidation",()=>{
 it("rechecks a cached identity and shares an in-flight read without invalidating an unchanged gate",async()=>{
  let release!:(value:Response)=>void;
  const fetcher=vi.fn().mockResolvedValueOnce(Response.json(session())).mockImplementationOnce(()=>new Promise<Response>(done=>{release=done;}));vi.stubGlobal("fetch",fetcher);
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const reset=vi.fn();state.registerSessionInvalidator(reset);
  const first=state.refreshSessionResult(),second=state.refreshSessionResult();expect(first).toBe(second);release(Response.json(session()));
  expect((await first).session).toEqual(session());expect(reset).not.toHaveBeenCalled();expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await state.verifySession()).toEqual(session());expect(fetcher).toHaveBeenCalledTimes(2);
 });
 it.each([session("different"),session("same",[]),session("same",["development_clerk"],[])])("publishes changed identity or permissions before notifying all dependent gates",async next=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(session())).mockResolvedValueOnce(Response.json(next)));
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const reads:unknown[]=[];
  state.registerSessionInvalidator(()=>reads.push(state.cachedVerifiedSession()));await state.refreshSession();expect(reads).toEqual([next]);
 });
 it("does not treat reordered role/capability arrays as a new identity",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(session("same",["a","b"],["x","y"]))).mockResolvedValueOnce(Response.json(session("same",["b","a"],["y","x"]))));
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const reset=vi.fn();state.registerSessionInvalidator(reset);await state.refreshSession();expect(reset).not.toHaveBeenCalled();
 });
 it.each([401,403,503])("invalidates a previously authorized gate on HTTP %i",async status=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(session())).mockResolvedValueOnce(new Response("",{status})));
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const reset=vi.fn();state.registerSessionInvalidator(reset);
  expect(await state.refreshSessionResult()).toEqual({session:"denied",requestFailed:status===503});expect(reset).toHaveBeenCalledTimes(1);expect(state.cachedVerifiedSession()).toBe("denied");
 });
 it("keeps explicit logout stronger than a late revalidation",async()=>{
  let release!:(value:Response)=>void;vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(session())).mockImplementationOnce(()=>new Promise<Response>(done=>{release=done;})));
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const pending=state.refreshSession();state.invalidateSession();release(Response.json(session()));expect(await pending).toBe("denied");expect(state.cachedVerifiedSession()).toBeUndefined();
 });
 it("a cancelled task recheck removes prior admission and offers recovery instead of remounting with a stale identity",async()=>{
  vi.stubGlobal("fetch",vi.fn().mockResolvedValueOnce(Response.json(session())).mockRejectedValueOnce(new DOMException("TEST abort","AbortError")));
  const state=await import("../../apps/web/src/auth-session.js");await state.verifySession();const reset=vi.fn();state.registerSessionInvalidator(reset);
  expect(await state.refreshSessionResult()).toEqual({session:"denied",requestFailed:true,cancelled:true});expect(state.cachedVerifiedSession()).toBe("denied");expect(reset).toHaveBeenCalledTimes(1);
 });
 it("bounds a hung read, fails closed, and allows an explicit retry without accepting its late response",async()=>{
  vi.useFakeTimers();let release!:(value:Response)=>void;const fetcher=vi.fn().mockImplementationOnce(()=>new Promise<Response>(done=>{release=done;})).mockResolvedValueOnce(Response.json(session("new")));vi.stubGlobal("fetch",fetcher);
  const state=await import("../../apps/web/src/auth-session.js");const pending=state.verifySessionResult();await vi.advanceTimersByTimeAsync(state.SESSION_READ_TIMEOUT_MS);
  expect(await pending).toEqual({session:"denied",requestFailed:true});expect(await state.verifySession(true)).toEqual(session("new"));release(Response.json(session("old")));await Promise.resolve();expect(state.cachedVerifiedSession()).toEqual(session("new"));
 });
});
