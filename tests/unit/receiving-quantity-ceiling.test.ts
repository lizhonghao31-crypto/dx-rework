import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { ensureWithinSourceReceivingActualQuantity, sourceReceivingQuantityCeilingError } from "../../apps/api/src/rework/receiving-quantity-ceiling.js";

describe("receiving-linked rework quantity ceiling", () => {
  it("maps only the known receiving ceiling constraint without masking other database failures", () => {
    expect(sourceReceivingQuantityCeilingError({code:"23514",message:"rework quantity exceeds source receiving actual quantity ceiling 100"})).toMatchObject({code:"VALIDATION_ERROR",statusCode:400,message:"确认数量不能超过本次实收数量 100 件，请刷新报数后重试"});
    for(const cause of [null, new Error("unexpected"), {code:"23514",message:"another constraint"}, {code:"23505",message:"rework quantity exceeds source receiving actual quantity ceiling 100"}]) expect(sourceReceivingQuantityCeilingError(cause)).toBeNull();
  });
  it("rejects quantities above the exact source receiving actual quantity", async () => {
    const database = {
      query: async () => ({ rows: [{ quantity: "100" }] }),
    };
    await expect(ensureWithinSourceReceivingActualQuantity(
      database as never,
      "00000000-0000-4000-8000-000000000001",
      [{ label: "返工工序报数", quantity: 101 }],
    )).rejects.toThrow("返工工序报数不能超过本次实收数量 100 件");
    await expect(ensureWithinSourceReceivingActualQuantity(
      database as never,
      "00000000-0000-4000-8000-000000000001",
      [{ label: "整查返件总数", quantity: 100 }],
    )).resolves.toBeUndefined();
  });

  it("keeps legacy orders without a receiving batch compatible", async () => {
    const database = {
      query: async () => ({ rows: [{ quantity: null }] }),
    };
    await expect(ensureWithinSourceReceivingActualQuantity(
      database as never,
      "00000000-0000-4000-8000-000000000002",
      [{ label: "返工工序报数", quantity: 999 }],
    )).resolves.toBeUndefined();
  });

  it("applies the exact original craft ceiling without converting pieces into garments", async () => {
    const database = { query: async () => ({ rows: [{ quantity: "20",unit:"片" }] }) };
    const id = "00000000-0000-4000-8000-000000000003";
    await expect(ensureWithinSourceReceivingActualQuantity(database as never,id,[{label:"实际发出",quantity:21}])).rejects.toThrow("实际发出不能超过本次原工艺问题范围 20 片");
    await expect(ensureWithinSourceReceivingActualQuantity(database as never,id,[{label:"实际发出",quantity:20}])).resolves.toBeUndefined();
    expect(sourceReceivingQuantityCeilingError({code:"23514",message:"rework quantity exceeds source craft issue quantity ceiling 20"})).toMatchObject({
      code:"VALIDATION_ERROR",message:"确认数量不能超过本次原工艺问题范围 20 片，请刷新后重试",
    });
  });

  it("covers every persisted quantity path with a database guard", async () => {
    const migration = await readFile("apps/api/migrations/0141_rework_receiving_quantity_ceiling.sql", "utf8");
    for (const table of [
      "rework_process_configuration_items",
      "rework_process_quantity_adjustments",
      "rework_work_reports",
      "rework_work_report_quantity_revisions",
      "rework_tail_inspection_reports",
      "rework_tail_completion_quantities",
    ]) {
      expect(migration).toContain(table);
    }
    expect(migration).toContain("source_receiving_batch_id");
    expect(migration).toContain("exceeds source receiving actual quantity ceiling");
  });

  it("shows explicit dialogs when quantity or workflow submissions fail", async () => {
    const [work, tail, whole, configuration, legacy] = await Promise.all([
      readFile("apps/web/src/work-reporting-form.tsx", "utf8"),
      readFile("apps/web/src/tail-inspection-panel.tsx", "utf8"),
      readFile("apps/web/src/whole-order-review-panel.tsx", "utf8"),
      readFile("apps/web/src/process-worker-assignment-form.tsx", "utf8"),
      readFile("apps/web/src/legacy-process-configuration-form.tsx", "utf8"),
    ]);
    expect(work).toContain('title: "返工报数提交失败"');
    expect(work).toContain('title: "流程提交失败"');
    expect(tail).toContain('title: "整查报数提交失败"');
    expect(whole).toContain('title: "数量提交失败"');
    expect(configuration).toContain('title: "工序配置提交失败"');
    expect(legacy).toContain('title: "工序配置提交失败"');
  });
});
