import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = () => {
  const entries = new Map<string,string>();
  return { getItem:(key:string)=>entries.get(key)??null, setItem:(key:string,value:string)=>entries.set(key,value), removeItem:(key:string)=>entries.delete(key) };
};
let local:ReturnType<typeof store>,tab:ReturnType<typeof store>,replace:ReturnType<typeof vi.fn>;
beforeEach(()=>{
  vi.resetModules();local=store();tab=store();replace=vi.fn();
  vi.stubGlobal("window",{localStorage:local,sessionStorage:tab,location:{pathname:"/ui/home",search:"",replace},addEventListener:vi.fn(),removeEventListener:vi.fn()});
  vi.stubGlobal("BroadcastChannel",undefined);
});
afterEach(()=>{vi.unstubAllGlobals();vi.unstubAllEnvs();});

describe("current browser logout",()=>{
  it("revokes first, records explicit logout and replaces the current page",async()=>{
    const fetcher=vi.fn(async()=>{expect(local.getItem("dx-rework:logged-out:/")).toBeNull();return new Response(null,{status:204});});
    vi.stubGlobal("fetch",fetcher);
    const {exitCurrentSession}=await import("../../apps/web/src/session-exit.js");
    expect(await exitCurrentSession()).toBe(true);
    expect(fetcher).toHaveBeenCalledWith("/api/auth/logout",{method:"POST",credentials:"include",cache:"no-store"});
    expect(local.getItem("dx-rework:logged-out:/")).toBeTruthy();expect(replace).toHaveBeenCalledWith("/auth/logged-out");
  });
  it("does not revoke or clear identity when an existing unsaved guard is cancelled",async()=>{
    const fetcher=vi.fn();vi.stubGlobal("fetch",fetcher);
    const {registerInternalNavigationGuard}=await import("../../apps/web/src/internal-navigation.js");
    const unregister=registerInternalNavigationGuard(async()=>false);
    try {expect(await(await import("../../apps/web/src/session-exit.js")).exitCurrentSession()).toBe(false);}finally{unregister();}
    expect(fetcher).not.toHaveBeenCalled();expect(replace).not.toHaveBeenCalled();expect(local.getItem("dx-rework:logged-out:/")).toBeNull();
  });
  it.each(["http","network"])("does not pretend logout succeeded after %s failure; a retry is allowed",async kind=>{
    const fetcher=vi.fn();if(kind==="http")fetcher.mockResolvedValueOnce(new Response(null,{status:500}));else fetcher.mockRejectedValueOnce(new Error("TEST network"));
    fetcher.mockResolvedValueOnce(new Response(null,{status:204}));vi.stubGlobal("fetch",fetcher);
    const {exitCurrentSession}=await import("../../apps/web/src/session-exit.js");
    await expect(exitCurrentSession()).rejects.toThrow();expect(replace).not.toHaveBeenCalled();expect(local.getItem("dx-rework:logged-out:/")).toBeNull();
    expect(await exitCurrentSession()).toBe(true);expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("shares one outstanding confirmation and request across repeated clicks",async()=>{
    let done!:(r:Response)=>void;const fetcher=vi.fn(()=>new Promise<Response>(resolve=>{done=resolve;}));vi.stubGlobal("fetch",fetcher);
    const {exitCurrentSession}=await import("../../apps/web/src/session-exit.js");const first=exitCurrentSession(),second=exitCurrentSession();expect(first).toBe(second);
    await vi.waitFor(()=>expect(fetcher).toHaveBeenCalledTimes(1));done(new Response(null,{status:204}));expect(await Promise.all([first,second])).toEqual([true,true]);
  });
  it("keeps a newer logout blocked when an older login completes",async()=>{
    const state=await import("../../apps/web/src/logout-state.js");const old=state.markLoggedOut(),newer=state.markLoggedOut();
    expect(state.completeExplicitLogin(old)).toBe(false);expect(state.logoutMarker()).toBe(newer);
    expect(state.completeExplicitLogin(newer)).toBe(true);expect(state.logoutMarker()).toBeNull();
  });
  it("isolates application paths and persists through a fresh module load",async()=>{
    vi.stubEnv("BASE_URL","/acceptance/");const state=await import("../../apps/web/src/logout-state.js");state.markLoggedOut();
    expect(state.logoutStorageKey).toBe("dx-rework:logged-out:/acceptance/");expect(local.getItem("dx-rework:logged-out:/")).toBeNull();
    vi.resetModules();expect((await import("../../apps/web/src/logout-state.js")).logoutMarker()).toBeTruthy();
  });
  it("keeps logout intent in the tab when persistent storage refuses writes",async()=>{
    vi.stubGlobal("window",{localStorage:{...local,setItem:()=>{throw new Error("TEST quota");}},sessionStorage:tab,location:{pathname:"/ui/home",search:"",replace}});
    const state=await import("../../apps/web/src/logout-state.js");expect(state.logoutMarker()).toBeNull();const marker=state.markLoggedOut();expect(state.logoutMarker()).toBe(marker);
    vi.resetModules();expect((await import("../../apps/web/src/logout-state.js")).logoutMarker()).toBe(marker);
  });
});
