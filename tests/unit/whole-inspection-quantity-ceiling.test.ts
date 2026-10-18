import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("whole-inspection quantity ceiling", () => {
  it("allows every positive process quantity up to the whole-inspection quantity", async () => {
    const [service, migration, manifest] = await Promise.all([
      read("apps/api/src/rework/whole-order-review-service.ts"),
      read("apps/api/migrations/0110_whole_inspection_quantity_ceiling.sql"),
      read("apps/api/src/platform/migration-manifest.json"),
    ]);

    expect(service).toContain("numberValue(plan.completed_quantity) <= numberValue(plan.tail_checked_quantity)");
    expect(service).toContain("numberValue(plan.completed_quantity) > numberValue(plan.tail_checked_quantity)");
    expect(service).not.toContain("numberValue(plan.completed_quantity) !== numberValue(plan.tail_checked_quantity)");
    expect(migration).toContain("IF worker_quantity>tail_quantity");
    expect(migration).toContain("AND worker.quantity>tail_total.quantity");
    expect(migration).not.toContain("IF worker_quantity<>tail_quantity");
    expect(migration).not.toContain("AND worker.quantity<>tail_total.quantity");
    expect(manifest).toContain('"version": "0110_whole_inspection_quantity_ceiling"');
  });

  it("uses the new business name and ceiling semantics without changing internal identifiers", async () => {
    const [panel, configuration, contracts] = await Promise.all([
      read("apps/web/src/whole-order-review-panel.tsx"),
      read("apps/api/src/rework/process-configuration-service.ts"),
      read("packages/contracts/src/business-display.ts"),
    ]);

    expect(panel).toContain("{specialLabel}余量");
    expect(panel).toContain("✓ 可确认");
    expect(panel).toContain("⚠ 工序超数");
    expect(panel).not.toContain("完全一致");
    expect(configuration).toContain('["整查", "尾查"].includes(submittedProcessName)');
    expect(configuration).toContain('executionKind === "tail_inspection" ? specialName');
    expect(contracts).toContain('tail_inspector: "整查"');
    expect(contracts).toContain('"tail_inspection:report": "整查报数"');
  });
}
);
