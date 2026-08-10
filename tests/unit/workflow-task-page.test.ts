import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workflow task page", () => {
  it("opens production and wage actions as focused personal tasks", async () => {
    const [list, task, detail, configuration, reporting] = await Promise.all([
      readFile("apps/web/src/my-todos-page.tsx", "utf8"),
      readFile("apps/web/src/responsibility-task-page.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/process-configuration-form.tsx", "utf8"),
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
    ]);

    for (const routeName of ["process_configuration", "whole_order_review", "wage_period_detail"]) {
      expect(list).toContain(`"${routeName}"`);
      expect(task).toContain(`"${routeName}"`);
    }
    expect(task).toContain("<ReworkDetailPage");
    expect(detail).toContain("<ProcessConfigurationForm reworkOrderId={detail.reworkOrderId}");
    expect(detail).toContain('taskMode="whole_order_review"');
    expect(task).toContain("<WagePeriodDetailPage periodId={route.entityId} />");
    expect(configuration).toContain("reworkOrderId: providedReworkOrderId");
    expect(reporting).toContain('taskMode?: "workspace" | "whole_order_review"');
    expect(reporting).toContain('if (taskMode === "whole_order_review")');
  });
});
