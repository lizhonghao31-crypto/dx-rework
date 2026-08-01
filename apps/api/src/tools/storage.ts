import { createHash, randomBytes } from "node:crypto";

import { ApplicationError } from "../platform/errors.js";

export type StoredObjectMetadata = Readonly<{ sizeBytes: number; mimeType: string; sha256?: string }>;
export interface ObjectStorage {
  createUploadUrl(objectKey: string, options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number }): Promise<string>;
  createDownloadUrl(objectKey: string, options: { ttlSeconds: number; filename: string }): Promise<string>;
  head(objectKey: string): Promise<StoredObjectMetadata>;
}

/** Narrow facade implemented by the official Aliyun OSS SDK client (`ali-oss`). */
export interface AliyunOssSdkClient {
  signatureUrl(name: string, options: Record<string, unknown>): string;
  head(name: string): Promise<{ res: { headers: Record<string, string | number | undefined> } }>;
}

export class AliyunPrivateObjectStorage implements ObjectStorage {
  constructor(private readonly client: AliyunOssSdkClient) {}
  async createUploadUrl(objectKey: string, options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number }): Promise<string> {
    return this.client.signatureUrl(objectKey, { method: "PUT", expires: options.ttlSeconds, "Content-Type": options.mimeType, headers: { "x-oss-meta-sha256": options.sha256, "x-oss-object-acl": "private" } });
  }
  async createDownloadUrl(objectKey: string, options: { ttlSeconds: number; filename: string }): Promise<string> {
    return this.client.signatureUrl(objectKey, { method: "GET", expires: options.ttlSeconds, response: { "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(options.filename)}` } });
  }
  async head(objectKey: string): Promise<StoredObjectMetadata> {
    const result = await this.client.head(objectKey);
    const headers = result.res.headers;
    const sha256 = headers["x-oss-meta-sha256"];
    return { sizeBytes: Number(headers["content-length"]), mimeType: String(headers["content-type"] ?? ""), ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {}) };
  }
}

export class DisabledObjectStorage implements ObjectStorage {
  private unavailable(): never { throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage is not configured", 503); }
  async createUploadUrl(): Promise<string> { return this.unavailable(); }
  async createDownloadUrl(): Promise<string> { return this.unavailable(); }
  async head(): Promise<StoredObjectMetadata> { return this.unavailable(); }
}

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObjectMetadata>();
  readonly signed: Array<{ method: "PUT" | "GET"; objectKey: string; ttlSeconds: number }> = [];
  async createUploadUrl(objectKey: string, options: { ttlSeconds: number }): Promise<string> { this.signed.push({ method: "PUT", objectKey, ttlSeconds: options.ttlSeconds }); return `https://private.example.test/${encodeURIComponent(objectKey)}?method=PUT&ttl=${options.ttlSeconds}`; }
  async createDownloadUrl(objectKey: string, options: { ttlSeconds: number }): Promise<string> { this.signed.push({ method: "GET", objectKey, ttlSeconds: options.ttlSeconds }); return `https://private.example.test/${encodeURIComponent(objectKey)}?method=GET&ttl=${options.ttlSeconds}`; }
  async head(objectKey: string): Promise<StoredObjectMetadata> { const value = this.objects.get(objectKey); if (!value) throw new Error("object missing"); return value; }
}

export function createPrivateObjectKey(prefix: string, filename: string, now = new Date()): string {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || /\.(?:exe|js|html)\.[A-Za-z0-9]+$/i.test(filename)) throw new ApplicationError("VALIDATION_ERROR", "Unsafe filename", 400);
  const extension = filename.toLowerCase().match(/\.(jpe?g|png|webp|pdf)$/)?.[1];
  const normalized = extension === "jpeg" ? "jpg" : extension;
  if (!normalized) throw new ApplicationError("VALIDATION_ERROR", "Filename extension is not allowed", 400);
  const date = now.toISOString().slice(0, 10).replaceAll("-", "/");
  return `${prefix}/${date}/${randomBytes(24).toString("hex")}.${normalized}`;
}

export const hashRequest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
