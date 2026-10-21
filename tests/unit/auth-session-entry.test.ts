import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthorizedSession } from "../../apps/web/src/auth.js";

const authorized: AuthorizedSession = {
  status: "authorized",
  user: { id: "TEST-user", displayName: "TEST", capabilities: [], isRoot: true },
};

beforeEach(() => vi.resetModules());
afterEach(() => vi.unstubAllGlobals());

describe("shared entry session verification", () => {
  it("shares the request and result between the entry and existing callers", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(authorized)));
    vi.stubGlobal("fetch", fetchMock);
    const { verifySessionResult, verifySession, cachedVerifiedSession } = await import("../../apps/web/src/auth-session.js");
    expect(cachedVerifiedSession()).toBeUndefined();
    const [entry, gate] = await Promise.all([verifySessionResult(), verifySession()]);
    expect(entry).toEqual({ session: authorized, requestFailed: false });
    expect(gate).toEqual(authorized);
    expect(await verifySession()).toEqual(authorized);
    expect(cachedVerifiedSession()).toEqual(authorized);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", { credentials: "include", cache: "no-store" });
  });

  it.each([401, 403])("keeps HTTP %i denied without inventing a transport failure", async (status) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status })));
    const { verifySessionResult, verifySession } = await import("../../apps/web/src/auth-session.js");
    expect(await verifySessionResult()).toEqual({ session: "denied", requestFailed: false });
    expect(await verifySession()).toBe("denied");
  });

  it.each([429,500,503])('fails closed but reports an unread identity for HTTP %i',async status=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response('',{status})));const state=await import('../../apps/web/src/auth-session.js');expect(await state.verifySessionResult()).toEqual({session:'denied',requestFailed:true});expect(await state.verifySession()).toBe('denied');
  });
  it.each([{status:'authorized',user:null},{status:'authorized',user:{id:'TEST',displayName:'TEST',capabilities:null}},{status:'invalid',user:authorized.user},{status:'authorized',user:{...authorized.user,businessRoles:{}}}])('rejects a malformed successful identity without granting or inventing no-role',async value=>{
    vi.stubGlobal('fetch',vi.fn().mockResolvedValue(Response.json(value)));const state=await import('../../apps/web/src/auth-session.js');expect(await state.verifySessionResult()).toEqual({session:'denied',requestFailed:true});
  });
  it('does not cache a cancelled identity read and can read again',async()=>{
    const fetch=vi.fn().mockRejectedValueOnce(new DOMException('TEST cancelled','AbortError')).mockResolvedValueOnce(Response.json(authorized));vi.stubGlobal('fetch',fetch);const state=await import('../../apps/web/src/auth-session.js');expect(await state.verifySessionResult()).toEqual({session:'denied',requestFailed:false,cancelled:true});expect(state.cachedVerifiedSession()).toBeUndefined();expect(await state.verifySession()).toEqual(authorized);
  });
  it("keeps no-role sessions distinct from unauthenticated sessions", async () => {
    const noRole = { ...authorized, status: "no_role" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify(noRole))));
    const { verifySessionResult, verifySession } = await import("../../apps/web/src/auth-session.js");
    expect(await verifySessionResult()).toEqual({ session: noRole, requestFailed: false });
    expect(await verifySession()).toEqual(noRole);
  });

  it.each(["network", "invalid-json"])("preserves the entry error and protected-page fail-closed result: %s", async (failure) => {
    vi.stubGlobal("fetch", failure === "network"
      ? vi.fn().mockRejectedValue(new Error("TEST unavailable"))
      : vi.fn().mockResolvedValue(new Response("invalid JSON")));
    const { verifySessionResult, verifySession } = await import("../../apps/web/src/auth-session.js");
    expect(await verifySessionResult()).toEqual({ session: "denied", requestFailed: true });
    expect(await verifySession()).toBe("denied");
  });

  it("does not let an older request overwrite a forced newer result", async () => {
    let resolveOld!: (response: Response) => void;
    const old = new Promise<Response>((resolve) => { resolveOld = resolve; });
    const fetchMock = vi.fn().mockReturnValueOnce(old).mockResolvedValueOnce(new Response(JSON.stringify(authorized)));
    vi.stubGlobal("fetch", fetchMock);
    const { verifySessionResult, verifySession, cachedVerifiedSession } = await import("../../apps/web/src/auth-session.js");
    const previous = verifySessionResult();
    expect(await verifySession(true)).toEqual(authorized);
    resolveOld(new Response("", { status: 401 }));
    expect(await previous).toEqual({ session: "denied", requestFailed: false });
    expect(cachedVerifiedSession()).toEqual(authorized);
    expect(await verifySession()).toEqual(authorized);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

it("invalidates every pending authorization result and dependent cache on explicit logout",async()=>{
  let resolve!:(response:Response)=>void;
  vi.stubGlobal("fetch",vi.fn(()=>new Promise<Response>(done=>{resolve=done;})));
  const state=await import("../../apps/web/src/auth-session.js"),reset=vi.fn();state.registerSessionInvalidator(reset);
  const old=state.verifySession();state.invalidateSession();resolve(new Response(JSON.stringify(authorized)));
  expect(await old).toBe("denied");expect(state.cachedVerifiedSession()).toBeUndefined();expect(reset).toHaveBeenCalledTimes(1);
});
