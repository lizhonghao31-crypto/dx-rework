import { describe, expect, it } from "vitest";
import { patternEstimate, patternListPath, patternReturnPath, readPatternListQuery } from "../../apps/web/src/pattern-order-query.js";

describe("pattern order navigation and displayed estimate", () => {
  it("retains search, status, stable person filters and page when returning from detail", () => {
    const query = { q: "本次款号 A&B", kind: "pattern", status: "in_progress", creatorId: "11111111-1111-4111-8111-111111111111", workerId: "22222222-2222-4222-8222-222222222222", page: 3 };
    const path = patternListPath(query);
    expect(readPatternListQuery(path.slice(path.indexOf("?")))).toEqual(query);
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: path })}`)).toBe(path);
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: "/ui/my-tasks?module=pattern_room&q=本次&page=2" })}`)).toContain("module=pattern_room");
    for (const value of ["https://example.com", "//example.com", "/ui/pattern-room/create\\evil", "/ui/admin"]) expect(patternReturnPath(`?${new URLSearchParams({ returnTo: value })}`)).toBe("/ui/pattern-room/create");
  });
  it("calculates the read-only estimate without losing large three-place decimal amounts", () => {
    expect(patternEstimate("18.125", "3")).toBe("54.375");
    expect(patternEstimate("99999999999.999", "1000000")).toBe("99999999999999000.000");
    expect(patternEstimate("0.000", "2")).toBe("0.000");
    for (const quantity of ["0", "-1", "1.5", "1e3", "1000001", ""]) expect(patternEstimate("40.000", quantity)).toBeNull();
    expect(patternEstimate(null, "1")).toBeNull();
  });
});
