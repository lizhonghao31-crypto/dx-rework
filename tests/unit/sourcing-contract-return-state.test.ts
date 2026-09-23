import { describe, expect, it } from "vitest";
import { contractReturnCutoff, contractReturnState } from "../../apps/api/src/sourcing/contract-return-state.js";

const generated = "2026-09-23T02:00:00.000Z";
const due = "2026-09-25T02:00:00.000Z";
const facts = {
  contract_return_monitor_enabled: true,contract_generated_at: generated,
  contract_return_due_at: due,contract_returned_at: null,
};

describe("contract return 48-hour clock", () => {
  it("excludes existing approved cases and cases whose PDF is not ready", () => {
    expect(contractReturnState({ ...facts,contract_return_monitor_enabled: false }, due).contractReturnStatus).toBeNull();
    expect(contractReturnState({ ...facts,contract_generated_at: null,contract_return_due_at: null }, due).contractReturnMonitoring).toBe(false);
    expect(contractReturnCutoff("")).toBeNull();
    expect(() => contractReturnCutoff("2026-09-23")).toThrow();
    expect(() => contractReturnCutoff("2026-09-31T10:00:00+08:00")).toThrow();
    expect(() => contractReturnCutoff("2026-09-23T24:00:00+08:00")).toThrow();
  });

  it("uses an inclusive deadline and continuous hours across local dates", () => {
    expect(contractReturnState(facts, due).contractReturnStatus).toBe("pending");
    expect(contractReturnState(facts, "2026-09-25T02:00:01Z")).toMatchObject({
      contractReturnStatus: "overdue_pending",contractReturnOverdueHours: 0,
    });
    expect(contractReturnState(facts, "2026-09-25T08:00:00Z").contractReturnOverdueHours).toBe(6);
    expect(contractReturnState(facts, "2026-09-25T08:00:01Z").contractReturnOverdueHours).toBe(6);
  });

  it("freezes lateness at the first persisted return, including when checked the next day", () => {
    const returned = { ...facts,contract_returned_at: "2026-09-25T09:00:00Z" };
    expect(contractReturnState(returned, "2026-09-26T10:00:00Z")).toMatchObject({
      contractReturnStatus: "returned_late",contractReturnOverdueHours: 7,
      contractReturnedAt: "2026-09-25T09:00:00.000Z",
    });
    expect(contractReturnState({ ...facts,contract_returned_at: due }, "2026-09-26T10:00:00Z").contractReturnStatus).toBe("returned_on_time");
  });
});
