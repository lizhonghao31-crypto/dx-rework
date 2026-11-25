import {createWebUrls} from "../url-contract.js";
import {feedbackFetch,feedbackJson} from "./request-response-feedback.js";
import {SubmissionRequestError} from "./submission-validation.js";

const {apiUrl}=createWebUrls(import.meta.env.BASE_URL);
export type ApiSchema<T> = Readonly<{ parse(value: unknown): T }>;

export class SourcingRequestError extends SubmissionRequestError {
  constructor(message: string, code?: string, status = 400, readonly requestId?: string) {
    super(message, code, status);
  }
}

export const request = async <T,>(
  path: string,
  schema: ApiSchema<T>,
  init: RequestInit = {},
): Promise<T> => {
  const response = await feedbackFetch(apiUrl(path), {
    credentials: "include",
    cache: "no-store",
    ...init,
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
  const failureBody = response.ok ? null : await response.clone().json().catch(() => null) as { error?: { requestId?: unknown } } | null;
  const candidateRequestId = failureBody?.error?.requestId;
  const requestId = typeof candidateRequestId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(candidateRequestId) ? candidateRequestId : undefined;
  return feedbackJson(response,init.method??'GET',value=>schema.parse(value),(message,code,status)=>new SourcingRequestError(message,code,status,requestId));
};

export const requestSubmission = async <T,>(path: string, schema: ApiSchema<T>, init: RequestInit): Promise<T> => {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  try { return await request(path, schema, { ...init, signal: controller.signal }); }
  finally { window.clearTimeout(timeout); }
};
