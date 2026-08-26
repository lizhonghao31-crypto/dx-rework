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
    expect(configuration).toContain("本单不需要整查，不能配置尾查工序");
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
    expect(review).toContain("工人有效上数");
    expect(panel).toContain("!overview.tailInspectionRequired");
    expect(panel).toContain("本单无需整查");
  });
});
