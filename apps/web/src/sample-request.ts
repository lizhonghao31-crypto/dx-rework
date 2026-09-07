import type { z } from "zod";

export class SampleRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number) {
    super(message);
    this.name = "SampleRequestError";
  }
}

// JSON is declared only when a body is actually sent. In particular, finalize
// is a bodyless POST; an empty JSON body is rejected before its route handler.
export async function sampleRequest<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(url, { ...init, credentials: "include", cache: "no-store", headers });
  const body: unknown = await response.json().catch(() => {
    throw new SampleRequestError("服务响应异常，请稍后重试", "INVALID_RESPONSE", response.status);
  });
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body ? body.error : null;
    const code = typeof error === "object" && error !== null && "code" in error && typeof error.code === "string" ? error.code : "REQUEST_FAILED";
    const message = typeof error === "object" && error !== null && "message" in error && typeof error.message === "string" ? error.message : "操作失败，请重试";
    // Preserve the original validator message for the shared image-normalization
    // retry. Translate only at the user-facing boundary.
    throw new SampleRequestError(message, code, response.status);
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw new SampleRequestError("服务返回的资料不完整，请稍后重试", "INVALID_RESPONSE", response.status);
  return parsed.data;
}

export function sampleErrorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  if (error instanceof SampleRequestError) {
    if (error.status === 401) return "登录已失效，请重新登录后重试";
    if (error.status === 403) return "当前账号无权执行此操作，请联系负责人";
    if (error.status === 413) return "图片过大，请选择较小的图片后重试";
    if (error.status >= 500) return "服务暂时不可用，请稍后重试";
    if (/[一-鿿]/.test(error.message)) return error.message;
    if (error.code === "ATTACHMENT_METADATA_MISMATCH") return "图片内容校验未通过，请移除后重新上传";
    if (error.status === 400) return "请求资料校验未通过，请检查后重试";
    if (error.status === 409) return "资料状态已变化，请刷新后重试";
    return fallback;
  }
  return error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : fallback;
}
