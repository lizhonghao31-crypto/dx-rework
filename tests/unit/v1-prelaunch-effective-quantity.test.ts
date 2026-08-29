import { readFile } from "node:fs/promises";

import {
  CorrectWorkReportQuantitiesSchema,
  CorrectWorkReportQuantitySchema,
  ReviewWholeOrderSchema,
} from "@dx-rework/contracts";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");
const id = "00000000-0000-4000-8000-000000000010";

describe("1.0 prelaunch effective quantity", () => {
  it("keeps correction input minimal and removes the third final-quantity input", () => {
    expect(CorrectWorkReportQuantitySchema.parse({
      expectedOrderVersion: 7,
      effectiveQuantity: 4800,
    })).toEqual({ expectedOrderVersion: 7, effectiveQuantity: 4800 });
    expect(CorrectWorkReportQuantitySchema.safeParse({
      expectedOrderVersion: 7,
      effectiveQuantity: 0,
    }).success).toBe(false);
    expect(CorrectWorkReportQuantitiesSchema.parse({
      expectedOrderVersion: 7,
      configurationItemId: id,
      corrections: [{ workReportId: id, effectiveQuantity: 4800 }],
    }).corrections).toHaveLength(1);
    expect(ReviewWholeOrderSchema.safeParse({
      expectedOrderVersion: 7,
      temporaryCoefficients: [{
        configurationItemId: id,
        personId: id,
        multiplier: 1,
      }],
    }).success).toBe(true);
    expect(ReviewWholeOrderSchema.safeParse({
      expectedOrderVersion: 7,
      finalQuantities: [{ configurationItemId: id, finalConfirmedQuantity: 4800 }],
      temporaryCoefficients: [],
    }).success).toBe(false);
  });

  it("stores corrections as append-only revisions with a trusted event", async () => {
    const migration = await read("apps/api/migrations/0087_effective_work_report_quantity.sql");
    expect(migration).toContain("CREATE TABLE rework_work_report_quantity_revisions");
    expect(migration).toContain("UNIQUE(work_report_id,revision_version)");
    expect(migration).toContain("rework_work_report_quantity_revisions_no_update");
    expect(migration).toContain("rework_work_report_quantity_revisions_no_delete");
    expect(migration).toContain("rework_work_report_quantity_revisions_no_truncate");
    expect(migration).toContain("rework.work_report.quantity_correct");
    expect(migration).toContain("authorization_capability='submission:audit'");
  });

  it("uses one effective source for N05 reconciliation, N06 and wage materialization", async () => {
    const [migration, service] = await Promise.all([
      read("apps/api/migrations/0087_effective_work_report_quantity.sql"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
    ]);
    expect(migration).toContain("CREATE OR REPLACE FUNCTION rework_work_report_effective_quantity");
    expect(migration).toContain("worker_quantity<>tail_quantity");
    expect(migration).toContain("NEW.final_confirmed_quantity<>worker_quantity");
    expect(service).toContain("rework_work_report_effective_quantity(report.work_report_id)*item.unit_price");
    expect(service).toContain("async correctReportQuantity");
    expect(service).toContain('order.status !== "pending_order_review"');
  });

  it("keeps N05 editable and N06 read-only in the existing panel", async () => {
    const [panel, routes, service] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/api/src/rework/whole-order-review-routes.ts"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
    ]);
    expect(panel).toContain("主管修改，原值");
    expect(panel).toContain('className="quantity-report-row quantity-tail-summary"');
    expect(panel).toContain("work-report-quantity-corrections");
    expect(panel).toContain("IE 只读核对系统锁定的数量事实");
    expect(panel).toContain("确认数量并提交 IE");
    expect(panel).toContain("const [coefficientExpanded, setCoefficientExpanded] = useState<Record<string, boolean>>({})");
    expect(panel).toContain("const [coefficientSectionExpanded, setCoefficientSectionExpanded] = useState(false)");
    expect(panel).toContain("<strong>临时工工资调整</strong>");
    expect(panel).toContain("temporaryWorkerGroups.map");
    expect(panel).not.toContain("finalQuantities");
    expect(panel).toContain("work-report-quantity-corrections");
    expect(panel).toContain(">保存修正</Button>");
    expect(panel).not.toContain("onClick={() => void correct(report)}");
    expect(routes).toContain("CorrectWorkReportQuantitiesSchema");
    expect(routes).toContain("correctReportQuantities");
    expect(service).toContain("async correctReportQuantities");
    expect(service).toContain("WHERE report.work_report_id=ANY($1::uuid[])");
    expect(service).toContain("await this.order(client, reworkOrderId, true)");
  });
});
