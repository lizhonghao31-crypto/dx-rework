import { readdir, readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invalidateSession, sessionCacheVersion, verifySession } from "../../apps/web/src/auth-session.js";
import { readTodoIndicator } from "../../apps/web/src/todo-indicator-read.js";
import { installTodoIndicatorRefresh, publishTodoRead } from "../../apps/web/src/todo-indicator-refresh.js";

afterEach(() => {
  invalidateSession();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const authorized = (id: string, capabilities = ["todo:view"]) => Response.json({
  status: "authorized", user: { id, displayName: "TEST", capabilities },
});
const indicator = (actorId: string, pendingCount: number) => Response.json(
  { pendingCount, unreadCount: pendingCount },
  { headers: { "x-dx-rework-actor-id": actorId } },
);

describe("web refresh policy", () => {
  it("keeps business queues manual-refresh while allowing the lightweight todo indicator", async () => {
    const root = "apps/web/src";
    const indicatorRefreshPath = "todo-indicator-refresh.ts";
    const entries = await readdir(root, { recursive: true });
    const queueSources = await Promise.all(entries
      .filter((entry) =>
        (entry.endsWith(".ts") || entry.endsWith(".tsx"))
        && entry !== indicatorRefreshPath)
      .map((entry) => readFile(`${root}/${entry}`, "utf8")));
    // PR08 permits only this display-only effect. Removing this exact reviewed block
    // leaves every other visibility handler subject to the original policy below.
    const displayClock = 'useEffect(()=>{const update=()=>{setVisible(!document.hidden);setNow(Date.now());};document.addEventListener("visibilitychange",update);const timer=setInterval(()=>{if(!document.hidden)setNow(Date.now());},60000);return()=>{document.removeEventListener("visibilitychange",update);clearInterval(timer);};},[]);';
    const dashboard = await readFile(`${root}/production-dashboard-page.tsx`, "utf8");
    expect(dashboard).toContain(displayClock);
    expect(displayClock).not.toMatch(/fetch|load\(|request\(|dispatchEvent|location/);
    // Explicit logout admits/restores identity at the application root; it does
    // not introduce background business-queue refresh.
    const auth = await readFile(`${root}/auth.tsx`, "utf8");
    const admission = auth.match(/export function SessionBoundary[\s\S]*?(?=\nexport function AuthGate)/)?.[0];
    expect(admission).toBeDefined();
    expect(admission).toContain("verifySession(true)");
    expect(admission).not.toMatch(/fetch\(|todos\/|setInterval|dispatchEvent/);
    const source = queueSources.join("\n").replace(displayClock, "").replace(admission!, "");
    expect(source).not.toContain("window.setInterval");
    expect(source).not.toContain('window.addEventListener("focus"');
    expect(source).not.toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('window.addEventListener("touchstart", touchStart');
    expect(source).toContain("if (shouldRefresh) window.location.reload();");

    const indicatorRefresh = await readFile(`${root}/${indicatorRefreshPath}`, "utf8");
    expect(indicatorRefresh).toContain("TODO_INDICATOR_POLL_INTERVAL_MS = 60_000");
    expect(indicatorRefresh).toContain("window.setInterval");
    expect(indicatorRefresh).toContain('document.addEventListener("visibilitychange"');
    expect(indicatorRefresh).not.toContain("todos/mine");
  });
});


describe("todo indicator refresh", () => {
  it("pauses hidden polling, coalesces visibility triggers and follows a read saved during an older request", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(authorized("first")));
    await verifySession();
    const tab = new EventTarget();
    const document = Object.assign(new EventTarget(), { visibilityState: "visible" as "hidden" | "visible" });
    vi.stubGlobal("window", Object.assign(tab, { setInterval, clearInterval }));
    vi.stubGlobal("document", document);

    const first = Promise.withResolvers<void>();
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValueOnce(undefined)
      .mockReturnValueOnce(first.promise).mockResolvedValue(undefined);
    const stop = installTodoIndicatorRefresh(refresh);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(1);
      document.visibilityState = "hidden";
      await vi.advanceTimersByTimeAsync(120_000);
      expect(refresh).toHaveBeenCalledTimes(1);

      document.visibilityState = "visible";
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(2);
      document.dispatchEvent(new Event("visibilitychange"));
      publishTodoRead("someone-else");
      publishTodoRead("first");
      publishTodoRead("first");
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledTimes(2);
      first.resolve();
      await vi.advanceTimersByTimeAsync(0);
      expect(refresh).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(refresh).toHaveBeenCalledTimes(4);
    } finally {
      stop();
    }
    await vi.advanceTimersByTimeAsync(120_000);
    document.dispatchEvent(new Event("visibilitychange"));
    publishTodoRead("first");
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(4);
  });

  it("shares reads within the current identity and discards old responses across permission or actor changes", async () => {
    const stale = Promise.withResolvers<Response>();
    const fresh = Promise.withResolvers<Response>();
    const fetch = vi.fn()
      .mockResolvedValueOnce(authorized("first"))
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce(authorized("second"))
      .mockReturnValueOnce(fresh.promise)
      .mockResolvedValueOnce(indicator("second", 3))
      .mockResolvedValueOnce(authorized("second", []));
    vi.stubGlobal("fetch", fetch);

    await verifySession();
    const firstEpoch = sessionCacheVersion();
    const first = readTodoIndicator("first", firstEpoch);
    expect(readTodoIndicator("first", firstEpoch)).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(2);

    await verifySession(true);
    const secondEpoch = sessionCacheVersion();
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true);
    const second = readTodoIndicator("second", secondEpoch);
    stale.resolve(indicator("wrong-actor", 900));
    await expect(first).resolves.toBeNull();
    expect(readTodoIndicator("second", secondEpoch)).toBe(second);
    fresh.resolve(indicator("second", 2));
    await expect(second).resolves.toMatchObject({ pendingCount: 2, unreadCount: 2 });

    await expect(readTodoIndicator("second", secondEpoch)).resolves.toMatchObject({ pendingCount: 3 });
    await verifySession(true);
    await expect(readTodoIndicator("second", sessionCacheVersion())).resolves.toBeNull();
    await expect(readTodoIndicator("first", firstEpoch)).resolves.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(6);
  });
});
