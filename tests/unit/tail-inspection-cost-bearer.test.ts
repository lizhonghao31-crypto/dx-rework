import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("tail inspection cost bearer", () => {
  it("captures and enforces the cost bearer at N01 and N07", async () => {
    const [migration, form, contracts, responsibility, panel] = await Promise.all([
      read("apps/api/migrations/0113_tail_inspection_cost_bearer.sql"),
      read("apps/web/src/rework-v2-form.tsx"),
      read("packages/contracts/src/index.ts"),
      read("apps/api/src/rework/responsibility-determination-service.ts"),
      read("apps/web/src/responsibility-determination-panel.tsx"),
    ]);
    expect(migration).toContain("tail_inspection_cost_bearer");
    expect(migration).toContain("rework_no='RW-2026-0826-001' AND style_no='HO20544223'");
    expect(form).toContain("谁承担整查费用？");
    expect(form).toContain('tailInspectionCostBearer: ""');
    expect(contracts).toContain('TailInspectionCostBearerSchema = z.enum(["own_factory", "processing_factory"])');
    expect(responsibility).toContain("item.execution_kind IN ('worker','tail_inspection')");
    expect(responsibility).toContain("整查费用由加工厂承担时必须按加工厂 100%、倍率 1.2 扣款");
    expect(panel).toContain('multiplier: "1.200"');
    expect(panel).toContain('tailInspectionCostBearer: tailCostBearer');
  });

  it("keeps wage month-close dormant while finance uses the report for reconciliation", async () => {
    const [review, list, detail, todos, reporting] = await Promise.all([
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/web/src/wages/wage-period-list.tsx"),
      read("apps/web/src/wages/wage-period-detail.tsx"),
      read("apps/api/src/todos/service.ts"),
      read("apps/api/src/reporting/management-reporting-orders.ts"),
    ]);
    expect(review).not.toContain('category: "wage_month_close"');
    expect(review).toContain("工资月结已退出当前流程；报表继续用于财务对数");
    expect(list).toContain("const WAGE_MONTH_CLOSE_ENABLED: boolean = false");
    expect(detail).toContain("返工工资对数明细");
    expect(todos).toContain("todos.category<>'wage_month_close'");
    expect(reporting).toContain("todo.category<>'wage_month_close'");
  });
});
