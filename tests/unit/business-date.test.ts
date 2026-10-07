import { describe, expect, it, vi } from "vitest";

import { shanghaiBusinessDate } from "../../apps/web/src/business-date.js";
import { reportingBusinessDate } from "../../apps/web/src/reporting/reporting-client.js";

describe("Shanghai business date", () => {
  it.each(["UTC", "America/Los_Angeles", "Asia/Shanghai"])("keeps Shanghai date boundaries in a %s host", (zone) => {
    vi.stubEnv("TZ", zone);
    try {
      for (const [instant, date] of [
        ["2026-10-06T15:59:59.999Z", "2026-10-06"],
        ["2026-10-06T16:00:00.000Z", "2026-10-07"],
        ["2026-10-06T18:05:29.000Z", "2026-10-07"],
        ["2026-12-31T16:00:00.000Z", "2027-01-01"],
        ["2028-02-28T16:00:00.000Z", "2028-02-29"],
      ]) expect(shanghaiBusinessDate(new Date(instant!))).toBe(date);
    } finally { vi.unstubAllEnvs(); }
  });

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
