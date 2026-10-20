import {feedbackFetch,feedbackJson} from "./request-response-feedback.js";
import { z } from "zod";
import { AttachmentResponseSchema, UploadIntentResponseSchema } from "@dx-rework/contracts";
import { createWebUrls } from "../url-contract.js";
import { sha256Hex } from "./attachment-upload.js";
import { uploadPatternMaterial } from "./pattern-material-upload.js";

export const patternUrls = createWebUrls(import.meta.env.BASE_URL);
export class PatternRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) { super(message); }
}
export async function patternRequest<T>(path: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const response = await feedbackFetch(patternUrls.apiUrl(`pattern-room/${path}`), { ...init, credentials: "include", cache: "no-store", headers: { "content-type": "application/json", ...init.headers } });
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value),(message,code,status)=>new PatternRequestError(message,code??'UNKNOWN',status));
}
export function readPatternUploadLimits(kind: "pattern" | "misc", purpose: "create" | "rework", signal?: AbortSignal) {
  return patternRequest(`attachments/upload-limits?kind=${kind}&purpose=${purpose}`, z.object({ maxUploadBytes: z.number().int().positive() }), { signal: signal ?? null });
}
export async function uploadPatternOriginal(file: File, kind: "pattern" | "misc" = "pattern", purpose: "create" | "rework" = "create") {
  const { maxUploadBytes } = await readPatternUploadLimits(kind, purpose);
  return uploadPatternMaterial(file, async file => {
  const intent = await patternRequest(`attachments/upload-intents?kind=${kind}&purpose=${purpose}`, UploadIntentResponseSchema, { method: "POST", body: JSON.stringify({ filename: file.name, mimeType: file.type, sizeBytes: file.size, sha256: await sha256Hex(file) }) });
  const form = new FormData();
  for (const [name, value] of Object.entries(intent.uploadFields)) form.append(name, value);
  form.append("file", file);
  const response = await fetch(intent.uploadUrl, { method: intent.uploadMethod, body: form, credentials: "omit" });
  if (!response.ok) throw new Error(`${file.name} 上传失败，请重试`);
  return patternRequest(`attachments/${intent.attachmentId}/finalize?kind=${kind}&purpose=${purpose}`, AttachmentResponseSchema, { method: "POST", body: "{}" });
  }, maxUploadBytes);
}
export const patternTime = (value: string | null) => value ? new Date(value).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false }) : "—";
export function elapsedText(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours} 小时 ${minutes % 60} 分` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
}
