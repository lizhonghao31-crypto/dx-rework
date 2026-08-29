import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";

const actor = (
  role: "worker" | "tail_inspector",
  authorizationCapabilities?: readonly string[],
) => {
  const authorizationCapability = role === "worker" ? "work:report" : "tail_inspection:report";
  return {
    actorId: "00000000-0000-4000-8000-000000000001",
    actorRoles: [role],
    authorizationCapability,
    authorizationCapabilities: authorizationCapabilities ?? [authorizationCapability],
    requestId: "frontline-task-list",
  };
};

describe("v1 prelaunch frontline minimal tasks and mobile density", () => {
  it("returns only the selected kind of the current user's unreported active tasks", async () => {
    const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
      expect(sql).toContain("person.app_user_id=$1::uuid");
      expect(sql).toContain("item.execution_kind=$2");
      expect(sql).toContain("order_record.status='in_progress'");
      expect(sql).toContain("rework_work_report_rejections");
      expect(values[0]).toBe("00000000-0000-4000-8000-000000000001");
      expect(["worker", "tail_inspection"]).toContain(values[1]);
      return { rows: [{
        rework_order_id: "00000000-0000-4000-8000-000000000010",
        rework_no: "RW-001",
        style_no: "ST-001",
        order_no: "ORD-001",
        process_names: ["返工", "车缝"],
      }] };
    });
    const service = new WorkReportingService({ query } as never);
    await expect(service.listFrontlineTasks(actor("worker"), "worker")).resolves.toEqual({
      kind: "worker",
      items: [{
        reworkOrderId: "00000000-0000-4000-8000-000000000010",
        reworkNo: "RW-001",
        styleNo: "ST-001",
        orderNo: "ORD-001",
        processNames: ["返工", "车缝"],
        status: "in_progress",
      }],
    });
    await expect(service.listFrontlineTasks(actor("worker"), "tail_inspection")).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(service.listFrontlineTasks(
      actor("worker", ["work:report", "tail_inspection:report"]),
      "tail_inspection",
    )).resolves.toMatchObject({ kind: "tail_inspection" });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("uses separate worker and tail entries, auto-opens one order and keeps multiple orders minimal", async () => {
    const [landing, page, app, form, routes] = await Promise.all([
      readFile("apps/web/src/frontline-landing-page.tsx", "utf8"),
      readFile("apps/web/src/frontline-task-page.tsx", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/api/src/rework/work-reporting-routes.ts", "utf8"),
    ]);
    expect(landing).toContain("ui/frontline/tasks?kind=worker");
    expect(landing).toContain("ui/frontline/tasks?kind=tail_inspection");
    expect(app).toContain('path === "/ui/frontline/tasks"');
    expect(page).toContain("items.length === 1 ? items[0] : null");
    expect(page).toContain("只显示分配给本人且尚未报数的当前任务");
    expect(page).toContain("款号");
    expect(page).toContain("返工单");
    expect(page).not.toContain("订单号未填写");
    expect(page).toContain("工序");
    expect(page).toContain("<b>进入</b>");
    expect(form).toContain('task.executionKind === frontlineContext.kind');
    expect(form).toContain('"整查完成&报数" : "我已完工&上数"');
    expect(form).toContain("selfReportableTaskIds.has(task.workTaskId)");
    expect(form).toContain("openReporting([task])");
    expect(form).toContain("reportableTasks.length > 0 && (isRoot || canAssign)");
    expect(form).not.toContain("reportableTasks.length > 0 && <Surface className=\"work-reporting-primary-action\"");
    expect(routes).toContain('app.get("/frontline/work-tasks"');
  });

  it("removes real mobile container height while preserving touch and safe-area boundaries", async () => {
    const [page, css, taskCss] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-compact.css", "utf8"),
      readFile("apps/web/src/frontline-task-page.css", "utf8"),
    ]);
    expect(page).toContain('className="rework-detail-header"');
    expect(css).toContain(".rework-detail-header .page-heading{gap:5px;margin-bottom:6px}");
    expect(css).toContain(".rework-detail-core-fact{min-height:52px;padding:6px 8px}");
    expect(css).toContain(".rework-detail-target-layout .rework-detail-images,.rework-detail-target-layout .rework-workflow{padding:2px 7px}");
    expect(css).toContain(".rework-detail-target-layout .rework-detail-workspace{gap:5px;padding:7px");
    expect(css).toContain("min-height: 44px");
    expect(taskCss).toContain("env(safe-area-inset-bottom,0px)");
    expect(taskCss).toContain("min-height:44px");
  });
});
