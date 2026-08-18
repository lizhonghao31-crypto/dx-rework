import { readFile } from "node:fs/promises";

import {
  SubmitProcessConfigurationSchema,
  SubmitTailInspectionReportSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

describe("tail inspection parallel flow", () => {
  it("requires N02 to assign distinct tail inspectors and validates per-process physical counts", () => {
    const assignment = "00000000-0000-4000-8000-000000000001";
    expect(SubmitProcessConfigurationSchema.safeParse({
      expectedOrderVersion: 1,
      expectedConfigurationVersion: 1,
      tailInspectors: [{ userId: assignment, boxScope: "A箱" }],
    }).success).toBe(true);
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

  it("retires the plan-adjustment path and gates N07 on per-process worker-to-tail reconciliation", async () => {
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
    expect(service).toContain("worker.quantity>tail_checked.quantity");
    expect(workerService).toContain("rework_tail_inspection_assignments");
    expect(workerService).toContain("工人完工上数只能填写整数件数");
    expect(configurationService).toContain('category: "tail_inspection"');
    expect(configurationService).toContain("tail-inspection:${reworkOrderId}:${assignment.assignmentId}");
    expect(tailService).toContain("completeOpenByDedupeKey");
    expect(tailService).toContain("orderTransitionEventId");
    expect(tailService).toContain('entityType: "rework_order"');
    expect(tailService).toContain("assignment.tail_inspector_user_id === actor.actorId || rootCanSubmit");
    expect(panel).toContain("返件总数（件）");
    expect(panel).toContain("Root 可代报");
    expect(panel).toContain("Root 代报尾查数量");
    expect(panel).toContain("每个工序默认同步该总数");
  });
});
