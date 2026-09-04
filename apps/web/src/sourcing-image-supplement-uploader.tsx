import { formatBusinessDecimal } from "@dx-rework/contracts/business-display";
import {
  AttachmentResponseSchema,
  MAX_SOURCING_ATTACHMENTS,
  SourcingAttachmentListResponseSchema,
  UploadIntentResponseSchema,
} from "@dx-rework/contracts";
import { useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  currentQcUploadConcurrency,
  currentUploadClientProfile,
  isImageUploadCandidate,
  measureAttachmentUploadStage,
  prepareAndUploadWithConcurrency,
  prepareImageUploadCandidate,
  sha256Hex,
  uploadImageWithNormalizationRetry,
  type AttachmentUploadTimingContext,
} from "./attachment-upload.js";
import { createClientRequestId } from "./client-request-id.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
type ApiSchema<T> = Readonly<{ parse(value: unknown): T }>;

const errorMessage = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "请求未完成，请稍后重试";
  } catch {
    return "请求未完成，请稍后重试";
  }
};

async function request<T>(
  path: string,
  schema: ApiSchema<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await errorMessage(response));
  return schema.parse(await response.json());
}

export function SourcingImageSupplementUploader({
  sourcingCaseId,
  currentAttachmentCount,
  onUploaded,
}: {
  sourcingCaseId: string;
  currentAttachmentCount: number;
  onUploaded(): Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const remaining = Math.max(0, MAX_SOURCING_ATTACHMENTS - currentAttachmentCount);

  const uploadImages = async (files: FileList | null): Promise<void> => {
    if (!files?.length || uploading || remaining === 0) return;
    const selected = Array.from(files);
    const unsupported = selected.find((file) => !isImageUploadCandidate(file));
    if (unsupported) {
      setMessage(`${unsupported.name} 不是支持的图片格式`);
      return;
    }
    if (selected.length > remaining) {
      setMessage(`还可补充 ${formatBusinessDecimal(remaining)} 张；请减少本次选择数量后重试`);
      return;
    }

    setUploading(true);
    setMessage(`正在处理 ${formatBusinessDecimal(selected.length)} 张订单图片…`);
    let completedUploadCount = 0;
    try {
      const profile = currentUploadClientProfile();
      const attachmentIds = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file, index) => {
          setMessage(`正在处理第 ${index + 1}/${selected.length} 张订单图片…`);
          const baseTiming: AttachmentUploadTimingContext = {
            diagnosticId: createClientRequestId(),
            ...profile,
            originalBytes: file.size,
            uploadBytes: file.size,
            mimeType: file.type,
          };
          const prepared = await measureAttachmentUploadStage(
            baseTiming,
            "prepare",
            () => prepareImageUploadCandidate(file),
          );
          const timing = { ...baseTiming, uploadBytes: prepared.size, mimeType: prepared.type };
          const sha256 = await measureAttachmentUploadStage(timing, "hash", () => sha256Hex(prepared));
          return { file: prepared, timing, sha256 };
        },
        async ({ file, timing, sha256 }, sourceFile, index): Promise<string> => {
          setMessage(`正在上传第 ${index + 1}/${selected.length} 张订单图片…`);
          return uploadImageWithNormalizationRetry(sourceFile, file, async (candidate) => {
            const candidateTiming = candidate === file
              ? timing
              : { ...timing, uploadBytes: candidate.size, mimeType: candidate.type };
            const candidateSha256 = candidate === file
              ? sha256
              : await measureAttachmentUploadStage(
                  candidateTiming,
                  "hash",
                  () => sha256Hex(candidate),
                );
            const intent = await measureAttachmentUploadStage(
              candidateTiming,
              "intent",
              () => request("tools/attachments/upload-intents", UploadIntentResponseSchema, {
                method: "POST",
                body: JSON.stringify({
                  filename: candidate.name,
                  mimeType: candidate.type,
                  sizeBytes: candidate.size,
                  sha256: candidateSha256,
                }),
              }),
            );
            const upload = new FormData();
            for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
            upload.append("file", candidate);
            const response = await measureAttachmentUploadStage(
              candidateTiming,
              "oss",
              () => fetch(intent.uploadUrl, { method: "POST", body: upload }),
            );
            if (!response.ok) throw new Error(`${sourceFile.name} 上传失败`);
            const finalized = await measureAttachmentUploadStage(
              candidateTiming,
              "finalize",
              () => request(
                `tools/attachments/${intent.attachmentId}/finalize`,
                AttachmentResponseSchema,
                { method: "POST" },
              ),
            );
            completedUploadCount += 1;
            setMessage(`已上传 ${formatBusinessDecimal(completedUploadCount)}/${formatBusinessDecimal(selected.length)} 张订单图片…`);
            return finalized.attachmentId;
          });
        },
      );
      await request(
        `sourcing/cases/${sourcingCaseId}/supplemental-images`,
        SourcingAttachmentListResponseSchema,
        {
          method: "POST",
          headers: { "idempotency-key": createClientRequestId() },
          body: JSON.stringify({ attachmentIds }),
        },
      );
      await onUploaded();
      setMessage(`已补充 ${formatBusinessDecimal(attachmentIds.length)} 张订单图片`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rework-detail-image-upload">
      {message && <p role="status">{message}</p>}
      <label className="qc-file-button rework-detail-image-upload__button">
        <span>{uploading ? "正在上传…" : remaining > 0 ? "补充图片" : `已达 ${MAX_SOURCING_ATTACHMENTS} 张上限`}</span>
        <input
          type="file"
          accept="image/*"
          multiple
          disabled={uploading || remaining === 0}
          onChange={(event) => {
            void uploadImages(event.target.files);
            event.target.value = "";
          }}
        />
      </label>
    </div>
  );
}
