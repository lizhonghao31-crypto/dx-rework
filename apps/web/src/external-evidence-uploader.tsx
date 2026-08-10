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
const prepareTimeoutMilliseconds = 30_000;
const apiTimeoutMilliseconds = 15_000;
const uploadTimeoutMilliseconds = 45_000;

type UploadStage = "preparing" | "uploading" | "verifying";

const stageLabel: Record<UploadStage, string> = {
  preparing: "正在准备文件",
  uploading: "正在上传文件",
  verifying: "正在进行服务端校验",
};

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
  const response = await withTimeout(
    (signal) => fetch(apiUrl(path), {
      credentials: "include",
      ...init,
      signal,
      headers: {
        accept: "application/json",
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    }),
    apiTimeoutMilliseconds,
    "服务器响应超时",
  );
  if (!response.ok) throw new Error(await responseError(response));
  return schema.parse(await response.json());
};

const withTimeout = async <T,>(
  operation: (signal: AbortSignal) => Promise<T>,
  milliseconds: number,
  message: string,
): Promise<T> => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(controller.signal),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(message));
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
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
  const [stage, setStage] = useState<UploadStage | null>(null);
  const [failedFile, setFailedFile] = useState<string | null>(null);

  const uploadFiles = async (files: FileList | null): Promise<void> => {
    if (!files?.length || disabled || uploading) return;
    setUploading(true);
    setFailedFile(null);
    try {
      const nextIds = [...attachmentIds];
      const nextUploaded = [...uploaded];
      for (const file of Array.from(files)) {
        setStage("preparing");
        if (!supportedTypes.has(file.type)) {
          throw new Error(`${file.name} 不是支持的图片或 PDF`);
        }
        const digest = new Uint8Array(await withTimeout(
          async () => crypto.subtle.digest("SHA-256", await file.arrayBuffer()),
          prepareTimeoutMilliseconds,
          `${file.name} 文件准备超时`,
        ));
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
        setStage("uploading");
        const form = new FormData();
        for (const [name, value] of Object.entries(intent.uploadFields)) {
          form.append(name, value);
        }
        form.append("file", file);
        const upload = await withTimeout(
          (signal) => fetch(intent.uploadUrl, {
            method: "POST",
            body: form,
            signal,
          }),
          uploadTimeoutMilliseconds,
          `${file.name} 上传超时`,
        );
        if (!upload.ok) throw new Error(`${file.name} 上传失败（${upload.status}）`);
        setStage("verifying");
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
      const failed = Array.from(files).find((file) =>
        !uploaded.some((item) => item.filename === file.name));
      setFailedFile(failed?.name ?? "所选文件");
      onMessage(`${error instanceof Error ? error.message : "附件上传失败"}，请重新选择文件重试。`);
    } finally {
      setUploading(false);
      setStage(null);
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
      {uploading && stage && <StatusBadge tone="warning">{stageLabel[stage]}</StatusBadge>}
      {!uploading && failedFile && (
        <small className="external-upload-error" role="alert">
          {failedFile} 未上传成功，可重新选择同一文件重试。
        </small>
      )}
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
