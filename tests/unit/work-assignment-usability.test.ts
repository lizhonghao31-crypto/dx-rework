import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N04 worker assignment usability", () => {
  it("uses a true single-select control for individual work without weakening server validation", async () => {
    const page = await read("apps/web/src/work-reporting-form.tsx");
    const contract = await read("packages/contracts/src/index.ts");

    expect(page).toContain('type={mode === "individual" ? "radio" : "checkbox"}');
    expect(page).toContain('setSelected(checked ? { [personId]: true } : {})');
    expect(page).toContain("setSelected({});");
    expect(contract).toContain('if (value.mode === "individual" && value.members.length !== 1)');
  });
});
