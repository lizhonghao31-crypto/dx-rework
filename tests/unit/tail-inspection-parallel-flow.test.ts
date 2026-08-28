import { readFile } from "node:fs/promises";

import {
  SubmitProcessConfigurationSchema,
  SubmitTailInspectionReportSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("legacy tail inspection parallel flow", () => {
  it("rejects the retired standalone tail-assignment payload while preserving historical report validation", () => {
    const assignment = "00000000-0000-4000-8000-000000000001";
    expect(SubmitProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 1,
      expectedConfigurationVersion: 1,
      tailInspectors: [{ userId: assignment, boxScope: "A箱" }],
    }).success).toBe(false);
    expect(SubmitProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 1,
      expectedConfigurationVersion: 1,
      tailInspectors: [{ userId: assignment }, { userId: assignment }],
    }).success).toBe(false);

    const process = "00000000-0000-4000-8000-000000000002";
    expect(SubmitTailInspectionReportSchema.safeParse({
      returnedQuantity: 200,
      items: [{ configurationItemId: process, inspectedQuantity: 200 }],
    }).success).toBe(true);
    expect(SubmitTailInspectionReportSchema.safeParse({
      returnedQuantity: 200,
      items: [{ configurationItemId: process, inspectedQuantity: 201 }],
    }).success).toBe(false);
  });

  it("keeps historical per-process worker-to-tail reconciliation readable", async () => {
    const [migration, service, workerService, configurationService, tailService, panel] = await Promise.all([
      readFile("apps/api/migrations/0067_tail_inspection_parallel_flow.sql", "utf8"),
      readFile("apps/api/src/rework/whole-order-review-service.ts", "utf8"),
      readFile("apps/api/src/rework/work-reporting-service.ts", "utf8"),
      readFile("apps/api/src/rework/process-configuration-service.ts", "utf8"),
      readFile("apps/api/src/rework/tail-inspection-service.ts", "utf8"),
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
    ]);

    expect(migration).toContain("quantity adjustment is retired");
    expect(migration).toContain("worker count cannot exceed tail inspection count");
    expect(migration).toContain("alternative_action:='rework.tail_inspection.submit'");
    expect(migration).toContain("dx_rework.rework_request_id");
    expect(service).toContain("assertTailReconciliation");
    expect(service).toContain("tail_item.execution_kind='tail_inspection'");
    expect(service).toContain("item.execution_kind='worker'");
    expect(service).toContain("usesUnifiedTailReports");
    expect(service).toContain("worker.quantity > CASE WHEN $2::boolean");
    expect(service).toContain("ELSE legacy_tail.quantity END");
    expect(workerService).toContain("rework_tail_inspection_assignments");
    expect(workerService).toContain("返工执行报数只能填写整数件数");
    expect(configurationService).not.toContain('category: "tail_inspection"');
    expect(configurationService).not.toContain("INSERT INTO rework_tail_inspection_assignments");
    expect(tailService).toContain("completeOpenByDedupeKey");
    expect(tailService).toContain("orderTransitionEventId");
    expect(tailService).toContain('entityType: "rework_order"');
    expect(tailService).toContain("assignment.tail_inspector_user_id === actor.actorId || rootCanSubmit");
    expect(panel).toContain("返件总数（件）");
    expect(panel).toContain('isRoot ? "可代报"');
    expect(panel).toContain("确认代 ${assignment.tailInspectorName} 提交整查报数");
    expect(panel).toContain("每个工序默认同步该总数");
  });
});
