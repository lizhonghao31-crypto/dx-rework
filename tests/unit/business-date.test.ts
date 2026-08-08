import { describe, expect, it } from "vitest";

import { shanghaiBusinessDate } from "../../apps/web/src/business-date.js";

describe("Shanghai business date", () => {
  it("does not record the previous UTC day during Shanghai early morning", () => {
    expect(shanghaiBusinessDate(new Date("2026-08-08T19:30:00.000Z"))).toBe("2026-08-09");
  });

  it("keeps the same calendar day after Shanghai morning", () => {
    expect(shanghaiBusinessDate(new Date("2026-08-09T04:30:00.000Z"))).toBe("2026-08-09");
  });
});
