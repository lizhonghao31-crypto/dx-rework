import { readFile } from "node:fs/promises";

import { truncateDecimal } from "../../apps/api/src/rework/process-configuration-service.js";
import {
  cents,
  decimalToScaled,
  halfUp2,
} from "../../apps/api/src/rework/responsibility-determination-service.js";
import { describe, expect, it } from "vitest";

describe("UAT 1.6 closure regressions", () => {
  it("keeps terminal archive, complete initiation context and readonly history visible in the order detail", async () => {
    const [detail, form, service] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/api/src/rework/service.ts", "utf8"),
    ]);
    expect(detail).toContain('if (detail.status === "completed")');
    expect(detail).toContain('node("settlement_followup", "09", "返工业务完成"');
    expect(detail).toContain("处理人：");
    expect(detail).toContain("处理时间：");
    expect(detail).toContain("处理意见：");
    expect(detail).toContain('action.includes("process_configuration.review") || action.includes("ie_review")');
    expect(detail).toContain('action.includes(".complete") || action.includes(".archive")');
    expect(detail).toContain("其他附件（含外部责任凭证）");
    expect(detail).toContain("订单图片");
    expect(detail).toContain("attachmentUrl");
    expect(detail).toContain('mode: "preview" | "download"');
    expect(detail).toContain('attachmentUrl(attachment.attachmentId, "preview")');
    expect(detail).toContain("external_responsibility_case");
    for (const field of [
      "customerSupplyCode",
      "factoryStyleNo",
      "orderQuantity",
      "reworkReason",
      "reworkProcess",
    ]) {
      expect(form).toContain(field);
      expect(service).toContain(field);
    }
  });

  it("uses settled wage cents and allows an absent external supplier to be added at the handling point", async () => {
    const [responsibility, external, access] = await Promise.all([
      readFile("apps/api/src/rework/responsibility-determination-service.ts", "utf8"),
      readFile("apps/web/src/external-responsibility-panel.tsx", "utf8"),
      readFile("apps/api/src/access/routes.ts", "utf8"),
    ]);
    expect(responsibility).toContain("wage.payable_amount::text amount");
    expect(responsibility).toContain("sum(wage.payable_amount)");
    expect(responsibility).not.toContain("round(share.amount,2)::text amount");
    expect(external).toContain("新增并选择");
    expect(external).toContain("external-responsibilities/temporary-suppliers");
    expect(external).not.toContain('apiUrl("master-data/suppliers")');
    expect(access).not.toContain('capability === "master_data:manage"');
  });

  it("truncates unit prices to three decimals and rounds settled piecework money half up", () => {
    expect(truncateDecimal(5.4959, 3)).toBe(5.495);
    const scaled = decimalToScaled("5.495", 8)
      * decimalToScaled("1.000", 3)
      * 10_000n;
    expect(cents(halfUp2(scaled, 10n ** 15n))).toBe("5.50");
  });

  it("does not describe an unfinished upload as an attachment processing exception", async () => {
    const [adminService, adminPage] = await Promise.all([
      readFile("apps/api/src/admin-console-service.ts", "utf8"),
      readFile("apps/web/src/admin-console-page.tsx", "utf8"),
    ]);
    expect(adminService).toContain("attachment_upload_not_completed");
    expect(adminService).not.toContain("attachment_pending_overdue");
    expect(adminPage).toContain("待上传（尚未完成）");
    expect(adminPage).toContain("已上传");
  });

  it("includes ready external evidence in the detail record and authorizes it through the same business view", async () => {
    const [detailService, server] = await Promise.all([
      readFile("apps/api/src/rework/rework-business-detail-service.ts", "utf8"),
      readFile("apps/api/src/server.ts", "utf8"),
    ]);
    expect(detailService).toContain("external_responsibility_case");
    expect(detailService).toContain("canDownloadBoundAttachment");
    expect(server).toContain("reworkBusinessDetailService.canDownloadBoundAttachment");
    const settledWageMigration = await readFile(
      "apps/api/migrations/0045_responsibility_settled_wage_base.sql",
      "utf8",
    );
    expect(settledWageMigration).toContain("wage.payable_amount = NEW.base_member_share_amount");
    expect(settledWageMigration).toContain("unit_price = trunc(unit_price, 3)");
  });
});
