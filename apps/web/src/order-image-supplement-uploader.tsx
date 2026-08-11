import {
  AttachmentResponseSchema,
  MAX_REWORK_ATTACHMENTS,
  UploadIntentResponseSchema,
} from "@dx-rework/contracts";
import { StatusBadge } from "@dx-rework/ui";
import { useState } from "react";

import { createWebUrls } from "../url-contract.js";
import {
  currentQcUploadConcurrency,
  isImageAttachment,
  prepareAndUploadWithConcurrency,
  prepareAttachmentForUpload,
  sha256Hex,
} from "./attachment-upload.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);

type ApiSchema<T> = { parse(value: unknown): T };

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

export function OrderImageSupplementUploader({
  reworkOrderId,
  expectedVersion,
  currentAttachmentCount,
  onUploaded,
}: {
  reworkOrderId: string;
  expectedVersion: number;
  currentAttachmentCount: number;
  onUploaded(): Promise<void>;
}) {
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState("");
  const remaining = Math.max(0, MAX_REWORK_ATTACHMENTS - currentAttachmentCount);

  const uploadImages = async (files: FileList | null): Promise<void> => {
    if (!files?.length || uploading || remaining === 0) return;
    const selected = Array.from(files);
    const unsupported = selected.find((file) => !isImageAttachment(file));
    if (unsupported) {
      setMessage(`${unsupported.name} 不是支持的图片格式`);
      return;
    }
    if (selected.length > remaining) {
      setMessage(`还可补充 ${remaining} 张；请减少本次选择数量后重试`);
      return;
    }

    setUploading(true);
    setMessage(`正在上传 ${selected.length} 张订单图片…`);
    let completedUploadCount = 0;
    try {
      const attachmentIds = await prepareAndUploadWithConcurrency(
        selected,
        currentQcUploadConcurrency(),
        async (file, index) => {
          setMessage(`正在处理第 ${index + 1}/${selected.length} 张订单图片…`);
          const prepared = await prepareAttachmentForUpload(file);
          return { file: prepared, sha256: await sha256Hex(prepared) };
        },
        async ({ file, sha256 }, _sourceFile, index): Promise<string> => {
          setMessage(`正在上传第 ${index + 1}/${selected.length} 张订单图片…`);
          const intent = await request(
            "tools/attachments/upload-intents",
            UploadIntentResponseSchema,
            {
              method: "POST",
              body: JSON.stringify({
                filename: file.name,
                mimeType: file.type,
                sizeBytes: file.size,
                sha256,
              }),
            },
          );
          const upload = new FormData();
          for (const [name, value] of Object.entries(intent.uploadFields)) upload.append(name, value);
          upload.append("file", file);
          const response = await fetch(intent.uploadUrl, { method: "POST", body: upload });
          if (!response.ok) throw new Error(`${file.name} 上传失败`);
          const finalized = await request(
            `tools/attachments/${intent.attachmentId}/finalize`,
            AttachmentResponseSchema,
            { method: "POST" },
          );
          completedUploadCount += 1;
          setMessage(`已上传 ${completedUploadCount}/${selected.length} 张订单图片…`);
          return finalized.attachmentId;
        },
      );
      await request(
        `rework-orders/${reworkOrderId}/supplemental-images`,
        { parse: (value: unknown) => value },
        {
          method: "POST",
          headers: { "idempotency-key": crypto.randomUUID() },
          body: JSON.stringify({ expectedVersion, attachmentIds }),
        },
      );
      await onUploaded();
      setMessage(`已补充 ${attachmentIds.length} 张订单图片`);
    } catch (error: unknown) {
      setMessage(error instanceof Error ? error.message : "订单图片上传失败");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="rework-detail-image-upload">
      <div>
        <strong>补充订单图片</strong>
        <small>创建后可继续补传；QC 附件总量最多 {MAX_REWORK_ATTACHMENTS} 份。</small>
      </div>
      <StatusBadge tone={remaining > 0 ? "info" : "warning"}>
        {remaining > 0 ? `还可补充 ${remaining} 张` : `已达到 ${MAX_REWORK_ATTACHMENTS} 份上限`}
      </StatusBadge>
      <label className="qc-file-button rework-detail-image-upload__button">
        <span>{uploading ? "正在上传…" : remaining > 0 ? "补充订单图片" : `已达到 ${MAX_REWORK_ATTACHMENTS} 份上限`}</span>
        <input
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          disabled={uploading || remaining === 0}
          onChange={(event) => {
            void uploadImages(event.target.files);
            event.target.value = "";
          }}
        />
      </label>
      {message && <p role="status">{message}</p>}
    </div>
  );
}
