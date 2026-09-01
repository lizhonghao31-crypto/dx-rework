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
    const source = queueSources.join("\n");
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
