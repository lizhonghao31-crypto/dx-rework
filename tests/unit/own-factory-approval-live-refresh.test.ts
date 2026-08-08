import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("own-factory approval live state", () => {
  it("refreshes a pending N08-A approval while visible so the second owner sees the first decision without submitting a stale action", async () => {
    const source = await read("apps/web/src/own-factory-approval-panel.tsx");
    expect(source).toContain("const approvalRefreshMilliseconds = 15_000;");
    expect(source).toContain("window.setInterval(refreshVisible, approvalRefreshMilliseconds)");
    expect(source).toContain('window.addEventListener("focus", refreshVisible)');
    expect(source).toContain('document.addEventListener("visibilitychange", refreshVisible)');
    expect(source).toContain('document.visibilityState === "visible"');
    expect(source).toContain("if (requestInFlight) return;");
  });
});
