import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("N02 alignment root-cause fixes", () => {
  it("keeps the tail picker in the intended grid column instead of an implicit named area", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-form.css", "utf8");
    expect(css).toContain(".process-worker-line .process-worker-picker{grid-area:picker");
    expect(css).toContain(".process-worker-tail-body>.process-worker-picker{grid-area:auto");
  });

  it("renders people-group titles above their boxes instead of through the fieldset border", async () => {
    const css = await readFile("apps/web/src/process-worker-assignment-form.css", "utf8");
    expect(css).toContain(".process-worker-people-group{border:0");
    expect(css).toContain(".process-worker-people-group>div{box-sizing:border-box;border:1px solid var(--dx-v2-color-border)");
    expect(css).toContain(".process-worker-people-group legend{margin:0 0 4px");
  });
});
