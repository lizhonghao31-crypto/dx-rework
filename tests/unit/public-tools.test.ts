import { describe, expect, it } from "vitest";
import { transitionAttachment, transitionExportJob, transitionOutbox, sanitizeOperationalError } from "@dx-rework/domain";
import {
  AliyunPrivateObjectStorage,
  createPrivateObjectKey,
  DisabledObjectStorage,
  FakeObjectStorage,
  ObjectStorageObjectNotFoundError,
} from "../../apps/api/src/tools/storage.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

class MemoryIdempotency {
  private records = new Map<string, { hash: string; promise: Promise<unknown> }>();
  executions = 0;

  execute(key: string, hash: string, work: () => Promise<unknown>) {
    const prior = this.records.get(key);
    if (prior) {
      if (prior.hash !== hash) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "different payload", 409);
      return prior.promise;
    }
    this.executions += 1;
    const promise = work();
    this.records.set(key, { hash, promise });
    return promise;
  }
}

describe("public tools domain contracts", () => {
  it("permits only explicit attachment/outbox/export transitions", () => {
    expect(transitionAttachment("pending", "ready")).toBe("ready");
    expect(() => transitionAttachment("ready", "pending")).toThrow();
    expect(transitionOutbox("failed", "processing")).toBe("processing");
    expect(() => transitionOutbox("sent", "processing")).toThrow();
    expect(transitionExportJob("running", "succeeded")).toBe("succeeded");
    expect(() => transitionExportJob("failed", "running")).toThrow();
  });

  it("persists only a fixed safe classification for operational errors", () => {
    const error = new Error(
      "accessKeySecret=leak client_secret=leak x-oss-credential=leak authorization=Bearer leak",
    );
    expect(sanitizeOperationalError(error)).toBe("Operation failed; inspect protected server logs");
    expect(sanitizeOperationalError({ accessKeySecret: "leak" })).toBe("Operation failed; inspect protected server logs");
  });

  it("executes concurrent equal idempotency requests once and rejects a different hash", async () => {
    const gate = new MemoryIdempotency();
    let release!: () => void;
    const work = new Promise((resolve) => { release = () => resolve({ ok: true }); });
    const one = gate.execute("actor:key", "same", () => work);
    const two = gate.execute("actor:key", "same", async () => ({ bad: true }));
    expect(gate.executions).toBe(1);
    expect(() => gate.execute("actor:key", "different", async () => null)).toThrowError(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 }),
    );
    release();
    await expect(Promise.all([one, two])).resolves.toEqual([{ ok: true }, { ok: true }]);
  });
});

