import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("sourcing PR2 unified desktop workspace", () => {
  it("uses the shared shell with three permission-aware sourcing children", async () => {
    const source = await readFile("apps/web/src/components.tsx", "utf8");
    expect(source).toContain('name: "创建订单"');
    expect(source).toContain('name: "待审批订单"');
    expect(source).toContain('name: "历史订单"');
    expect(source).toContain('hasCapability("sourcing:inquiry:create")');
    expect(source).toContain("Desktop-only sourcing");
    expect(source).not.toContain('"创建订单": { label:');
  });

  it("keeps all approval facts, photos and workflow nodes visible on one detail page", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    for (const label of [
      "跟单创建订单",
      "IE 给价",
      "调价与选厂",
      "最终审批",
      "财务核对",
      "交货日期",
      "工艺",
      "订单图片",
      "办理区",
    ]) expect(source).toContain(label);
    expect(source).toContain("MAX_SOURCING_ATTACHMENTS");
    expect(source).toContain("SourcingTimelineResponseSchema");
    expect(source).toContain("sourcingWorkflowNodeHref");
    expect(source).toContain('{ key: "finance", number: "05"');
    expect(source).not.toContain('{ key: "contract"');
    expect(source).toContain("rework-detail-node-history");
    expect(source).toContain('sourcing-detail-layout');
    expect(source).not.toContain('<h2>流程记录</h2>');
    expect(source).toContain('import "./rework-detail.css"');
  });

  it("provides stable create, pending, history and detail routes", async () => {
    const source = await readFile("apps/web/src/App.tsx", "utf8");
    expect(source).toContain('path === "/ui/sourcing/create"');
    expect(source).toContain('path === "/ui/sourcing/pending"');
    expect(source).toContain('path === "/ui/sourcing/history"');
    expect(source).toContain("sourcingOrderMatch");
    expect(source).toContain("ui\\/sourcing\\/orders");
    expect(source).toContain('path.startsWith("/ui/sourcing")');
  });

  it("binds only ready owned image attachments to the created sourcing case", async () => {
    const source = await readFile("apps/api/src/sourcing/sourcing-service.ts", "utf8");
    expect(source).toContain("uploaded_by=$2");
    expect(source).toContain("status='ready'");
    expect(source).toContain("entity_type IS NULL");
    expect(source).toContain("entity_type='sourcing_case'");
    expect(source).toContain("listTimeline");
  });
  it("reuses the proven rework image normalization and removal path", async () => {
    const source = await readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8");
    for (const contract of [
      "isImageUploadCandidate",
      "prepareImageUploadCandidate",
      "uploadImageWithNormalizationRetry",
      "measureAttachmentUploadStage",
      "currentUploadClientProfile",
      "removeImage",
      "URL.createObjectURL(candidate)",
      'accept="image/*"',
      "disabled={busy || uploading",
    ]) expect(source).toContain(contract);
    expect(source).not.toContain("isImageAttachment");
    expect(source).not.toContain("prepareAttachmentForUpload");
    expect(source).not.toContain("Uploaded object is not a valid file of the declared type");
  });

});
