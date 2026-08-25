import { createHash, randomBytes } from "node:crypto";

import { ApplicationError } from "../platform/errors.js";

export type StoredObjectMetadata = Readonly<{ sizeBytes: number; mimeType: string; sha256?: string }>;
export type UploadGrant = Readonly<{
  method: "POST";
  uploadUrl: string;
  fields: Readonly<Record<string, string>>;
  expiresAt: string;
}>;
export type DownloadGrant = Readonly<{ downloadUrl: string; expiresAt: string }>;

export class ObjectStorageObjectNotFoundError extends Error {
  constructor() {
    super("Object not found");
    this.name = "ObjectStorageObjectNotFoundError";
  }
}

export interface ObjectStorage {
  createExactSizeNonOverwritableUploadGrant(
    objectKey: string,
    options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number },
  ): Promise<UploadGrant>;
  createDownloadGrant(objectKey: string, options: { ttlSeconds: number; filename: string; disposition?: "attachment" | "inline" }): Promise<DownloadGrant>;
  head(objectKey: string): Promise<StoredObjectMetadata>;
  readBytes(objectKey: string, maxBytes: number): Promise<Uint8Array>;
  computeSha256(objectKey: string): Promise<string>;
  deleteObject(objectKey: string): Promise<void>;
}

export type AliyunPostPolicyCondition =
  | Readonly<Record<string, string>>
  | readonly ["eq", string, string]
  | readonly ["content-length-range", number, number];

/**
 * Narrow Aliyun OSS V4 client contract. The runtime implementation may use an
 * official SDK or Alibaba Cloud's documented manual V4 algorithm, but the
 * application layer never receives long-term credentials or implements signing.
 */
export interface AliyunOssSdkClient {
  createPostObjectUploadGrant(options: {
    expiration: string;
    fields: Readonly<Record<string, string>>;
    conditions: readonly AliyunPostPolicyCondition[];
  }): Promise<{ uploadUrl: string; fields: Readonly<Record<string, string>> }>;
  signatureUrl(name: string, options: Record<string, unknown>): string;
  head(name: string): Promise<{ res: { headers: Record<string, string | number | undefined> } }>;
  createReadStream(name: string): Promise<AsyncIterable<Uint8Array>>;
  delete(name: string): Promise<void>;
}

export class AliyunPrivateObjectStorage implements ObjectStorage {
  constructor(
    private readonly client: AliyunOssSdkClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createExactSizeNonOverwritableUploadGrant(
    objectKey: string,
    options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number },
  ): Promise<UploadGrant> {
    const expiresAt = grantExpiry(this.now(), options.ttlSeconds);
    const fields = Object.freeze({
      key: objectKey,
      "x-oss-meta-sha256": options.sha256,
      "x-oss-object-acl": "private",
      "x-oss-forbid-overwrite": "true",
      success_action_status: "204",
    });
    const conditions: readonly AliyunPostPolicyCondition[] = [
      ["eq", "$key", objectKey],
      ["eq", "$content-type", options.mimeType],
      ["eq", "$x-oss-meta-sha256", options.sha256],
      ["eq", "$x-oss-object-acl", "private"],
      ["eq", "$x-oss-forbid-overwrite", "true"],
      ["eq", "$success_action_status", "204"],
      ["content-length-range", options.sizeBytes, options.sizeBytes],
    ];
    const signed = await this.client.createPostObjectUploadGrant({
      expiration: expiresAt,
      fields,
      conditions,
    });
    if (!isHttpsUrl(signed.uploadUrl) || Object.hasOwn(signed.fields, "file")) {
      throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage returned an invalid upload grant", 503);
    }
    for (const [name, value] of Object.entries(fields)) {
      if (signed.fields[name] !== value) {
        throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage weakened a required upload policy field", 503);
      }
    }
    return {
      method: "POST",
      uploadUrl: signed.uploadUrl,
      fields: Object.freeze({ ...signed.fields }),
      expiresAt,
    };
  }

