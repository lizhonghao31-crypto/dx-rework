import { createHash, createHmac } from "node:crypto";

import { ApplicationError } from "../platform/errors.js";
import type {
  AliyunOssSdkClient,
  AliyunPostPolicyCondition,
} from "./storage.js";

const SIGNATURE_VERSION = "OSS4-HMAC-SHA256";
const SERVICE = "oss";
const REQUEST_TYPE = "aliyun_v4_request";
const MAX_LONG_TERM_KEY_TTL_SECONDS = 7 * 24 * 60 * 60;
const INTERNAL_REQUEST_TTL_SECONDS = 60;

type ClientOptions = Readonly<{
  region: string;
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  accessKeySecret: string;
  now?: () => Date;
  fetchImpl?: typeof fetch;
}>;

type PresignOptions = Readonly<{
  method: "DELETE" | "GET" | "HEAD";
  expires: number;
  query?: Readonly<Record<string, string>>;
}>;

class AliyunOssHttpError extends Error {
  readonly statusCode: number;

  constructor(statusCode: number) {
    super(`Aliyun OSS request failed with HTTP ${statusCode}`);
    this.name = "AliyunOssHttpError";
    this.statusCode = statusCode;
  }
}

const rfc3986Encode = (value: string): string =>
  encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

const encodeObjectPath = (value: string): string =>
  value.split("/").map(rfc3986Encode).join("/");

const hmac = (key: string | Buffer, value: string): Buffer =>
  createHmac("sha256", key).update(value, "utf8").digest();

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const signingRegion = (region: string): string =>
  region.startsWith("oss-") ? region.slice("oss-".length) : region;

const ossTimestamp = (value: Date): string =>
  value.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

const credentialScope = (date: string, region: string): string =>
  `${date}/${region}/${SERVICE}/${REQUEST_TYPE}`;

const signingKey = (
  accessKeySecret: string,
  date: string,
  region: string,
): Buffer => {
  const dateKey = hmac(`aliyun_v4${accessKeySecret}`, date);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, REQUEST_TYPE);
};

