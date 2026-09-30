import { describe, expect, it } from "vitest";

import { shanghaiBusinessDate } from "../../apps/web/src/business-date.js";
import { reportingBusinessDate } from "../../apps/web/src/reporting/reporting-client.js";

describe("Shanghai business date", () => {
  it("does not record the previous UTC day during Shanghai early morning", () => {
    expect(shanghaiBusinessDate(new Date("2026-08-08T19:30:00.000Z"))).toBe("2026-08-09");
  });

  it("keeps the same calendar day after Shanghai morning", () => {
    expect(shanghaiBusinessDate(new Date("2026-08-09T04:30:00.000Z"))).toBe("2026-08-09");
  });

  it("shares the Chinese Shanghai business date with report defaults", () => {
    const value = new Date("2026-08-08T19:30:00.000Z");
    expect(reportingBusinessDate(value)).toBe(shanghaiBusinessDate(value));
  });
});