describe("private object storage", () => {
  it("creates unpredictable private keys without filenames and rejects traversal/double-extension", () => {
    const a = createPrivateObjectKey("private", "evidence.JPG", new Date("2026-08-01T00:00:00.987Z"));
    const b = createPrivateObjectKey("private", "evidence.JPG", new Date("2026-08-01T00:00:00.987Z"));
    expect(a).toMatch(/^private\/2026\/08\/01\/[0-9a-f]{48}\.jpg$/);
    expect(a).not.toBe(b);
    expect(a).not.toContain("evidence");
    expect(() => createPrivateObjectKey("private", "../x.pdf")).toThrow();
    expect(() => createPrivateObjectKey("private", "report.exe.pdf")).toThrow();
  });

  it("records exact-size POST and short GET grants in the fake and fails explicitly when disabled", async () => {
    const now = () => new Date("2026-08-01T00:00:00.987Z");
    const fake = new FakeObjectStorage(now);
    const upload = await fake.createExactSizeNonOverwritableUploadGrant("private/x.pdf", {
      mimeType: "application/pdf",
      sizeBytes: 1,
      sha256: "a".repeat(64),
      ttlSeconds: 300,
    });
    const download = await fake.createDownloadGrant("private/x.pdf", { ttlSeconds: 120, filename: "x.pdf" });
    expect(fake.signed).toEqual([
      { method: "POST", objectKey: "private/x.pdf", ttlSeconds: 300, sizeBytes: 1 },
      { method: "GET", objectKey: "private/x.pdf", ttlSeconds: 120 },
    ]);
    expect(upload).toMatchObject({
      method: "POST",
      expiresAt: "2026-08-01T00:05:00.000Z",
      fields: { key: "private/x.pdf", "x-oss-forbid-overwrite": "true" },
    });
    expect(download.expiresAt).toBe("2026-08-01T00:02:00.000Z");
    await expect(new DisabledObjectStorage().head("x")).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
  });

  it("binds exact size, metadata, private ACL and non-overwrite in the signed POST policy", async () => {
    const postCalls: Array<Record<string, unknown>> = [];
    const getCalls: Array<Record<string, unknown>> = [];
    const client = {
      createPostObjectUploadGrant: async (options: {
        expiration: string;
        fields: Readonly<Record<string, string>>;
        conditions: readonly unknown[];
      }) => {
        postCalls.push(options);
        return {
          uploadUrl: "https://oss.test/",
          fields: { ...options.fields, policy: "signed-policy", "x-oss-signature": "signed" },
        };
      },
      signatureUrl: (name: string, options: Record<string, unknown>) => {
        getCalls.push({ name, ...options });
        return "https://oss.test/private/x.png?signature=signed";
      },
      createReadStream: async () => (async function* () {
        yield new TextEncoder().encode("test");
      })(),
      head: async () => ({
        res: {
          headers: {
            "content-length": "4",
            "content-type": "image/png",
            "x-oss-meta-sha256": "ABCD",
          },
        },
      }),
    };
    const storage = new AliyunPrivateObjectStorage(client, () => new Date("2026-08-01T00:00:00.987Z"));
    const upload = await storage.createExactSizeNonOverwritableUploadGrant("private/x.png", {
      mimeType: "image/png",
      sizeBytes: 4,
      sha256: "abcd",
      ttlSeconds: 300,
    });
    const download = await storage.createDownloadGrant("private/x.png", { filename: "x.png", ttlSeconds: 60 });

    expect(postCalls[0]).toMatchObject({ expiration: "2026-08-01T00:05:00.000Z" });
    expect(postCalls[0]?.conditions).toEqual(expect.arrayContaining([
      ["eq", "$key", "private/x.png"],
      ["eq", "$Content-Type", "image/png"],
      ["eq", "$x-oss-meta-sha256", "abcd"],
      ["eq", "$x-oss-object-acl", "private"],
      ["eq", "$x-oss-forbid-overwrite", "true"],
      ["content-length-range", 4, 4],
    ]));
    expect(upload).toMatchObject({
      method: "POST",
      expiresAt: "2026-08-01T00:05:00.000Z",
      fields: { key: "private/x.png", "x-oss-forbid-overwrite": "true" },
    });
    expect(download.expiresAt).toBe("2026-08-01T00:01:00.000Z");
    expect(getCalls[0]).toMatchObject({ name: "private/x.png", method: "GET", expires: 60 });
    expect(await storage.head("private/x.png")).toEqual({ sizeBytes: 4, mimeType: "image/png", sha256: "abcd" });
    expect(await storage.computeSha256("private/x.png")).toBe("9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08");
  });

  it("rejects a weakened or insecure SDK upload grant", async () => {
    const base = {
      signatureUrl: () => "https://oss.test/x",
      head: async () => ({ res: { headers: {} } }),
      createReadStream: async () => (async function* () { yield new Uint8Array(); })(),
    };
    const weakened = new AliyunPrivateObjectStorage({
      ...base,
      createPostObjectUploadGrant: async () => ({
        uploadUrl: "https://oss.test/",
        fields: { key: "different" },
      }),
    });
    const insecure = new AliyunPrivateObjectStorage({
      ...base,
      createPostObjectUploadGrant: async (options: { fields: Readonly<Record<string, string>> }) => ({
        uploadUrl: "http://oss.test/",
        fields: options.fields,
      }),
    });
    const options = { mimeType: "application/pdf", sizeBytes: 1, sha256: "a".repeat(64), ttlSeconds: 300 };
    await expect(weakened.createExactSizeNonOverwritableUploadGrant("private/x.pdf", options)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
    await expect(insecure.createExactSizeNonOverwritableUploadGrant("private/x.pdf", options)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
    });
  });

  it("normalizes the official SDK missing-object error", async () => {
    const storage = new AliyunPrivateObjectStorage({
      createPostObjectUploadGrant: async (options) => ({ uploadUrl: "https://oss.test", fields: options.fields }),
      signatureUrl: () => "https://oss.test",
      head: async () => { throw { status: 404, code: "NoSuchKey" }; },
      createReadStream: async () => { throw { status: 404, code: "NoSuchKey" }; },
    });
    await expect(storage.head("missing")).rejects.toBeInstanceOf(ObjectStorageObjectNotFoundError);
    await expect(storage.computeSha256("missing")).rejects.toBeInstanceOf(ObjectStorageObjectNotFoundError);
  });
});
