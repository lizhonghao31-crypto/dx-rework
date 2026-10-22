import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("1.0 prelaunch PR-10 perceived performance", () => {
  it("reuses the verified in-page session instead of refetching auth/me", async () => {
    const [auth, session, shell, reworkQuery, orderBoard] = await Promise.all([
      read("apps/web/src/auth.tsx"),
      read("apps/web/src/auth-session.ts"),
      read("apps/web/src/components.tsx"),
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
    ]);

    expect(auth).toContain('export { verifySession, verifySessionResult } from "./auth-session.js";');
    expect(session).toContain("export function verifySession(force = false): Promise<VerifiedSession>");
    // Assert the cache/concurrency contract, independent of equivalent source spelling.
    vi.resetModules();let release!:(response:Response)=>void;
    const fetcher=vi.fn(()=>new Promise<Response>(done=>{release=done;}));vi.stubGlobal("fetch",fetcher);
    try{
      const state=await import("../../apps/web/src/auth-session.js");
      const pending=state.verifySessionResult();expect(state.verifySessionResult()).toBe(pending);
      const identity={status:"authorized",user:{id:"TEST-cache",displayName:"TEST",businessRoles:[],capabilities:[]}};
      release(Response.json(identity));expect((await pending).session).toEqual(identity);
      expect(await state.verifySession()).toEqual(identity);expect(fetcher).toHaveBeenCalledTimes(1);
    }finally{vi.unstubAllGlobals();}
    expect(shell).toContain("verifySession()");
    expect(reworkQuery).toContain("verifySession()");
    expect(orderBoard).toContain("verifySession()");
    expect(shell).not.toContain('apiUrl("auth/me")');
    expect(reworkQuery).not.toContain('apiUrl("auth/me")');
    expect(orderBoard).not.toContain('apiUrl("auth/me")');
  });

  it("loads each page immediately and debounces only typed search text", async () => {
    const [hook, reworkQuery, orderBoard, workflowQueue, wages] = await Promise.all([
      read("apps/web/src/use-debounced-value.ts"),
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/reporting/workflow-queue-page.tsx"),
      read("apps/web/src/wages/wage-period-list.tsx"),
    ]);

    expect(hook).toContain("useState(value)");
    for (const page of [reworkQuery, orderBoard, workflowQueue, wages]) {
      expect(page).toContain("useDebouncedValue");
      expect(page).not.toContain("window.setTimeout");
    }
  });

  it("keeps ready business data visible while filters refresh", async () => {
    const [reworkQuery, orderBoard, workflowQueue, wages] = await Promise.all([
      read("apps/web/src/reporting/rework-query-page.tsx"),
      read("apps/web/src/order-board-page.tsx"),
      read("apps/web/src/reporting/workflow-queue-page.tsx"),
      read("apps/web/src/wages/wage-period-list.tsx"),
    ]);

    expect(reworkQuery).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(workflowQueue).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(wages).toContain('current.kind === "ready" ? current : { kind: "loading" }');
    expect(orderBoard.split("setPageLoading(true);")[1]?.split(".catch(")[0]).not.toContain("setData(null)");
    expect(orderBoard).toContain("setData(null)"); // Error/permission rejection clears stale facts.
  });
});
