import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AcceptanceObjectStorage, registerAcceptanceStorageRoutes } from "../../apps/api/src/tools/acceptance-storage.js";

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "acceptance-storage-")); dirs.push(dir);
  let now = Date.now();
  const storage = new AcceptanceObjectStorage(dir, "https://test.invalid/acceptance/api", "test-secret", () => now);
  const app = Fastify(); registerAcceptanceStorageRoutes(app, storage); await app.ready();
  return { dir, storage, app, expire: () => { now += 301000; } };
}
const bytes = Buffer.from("test image content");
const options = { mimeType: "image/png", sizeBytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), ttlSeconds: 300 };
async function upload(app: Awaited<ReturnType<typeof setup>>["app"], token: string, content = bytes, mime = "image/png") {
  const form = new FormData(); form.append("grant", token); form.append("file", new Blob([content], { type: mime }), "test.png");
  const request = new Request("https://test.invalid", { method: "POST", body: form });
  return app.inject({ method: "POST", url: "/acceptance-files/upload", headers: { "content-type": request.headers.get("content-type")! }, payload: Buffer.from(await request.arrayBuffer()) });
}
describe("isolated acceptance attachments", () => {
  it("uploads through the unchanged multipart contract, persists across restarts, and downloads exact bytes", async () => {
    const { app, storage, dir } = await setup();
    try {
      const grant = await storage.createExactSizeNonOverwritableUploadGrant("private/test", options);
      expect((await upload(app, grant.fields.grant)).statusCode).toBe(204);
      const restarted = new AcceptanceObjectStorage(dir, "https://test.invalid/acceptance/api", "test-secret");
      expect(await restarted.head("private/test")).toEqual({ mimeType: "image/png", sizeBytes: bytes.length, sha256: options.sha256 });
      expect(await restarted.computeSha256("private/test")).toBe(options.sha256);
      const download = await restarted.createDownloadGrant("private/test", { ttlSeconds: 300, filename: "测试.png", disposition: "inline" });
      const response = await app.inject({ url: "/acceptance-files/download" + new URL(download.downloadUrl).search });
      expect(response.statusCode).toBe(200); expect(response.rawPayload).toEqual(bytes);
      expect(response.headers["cache-control"]).toBe("private, no-store");
      expect((await upload(app, grant.fields.grant)).statusCode).toBe(409);
    } finally { await app.close(); }
  });
  it("rejects tampered, expired, wrong-purpose and mismatched uploads", async () => {
    const { app, storage, expire } = await setup();
    try {
      const grant = await storage.createExactSizeNonOverwritableUploadGrant("test", options);
      expect((await upload(app, "bad")).statusCode).toBe(403);
      expect((await upload(app, grant.fields.grant, Buffer.from("x"))).statusCode).toBe(400);
      expect((await upload(app, grant.fields.grant, bytes, "text/plain")).statusCode).toBe(400);
      expect((await upload(app, grant.fields.grant, Buffer.alloc(bytes.length))).statusCode).toBe(400);
      expect((await app.inject({ url: "/acceptance-files/download?grant=" + grant.fields.grant })).statusCode).toBe(403);
      expire(); expect((await upload(app, grant.fields.grant)).statusCode).toBe(403);
    } finally { await app.close(); }
  });
  it("prevents concurrent overwrite, bounds reads and hashes keys outside the filesystem namespace", async () => {
    const { app, storage } = await setup();
    try {
      const results = await Promise.allSettled([1, 2].map(() => storage.writeImmutable("../../escape", bytes, options)));
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      await expect(storage.readBytes("../../escape", 1)).rejects.toThrow("limit");
      expect(await storage.readBytes("../../escape", bytes.length)).toEqual(bytes);
      await storage.deleteObject("../../escape"); await expect(storage.head("../../escape")).rejects.toThrow("Object not found");
      await expect(storage.createExactSizeNonOverwritableUploadGrant("large", { ...options, sizeBytes: 21 * 1024 * 1024 })).rejects.toThrow("limit");
    } finally { await app.close(); }
  });
});
