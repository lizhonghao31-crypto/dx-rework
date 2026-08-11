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
    expect(seen).toHaveLength(2);
    expect(seen[0]?.method).toBe("HEAD");
    expect(seen[1]?.method).toBe("GET");
    expect(seen.every((request) =>
      new URL(request.url).searchParams.get("x-oss-signature-version")
        === "OSS4-HMAC-SHA256"
    )).toBe(true);
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
    const [server, uploader, gate] = await Promise.all([
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
    ]);

    expect(server).toContain("AliyunOssV4RestClient");
    expect(server).toContain("AliyunPrivateObjectStorage");
    expect(server).not.toContain(
      "OSS is configured but the official Aliyun OSS SDK client has not been injected",
    );
    const signedFieldsAt = uploader.indexOf(
      "for (const [name, value] of Object.entries(intent.uploadFields))",
    );
    const fileAt = uploader.indexOf('form.append("file",');
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
