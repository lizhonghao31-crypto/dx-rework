import { createWebUrls } from "../url-contract.js";
const urls = createWebUrls(import.meta.env.BASE_URL);
export async function digitalRequest<T>(path: string, method = "GET", body?: unknown, key?: string): Promise<T> {
  const response = await fetch(urls.apiUrl(`digital-production/${path}`), { method, credentials: "include", cache: "no-store",
    headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { error?: { message?: string } };
    throw new Error(data.error?.message ?? (response.status === 404 ? "数字生产功能尚未开放" : "操作失败，请重试"));
  }
  return response.json() as Promise<T>;
}
