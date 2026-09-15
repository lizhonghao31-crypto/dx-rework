import { describe, expect, it } from "vitest";
import { patternEstimate, patternListPath, patternReturnPath, readPatternListQuery, patternPagePath } from "../../apps/web/src/pattern-order-query.js";

describe("pattern order navigation and displayed estimate", () => {
  it("routes direct legacy query bookmarks to the board before applying creation access", () => {
    for (const search of ["?q=DX123&page=2", "?status=in_progress", "?page=1", "?creatorId=", "?workerId="]) expect(patternPagePath("/ui/pattern-room/create", search)).toBe("/ui/pattern-room/orders");
    expect(patternPagePath("/ui/pattern-room/create", "?kind=misc")).toBe("/ui/pattern-room/create");
    expect(patternPagePath("/ui/pattern-room/prices", "?q=test")).toBe("/ui/pattern-room/prices");
  });
  it("retains search, status, stable person filters and page when returning from detail", () => {
    const query = { q: "本次款号 A&B", kind: "pattern", status: "in_progress", creatorId: "11111111-1111-4111-8111-111111111111", workerId: "22222222-2222-4222-8222-222222222222", page: 3 };
    const path = patternListPath(query);
    expect(path).toMatch(/^\/ui\/pattern-room\/orders/);
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: "/ui/pattern-room/create?q=旧链接&page=2" })}`)).toContain("/ui/pattern-room/orders?q=");
    expect(readPatternListQuery(path.slice(path.indexOf("?")))).toEqual(query);
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: path })}`)).toBe(path);
    expect(patternReturnPath(`?${new URLSearchParams({ returnTo: "/ui/my-tasks?module=pattern_room&q=本次&page=2" })}`)).toContain("module=pattern_room");
    for (const value of ["https://example.com", "//example.com", "/ui/pattern-room/create\\evil", "/ui/admin"]) expect(patternReturnPath(`?${new URLSearchParams({ returnTo: value })}`)).toBe("/ui/pattern-room/orders");
  });
  it("calculates the read-only estimate without losing large three-place decimal amounts", () => {
    expect(patternEstimate("18.125", "3")).toBe("54.375");
    expect(patternEstimate("99999999999.999", "1000000")).toBe("99999999999999000.000");
    expect(patternEstimate("0.000", "2")).toBe("0.000");
    for (const quantity of ["0", "-1", "1.5", "1e3", "1000001", ""]) expect(patternEstimate("40.000", quantity)).toBeNull();
    expect(patternEstimate(null, "1")).toBeNull();
  });
});
