import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("N01 v2 streamlined initiation", () => {
  it("keeps only the three routing facts and one report as the primary required contract", async () => {
    const [form, app, migration, submission] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/api/migrations/0077_rework_v2_n01_supply_context.sql", "utf8"),
      readFile("apps/api/src/rework/v2-submission-service.ts", "utf8"),
    ]);

    expect(app).toContain("<ReworkInitiationV2Form />");
    for (const label of ["款号 <b>*</b>", "加工厂 <b>*</b>", "订单跟单 <b>*</b>"]) {
      expect(form).toContain(label);
    }
    expect(form).toContain("上传报告 <b>*</b>");
    expect(form).toContain("＋ 上传报告");
    expect(form).toContain('accept="image/*"');
    expect(form).toContain("uploadImageWithNormalizationRetry");
    expect(form).toContain("availableImageCount > 0");
    expect(form).toContain("order?.attachmentIds.length ?? existingAttachmentCount");
    expect(form).toContain("报告仅支持图片格式");
    expect(form).not.toContain("验货阶段（必填）");
    expect(form).not.toContain("订单数量（必填）");
    expect(migration).toContain("rework_orders_n01_v2_submission_complete_check");
    expect(migration).toContain("merchandiser_user_id IS NOT NULL");
    expect(submission).toContain("请完整填写款号、加工厂和订单跟单");
    expect(submission).toContain("REWORK_IMAGE_REQUIRED");
  });

  it("keeps optional supplier relationships searchable, folded and outside the core rework row", async () => {
    const [form, migration, contracts] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/api/migrations/0077_rework_v2_n01_supply_context.sql", "utf8"),
      readFile("packages/contracts/src/rework-supply-context.ts", "utf8"),
    ]);

    expect(form).toContain('<details className="rework-v2-more">');
    expect(form).toContain("<summary>更多信息</summary>");
    for (const label of ["洗水厂", "印绣花厂", "面辅料供应商", "印绣花跟单"]) {
      expect(form).toContain(label);
    }
    expect(form).toContain("<SearchSelect");
    expect(migration).toContain("CREATE TABLE rework_order_supply_context");
    expect(migration).toContain("washing_supplier_id");
    expect(migration).toContain("embroidery_supplier_id");
    expect(migration).toContain("fabric_supplier_id");
    expect(migration).toContain("embroidery_merchandiser_user_id");
    expect(contracts).toContain("SaveReworkSupplyContextSchema");
  });

  it("uses the receiving board as the only N01 creation entry", async () => {
    const [board, navigation, form] = await Promise.all([
      readFile("apps/web/src/order-board-page.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
    ]);

    expect(board).toContain('pageUrl("ui/qc/new")');
    expect(board).toContain("new URLSearchParams({ receivingBatchId: row.receivingBatchId })");
    expect(board).toContain("发起返工");
    expect(navigation).not.toContain('name: "发起返工"');
    expect(form).toContain('get("receivingBatchId")');
    expect(form).toContain("rework-orders/receiving-entry/");
    expect(form).toContain('readOnly={Boolean(receivingBatchId || order?.receivingBatchId)}');
    expect(form).not.toContain("differenceQuantity");
    expect(form).not.toContain("lastReceiverName");
    expect(form).not.toContain("receivedAt");
  });
});
