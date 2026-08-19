import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const businessUiFiles = [
  "apps/web/src/components.tsx",
  "apps/web/src/rework-detail-page.tsx",
  "apps/web/src/process-configuration-form.tsx",
  "apps/web/src/work-reporting-form.tsx",
  "apps/web/src/tail-inspection-panel.tsx",
  "apps/web/src/whole-order-review-panel.tsx",
  "apps/web/src/responsibility-determination-panel.tsx",
  "apps/web/src/responsibility-queue-page.tsx",
  "apps/web/src/own-factory-approval-panel.tsx",
  "apps/web/src/own-factory-approval-queue-page.tsx",
  "apps/web/src/external-responsibility-panel.tsx",
  "apps/web/src/external-responsibility-queue-page.tsx",
  "apps/web/src/reporting/rework-query-page.tsx",
  "apps/web/src/reporting/report-center-page.tsx",
  "apps/web/src/wages/wage-period-list.tsx",
  "apps/web/src/wages/wage-period-detail.tsx",
] as const;

const retiredBusinessCopy = [
  "已加载责任版本",
  "当前状态不在工序配置节点",
  "订单版本 ",
  "Root 代",
  "Root 可",
  "供 Root",
  "服务端拟扣",
  "系统不接受浏览器",
  "使用稳定游标翻页",
  "页面预览与 Excel 使用同一服务端",
  "金额直接读取服务端",
  "旧责任处理",
] as const;

describe("business copy noise contract", () => {
  it("keeps implementation, debug and retired-flow copy out of business workbenches", async () => {
    const sources = await Promise.all(businessUiFiles.map(async (path) => ({
      path,
      source: await readFile(path, "utf8"),
    })));

    for (const { path, source } of sources) {
      for (const phrase of retiredBusinessCopy) {
        expect(source, `${path} still exposes retired copy: ${phrase}`).not.toContain(phrase);
      }
    }
  });

  it("keeps Root workflow bypasses while presenting them in ordinary business language", async () => {
    const [components, reporting, tail] = await Promise.all([
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
    ]);

    expect(components).toContain("const isRoot = currentUser?.isRoot === true;");
    expect(components).not.toContain('...(isRoot ? ["超级用户"] : [])');
    expect(reporting).toContain("const reportableTasks = isRoot ? pendingTasks : canAssign ? temporaryTasks : pendingTasks;");
    expect(reporting).toContain('isRoot ? "代上数"');
    expect(tail).toContain('isRoot ? "可代报"');
  });

  it("keeps responsibility versions in data while removing passive version chatter from the active workspace", async () => {
    const source = await readFile("apps/web/src/responsibility-determination-panel.tsx", "utf8");
    expect(source).toContain("expectedCurrentDeterminationVersion");
    expect(source).toContain("determination?.version");
    expect(source).not.toContain("已加载责任版本");
    expect(source).not.toMatch(/StatusBadge[^\n]*V\$\{determination\.version\}/);
  });
});
