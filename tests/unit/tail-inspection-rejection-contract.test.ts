import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("legacy tail inspection rejection", () => {
  it("lets the tail supervisor reject a submitted tail count and keeps the original report as audit history", async () => {
    const [service, routes, migration, panel] = await Promise.all([
      read("apps/api/src/rework/tail-inspection-service.ts"),
      read("apps/api/src/rework/tail-inspection-routes.ts"),
      read("apps/api/migrations/0072_tail_inspection_rejection.sql"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);

    expect(routes).toContain("/tail-inspection-assignments/:assignmentId/reject");
    expect(service).toContain('order.status !== "pending_order_review"');
    expect(service).toContain("SET status='rejected'");
    expect(service).toContain("rework.tail_inspection.reject");
    expect(service).toContain("tail-inspection-return:");
    expect(migration).toContain("guard_rework_tail_inspection_report_rejection");
    expect(migration).not.toContain("DELETE FROM rework_tail_inspection_reports");
    expect(panel).toContain("驳回整查");
    expect(panel).toContain("整查可重新报数");
  });

  it("keeps the rejection todo on the same assignment entity as its source event", async () => {
    const service = await read("apps/api/src/rework/tail-inspection-service.ts");
    const todoProjection = service.split('sourceAction: "rework.tail_inspection.reject"')[1]
      ?.split("recipientUserId:")[0] ?? "";

    expect(todoProjection).toContain('entityType: "rework_tail_inspection_assignment"');
    expect(todoProjection).toContain("entityId: assignmentId");
    expect(todoProjection).not.toContain('entityType: "rework_order"');
  });

  it("does not disturb valid worker completion records when correcting a legacy tail count", async () => {
    const service = await read("apps/api/src/rework/tail-inspection-service.ts");
    expect(service).not.toContain("UPDATE rework_work_reports");
    expect(service).not.toContain("DELETE FROM rework_work_reports");
  });
});