const compareEncoded = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const queryString = (values: Readonly<Record<string, string>>): string =>
  Object.entries(values)
    .map(([key, value]) => [rfc3986Encode(key), rfc3986Encode(value)] as const)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      compareEncoded(leftKey, rightKey) || compareEncoded(leftValue, rightValue),
    )
    .map(([key, value]) => `${key}=${value}`)
    .join("&");

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export class AliyunOssV4RestClient implements AliyunOssSdkClient {
  private readonly region: string;
  private readonly bucket: string;
  private readonly accessKeyId: string;
  private readonly accessKeySecret: string;
  private readonly baseUrl: URL;
  private readonly now: () => Date;
  private readonly fetchImpl: typeof fetch;

  constructor(options: ClientOptions) {
    this.region = signingRegion(options.region.trim());
    this.bucket = options.bucket.trim();
    this.accessKeyId = options.accessKeyId;
    this.accessKeySecret = options.accessKeySecret;
    this.now = options.now ?? (() => new Date());
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (!this.region || !this.bucket || !this.accessKeyId || !this.accessKeySecret) {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Aliyun OSS V4 signing configuration is incomplete",
        503,
      );
    }

    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:") {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Aliyun OSS endpoint must use HTTPS",
        503,
      );
    }
    if (endpoint.hostname.includes("-internal.")) {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Browser direct upload requires a public Aliyun OSS endpoint",
        503,
      );
    }
    if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Aliyun OSS endpoint must not contain a path, query, or fragment",
        503,
      );
    }
    if (!endpoint.hostname.startsWith(`${this.bucket}.`)) {
      endpoint.hostname = `${this.bucket}.${endpoint.hostname}`;
    }
    this.baseUrl = endpoint;
  }

  async createPostObjectUploadGrant(options: {
    expiration: string;
    fields: Readonly<Record<string, string>>;
    conditions: readonly AliyunPostPolicyCondition[];
  }): Promise<{ uploadUrl: string; fields: Readonly<Record<string, string>> }> {
    const now = this.now();
    const timestamp = ossTimestamp(now);
    const date = timestamp.slice(0, 8);
    const credential = `${this.accessKeyId}/${credentialScope(date, this.region)}`;
    const authenticationFields = {
      "x-oss-signature-version": SIGNATURE_VERSION,
      "x-oss-credential": credential,
      "x-oss-date": timestamp,
    } as const;
    const policy = JSON.stringify({
      expiration: options.expiration,
      conditions: [
        { bucket: this.bucket },
        { "x-oss-signature-version": SIGNATURE_VERSION },
        { "x-oss-credential": credential },
        { "x-oss-date": timestamp },
        ...options.conditions,
      ],
    });
    const encodedPolicy = Buffer.from(policy, "utf8").toString("base64");
    const signature = createHmac(
      "sha256",
      signingKey(this.accessKeySecret, date, this.region),
    ).update(encodedPolicy, "utf8").digest("hex");

    return {
      uploadUrl: this.baseUrl.toString(),
      fields: Object.freeze({
        ...options.fields,
        ...authenticationFields,
        policy: encodedPolicy,
        "x-oss-signature": signature,
      }),
    };
  }

  signatureUrl(name: string, options: Record<string, unknown>): string {
    const method = options.method === "HEAD" ? "HEAD" : "GET";
    const expires = Number(options.expires);
    const response = isRecord(options.response) ? options.response : {};
    const contentDisposition = response["content-disposition"];
    return this.presign(name, {
      method,
      expires,
      query: {
        ...(typeof contentDisposition === "string" ? { "response-content-disposition": contentDisposition } : {}),
        ...(typeof options.process === "string" ? { "x-oss-process": options.process } : {}),
      },
    });
  }

  async head(name: string, signal?: AbortSignal): Promise<{
    res: { headers: Record<string, string | number | undefined> };
  }> {
    let headFailure: unknown;
    try {
      const response = await this.fetchImpl(
        this.presign(name, { method: "HEAD", expires: INTERNAL_REQUEST_TTL_SECONDS }),
        { method: "HEAD", ...(signal ? { signal } : {}) },
      );
      if (response.ok) return { res: { headers: this.responseHeaders(response) } };
      if (response.status === 404) this.ensureSuccess(response);
      headFailure = new AliyunOssHttpError(response.status);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof AliyunOssHttpError && error.statusCode === 404) throw error;
      headFailure = error;
    }

    // Some OSS gateways reject signed HEAD requests even though the object is
    // readable. A one-byte GET preserves the same private, signed verification
    // boundary without downloading the image body.
    try {
      const response = await this.fetchImpl(
        this.presign(name, { method: "GET", expires: INTERNAL_REQUEST_TTL_SECONDS }),
        { method: "GET", headers: { range: "bytes=0-0" }, ...(signal ? { signal } : {}) },
      );
      this.ensureSuccess(response);
      const headers = this.responseHeaders(response);
      const totalSize = this.contentRangeTotal(headers["content-range"]);
      if (totalSize !== undefined) headers["content-length"] = String(totalSize);
      await response.body?.cancel();
      return { res: { headers } };
    } catch (fallbackFailure) {
      throw fallbackFailure ?? headFailure;
    }
  }

  private responseHeaders(response: Response): Record<string, string> {
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return headers;
  }

  private contentRangeTotal(value: string | undefined): number | undefined {
    const match = value?.match(/^bytes\s+\d+-\d+\/(\d+)$/i);
    if (!match) return undefined;
    const total = Number(match[1]);
    return Number.isSafeInteger(total) && total >= 0 ? total : undefined;
  }

  async createReadStream(name: string, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>> {
    const response = await this.fetchImpl(
      this.presign(name, { method: "GET", expires: INTERNAL_REQUEST_TTL_SECONDS }),
      { method: "GET", ...(signal ? { signal } : {}) },
    );
    this.ensureSuccess(response);
    if (!response.body) {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Aliyun OSS returned an empty response stream",
        503,
      );
    }
    return response.body as unknown as AsyncIterable<Uint8Array>;
  }

  async putGeneratedObject(
    name: string,
    content: Uint8Array,
    options: { mimeType: string; sha256: string; signal?: AbortSignal },
  ): Promise<void> {
    const grant = await this.createPostObjectUploadGrant({
      expiration: new Date(this.now().getTime() + INTERNAL_REQUEST_TTL_SECONDS * 1000).toISOString(),
      fields: {
        key: name,
        "x-oss-meta-sha256": options.sha256,
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        success_action_status: "204",
      },
      conditions: [
        ["eq", "$key", name],
        ["eq", "$content-type", options.mimeType],
        ["eq", "$x-oss-meta-sha256", options.sha256],
        ["eq", "$x-oss-object-acl", "private"],
        ["eq", "$x-oss-forbid-overwrite", "true"],
        ["eq", "$success_action_status", "204"],
        ["content-length-range", content.byteLength, content.byteLength],
      ],
    });
    const form = new FormData();
    for (const [key, value] of Object.entries(grant.fields)) form.append(key, value);
    form.append("file", new Blob([Uint8Array.from(content)], { type: options.mimeType }), "contract.pdf");
    options.signal?.throwIfAborted();
    const response = await this.fetchImpl(grant.uploadUrl, { method: "POST", body: form, ...(options.signal ? { signal: options.signal } : {}) });
    this.ensureSuccess(response);
    await response.body?.cancel();
  }

  async delete(name: string): Promise<void> {
    const response = await this.fetchImpl(
      this.presign(name, { method: "DELETE", expires: INTERNAL_REQUEST_TTL_SECONDS }),
      { method: "DELETE" },
    );
    if (response.status === 404) return;
    this.ensureSuccess(response);
    await response.body?.cancel();
  }

  private presign(name: string, options: PresignOptions): string {
    if (!Number.isInteger(options.expires)
      || options.expires < 1
      || options.expires > MAX_LONG_TERM_KEY_TTL_SECONDS) {
      throw new ApplicationError(
        "STORAGE_UNAVAILABLE",
        "Aliyun OSS signed URL TTL is invalid",
        503,
      );
    }

    const now = this.now();
    const timestamp = ossTimestamp(now);
    const date = timestamp.slice(0, 8);
    const scope = credentialScope(date, this.region);
    const credential = `${this.accessKeyId}/${scope}`;
    const parameters: Record<string, string> = {
      ...(options.query ?? {}),
      "x-oss-additional-headers": "host",
      "x-oss-credential": credential,
      "x-oss-date": timestamp,
      "x-oss-expires": String(options.expires),
      "x-oss-signature-version": SIGNATURE_VERSION,
    };
    const canonicalQuery = queryString(parameters);
    const canonicalUri = `/${rfc3986Encode(this.bucket)}/${encodeObjectPath(name)}`;
    const canonicalHeaders = `host:${this.baseUrl.host.toLowerCase()}\n`;
    const canonicalRequest = [
      options.method,
      canonicalUri,
      canonicalQuery,
      canonicalHeaders,
      "host",
      "UNSIGNED-PAYLOAD",
    ].join("\n");
    const stringToSign = [
      SIGNATURE_VERSION,
      timestamp,
      scope,
      sha256Hex(canonicalRequest),
    ].join("\n");
    const signature = createHmac(
      "sha256",
      signingKey(this.accessKeySecret, date, this.region),
    ).update(stringToSign, "utf8").digest("hex");
    const objectPath = encodeObjectPath(name);
    return `${this.baseUrl.origin}/${objectPath}?${canonicalQuery}&x-oss-signature=${signature}`;
  }

  private ensureSuccess(response: Response): void {
    if (response.ok) return;
    throw new AliyunOssHttpError(response.status);
  }
}
