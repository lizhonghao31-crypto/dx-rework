import { describe, expect, it } from "vitest";

import { rankUsageSearchOptions } from "../../apps/web/src/search-option-ranking.js";

describe("N01 searchable history ranking", () => {
  const options = [
    { label: "蓝色", personalUsageCount: 2, globalUsageCount: 4, lastUsedAt: "2026-08-10T00:00:00.000Z" },
    { label: "深蓝色", personalUsageCount: 5, globalUsageCount: 8, lastUsedAt: "2026-08-12T00:00:00.000Z" },
    { label: "蓝灰色", personalUsageCount: 0, globalUsageCount: 20, lastUsedAt: "2026-08-14T00:00:00.000Z" },
  ];

  it("orders the empty menu by personal frequency, then organization frequency", () => {
    expect(rankUsageSearchOptions(options, "").map((option) => option.label))
      .toEqual(["深蓝色", "蓝色", "蓝灰色"]);
  });

  it("prioritizes exact, prefix and contains matches before usage counts", () => {
    expect(rankUsageSearchOptions(options, "蓝色").map((option) => option.label))
      .toEqual(["蓝色", "深蓝色"]);
    expect(rankUsageSearchOptions(options, "蓝").map((option) => option.label))
      .toEqual(["蓝色", "蓝灰色", "深蓝色"]);
  });

  it("falls back to organization frequency when personal history is empty", () => {
    const newUserOptions = options.map((option) => ({ ...option, personalUsageCount: 0 }));
    expect(rankUsageSearchOptions(newUserOptions, "").map((option) => option.label))
      .toEqual(["蓝灰色", "深蓝色", "蓝色"]);
  });
});
