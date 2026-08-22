import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("PR-05 final quantity and IE review", () => {
  it("adds an explicit two-step state transition", async () => {
    const [domain, contracts, migration] = await Promise.all([
      read("packages/domain/src/index.ts"),
      read("packages/contracts/src/index.ts"),
      read("apps/api/migrations/0080_rework_v2_final_quantity_ie_review.sql"),
    ]);
    expect(domain).toContain('pending_order_review: ["in_progress", "pending_order_review", "pending_quantity_adjustment_ie_review", "pending_final_quantity_ie_review"]');
    expect(domain).toContain('pending_final_quantity_ie_review: ["pending_order_review", "pending_responsibility_determination"]');
    expect(contracts).toContain("ReviewFinalQuantitySchema");
    expect(migration).toContain("rework.tail_completion.confirm");
    expect(migration).toContain("rework.final_quantity.ie_review");
  });

  it("preserves reported quantities and stores versioned final quantities", async () => {
    const [migration, service] = await Promise.all([
      read("apps/api/migrations/0080_rework_v2_final_quantity_ie_review.sql"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
    ]);
    expect(migration).toContain("CREATE TABLE rework_tail_completion_quantities");
    expect(migration).toContain("CREATE TABLE rework_tail_completion_reviews");
    expect(migration).toContain("confirmation_version");
    expect(migration).toContain("settlement_quantity");
    expect(service).toContain("worker_reported_quantity");
    expect(service).toContain("final_confirmed_quantity");
    expect(service).not.toContain("SET actual_quantity=");
  });

  it("materializes wages only after IE approval using settlement quantity", async () => {
    const [migration, service] = await Promise.all([
      read("apps/api/migrations/0080_rework_v2_final_quantity_ie_review.sql"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
    ]);
    expect(migration).toContain("COALESCE(report.settlement_quantity,report.actual_quantity)");
    expect(migration).toContain("approved IE final-quantity review is required");
    expect(service).toContain("rework.final_quantity.ie_review");
    expect(service).toContain("pending_responsibility_determination");
  });

  it("shows separate N05 and N06 workspaces with return semantics", async () => {
    const [detail, panel] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);
    expect(detail).toContain('node("whole_order_review", "05", "尾部最终数量确认"');
    expect(detail).toContain('node("final_quantity_ie_review", "06", "IE 最终数量复核"');
    expect(panel).toContain("工人上数、尾查数与最终确认数");
    expect(panel).toContain("退回尾部确认");
    expect(panel).toContain("通过并进入责任判定");
  });
});
