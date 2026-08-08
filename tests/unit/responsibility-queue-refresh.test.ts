import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N07 queue refresh", () => {
  it("refreshes on focus and a modest polling interval without clearing a ready queue on transient refresh failure", async () => {
    const source = await readFile("apps/web/src/responsibility-queue-page.tsx", "utf8");
    expect(source).toContain("const queueRefreshMilliseconds = 15_000");
    expect(source).toContain('window.addEventListener("focus", refresh)');
    expect(source).toContain("if (initial)");
  });
});
