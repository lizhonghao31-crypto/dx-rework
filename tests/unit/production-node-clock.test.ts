import { describe, expect, it } from "vitest";
import { classifyProductionNodeClock } from "../../packages/domain/src/production-node-clock.js";

const facts = {
  enteredAt: "2026-09-28T08:00:00.000Z",
  warningAt: "2026-09-29T00:00:00.000Z",
  dueAt: "2026-09-29T08:00:00.000Z",
  completedAt: null,
} as const;

describe("digital production node clock classification", () => {
  it("keeps normal, attention and overdue distinct without inventing whole-order risk", () => {
    expect(classifyProductionNodeClock(facts, "2026-09-28T23:59:59.000Z").state).toBe("normal");
    expect(classifyProductionNodeClock(facts, "2026-09-29T00:00:00.000Z").state).toBe("attention");
    expect(classifyProductionNodeClock(facts, "2026-09-29T08:00:00.000Z").state).toBe("overdue");
  });

  it("judges completion against the original deadline rather than the current clock", () => {
    expect(classifyProductionNodeClock(
      { ...facts, completedAt: "2026-09-29T07:59:59.000Z" },
      "2026-10-01T00:00:00.000Z",
    ).state).toBe("completed_on_time");
    expect(classifyProductionNodeClock(
      { ...facts, completedAt: "2026-09-29T08:00:01.000Z" },
      "2026-10-01T00:00:00.000Z",
    ).state).toBe("completed_overdue");
  });

  it("rejects invalid chronology instead of silently repairing it", () => {
    expect(() => classifyProductionNodeClock(
      { ...facts, warningAt: "2026-09-30T00:00:00.000Z" },
      "2026-09-28T09:00:00.000Z",
    )).toThrow(/out of order/);
  });
});