  async createDownloadGrant(objectKey: string, options: { ttlSeconds: number; filename: string; disposition?: "attachment" | "inline" }): Promise<DownloadGrant> {
    // Capture before signing so the advertised timestamp can never exceed the URL's real lifetime.
    const expiresAt = grantExpiry(this.now(), options.ttlSeconds);
    const downloadUrl = this.client.signatureUrl(objectKey, {
      method: "GET",
      expires: options.ttlSeconds,
      response: {
        "content-disposition": `${options.disposition ?? "attachment"}; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
      },
    });
    if (!isHttpsUrl(downloadUrl)) {
      throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage returned an invalid download grant", 503);
    }
    return { downloadUrl, expiresAt };
  }

  async computeSha256(objectKey: string): Promise<string> {
    try {
      const stream = await this.client.createReadStream(objectKey);
      const digest = createHash("sha256");
      for await (const chunk of stream) digest.update(chunk);
      return digest.digest("hex");
    } catch (error) {
      if (isObjectNotFound(error)) throw new ObjectStorageObjectNotFoundError();
      throw error;
    }
  }

  async readBytes(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    try {
      const stream = await this.client.createReadStream(objectKey);
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      for await (const chunk of stream) {
        totalBytes += chunk.byteLength;
        if (totalBytes > maxBytes) {
          throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH", "Stored object exceeds its declared size", 422);
        }
        chunks.push(Buffer.from(chunk));
      }
      return Buffer.concat(chunks, totalBytes);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (isObjectNotFound(error)) throw new ObjectStorageObjectNotFoundError();
      throw error;
    }
  }

  async deleteObject(objectKey: string): Promise<void> {
    try {
      await this.client.delete(objectKey);
    } catch (error) {
      if (isObjectNotFound(error)) return;
      throw error;
    }
  }

  async head(objectKey: string): Promise<StoredObjectMetadata> {
    let result;
    try {
      result = await this.client.head(objectKey);
    } catch (error) {
      if (isObjectNotFound(error)) throw new ObjectStorageObjectNotFoundError();
      throw error;
    }
    const headers = result.res.headers;
    const sha256 = headers["x-oss-meta-sha256"];
    return {
      sizeBytes: Number(headers["content-length"]),
      mimeType: String(headers["content-type"] ?? ""),
      ...(typeof sha256 === "string" ? { sha256: sha256.toLowerCase() } : {}),
    };
  }
}

function grantExpiry(now: Date, ttlSeconds: number): string {
  const issuedAtSeconds = Math.floor(now.getTime() / 1000);
  return new Date((issuedAtSeconds + ttlSeconds) * 1000).toISOString();
}

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

function isObjectNotFound(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { status?: unknown; statusCode?: unknown; code?: unknown };
  return candidate.status === 404 || candidate.statusCode === 404 || candidate.code === "NoSuchKey";
}

export class DisabledObjectStorage implements ObjectStorage {
  private unavailable(): never {
    throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage is not configured", 503);
  }
  async createExactSizeNonOverwritableUploadGrant(): Promise<UploadGrant> { return this.unavailable(); }
  async createDownloadGrant(): Promise<DownloadGrant> { return this.unavailable(); }
  async head(): Promise<StoredObjectMetadata> { return this.unavailable(); }
  async readBytes(): Promise<Uint8Array> { return this.unavailable(); }
  async computeSha256(): Promise<string> { return this.unavailable(); }
  async deleteObject(): Promise<void> { return this.unavailable(); }
}

export class FakeObjectStorage implements ObjectStorage {
  readonly objects = new Map<string, StoredObjectMetadata>();
  readonly objectBytes = new Map<string, Uint8Array>();
  readonly contentSha256 = new Map<string, string>();
  readonly deleted: string[] = [];
  readonly signed: Array<{ method: "POST" | "GET"; objectKey: string; ttlSeconds: number; sizeBytes?: number }> = [];

  constructor(private readonly now: () => Date = () => new Date()) {}

  async createExactSizeNonOverwritableUploadGrant(
    objectKey: string,
    options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number },
  ): Promise<UploadGrant> {
    this.signed.push({ method: "POST", objectKey, ttlSeconds: options.ttlSeconds, sizeBytes: options.sizeBytes });
    return {
      method: "POST",
      uploadUrl: "https://private.example.test/",
      fields: {
        key: objectKey,
        "x-oss-meta-sha256": options.sha256,
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        success_action_status: "204",
        policy: "fake-policy",
        "x-oss-signature": "fake-signature",
      },
      expiresAt: grantExpiry(this.now(), options.ttlSeconds),
    };
  }

  async createDownloadGrant(objectKey: string, options: { ttlSeconds: number; filename: string; disposition?: "attachment" | "inline" }): Promise<DownloadGrant> {
    this.signed.push({ method: "GET", objectKey, ttlSeconds: options.ttlSeconds });
    return {
      downloadUrl: `https://private.example.test/${encodeURIComponent(objectKey)}?method=GET`,
      expiresAt: grantExpiry(this.now(), options.ttlSeconds),
    };
  }

  async computeSha256(objectKey: string): Promise<string> {
    const value = this.objects.get(objectKey);
    if (!value) throw new ObjectStorageObjectNotFoundError();
    const digest = this.contentSha256.get(objectKey) ?? value.sha256;
    if (!digest) throw new Error("Object content digest is unavailable");
    return digest.toLowerCase();
  }

  async readBytes(objectKey: string, maxBytes: number): Promise<Uint8Array> {
    if (!this.objects.has(objectKey)) throw new ObjectStorageObjectNotFoundError();
    const bytes = this.objectBytes.get(objectKey);
    if (!bytes) throw new Error("Object bytes are unavailable");
    if (bytes.byteLength > maxBytes) {
      throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH", "Stored object exceeds its declared size", 422);
    }
    return bytes;
  }

  async deleteObject(objectKey: string): Promise<void> {
    this.deleted.push(objectKey);
    this.objects.delete(objectKey);
    this.objectBytes.delete(objectKey);
    this.contentSha256.delete(objectKey);
  }

  async head(objectKey: string): Promise<StoredObjectMetadata> {
    const value = this.objects.get(objectKey);
    if (!value) throw new ObjectStorageObjectNotFoundError();
    return value;
  }
}

export function createPrivateObjectKey(prefix: string, filename: string, now = new Date()): string {
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..") || /\.(?:exe|js|html)\.[A-Za-z0-9]+$/i.test(filename)) {
    throw new ApplicationError("VALIDATION_ERROR", "Unsafe filename", 400);
  }
  const extension = filename.toLowerCase().match(/\.(jpe?g|png|webp|pdf)$/)?.[1];
  const normalized = extension === "jpeg" ? "jpg" : extension;
  if (!normalized) throw new ApplicationError("VALIDATION_ERROR", "Filename extension is not allowed", 400);
  const date = now.toISOString().slice(0, 10).replaceAll("-", "/");
  return `${prefix}/${date}/${randomBytes(24).toString("hex")}.${normalized}`;
}

export const hashRequest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
