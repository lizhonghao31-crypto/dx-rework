import { readFile } from "node:fs/promises";

import { AddActiveWorkTaskMembersSchema } from "@dx-rework/contracts";
import {
  calculateWorkAmount,
  splitAmount,
} from "../../apps/api/src/rework/work-reporting-service.js";
import { canAdjustActiveWorkforce, canAssignWork } from "../../apps/web/src/work-reporting-permissions.js";
import { localDateTimeValue, reportAttempt, reportsArePersisted, taskAttempt, workReportDraft } from "../../apps/web/src/work-reporting-submission.js";
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

  it("keeps worker quantities whole pieces and allows three-decimal IE prices", () => {
    expect(Number.isInteger(2)).toBe(true);
    expect(Number.isInteger(0.2)).toBe(false);
    expect(calculateWorkAmount(0.1, "0.55")).toBe(0.055);
    expect(calculateWorkAmount(1.2, "12.50")).toBe(15);
  });

  it("does not give worker-only users supervisor data requests or assignment controls", async () => {
    expect(canAssignWork({ businessRoles: ["worker"], capabilities: ["work:report"] })).toBe(false);
    expect(canAssignWork({ businessRoles: ["tail_supervisor"], capabilities: ["work:assign"] })).toBe(true);
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    expect(form).toContain("(!activeAdjustable || !adjustmentView)");
    expect(form).toContain('adjustmentView ? "work-task-adjustment-options" : "work-task-options"');
    expect(form).toContain('effectiveTaskMode === "task_assignment" && data');
    expect(form).toContain("我已完工&上数");
    expect(form).toContain("task.canSubmitReport");
    expect(form).toContain("reportQuantities");
    expect(form).toContain("work-reports/batch");
    expect(form).toContain("正在批量提交");
    expect(form).not.toContain("for (const { task, text } of quantities)");
    expect(form).toContain('step="1"');
    expect(form).toContain("大于 0 的整数件数");
    expect(form).toContain("当前岗位只处理尾部确认，不展示工人的个人上数");
    expect(form).toContain("managerProgressView");
    expect(form).toContain("未完成 {incompleteTasks.length}");
    expect(form).toContain("已完成 {completedTasks.length}");
    expect(form).toContain("ManagerTaskProgressRow");
    expect(form).toContain("groupTasksByProcess");
    expect(form).toContain("processOrder.set(processName, processOrder.size)");
    expect(form).not.toContain("window.setInterval");
    expect(form).toContain("IE 核准单价：¥");
    expect(form).toContain("formatApprovedUnitPrice(task.unitPrice)");
    expect(form).toContain('className="work-reporting-approved-price"');
    expect(form).toContain("pendingTasksExpanded");
    expect(form).toContain("completedTasksExpanded");
    expect(form).toContain('aria-controls="n04-pending-task-list"');
    expect(form).toContain('aria-controls="n04-completed-task-list"');
    const app = await readFile(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
    expect(app).toContain("return <AuthGate>{page}</AuthGate>");
  });

  it("restricts active employee adjustment to tail supervisors, owners, and Root", () => {
    expect(canAdjustActiveWorkforce({
      businessRoles: ["tail_supervisor"],
      capabilities: ["work:assignment_adjust"],
    })).toBe(true);
    expect(canAdjustActiveWorkforce({
      businessRoles: ["owner_group"],
      capabilities: ["work:assignment_adjust"],
    })).toBe(true);
    expect(canAdjustActiveWorkforce({
      businessRoles: ["production_management"],
      capabilities: ["work:assignment_adjust"],
    })).toBe(false);
    expect(canAdjustActiveWorkforce({
      businessRoles: ["quality_control"],
      capabilities: ["work:assignment_adjust"],
    })).toBe(false);
    expect(canAdjustActiveWorkforce({
      businessRoles: ["worker"],
      capabilities: ["work:assignment_adjust"],
    })).toBe(false);
    expect(canAdjustActiveWorkforce({
      isRoot: true,
      businessRoles: [],
      capabilities: [],
    })).toBe(true);
  });

  it("validates one atomic active-add batch and rejects duplicate employees", () => {
    const payload = {
      expectedOrderVersion: 3,
      configurationItemId: "00000000-0000-4000-8000-000000000011",
      memberIds: [
        "00000000-0000-4000-8000-000000000012",
        "00000000-0000-4000-8000-000000000013",
      ],
    };
    expect(AddActiveWorkTaskMembersSchema.safeParse(payload).success).toBe(true);
    expect(AddActiveWorkTaskMembersSchema.safeParse({
      ...payload,
      memberIds: [payload.memberIds[0], payload.memberIds[0]],
    }).success).toBe(false);
    expect(AddActiveWorkTaskMembersSchema.safeParse({
      ...payload,
      memberIds: Array.from({ length: 41 }, (_, index) =>
        `00000000-0000-4000-8000-${String(index + 100).padStart(12, "0")}`),
    }).success).toBe(false);
  });

  it("keeps the requested active-workforce UI actions separate and compact", async () => {
    const form = await readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8");
    const styles = await readFile(new URL("../../apps/web/src/work-reporting-form.css", import.meta.url), "utf8");
    const service = await readFile(new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url), "utf8");
    expect(form).toContain('className="n04-add-worker"');
    expect(form).toContain('className="n04-worker-remove"');
    expect(form).toContain('<h2>未完成</h2><StatusBadge tone="warning">');
    expect(form).not.toContain("n04-progress-group__title");
    expect(form).not.toContain("n04-progress-group__heading--compact");
    expect(form).not.toContain("candidate.configurationItemId === task.configurationItemId");
    expect(service).not.toContain("每道工序至少保留一名员工");
    expect(service).toContain("该员工已有上报记录，不能移除");
    expect(service).toContain('if (task.assignment_mode !== "individual")');
    expect(service).toContain("active_task.configuration_item_id=item.configuration_item_id");
    expect(service).toContain("configuration.status='approved'");
    expect(service.indexOf("const task = await this.task(client, workTaskId, true);"))
      .toBeLessThan(service.indexOf("只能在返工执行中移除员工"));
    expect(form).toContain("只加入当前订单，不修改默认人员名单");
    expect(styles).toContain(".n04-progress-group__toolbar");
    expect(styles).toContain(".n04-add-worker");
    expect(styles).toContain("position: absolute");
    expect(styles).toContain("left: 56px");
    expect(styles).toContain("white-space: nowrap");
    expect(styles).toContain(".n04-worker-remove");
    expect(styles).toContain("min-width: 18px");
    expect(styles).toContain("justify-content: center");
  });

  it("keeps assignment as an N03 draft and version-checks the unified start action", async () => {
    const service = await readFile(new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url), "utf8");
    expect(service).toContain("async confirmAssignments");
    expect(service).toContain("if (order.version !== input.expectedOrderVersion)");
    expect(service).toContain("rework.work_task.assignment_confirm");
    expect(service).toContain("async submitReportsBatch");
    expect(service).toContain("rework.work_report.batch_submit");
    expect(service).toContain("submittedWorkTaskIds: readonly string[]");
    expect(service).toContain("该人员已经分配到这道工序");
  });

  it("keeps required-tail recovery explicit and server-validated", async () => {
    const [service, routes, form, migration] = await Promise.all([
      readFile(new URL("../../apps/api/src/rework/work-reporting-service.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/src/rework/work-reporting-routes.ts", import.meta.url), "utf8"),
      readFile(new URL("../../apps/web/src/work-reporting-form.tsx", import.meta.url), "utf8"),
      readFile(new URL("../../apps/api/migrations/0109_n04_explicit_execution_completion.sql", import.meta.url), "utf8"),
    ]);
    expect(service).toContain("async completeExecution");
    expect(service).toContain("allowReportedTaskRecovery = false");
    expect(service).toContain("NOT $3::boolean");
    expect(service).toContain("tail_item.execution_kind='tail_inspection'");
    expect(service).toContain("仍有返工人员或整查任务未完成");
    expect(routes).toContain("/work-tasks/complete");
    expect(form).toContain("全部完成，进入节点05");
    const completedSectionIndex = form.indexOf('className="n04-progress-group n04-progress-group--completed"');
    const completionActionIndex = form.indexOf('className="n04-completion-action"');
    expect(completedSectionIndex).toBeGreaterThan(-1);
    expect(completionActionIndex).toBeGreaterThan(completedSectionIndex);
    expect(form).not.toContain("返工执行已全部完成");
    expect(form).not.toContain("系统会再次核验普通返工和整查的有效报数");
    expect(migration).toContain("alternative_action_two:='rework.execution.complete'");
    expect(migration).toContain("alternative_capability_two:='work:assign'");
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

  it("recognizes a committed batch from its refreshed task facts without sending another POST", () => {
    const reports = [
      { workTaskId: "task-a", actualQuantity: 5_000 },
      { workTaskId: "task-b", actualQuantity: 6_000 },
    ];
    expect(reportsArePersisted([
      { workTaskId: "task-a", submittedQuantity: 5_000 },
      { workTaskId: "task-b", submittedQuantity: 6_000 },
    ], reports)).toBe(true);
    expect(reportsArePersisted([
      { workTaskId: "task-a", submittedQuantity: 5_000 },
      { workTaskId: "task-b", submittedQuantity: 0 },
    ], reports)).toBe(false);
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
