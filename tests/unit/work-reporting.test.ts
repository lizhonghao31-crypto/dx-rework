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
  it("allocates practical 0.001-yuan residuals deterministically", () => {
    const small = splitAmount(0.1, 3);
    expect(small).toEqual([0.034, 0.033, 0.033]);
    expect(small.reduce((total, share) => total + share, 0)).toBeCloseTo(0.1, 3);

    const fortyPeople = splitAmount(18.75, 40);
    expect(fortyPeople.slice(0, 30)).toEqual(Array.from({ length: 30 }, () => 0.469));
    expect(fortyPeople.slice(30)).toEqual(Array.from({ length: 10 }, () => 0.468));
    expect(fortyPeople.reduce((total, share) => total + share, 0)).toBeCloseTo(18.75, 3);
  });

  it("accepts one-decimal quantities and two-decimal prices for three-decimal work amounts", () => {
    expect(hasAtMostDecimalPlaces(0.2, 1)).toBe(true);
    expect(hasAtMostDecimalPlaces(0.21, 1)).toBe(false);
    expect(calculateWorkAmount(0.1, "0.55")).toBe(0.055);
    expect(calculateWorkAmount(1.2, "12.50")).toBe(15);
  });

  it("does not give worker-only users supervisor data requests or assignment controls", async () => {
    expect(canAssignWork({ businessRoles: ["worker"], capabilities: ["work:report"] })).toBe(false);
    expect(canAssignWork({ businessRoles: ["tail_supervisor"], capabilities: ["work:assign"] })).toBe(true);
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    expect(form).toContain("if (!assignable || !assignmentView) return;");
    expect(form).toContain("request(\"work-task-options\"");
    expect(form).toContain('effectiveTaskMode === "task_assignment" && data');
    expect(form).toContain("我已完工&上数");
    expect(form).toContain("task.canSubmitReport");
    expect(form).toContain("reportQuantities");
    expect(form).toContain('step="0.1"');
    expect(form).toContain("最多保留一位小数");
    expect(form).toContain("当前岗位只处理尾部确认，不展示工人的个人上数");
    const app = await readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("return <AuthGate>{page}</AuthGate>");
  });

  it("keeps assignment as an N03 draft and version-checks the unified start action", async () => {
    const service = await readFile(new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url), "utf8");
    expect(service).toContain("async confirmAssignments");
    expect(service).toContain("if (order.version !== input.expectedOrderVersion)");
    expect(service).toContain("rework.work_task.assignment_confirm");
    expect(service).toContain("该人员已经分配到这道工序");
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

  it("invokes the real Web Crypto randomUUID method with its required receiver", () => {
    const taskPayload = {
      expectedOrderVersion: 2,
      configurationItemId: "00000000-0000-4000-8000-000000000011",
      mode: "collective" as const,
      members: [{ personId: "00000000-0000-4000-8000-000000000010" }],
    };
    const reportPayload = {
      expectedOrderVersion: 3,
      actualQuantity: 1,
      completedAt: "2026-08-09T06:00:00.000Z",
    };

    expect(taskAttempt(undefined, taskPayload, globalThis.crypto.randomUUID).key)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(reportAttempt(undefined, reportPayload, globalThis.crypto.randomUUID).key)
      .toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
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
