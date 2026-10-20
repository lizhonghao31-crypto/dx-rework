import {feedbackFetch,feedbackJson} from "./request-response-feedback.js";
import {requestFailureMessage} from "./request-failure-message.js";
import type { z } from "zod";

export class SampleRequestError extends Error {
  constructor(message: string, readonly code: string, readonly status: number,readonly method="GET") {
    super(message);
    this.name = "SampleRequestError";
  }
}

// JSON is declared only when a body is actually sent. In particular, finalize
// is a bodyless POST; an empty JSON body is rejected before its route handler.
export async function sampleRequest<T>(url: string, schema: z.ZodType<T>, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body != null && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await feedbackFetch(url, { ...init, credentials: "include", cache: "no-store", headers });
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value),(message,code,status)=>new SampleRequestError(message,code??'REQUEST_FAILED',status,init.method??'GET'));
}

export function sampleErrorMessage(error: unknown, fallback = "操作失败，请重试"): string {
  if (error instanceof SampleRequestError) {
    if (error.status === 401) return "登录已失效，请重新登录后重试";
    if (error.status === 403) return "当前账号无权执行此操作，请联系负责人";
    if (error.status === 413) return "图片过大，请选择较小的图片后重试";
    if (/[一-鿿]/.test(error.message)) return error.message;
    if (error.code === "ATTACHMENT_METADATA_MISMATCH") return "图片内容校验未通过，请移除后重新上传";
    if (error.status === 400) return "请求资料校验未通过，请检查后重试";
    if (error.status === 409||error.status>=500) return requestFailureMessage(error.status,undefined,error.method);
    return fallback;
  }
  return error instanceof Error && /[一-鿿]/.test(error.message) ? error.message : fallback;
}
