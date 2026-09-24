import { describe, expect, it } from "vitest";
import { contractReturnCutoff, contractReturnState } from "../../apps/api/src/sourcing/contract-return-state.js";
import { sourcingContractReturnBadgeLabel, sourcingContractReturnLabel } from "../../apps/web/src/sourcing-contract-return-presentation.js";

const generated = "2026-09-23T02:00:00.000Z";
const due = "2026-09-25T02:00:00.000Z";
const facts = {
  contract_return_monitor_enabled: true,contract_generated_at: generated,
  contract_return_due_at: due,contract_returned_at: null,
  contract_return_overdue_seconds: 0,
};

describe("contract return 48-hour clock", () => {
  it("excludes existing approved cases and cases whose PDF is not ready", () => {
    expect(contractReturnState({ ...facts,contract_return_monitor_enabled: false }, due).contractReturnStatus).toBeNull();
    expect(contractReturnState({ ...facts,contract_generated_at: null,contract_return_due_at: null }, due).contractReturnMonitoring).toBe(false);
    expect(() => contractReturnCutoff("")).toThrow();
    const previous = process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
    try {
      delete process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
      expect(contractReturnCutoff()).toBe("2026-09-22T16:00:00.000Z");
    } finally {
      if (previous === undefined) delete process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
      else process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT = previous;
    }
    expect(() => contractReturnCutoff("2026-09-23")).toThrow();
    expect(() => contractReturnCutoff("2026-09-31T10:00:00+08:00")).toThrow();
    expect(() => contractReturnCutoff("0000-01-01T00:00:00Z")).toThrow();
    expect(() => contractReturnCutoff("2026-09-23T24:00:00+08:00")).toThrow();
  });

  it("uses an inclusive deadline and the SQL-calculated Sunday-free overdue duration", () => {
    expect(contractReturnState(facts, due).contractReturnStatus).toBe("pending");
    expect(contractReturnState(facts, "2026-09-25T02:00:01Z")).toMatchObject({
      contractReturnStatus: "overdue_pending",contractReturnOverdueHours: 0,
    });
    expect(contractReturnState({ ...facts,contract_return_overdue_seconds: 21_600 }, "2026-09-25T08:00:00Z").contractReturnOverdueHours).toBe(6);
    expect(contractReturnState({ ...facts,contract_return_overdue_seconds: 21_601 }, "2026-09-25T08:00:01Z").contractReturnOverdueHours).toBe(6);
  });

  it("freezes lateness at the first persisted return, including when checked the next day", () => {
    const returned = { ...facts,contract_returned_at: "2026-09-25T09:00:00Z",contract_return_overdue_seconds:25_200 };
    expect(contractReturnState(returned, "2026-09-26T10:00:00Z")).toMatchObject({
      contractReturnStatus: "returned_late",contractReturnOverdueHours: 7,
      contractReturnedAt: "2026-09-25T09:00:00.000Z",
    });
    expect(contractReturnState({ ...facts,contract_returned_at: due }, "2026-09-26T10:00:00Z").contractReturnStatus).toBe("returned_on_time");
  });

  it("does not include a paused Sunday in a late return's displayed hours", () => {
    const weekend = { ...facts,contract_return_due_at:"2026-09-26T15:00:00Z",
      contract_returned_at:"2026-09-27T08:00:00Z",contract_return_overdue_seconds:3600 };
    expect(contractReturnState(weekend,"2026-09-29T10:00:00Z")).toMatchObject({
      contractReturnStatus:"returned_late",contractReturnOverdueHours:1,
    });
  });
});

describe("contract return wording", () => {
  it("distinguishes unreturned lateness from a late signed contract", () => {
    expect(sourcingContractReturnBadgeLabel({contractReturnStatus:"overdue_pending",contractReturnOverdueHours:0})).toBe("逾期 <1 小时");
    expect(sourcingContractReturnBadgeLabel({contractReturnStatus:"returned_late",contractReturnOverdueHours:7})).toBe("逾期回签 7 小时");
    expect(sourcingContractReturnLabel({contractReturnStatus:"returned_late",contractReturnOverdueHours:7})).toBe("逾期回签 7 小时");
  });
});
