import {feedbackFetch,feedbackJson} from "./request-response-feedback.js";
import type { z } from "zod";
import { createWebUrls } from "../url-contract.js";

export const cuttingUrls = createWebUrls(import.meta.env.BASE_URL);

export class CuttingRequestError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function cuttingRequest<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const response = await feedbackFetch(cuttingUrls.apiUrl(`cutting/${path}`), {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value),(message,code,status)=>new CuttingRequestError(message,code??'UNKNOWN',status));
}

export const cuttingImageUrl = (
  attachmentId: string,
  mode: "thumbnail" | "preview" | "download" = "preview",
): string => cuttingUrls.apiUrl(
  `cutting/attachments/${attachmentId}/download?mode=${mode}`,
);

export const cuttingTime = (value: string | null): string =>
  value
    ? new Date(value).toLocaleString("zh-CN", {
        timeZone: "Asia/Shanghai",
        hour12: false,
      })
    : "—";
