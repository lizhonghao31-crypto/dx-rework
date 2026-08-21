import { readFile } from "node:fs/promises";
import type { ReworkOrderResponse } from "@dx-rework/contracts";
import { describe, expect, it, vi } from "vitest";

import { hasPageAccess } from "../../apps/web/src/auth.js";
import {
  executeReworkSubmit,
  isReworkFormMutationAllowed,
  type PendingSubmitAttempt,
} from "../../apps/web/src/rework-submission.js";

const draft = (version = 3): ReworkOrderResponse => ({
  reworkOrderId: "00000000-0000-4000-8000-000000000010",
  reworkNo: null,
  status: "draft",
  styleNo: "PD20529725",
  customerSupplyCode: null,
  factoryStyleNo: null,
  orderNo: null,
  orderQuantity: null,
  merchandiserUserId: null,
  processingFactory: null,
  reworkReason: null,
  reworkProcess: null,
  problemPart: null,
  problemDescription: null,
  reworkQuantity: null,
  attachmentIds: [],
  hasOtherOpenStyleOrder: false,
  version,
  createdAt: "2026-08-02T00:00:00.000Z",
  updatedAt: "2026-08-02T00:00:00.000Z",
  submittedAt: null,
  cancelledAt: null,
  cancelReason: null,
});

describe("PR-05 web behavior", () => {
  it("replays an unresolved submit before attempting another draft save", async () => {
    const current = draft();
    const pending: PendingSubmitAttempt = {
      reworkOrderId: current.reworkOrderId,
      body: { expectedVersion: current.version },
      key: "original-submit-key",
    };
    const persistDraft = vi.fn(async () => draft(4));
    const createAttempt = vi.fn(() => pending);
    const send = vi.fn(async () => ({
      ...current,
      reworkNo: "RW-2026-0802-001",
      status: "pending_process_configuration" as const,
      version: 4,
    }));

    const submitted = await executeReworkSubmit(
      current,
      pending,
      persistDraft,
      createAttempt,
      send,
    );

    expect(persistDraft).not.toHaveBeenCalled();
    expect(createAttempt).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(pending);
    expect(submitted.status).toBe("pending_process_configuration");
  });

  it("persists first and creates one submit attempt when no replay exists", async () => {
    const saved = draft();
    const attempt: PendingSubmitAttempt = {
      reworkOrderId: saved.reworkOrderId,
      body: { expectedVersion: saved.version },
      key: "new-submit-key",
    };
    const persistDraft = vi.fn(async () => saved);
    const createAttempt = vi.fn(() => attempt);
    const send = vi.fn(async () => saved);

    await executeReworkSubmit(null, null, persistDraft, createAttempt, send);

    expect(persistDraft).toHaveBeenCalledOnce();
    expect(createAttempt).toHaveBeenCalledWith(saved);
    expect(send).toHaveBeenCalledWith(attempt);
  });

  it("keeps the submit idempotency attempt after the server draft staging that precedes real submit", async () => {
    const form = await readFile("apps/web/src/rework-v2-form.tsx", "utf8");

    expect(form).toContain("const pendingSubmit = useRef<PendingSubmitAttempt | null>(null);");
    expect(form).toContain("const persistServerDraft = async (clearPendingSubmit = true)");
    expect(form).toContain("if (clearPendingSubmit) pendingSubmit.current = null;");
    expect(form).toContain("executeReworkSubmit(");
    expect(form).toContain("() => persistServerDraft(false)");
    expect(form).toContain("pendingSubmit.current = attempt;");
    expect(form).toContain('headers: { "idempotency-key": attempt.key }');
  });

  it("blocks every form mutation until an existing draft has finished restoring", () => {
    expect(isReworkFormMutationAllowed({
      busy: false,
      uploading: false,
      restoringDraft: true,
    })).toBe(false);
    expect(isReworkFormMutationAllowed({
      busy: true,
      uploading: false,
      restoringDraft: false,
    })).toBe(false);
    expect(isReworkFormMutationAllowed({
      busy: false,
      uploading: true,
      restoringDraft: false,
    })).toBe(false);
    expect(isReworkFormMutationAllowed({
      busy: false,
      uploading: false,
      restoringDraft: false,
    })).toBe(true);
  });

  it("keeps QC uploads compact, capped and previewable throughout the order detail", async () => {
    const [form, detail, helper, supplement] = await Promise.all([
      readFile("apps/web/src/rework-v2-form.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/attachment-upload.ts", "utf8"),
      readFile("apps/web/src/order-image-supplement-uploader.tsx", "utf8"),
    ]);

    expect(form).toContain("MAX_REWORK_ATTACHMENTS");
    expect(form).toContain("const uploadConcurrency = currentQcUploadConcurrency();");
    expect(form).toContain("prepareAndUploadWithConcurrency(");
    expect(form).toContain("uploadConcurrency,");
    expect(form).not.toContain("mapWithConcurrency(selected, 2, prepareAttachmentForUpload)");
    expect(form).not.toContain("firstUploadStartedAt");
    expect(form).not.toContain("秒开始上传");
    expect(form).toContain("rework-v2-image-grid");
    expect(form).toContain("URL.createObjectURL(file)");
    expect(detail).toContain("订单图片");
    expect(detail).toContain("rework-detail-image-grid");
    expect(detail).toContain("rework-image-modal");
    expect(detail).toContain("OrderImageSupplementUploader");
    expect(detail).toContain("rework.attachments.supplement");
    expect(detail).not.toContain("点击缩略图可放大查看");
    expect(detail).not.toContain("暂未上传订单图片");
    expect(supplement).toContain("supplemental-images");
    expect(supplement).toContain("MAX_REWORK_ATTACHMENTS");
    expect(supplement).toContain("isImageAttachment");
    expect(supplement).toContain('"上传图片"');
    expect(helper).toContain("const MAX_IMAGE_EDGE = 2048");
    expect(helper).toContain("SMALL_IMAGE_DIRECT_UPLOAD_BYTES = 1024 * 1024");
    expect(helper).toContain("shouldCompressImageBeforeUpload(file)");
    expect(helper).toContain("__DX_REWORK_UPLOAD_TIMINGS__");
    expect(form).toContain('measureAttachmentUploadStage(timing, "hash"');
    expect(form).toContain('"intent"');
    expect(form).toContain('"oss"');
    expect(form).toContain('"finalize"');
    expect(helper).toContain('canvas.toBlob(resolve, "image/webp", WEBP_QUALITY)');
  });

  it("requires both the QC role and initiation capability only on the QC page", () => {
    const requirement = {
      requiredRole: "quality_control",
      requiredCapability: "rework:initiate",
    };
    expect(hasPageAccess({
      displayName: "品控",
      businessRoles: ["quality_control"],
      capabilities: ["rework:initiate"],
    }, requirement)).toBe(true);
    expect(hasPageAccess({
      displayName: "管理员",
      businessRoles: ["system_admin"],
      capabilities: ["rework:initiate"],
    }, requirement)).toBe(false);
    expect(hasPageAccess({
      displayName: "品控",
      businessRoles: ["quality_control"],
      capabilities: [],
    }, requirement)).toBe(false);
    expect(hasPageAccess({
      displayName: "其他岗位",
      businessRoles: ["worker"],
      capabilities: ["tasks:read"],
    })).toBe(true);
  });
});
