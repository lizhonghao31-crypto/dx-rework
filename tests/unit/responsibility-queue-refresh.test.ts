import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

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

