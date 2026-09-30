import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("own-factory approval refresh policy", () => {
  it("loads once and relies on explicit refresh plus server-side version checks", async () => {
    const source = await read("apps/web/src/own-factory-approval-panel.tsx");
    expect(source).not.toContain("window.setInterval");
    expect(source).not.toContain('window.addEventListener("focus"');
    expect(source).not.toContain("visibilitychange");
    expect(source).toContain("if (requestInFlight) return;");
    expect(source).toContain("expectedApprovalVersion");
  });
});
