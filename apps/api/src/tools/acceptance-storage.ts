import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import { ApplicationError } from "../platform/errors.js";
import { ObjectStorageObjectNotFoundError, type ObjectStorage, type StoredObjectMetadata, type DownloadOptions } from "./storage.js";

const MAX_BYTES = 20 * 1024 * 1024;
const fail = (message: string, status = 400): never => { throw new ApplicationError("ACCEPTANCE_STORAGE_ERROR", message, status); };
type Grant = { key: string; action: "upload" | "download"; expires: number; mimeType?: string; sizeBytes?: number; sha256?: string; filename?: string; disposition?: string };

/** Private test files only. Production still uses the existing OSS implementation. */
export class AcceptanceObjectStorage implements ObjectStorage {
  constructor(private readonly directory: string, private readonly baseUrl: string, private readonly secret: string,
    private readonly now: () => number = Date.now) {}

  private path(key: string): string { return join(this.directory, createHash("sha256").update(key).digest("hex") + ".json"); }
  private sign(grant: Grant): string {
    const data = Buffer.from(JSON.stringify(grant)).toString("base64url");
    return data + "." + createHmac("sha256", this.secret).update(data).digest("base64url");
  }
  verify(token: string, action: Grant["action"]): Grant {
    const [data, signature, extra] = token.split(".");
    if (!data || !signature || extra || token.length > 12000) return fail("Invalid file grant", 403);
    const expected = createHmac("sha256", this.secret).update(data).digest();
    const actual = Buffer.from(signature, "base64url");
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return fail("Invalid file grant", 403);
    let grant: Grant;
    try { grant = JSON.parse(Buffer.from(data, "base64url").toString()) as Grant; } catch { return fail("Invalid file grant", 403); }
    if (grant.action !== action || !Number.isFinite(grant.expires) || grant.expires <= this.now()) return fail("Expired file grant", 403);
    return grant;
  }
  async createExactSizeNonOverwritableUploadGrant(key: string, options: { mimeType: string; sizeBytes: number; sha256: string; ttlSeconds: number }) {
    if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 1 || options.sizeBytes > MAX_BYTES) return fail("File exceeds acceptance upload limit");
    const expires = this.now() + Math.min(options.ttlSeconds, 300) * 1000;
    return { method: "POST" as const, uploadUrl: this.baseUrl + "/acceptance-files/upload", fields: { grant: this.sign({ key, action: "upload", expires, ...options }) }, expiresAt: new Date(expires).toISOString() };
  }
  async createDownloadGrant(key: string, options: DownloadOptions) {
    await this.head(key);
    const expires = this.now() + Math.min(options.ttlSeconds, 300) * 1000;
    const token = this.sign({ key, action: "download", expires, filename: options.filename, disposition: options.disposition ?? "attachment" });
    return { downloadUrl: this.baseUrl + "/acceptance-files/download?grant=" + token, expiresAt: new Date(expires).toISOString() };
  }
  private async record(key: string): Promise<{ metadata: StoredObjectMetadata; bytes: string }> {
    try { return JSON.parse(await readFile(this.path(key), "utf8")) as { metadata: StoredObjectMetadata; bytes: string }; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectStorageObjectNotFoundError(); throw error; }
  }
  async head(key: string) { return (await this.record(key)).metadata; }
  async readBytes(key: string, maxBytes: number) {
    const record = await this.record(key);
    if (record.metadata.sizeBytes > maxBytes) return fail("File exceeds read limit");
    return Buffer.from(record.bytes, "base64");
  }
  async computeSha256(key: string) { return createHash("sha256").update(await this.readBytes(key, MAX_BYTES)).digest("hex"); }
  async writeImmutable(key: string, content: Uint8Array, options: { mimeType: string; sha256: string }) {
    if (content.byteLength > MAX_BYTES || createHash("sha256").update(content).digest("hex") !== options.sha256) return fail("File size or checksum mismatch");
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.path(key), temporary = join(this.directory, randomUUID() + ".tmp");
    try {
      await writeFile(temporary, JSON.stringify({ metadata: { ...options, sizeBytes: content.byteLength }, bytes: Buffer.from(content).toString("base64") }), { flag: "wx", mode: 0o600 });
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") return fail("File already exists", 409);
      throw error;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
  async deleteObject(key: string) { await unlink(this.path(key)).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
}

export function registerAcceptanceStorageRoutes(app: FastifyInstance, storage: AcceptanceObjectStorage): void {
  void app.register(async scoped => {
    scoped.addContentTypeParser(/^multipart\/form-data/i, { parseAs: "buffer", bodyLimit: MAX_BYTES + 65536 }, (_request, body, done) => done(null, body));
    scoped.post("/acceptance-files/upload", { bodyLimit: MAX_BYTES + 65536, logLevel: "silent" }, async (request, reply) => {
      const type = request.headers["content-type"] ?? "";
      if (!Buffer.isBuffer(request.body)) return fail("Expected file upload");
      let form;
      try { form = await new Request("https://acceptance.invalid", { method: "POST", headers: { "content-type": type }, body: new Uint8Array(request.body).buffer }).formData(); }
      catch { return fail("Invalid multipart upload"); }
      const token = form.get("grant"), file = form.get("file");
      if (typeof token !== "string" || !file || typeof file === "string" || form.getAll("file").length !== 1 || form.getAll("grant").length !== 1) return fail("Missing file grant");
      const grant = storage.verify(token, "upload");
      if (file.size !== grant.sizeBytes || file.type !== grant.mimeType || !grant.sha256) return fail("File size or type mismatch");
      await storage.writeImmutable(grant.key, new Uint8Array(await file.arrayBuffer()), { mimeType: grant.mimeType, sha256: grant.sha256 });
      return reply.code(204).send();
    });
    scoped.get<{ Querystring: { grant?: string } }>("/acceptance-files/download", { logLevel: "silent" }, async (request, reply) => {
      const grant = storage.verify(request.query.grant ?? "", "download");
      const metadata = await storage.head(grant.key);
      return reply.header("cache-control", "private, no-store").header("x-content-type-options", "nosniff")
        .header("content-security-policy", "sandbox")
        .header("content-disposition", `${grant.disposition === "inline" ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(grant.filename ?? "file")}`)
        .type(metadata.mimeType).send(await storage.readBytes(grant.key, MAX_BYTES));
    });
  });
}
