import {
  AttachmentResponseSchema,
  UploadIntentResponseSchema,
} from "@dx-rework/contracts";
import { Button, StatusBadge } from "@dx-rework/ui";
import { useState } from "react";

import { createWebUrls } from "../url-contract.js";

const { apiUrl } = createWebUrls(import.meta.env.BASE_URL);
const supportedTypes = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/pdf",
]);

type UploadedEvidence = {
  attachmentId: string;
  filename: string;
};

const responseError = async (response: Response): Promise<string> => {
  try {
    const body = await response.json() as { error?: { message?: string } };
    return body.error?.message ?? "附件操作失败";
  } catch {
    return "附件操作失败";
  }
};

const request = async <T,>(
  path: string,
  schema: { parse(value: unknown): T },
  init: RequestInit,
): Promise<T> => {
  const response = await fetch(apiUrl(path), {
    credentials: "include",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...init.headers,
    },
  });
  if (!response.ok) throw new Error(await responseError(response));
  return schema.parse(await response.json());
};

export function ExternalEvidenceUploader({
  attachmentIds,
  disabled,
  onChange,
  onMessage,
}: {
  attachmentIds: readonly string[];
  disabled: boolean;
  onChange(value: string[]): void;
  onMessage(message: string): void;
}) {
  const [uploaded, setUploaded] = useState<UploadedEvidence[]>([]);
  const [uploading, setUploading] = useState(false);

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length || disabled || uploading) return;
    setUploading(true);
    try {
      const nextIds = [...attachmentIds];
      const nextUploaded = [...uploaded];
      for (const file of Array.from(files)) {
        if (!supportedTypes.has(file.type)) {
          throw new Error(`${file.name} 不是支持的图片或 PDF`);
        }
        const digest = new Uint8Array(
          await crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
        );
        const sha256 = Array.from(
          digest,
          (byte) => byte.toString(16).padStart(2, "0"),
        ).join("");
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
        const form = new FormData();
        for (const [name, value] of Object.entries(intent.uploadFields)) {
          form.append(name, value);
        }
        form.append("file", file);
        const upload = await fetch(intent.uploadUrl, {
          method: "POST",
          body: form,
        });
        if (!upload.ok) throw new Error(`${file.name} 上传失败`);
        const finalized = await request(
          `tools/attachments/${intent.attachmentId}/finalize`,
          AttachmentResponseSchema,
          { method: "POST" },
        );
        nextIds.push(finalized.attachmentId);
        nextUploaded.push({
          attachmentId: finalized.attachmentId,
          filename: file.name,
        });
      }
      onChange([...new Set(nextIds)]);
      setUploaded(nextUploaded);
      onMessage(`${nextIds.length} 份证据附件已就绪，提交动作后将锁定到该台账。`);
    } catch (error: unknown) {
      onMessage(error instanceof Error ? error.message : "附件上传失败");
    } finally {
      setUploading(false);
    }
  };

  const remove = (attachmentId: string): void => {
    onChange(attachmentIds.filter((item) => item !== attachmentId));
    setUploaded((current) =>
      current.filter((item) => item.attachmentId !== attachmentId));
  };

  return (
    <div className="external-evidence-uploader">
      <label className="dx-field">
        <span>证据附件</span>
        <span className="dx-field__control">
          <input
            type="file"
            multiple
            accept="image/jpeg,image/png,image/webp,application/pdf"
            disabled={disabled || uploading}
            onChange={(event) => {
              void uploadFiles(event.target.files);
              event.target.value = "";
            }}
          />
        </span>
      </label>
      <small>支持 JPG、PNG、WebP 和 PDF；系统自动上传并绑定，无需填写附件 ID。</small>
      {uploading && <StatusBadge tone="warning">附件上传中</StatusBadge>}
      {uploaded.length > 0 && (
        <div className="external-evidence-list">
          {uploaded.map((item) => (
            <div key={item.attachmentId}>
              <span>{item.filename}</span>
              <Button
                disabled={disabled || uploading}
                onClick={() => remove(item.attachmentId)}
              >
                移除
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
