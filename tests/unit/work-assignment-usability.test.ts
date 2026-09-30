import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("N03 worker assignment usability", () => {
  it("assigns every selected person as an independent task before the supervisor starts rework", async () => {
    const page = await read("apps/web/src/work-reporting-form.tsx");
    const contract = await read("packages/contracts/src/index.ts");

    expect(page).toContain('type="checkbox"');
    expect(page).toContain('mode: "individual", members: [{ personId }]');
    expect(page).toContain("setSelected({});");
    expect(page).toContain("完成分配，开始返工");
    expect(contract).toContain('if (value.mode === "individual" && value.members.length !== 1)');
  });
});

