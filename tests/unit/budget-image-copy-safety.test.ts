import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { FakeObjectStorage, ObjectStorageObjectNotFoundError, type ObjectStorage } from "../../apps/api/src/tools/storage.js";
import { readBudgetSourcing } from "../../apps/api/src/production-platform/budget-sourcing-adapter.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

vi.mock("../../apps/api/src/production-platform/budget-sourcing-adapter.js", () => ({ readBudgetSourcing: vi.fn() }));

const actor: TrustedActorContext = { actorId: randomUUID(), actorRoles: ["order_merchandiser"], requestId: "TEST-copy-safety", authorizationCapability: "sourcing:inquiry:create" };
const orderId = randomUUID(), sourceId = randomUUID(), bytes = Buffer.from("TEST private budget image");
const sha256 = createHash("sha256").update(bytes).digest("hex");
const source = { attachment_id: sourceId, object_key: "TEST/source.png", original_filename: "TEST.png", mime_type: "image/png", size_bytes: String(bytes.length), sha256,
  uploaded_by: actor.actorId, status: "ready", entity_type: "digital_budget", entity_id: orderId, created_at: new Date("2026-11-01T00:00:00Z") };
const copy = { ...source, attachment_id: randomUUID(), object_key: "TEST/copy.png", entity_type: null as string | null, entity_id: null as string | null };

async function fixture(options: { prior?: typeof copy; fail?: string; rollbackFails?: boolean; dtoFails?: boolean; bound?: boolean } = {}) {
  vi.mocked(readBudgetSourcing).mockResolvedValue({ budgetVersion: 3, document: { imageAttachmentIds: [sourceId] } } as never);
  const storage = new FakeObjectStorage();
  await storage.writeImmutable(source.object_key, bytes, { mimeType: source.mime_type, sha256 });
  if (options.prior) await storage.writeImmutable(copy.object_key, bytes, { mimeType: copy.mime_type, sha256 });
  const operations: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, values?: unknown[]) => {
      operations.push(sql);
      if (sql === options.fail || options.fail === "INSERT" && sql.startsWith("INSERT INTO digital_budget_image_copies")) throw new Error("TEST original failure");
      if (sql === "ROLLBACK" && options.rollbackFails) throw new Error("TEST rollback disconnected");
      let rows: unknown[] = [];
      if (sql.includes("FROM digital_budget_image_copies")) rows = options.prior ? [options.prior] : [];
      if (sql.includes("FROM attachments a JOIN digital_budget_attachment_bindings")) rows = [source];
      if (sql.includes("FROM digital_production_child_links")) rows = options.bound ? [{ exists: 1 }] : [];
      if (sql.startsWith("INSERT INTO attachments")) rows = [{ ...copy, attachment_id: values![0], object_key: values![1], ...(options.dtoFails ? { created_at: "TEST invalid date" } : {}) }];
      return { rows, rowCount: rows.length };
    }),
    release: vi.fn(() => operations.push("RELEASE")),
  };
  const pool = { connect: vi.fn(async () => client) } as unknown as Pool;
  const service = new AttachmentService(pool, storage, { prefix: "TEST", ttlSeconds: 60, maxUploadBytes: 1000 }, { append: vi.fn() } as never);
  return { storage, client, operations, run: () => service.copyDigitalBudgetImage(actor, orderId, 3, sourceId), service };
}

afterEach(() => { vi.useRealTimers(); });

