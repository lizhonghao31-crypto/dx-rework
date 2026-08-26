import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("historical node write boundary", () => {
  it("never reopens retired assignment or tail controls from a historical node click", async () => {
    const source = await read("apps/web/src/work-reporting-form.tsx");

    expect(source).toContain('loaded?.reworkStatus === "pending_task_assignment"');
    expect(source).toContain('data.reworkStatus !== "pending_task_assignment"');
    expect(source).toContain('data.reworkStatus !== "in_progress"');
    expect(source).toContain('const assignmentWritable = data?.reworkStatus === "pending_task_assignment";');
    expect(source).toContain('const workReportingWritable = data?.reworkStatus === "in_progress";');
    expect(source).toContain('canAssign && assignmentWritable');
    expect(source).toContain('assignmentWritable ? "待开工" : "已处理"');
    expect(source).toContain('task.remainingQuantity === 0 ? "已完成"');
    expect(source).toContain('workReportingWritable ? "待上报" : "未完成"');
  });

  it("keeps backend state locks on the main write stages", async () => {
    const [processConfiguration, workReporting, tailInspection, wholeOrderReview, responsibilityPanel] = await Promise.all([
      read("apps/api/src/rework/process-configuration-service.ts"),
      read("apps/api/src/rework/work-reporting-service.ts"),
      read("apps/api/src/rework/tail-inspection-service.ts"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/web/src/responsibility-determination-panel.tsx"),
    ]);

    expect(processConfiguration).toContain('order.status !== "pending_process_configuration"');
    expect(workReporting).toContain('order.status !== "pending_task_assignment"');
    expect(workReporting).toContain('order.status !== "in_progress"');
    expect(tailInspection).toContain("isOpenForTailInspection(order.status)");
    expect(wholeOrderReview).toContain('order.status !== "pending_order_review"');
    expect(responsibilityPanel).toContain('response.reworkStatus === "pending_responsibility_determination"');
  });
});
