import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("web refresh policy", () => {
  it("uses explicit desktop refresh and mobile pull-to-refresh without polling or focus refresh", async () => {
    const root = "apps/web/src";
    const entries = await readdir(root, { recursive: true });
    const sources = await Promise.all(entries
      .filter((entry) => entry.endsWith(".ts") || entry.endsWith(".tsx"))
      .map((entry) => readFile(`${root}/${entry}`, "utf8")));
    const source = sources.join("\n");
    expect(source).not.toContain("window.setInterval");
    expect(source).not.toContain('window.addEventListener("focus"');
    expect(source).not.toContain('document.addEventListener("visibilitychange"');
    expect(source).toContain('window.addEventListener("touchstart", touchStart');
    expect(source).toContain("if (shouldRefresh) window.location.reload();");
  });
});
