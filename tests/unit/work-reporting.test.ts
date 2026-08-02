import { readFile } from "node:fs/promises";

import {
  calculateWorkAmount,
  hasAtMostDecimalPlaces,
  splitAmount,
} from "../../apps/api/src/rework/work-reporting-service.js";
import { canAssignWork } from "../../apps/web/src/work-reporting-permissions.js";
import { localDateTimeValue, reportAttempt, taskAttempt, workReportDraft } from "../../apps/web/src/work-reporting-submission.js";
import { describe, expect, it } from "vitest";

describe("work reporting monetary snapshots", () => {
  it("allocates the eight-decimal residual deterministically so every valid collective share stays positive", () => {
    const shares = splitAmount(0.1, 3);
    expect(shares).toEqual([0.03333334, 0.03333333, 0.03333333]);
    expect(shares.reduce((total, share) => total + share, 0)).toBeCloseTo(0.1, 10);
    expect(splitAmount(0.001, 40)).toEqual(Array.from({ length: 40 }, () => 0.000025));
    expect(splitAmount(0.00001, 40)).toEqual(Array.from({ length: 40 }, () => 0.00000025));
  });

  it("validates hour quantities and calculates report amounts from decimal values rather than binary products", () => {
    expect(hasAtMostDecimalPlaces(0.29, 2)).toBe(true);
    expect(hasAtMostDecimalPlaces(0.291, 2)).toBe(false);
    expect(calculateWorkAmount(1, "1.005")).toBe(1.005);
    expect(calculateWorkAmount(1.15, "2.239")).toBe(2.57485);
  });

  it("does not give worker-only users supervisor data requests or assignment controls", async () => {
    expect(canAssignWork({ businessRoles: ["worker"], capabilities: ["work:report"] })).toBe(false);
    expect(canAssignWork({ businessRoles: ["tail_supervisor"], capabilities: ["work:assign"] })).toBe(true);
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    expect(form).toContain("if (!assignable) { setPeople([]); setConfigItems([]); return; }");
    expect(form).toContain("request(\"work-task-options\"");
    expect(form).toContain("data && canAssign && <Surface>");
    expect(form).toContain("你的本次分摊 ¥");
    expect(form).toContain("task.canSubmitReport");
    expect(form).toContain("reportDrafts");
    const app = await readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain('{ requiredCapability: "work:report_for_worker" }');
  });

  it("reuses the idempotency key only while a report payload remains unresolved", () => {
    const payload = { expectedOrderVersion: 2, actualQuantity: 1, completedAt: "2026-08-02T12:00:00.000Z" };
    const first = reportAttempt(undefined, payload, () => "first-key");
    expect(reportAttempt(first, payload, () => "second-key")).toEqual(first);
    expect(reportAttempt(first, { ...payload, actualQuantity: 2 }, () => "changed-key")).toEqual({
      signature: JSON.stringify({ ...payload, actualQuantity: 2 }),
      key: "changed-key",
    });
  });

  it("keeps report drafts separate by task and reuses task assignment keys across uncertain responses", () => {
    const firstDraft = workReportDraft({}, "task-1", new Date(2026, 7, 2, 22, 3, 4));
    const secondDraft = workReportDraft({ "task-1": { ...firstDraft, quantity: "1" } }, "task-2", new Date(2026, 7, 2, 22, 4, 4));
    expect(firstDraft).toEqual({ quantity: "", completedAt: "2026-08-02T22:03" });
    expect(secondDraft).toEqual({ quantity: "", completedAt: "2026-08-02T22:04" });

    const payload = {
      expectedOrderVersion: 2,
      configurationItemId: "00000000-0000-4000-8000-000000000011",
      mode: "individual" as const,
      members: [{ personId: "00000000-0000-4000-8000-000000000010" }],
    };
    const first = taskAttempt(undefined, payload, () => "task-key");
    expect(taskAttempt(first, payload, () => "new-task-key")).toEqual(first);
    expect(taskAttempt(first, { ...payload, members: [] }, () => "changed-task-key")).toMatchObject({ key: "changed-task-key" });
    expect(localDateTimeValue(new Date(2026, 7, 2, 22, 3, 4))).toBe("2026-08-02T22:03");
  });
});
