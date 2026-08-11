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

  it("keeps the submit idempotency attempt after the draft save that precedes it", async () => {
    const form = await readFile("apps/web/src/rework-form.tsx", "utf8");

    expect(form).toContain("const persistDraft = async (clearPendingSubmit = true)");
    expect(form).toContain("if (clearPendingSubmit) pendingSubmit.current = null;");
    expect(form).toContain("() => persistDraft(false)");
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
    const [form, detail, helper] = await Promise.all([
      readFile("apps/web/src/rework-form.tsx", "utf8"),
      readFile("apps/web/src/rework-detail-page.tsx", "utf8"),
      readFile("apps/web/src/attachment-upload.ts", "utf8"),
    ]);

    expect(form).toContain("MAX_REWORK_ATTACHMENTS");
    expect(form).toContain("mapWithConcurrency(prepared, 2");
    expect(form).toContain("qc-upload-preview-list");
    expect(form).toContain("URL.createObjectURL(file)");
    expect(detail).toContain("订单图片");
    expect(detail).toContain("rework-detail-image-grid");
    expect(detail).toContain("rework-image-modal");
    expect(helper).toContain("const MAX_IMAGE_EDGE = 2048");
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
