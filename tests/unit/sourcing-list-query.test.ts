import { describe, expect, it } from "vitest";

import {
  readSourcingListQuery,
  sourcingListPath,
  sourcingReturnPath,
  withSourcingReturn,
} from "../../apps/web/src/sourcing-list-query.js";

describe("sourcing list query state", () => {
  it("round-trips category filters and page state", () => {
    const state = {
      q: " DX-100 ",
      stage: "finance" as const,
      gender: "女装" as const,
      styleName: "针织上衣",
      page: 3,
    };
    const path = sourcingListPath("pending", state);
    expect(path).toBe("/ui/sourcing/pending?q=DX-100&stage=finance&gender=%E5%A5%B3%E8%A3%85&styleName=%E9%92%88%E7%BB%87%E4%B8%8A%E8%A1%A3&page=3");
    expect(readSourcingListQuery(path.slice(path.indexOf("?")))).toEqual({
      q: "DX-100",
      stage: "finance",
      gender: "女装",
      styleName: "针织上衣",
      page: 3,
    });
  });

  it("drops workflow stage from history paths while retaining other filters", () => {
    expect(sourcingListPath("history", {
      q: "",
      stage: "owner",
      gender: "missing",
      styleName: "历史未维护",
      page: 2,
    })).toBe("/ui/sourcing/history?gender=missing&styleName=%E5%8E%86%E5%8F%B2%E6%9C%AA%E7%BB%B4%E6%8A%A4&page=2");
  });

  it("only accepts sourcing list return targets", () => {
    const state = {
      q: "工厂",
      stage: "management" as const,
      gender: "男装" as const,
      styleName: "梭织",
      page: 4,
    };
    const detail = withSourcingReturn("/ui/sourcing/orders/abc", "pending", state);
    expect(sourcingReturnPath(detail.slice(detail.indexOf("?"))))
      .toBe(sourcingListPath("pending", state));
    expect(sourcingReturnPath("?returnTo=https%3A%2F%2Fevil.example")).toBeNull();
    expect(sourcingReturnPath("?returnTo=%2Fui%2Fmy-tasks")).toBeNull();
  });
});
