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
  const response = await fetch(cuttingUrls.apiUrl(`cutting/${path}`), {
    ...init,
    credentials: "include",
    cache: "no-store",
    headers: {
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const body = await response.json();
  if (!response.ok) {
    throw new CuttingRequestError(
      body?.error?.message ?? "操作未完成，请重试",
      body?.error?.code ?? "UNKNOWN",
      response.status,
    );
  }
  return schema.parse(body);
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
