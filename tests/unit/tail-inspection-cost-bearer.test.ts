import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("tail inspection cost bearer", () => {
  it("captures and enforces the cost bearer at N01 and N07", async () => {
    const [
      migration,
      provenanceMigration,
      form,
      contracts,
      service,
      draftService,
      submissionService,
      responsibility,
      panel,
    ] = await Promise.all([
      read("apps/api/migrations/0113_tail_inspection_cost_bearer.sql"),
      read("apps/api/migrations/0119_tail_inspection_cost_bearer_provenance.sql"),
      read("apps/web/src/rework-v2-form.tsx"),
      read("packages/contracts/src/index.ts"),
      read("apps/api/src/rework/service.ts"),
      read("apps/api/src/rework/v2-draft-service.ts"),
      read("apps/api/src/rework/v2-submission-service.ts"),
      read("apps/api/src/rework/responsibility-determination-service.ts"),
      read("apps/web/src/responsibility-determination-panel.tsx"),
    ]);
    expect(migration).toContain("tail_inspection_cost_bearer");
    expect(migration).toContain("rework_no='RW-2026-0826-001' AND style_no='HO20544223'");
    expect(provenanceMigration).toContain("tail_inspection_cost_bearer_source");
    expect(provenanceMigration).toContain("'legacy_default'");
    expect(provenanceMigration).toContain("'quality_inspection'");
    expect(provenanceMigration).toContain("'production_override'");
    expect(provenanceMigration).toContain("'pending_final_quantity_ie_review'");
    expect(provenanceMigration).toContain("THEN 'processing_factory'");
    expect(provenanceMigration).toContain("SELECT procedure.prosrc");
    expect(provenanceMigration).toContain(
      "position('rework.tail_inspection.waive' IN guard_source)>0",
    );
    expect(provenanceMigration).toContain("old_count<>2");
    expect(provenanceMigration).toContain(
      "guard_source := replace(guard_source,old_fields,new_fields)",
    );
    expect(form).toContain("谁承担整查费用？");
    expect(form).toContain('tailInspectionCostBearer: ""');
    expect(contracts).toContain("TailInspectionCostBearerSchema = z.enum([");
    expect(contracts).toContain('"processing_factory",');
    expect(contracts).toContain("TailInspectionCostBearerSourceSchema");
    expect(service).not.toContain('input.tailInspectionCostBearer ?? "own_factory"');
    expect(draftService).toContain('"quality_inspection"');
    expect(submissionService).toContain('"quality_inspection"');
    expect(responsibility).not.toContain('order.tail_inspection_cost_bearer ?? "own_factory"');
    expect(responsibility).toContain('"legacy_default"');
    expect(responsibility).toContain('"production_override"');
    expect(responsibility).toContain("历史整查费用承担方未经生产主管确认");
    expect(responsibility).toContain("item.execution_kind IN ('worker','tail_inspection')");
    expect(responsibility).toContain("整查费用由加工厂承担时必须按加工厂 100%、倍率 1.2 扣款");
    expect(panel).toContain('multiplier: "1.200"');
    expect(panel).toContain('tailInspectionCostBearer: tailCostBearer');
    expect(panel).toContain("历史系统默认（非质检判断）");
    expect(panel).toContain('response.tailInspectionCostBearerSource === "legacy_default"');
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
