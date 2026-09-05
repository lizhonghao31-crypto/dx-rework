import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("wage UI read-only boundary", () => {
  it("does not expose month-close mutations", async () => {
    const source = await read("apps/web/src/wages/wage-period-detail.tsx");

    expect(source).toContain("export.xlsx");
    expect(source).toContain("返工工资对数明细");
    expect(source).not.toContain("pendingMutationKeys");
    expect(source).not.toContain("createClientRequestId");
    expect(source).not.toContain("confirmInApp");
    expect(source).not.toContain("lockPeriod");
    expect(source).not.toContain("月结锁定");
  });
});
