import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("whole-order review refresh policy", () => {
  it("loads once and refreshes after local commands instead of polling", async () => {
    const source = await read("apps/web/src/whole-order-review-panel.tsx");
    expect(source).not.toContain("window.setInterval");
    expect(source).not.toContain('window.addEventListener("focus"');
    expect(source).not.toContain("visibilitychange");
    expect(source).toContain("if (requestInFlight.current) return;");
    expect(source).toContain("await load();");
    expect(source).toContain("await onChanged();");
  });
});

