import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workforce directory UX", () => {
  it("supports business-facing search and does not render app user UUIDs", async () => {
    const source = await readFile("apps/web/src/workforce-master-data-page.tsx", "utf8");
    expect(source).toContain('label="搜索人员"');
    expect(source).toContain("person.aliases");
    expect(source).toContain("内部员工 · 可登录");
    expect(source).not.toContain("<small>{person.appUserId}</small>");
  });
});