describe("budget image copy transaction and retry safety", () => {
  it("commits one copied image and leaves the original unchanged", async () => {
    const f = await fixture();
    const result = await f.run();
    expect(result).toMatchObject({ filename: "TEST.png", sha256, status: "ready" });
    expect(result.attachmentId).not.toBe(sourceId);
    expect(f.operations.slice(-2)).toEqual(["COMMIT", "RELEASE"]);
    expect(f.storage.deleted).toEqual([]);
    expect(Buffer.from(await f.storage.readBytes(source.object_key, 1000))).toEqual(bytes);
  });

  it("cleans only the new object after a confirmed pre-commit rollback", async () => {
    const f = await fixture({ fail: "INSERT" });
    await expect(f.run()).rejects.toThrow("TEST original failure");
    expect(f.storage.deleted).toHaveLength(1);
    expect(f.storage.deleted).not.toContain(source.object_key);
    expect(f.operations).not.toContain("COMMIT");
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it.each([false, true])("retains the object after COMMIT is attempted, including rollback failure=%s", async rollbackFails => {
    const f = await fixture({ fail: "COMMIT", rollbackFails });
    await expect(f.run()).rejects.toThrow("TEST original failure");
    expect(f.storage.objects.size).toBe(2);
    expect(f.storage.deleted).toEqual([]);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("records a failed cleanup without replacing the original operation error", async () => {
    const f = await fixture({ fail: "INSERT" }), warning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    vi.spyOn(f.storage, "deleteObject").mockRejectedValue(new Error("TEST cleanup failed"));
    await expect(f.run()).rejects.toThrow("TEST original failure");
    expect(warning).toHaveBeenCalledWith(expect.any(String), { code: "BUDGET_IMAGE_CLEANUP_FAILED" });
  });

  it("retains the object and destroys the connection when rollback acknowledgement is lost", async () => {
    const f = await fixture({ fail: "INSERT", rollbackFails: true });
    await expect(f.run()).rejects.toThrow("TEST original failure");
    expect(f.storage.deleted).toEqual([]);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("does not roll back or delete committed bytes when DTO conversion fails", async () => {
    const f = await fixture({ dtoFails: true });
    await expect(f.run()).rejects.toThrow("Invalid time value");
    expect(f.operations).toContain("COMMIT");
    expect(f.operations).not.toContain("ROLLBACK");
    expect(f.storage.deleted).toEqual([]);
    expect(f.client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it("verifies an existing mapping after releasing its transaction and without copying again", async () => {
    const f = await fixture({ prior: copy });
    const head = vi.spyOn(f.storage, "head").mockImplementation(async () => {
      expect(f.operations.slice(-2)).toEqual(["COMMIT", "RELEASE"]);
      return { sizeBytes: bytes.length, mimeType: "image/png", sha256 };
    });
    await expect(f.run()).resolves.toMatchObject({ attachmentId: copy.attachment_id });
    expect(head).toHaveBeenCalledOnce();
    expect(f.operations.some(sql => sql.startsWith("INSERT"))).toBe(false);
    expect(f.storage.objects.size).toBe(2);
  });

  it("uses a bounded content hash when SHA metadata is absent", async () => {
    const f = await fixture({ prior: copy });
    vi.spyOn(f.storage, "head").mockResolvedValue({ sizeBytes: bytes.length, mimeType: "image/png" });
    const read = vi.spyOn(f.storage, "readBytes"), compute = vi.spyOn(f.storage, "computeSha256");
    await expect(f.run()).resolves.toMatchObject({ attachmentId: copy.attachment_id });
    expect(read).toHaveBeenCalledWith(copy.object_key, 1000, expect.any(AbortSignal));
    expect(compute).not.toHaveBeenCalled();
    vi.mocked(read).mockResolvedValue(Buffer.from("TEST corrupt same-sized image"));
    await expect(f.run()).rejects.toMatchObject({ code: "ATTACHMENT_METADATA_MISMATCH", statusCode: 422 });
  });

  it.each([
    ["missing", () => { throw new ObjectStorageObjectNotFoundError(); }, "ATTACHMENT_NOT_READY", 409],
    ["forbidden", () => { throw Object.assign(new Error("OSS forbidden"), { status: 403 }); }, "STORAGE_UNAVAILABLE", 503],
    ["size", () => ({ sizeBytes: 1, mimeType: "image/png", sha256 }), "ATTACHMENT_METADATA_MISMATCH", 422],
    ["mime", () => ({ sizeBytes: bytes.length, mimeType: "image/jpeg", sha256 }), "ATTACHMENT_METADATA_MISMATCH", 422],
    ["digest", () => ({ sizeBytes: bytes.length, mimeType: "image/png", sha256: "0".repeat(64) }), "ATTACHMENT_METADATA_MISMATCH", 422],
  ] as const)("does not return or repair an invalid mapped copy: %s", async (_name, head, code, statusCode) => {
    const f = await fixture({ prior: copy });
    vi.spyOn(f.storage, "head").mockImplementation(async () => head());
    await expect(f.run()).rejects.toMatchObject({ code, statusCode });
    expect(f.operations).not.toContain("ROLLBACK");
    expect(f.storage.deleted).toEqual([]);
    expect(f.storage.objects.size).toBe(2);
  });

  it("bounds HEAD by a five-second deadline", async () => {
    vi.useFakeTimers();
    const f = await fixture({ prior: copy });
    vi.spyOn(f.storage as ObjectStorage, "head").mockImplementation((_key, signal?: AbortSignal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const result = expect(f.run()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    await vi.advanceTimersByTimeAsync(5000);
    await result;
    expect(f.operations).not.toContain("ROLLBACK");
    expect(f.storage.deleted).toEqual([]);
  });

  it("does not restart the deadline for a hash read after a slow HEAD", async () => {
    vi.useFakeTimers();
    const f = await fixture({ prior: copy });
    vi.spyOn(f.storage, "head").mockImplementation(() => new Promise(resolve => {
      setTimeout(() => resolve({ sizeBytes: bytes.length, mimeType: "image/png" }), 4000);
    }));
    const read = vi.spyOn(f.storage as ObjectStorage, "readBytes").mockImplementation((_key, _limit, signal) => new Promise((_resolve, reject) => {
      signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
    }));
    const result = expect(f.run()).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    await vi.advanceTimersByTimeAsync(4999);
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![2]!.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await result;
    expect(read.mock.calls[0]![2]!.aborted).toBe(true);
    expect(f.storage.deleted).toEqual([]);
  });

  it("rejects invalid attachment status, ownership and unrelated bindings before storage access", async () => {
    for (const prior of [{ ...copy, status: "rejected" }, { ...copy, uploaded_by: randomUUID() }, { ...copy, entity_type: "sourcing_case", entity_id: randomUUID() }]) {
      const f = await fixture({ prior });
      const head = vi.spyOn(f.storage, "head");
      await expect(f.run()).rejects.toMatchObject({ code: "ATTACHMENT_NOT_READY" });
      expect(head).not.toHaveBeenCalled();
    }
  });

  it("accepts a ready copy bound through the same order's legitimate sourcing relationship", async () => {
    const f = await fixture({ prior: { ...copy, entity_type: "sourcing_case", entity_id: randomUUID() }, bound: true });
    await expect(f.run()).resolves.toMatchObject({ attachmentId: copy.attachment_id });
  });

  it("preserves the PMC and budget version/source guards before creating copies", async () => {
    const f = await fixture();
    await expect(f.service.copyDigitalBudgetImage({ ...actor, actorRoles: ["pmc"] }, orderId, 3, sourceId)).rejects.toMatchObject({ statusCode: 403 });
    for (const [version, id] of [[2, sourceId], [3, randomUUID()]] as const) {
      await expect(f.service.copyDigitalBudgetImage(actor, orderId, version, id)).rejects.toMatchObject({ code: "BUDGET_CONFLICT" });
    }
    expect(f.storage.objects.size).toBe(1);
    vi.mocked(readBudgetSourcing).mockRejectedValue(new ApplicationError("FORBIDDEN", "TEST revoked", 403));
    await expect(f.run()).rejects.toMatchObject({ statusCode: 403 });
    expect(f.storage.objects.size).toBe(1);
  });
});
