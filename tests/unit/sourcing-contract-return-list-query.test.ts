import { describe, expect, it } from "vitest";
import {
  readSourcingListQuery, sourcingListPath, sourcingReturnPath, withSourcingReturn,
} from "../../apps/web/src/sourcing-list-query.js";

describe("sourcing contract return list navigation", () => {
  it("round trips monitored-only and overdue filters with search and pagination", () => {
    const list = sourcingListPath("pending",{
      q:"秋裤",stage:"owner",gender:"男装",styleName:"针织",
      contractReturn:"all_overdue",page:3,
    });
    expect(readSourcingListQuery(list.split("?")[1]!)).toMatchObject({
      q:"秋裤",stage:"owner",gender:"男装",styleName:"针织",
      contractReturn:"all_overdue",page:3,
    });
    expect(sourcingReturnPath(withSourcingReturn("/ui/sourcing/cases/123","pending",
      readSourcingListQuery(list.split("?")[1]!)).split("?")[1]!)).toBe(list);
    expect(readSourcingListQuery("?contractReturn=all").contractReturn).toBe("all");
    expect(readSourcingListQuery("?contractReturn=unknown").contractReturn).toBeNull();
  });
});
