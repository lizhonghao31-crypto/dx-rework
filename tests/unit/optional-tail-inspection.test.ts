import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("optional tail inspection", () => {
  it("keeps every existing order on the historical mandatory-tail behavior", async () => {
    const [migration, manifest] = await Promise.all([
      read("apps/api/migrations/0099_optional_tail_inspection.sql"),
      read("apps/api/src/platform/migration-manifest.json"),
    ]);
    expect(migration).toContain("tail_inspection_required boolean NOT NULL DEFAULT true");
    expect(manifest).toContain('"version": "0099_optional_tail_inspection"');
    expect(manifest).toContain('"version": "0100_optional_tail_final_quantity_guard"');
  });

  it("defaults N01 to yes and preserves old local drafts as yes", async () => {
    const form = await read("apps/web/src/rework-v2-form.tsx");
    expect(form).toContain("是否需要整查？");
    expect(form).toContain("tailInspectionRequired: true");
    expect(form).toContain("tailInspectionRequired !== false");
    expect(form).toContain("tailInspectionRequired: form.tailInspectionRequired");
  });

  it("rejects tail payloads for no-tail orders and still requires one tail item otherwise", async () => {
    const configuration = await read("apps/api/src/rework/process-configuration-service.ts");
    expect(configuration).toContain("tailInspectionRequired ? tailItems.length !== 1 : tailItems.length !== 0");
    expect(configuration).toContain("本单不需要整查，不能配置整查工序");
  });

  it("removes tail assignment and reconciliation only for explicitly no-tail orders", async () => {
    const [assignment, review, panel] = await Promise.all([
      read("apps/web/src/process-worker-assignment-form.tsx"),
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);
    expect(assignment).toContain("tailInspectionRequired ? <Surface");
    expect(assignment).toContain(": configItems");
    expect(review).toContain("if (!tailInspectionRequired)");
    expect(review).toContain("仍有返工执行报数未完成，不能整单确认");
    expect(panel).toContain("!overview.tailInspectionRequired");
    expect(panel).toContain("本单无需${specialLabel}");
  });

  it("persists worker-derived final quantities without fabricating tail facts", async () => {
    const migration = await read("apps/api/migrations/0100_optional_tail_final_quantity_guard.sql");
    expect(migration).toContain("target.tail_inspection_required");
    expect(migration).toContain("rework_work_report_effective_quantity(report.work_report_id)");
    expect(migration).toContain("NEW.tail_reported_quantity<>0");
    expect(migration).toContain("NEW.final_confirmed_quantity<>worker_quantity");
    expect(migration).toContain("worker_quantity<>tail_quantity");
  });

  it("keeps the N06 guard and embedded error feedback aligned with the order decision", async () => {
    const [migration, integration, panel] = await Promise.all([
      read("apps/api/migrations/0101_optional_tail_n06_guard.sql"),
      read("tests/integration/optional-tail-inspection-postgres.test.ts"),
      read("apps/web/src/whole-order-review-panel.tsx"),
    ]);
    expect(migration).toContain("tail_process_count bigint");
    expect(migration).toContain("tail_required AND tail_process_count<>1");
    expect(migration).toContain("NOT tail_required AND tail_process_count<>0");
    expect(migration).toContain("unified_execution AND tail_required AND EXISTS");
    expect(integration).toContain("review.reviewFinalQuantity");
    expect(integration).toContain('kind === "inhouse_finishing" ? "completed" : "pending_responsibility_determination"');
    expect(panel).toContain("embedded && message");
  });

  it("uses no-tail workflow copy and waits for the saved tail roster to load", async () => {
    const [detail, assignment, businessDetail] = await Promise.all([
      read("apps/web/src/rework-detail-page.tsx"),
      read("apps/web/src/process-worker-assignment-form.tsx"),
      read("apps/api/src/rework/rework-business-detail-service.ts"),
    ]);
    expect(detail).toContain('detail.tailInspectionRequired ? `返工人员 / ${specialProcessLabel(detail)}` : detail.reworkKind === "inhouse_finishing" ? "做尾人员" : "返工人员"');
    expect(detail).toContain("系统按工人有效上数生成最终数量");
    expect(assignment).toContain("assignmentOptionsLoading && editable ? []");
    expect(assignment).toContain("正在加载默认名单…");
    expect(assignment).toContain("editable && !assignmentOptionsLoading");
    expect(businessDetail).toContain("tailInspectionRequired: row.tail_inspection_required");
  });
});
