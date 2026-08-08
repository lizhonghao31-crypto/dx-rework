import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("whole-order review live refresh", () => {
  it("refreshes N06 while visible so concurrent worker reports and quantity decisions do not leave a stale review", async () => {
    const source = await read("apps/web/src/whole-order-review-panel.tsx");
    expect(source).toContain("const reviewRefreshMilliseconds = 15_000;");
    expect(source).toContain("window.setInterval(refreshVisible, reviewRefreshMilliseconds)");
    expect(source).toContain('window.addEventListener("focus", refreshVisible)');
    expect(source).toContain('document.addEventListener("visibilitychange", refreshVisible)');
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain("if (requestInFlight) return;");
  });
});
