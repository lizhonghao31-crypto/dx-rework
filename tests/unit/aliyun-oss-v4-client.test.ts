import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { AliyunOssV4RestClient } from "../../apps/api/src/tools/aliyun-oss-v4-client.js";
import {
  AliyunPrivateObjectStorage,
  ObjectStorageObjectNotFoundError,
} from "../../apps/api/src/tools/storage.js";

const fixedNow = () => new Date("2024-12-03T03:44:20.000Z");
const baseOptions = {
  region: "oss-cn-hangzhou",
  endpoint: "https://oss-cn-hangzhou.aliyuncs.com/",
  bucket: "examplebucket",
  accessKeyId: "test-access",
  accessKeySecret: "testsecret",
  now: fixedNow,
} as const;

const sha256 = "a".repeat(64);

describe("Aliyun OSS V4 REST client", () => {
  it("matches a deterministic POST V4 policy signature", async () => {
    const client = new AliyunOssV4RestClient(baseOptions);
    const fields = {
      key: "private/a.pdf",
      "x-oss-meta-sha256": sha256,
      "x-oss-object-acl": "private",
      "x-oss-forbid-overwrite": "true",
      success_action_status: "204",
    };
    const signed = await client.createPostObjectUploadGrant({
      expiration: "2024-12-03T03:49:20.000Z",
      fields,
      conditions: [
        ["eq", "$key", "private/a.pdf"],
        ["eq", "$content-type", "application/pdf"],
        ["eq", "$x-oss-meta-sha256", sha256],
        ["eq", "$x-oss-object-acl", "private"],
        ["eq", "$x-oss-forbid-overwrite", "true"],
        ["eq", "$success_action_status", "204"],
        ["content-length-range", 123, 123],
      ],
    });

    expect(signed.uploadUrl).toBe(
      "https://examplebucket.oss-cn-hangzhou.aliyuncs.com/",
    );
    expect(signed.fields).toMatchObject({
      ...fields,
      "x-oss-signature-version": "OSS4-HMAC-SHA256",
      "x-oss-credential":
        "test-access/20241203/cn-hangzhou/oss/aliyun_v4_request",
      "x-oss-date": "20241203T034420Z",
      "x-oss-signature":
        "7be92d355ed651fdad3fe1a6faffe442ef9992fb384c85869c8f53ddc1c44aa3",
    });
    expect(signed.fields).not.toHaveProperty("Content-Type");
    const policy = JSON.parse(
      Buffer.from(signed.fields.policy!, "base64").toString("utf8"),
    ) as { expiration: string; conditions: unknown[] };
    expect(policy.expiration).toBe("2024-12-03T03:49:20.000Z");
    expect(policy.conditions).toContainEqual({ bucket: "examplebucket" });
    expect(policy.conditions).toContainEqual([
      "eq",
      "$content-type",
      "application/pdf",
    ]);
    expect(policy.conditions).toContainEqual([
      "content-length-range",
      123,
      123,
    ]);
  });

  it("matches a deterministic V4 presigned GET signature and path encoding", () => {
    const client = new AliyunOssV4RestClient(baseOptions);
    const signed = new URL(client.signatureUrl("private/a file.pdf", {
      method: "GET",
      expires: 300,
    }));

    expect(signed.pathname).toBe("/private/a%20file.pdf");
    expect(signed.searchParams.get("x-oss-additional-headers")).toBe("host");
    expect(signed.searchParams.get("x-oss-date")).toBe("20241203T034420Z");
    expect(signed.searchParams.get("x-oss-expires")).toBe("300");
    expect(signed.searchParams.get("x-oss-signature")).toBe(
      "dd7443f804117c1d982bb541b8c40d0722f40ae9d0a73d892490dc8280101e4d",
    );
  });

  it("signs response content-disposition instead of appending an unsigned query", () => {
    const client = new AliyunOssV4RestClient(baseOptions);
    const signed = new URL(client.signatureUrl("private/a file.pdf", {
      method: "GET",
      expires: 300,
      response: {
        "content-disposition": "attachment; filename*=UTF-8''报告 1.pdf",
      },
    }));

    expect(signed.searchParams.get("response-content-disposition")).toBe(
      "attachment; filename*=UTF-8''报告 1.pdf",
    );
    expect(signed.searchParams.get("x-oss-signature")).toBe(
      "b7300e861337036b40c78ae6b85ed8eae49fa2c6b3b68865d4220cc8fc2dda35",
    );
  });

  it("signs a reduced thumbnail transform without changing original download grants", async () => {
    const client = new AliyunOssV4RestClient(baseOptions);
    const storage = new AliyunPrivateObjectStorage(client, fixedNow);
    const options = { ttlSeconds: 300, filename: "drawing.jpg", disposition: "inline" as const };
    const thumbnail = new URL((await storage.createDownloadGrant("private/drawing.jpg", { ...options, variant: "thumbnail" })).downloadUrl);
    const original = new URL((await storage.createDownloadGrant("private/drawing.jpg", options)).downloadUrl);
    expect(thumbnail.searchParams.get("x-oss-process")).toBe("image/resize,m_lfit,w_480,h_360,limit_1/format,webp/quality,q_80");
    expect(original.searchParams.has("x-oss-process")).toBe(false);
    expect(thumbnail.searchParams.get("x-oss-signature")).not.toBe(original.searchParams.get("x-oss-signature"));
    expect(thumbnail.searchParams.get("x-oss-expires")).toBe("300");
  });

  it("uses signed HEAD metadata and streams object bytes for SHA-256 verification", async () => {
    const seen: Array<{ method: string | undefined; url: string }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = String(input);
      seen.push({ method: init?.method, url });
      if (init?.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: {
            "content-length": "3",
            "content-type": "application/pdf",
            "x-oss-meta-sha256": createHash("sha256").update("abc").digest("hex"),
          },
        });
      }
      return new Response(new TextEncoder().encode("abc"), { status: 200 });
    }) as typeof fetch;
    const client = new AliyunOssV4RestClient({ ...baseOptions, fetchImpl: fakeFetch });
    const storage = new AliyunPrivateObjectStorage(client, fixedNow);

    await expect(storage.head("private/a.pdf")).resolves.toEqual({
      sizeBytes: 3,
      mimeType: "application/pdf",
      sha256: createHash("sha256").update("abc").digest("hex"),
    });
    await expect(storage.computeSha256("private/a.pdf")).resolves.toBe(
      createHash("sha256").update("abc").digest("hex"),
    );
    expect(Buffer.from(await storage.readBytes("private/a.pdf", 3)))
      .toEqual(Buffer.from("abc"));
    expect(seen).toHaveLength(3);
    expect(seen[0]?.method).toBe("HEAD");
    expect(seen[1]?.method).toBe("GET");
    expect(seen[2]?.method).toBe("GET");
    expect(seen.every((request) =>
      new URL(request.url).searchParams.get("x-oss-signature-version")
        === "OSS4-HMAC-SHA256"
    )).toBe(true);
  });

  it("falls back to a one-byte signed GET when the gateway rejects HEAD", async () => {
    const seen: Array<{ method: string | undefined; headers: HeadersInit | undefined }> = [];
    const fakeFetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({ method: init?.method, headers: init?.headers });
      if (init?.method === "HEAD") return new Response(null, { status: 405 });
      return new Response("x", {
        status: 206,
        headers: {
          "content-length": "1",
          "content-range": "bytes 0-0/24576",
          "content-type": "image/webp",
          "x-oss-meta-sha256": sha256,
        },
      });
    }) as typeof fetch;
    const client = new AliyunOssV4RestClient({ ...baseOptions, fetchImpl: fakeFetch });
    const storage = new AliyunPrivateObjectStorage(client, fixedNow);

    await expect(storage.head("private/photo.webp")).resolves.toEqual({
      sizeBytes: 24576,
      mimeType: "image/webp",
      sha256,
    });
    expect(seen).toEqual([
      { method: "HEAD", headers: undefined },
      { method: "GET", headers: { range: "bytes=0-0" } },
    ]);
  });

  it("deletes an orphan through a short-lived signed DELETE request", async () => {
    const seen: Array<{ method: string | undefined; url: string }> = [];
    const fakeFetch = (async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      seen.push({ method: init?.method, url: String(input) });
      return new Response(null, { status: 204 });
    }) as typeof fetch;
    const client = new AliyunOssV4RestClient({ ...baseOptions, fetchImpl: fakeFetch });
    const storage = new AliyunPrivateObjectStorage(client, fixedNow);

    await expect(storage.deleteObject("private/stale.png")).resolves.toBeUndefined();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe("DELETE");
    const signed = new URL(seen[0]!.url);
    expect(signed.pathname).toBe("/private/stale.png");
    expect(signed.searchParams.get("x-oss-expires")).toBe("60");
    expect(signed.searchParams.get("x-oss-signature-version")).toBe("OSS4-HMAC-SHA256");
  });

  it("maps an OSS 404 into the storage not-found contract", async () => {
    const fakeFetch = (async (): Promise<Response> =>
      new Response(null, { status: 404 })) as typeof fetch;
    const client = new AliyunOssV4RestClient({ ...baseOptions, fetchImpl: fakeFetch });
    const storage = new AliyunPrivateObjectStorage(client, fixedNow);

    await expect(storage.head("private/missing.pdf")).rejects.toBeInstanceOf(
      ObjectStorageObjectNotFoundError,
    );
  });

  it("rejects an internal endpoint because upload grants are browser-facing", () => {
    expect(() => new AliyunOssV4RestClient({
      ...baseOptions,
      endpoint: "https://oss-cn-hangzhou-internal.aliyuncs.com/",
    })).toThrow("Browser direct upload requires a public Aliyun OSS endpoint");
  });

  it("requires production server wiring, file-last browser upload, and ECS read-only OSS/CORS preflight", async () => {
    const [server, uploader, gate,recovery] = await Promise.all([
      readFile(
        new URL("../../apps/api/src/server.ts", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../apps/web/src/external-evidence-uploader.tsx", import.meta.url),
        "utf8",
      ),
      readFile(
        new URL("../../scripts/run-business-chain-gate.mjs", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../../apps/web/src/attachment-upload-recovery.ts",import.meta.url),"utf8"),
    ]);

    expect(server).toContain("AliyunOssV4RestClient");
    expect(server).toContain("AliyunPrivateObjectStorage");
    expect(server).not.toContain(
      "OSS is configured but the official Aliyun OSS SDK client has not been injected",
    );
    expect(uploader).toContain("uploadAttachmentWithRecovery");
    const signedFieldsAt = recovery.indexOf("Object.entries(pending.intent.uploadFields)");
    const fileAt = recovery.indexOf("form.append('file',file)");
    expect(signedFieldsAt).toBeGreaterThanOrEqual(0);
    expect(fileAt).toBeGreaterThan(signedFieldsAt);
    expect(gate).toContain("business acceptance runtime must configure OSS");
    expect(gate).toContain("await client.head(missingObjectKey)");
    expect(gate).toContain('method: "OPTIONS"');
    expect(gate).toContain('"Access-Control-Request-Method": "POST"');
    expect(gate).toContain("OSS_RUNTIME_PREFLIGHT_PASSED");
    expect(gate).not.toContain("console.log(process.env.OSS_ACCESS_KEY_SECRET)");
  });
});
