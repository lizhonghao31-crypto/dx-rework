import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("UAT 1.6 closure regressions", () => {
  it("keeps terminal archive, complete initiation context and readonly history visible in the order detail", async () => {
    const [detail, form, service] = await Promise.all([
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/api/src/rework/service.ts", "utf8"),
    ]);
    expect(detail).toContain('if (status === "completed") return "completed";');
    expect(detail).toContain("处理人：");
    expect(detail).toContain("处理时间：");
    expect(detail).toContain("处理意见：");
    expect(detail).toContain("已上传附件");
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
    expect(responsibility).toContain("round(share.amount,2)::text amount");
    expect(external).toContain("新增并选择");
    expect(external).toContain("master-data/suppliers");
    expect(access).toContain('capability === "master_data:manage"');
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
});
