import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import {
  DisabledObjectStorage,
  ObjectStorageObjectNotFoundError,
  type ObjectStorage,
} from "../../apps/api/src/tools/storage.js";

const actor = { actorId: "00000000-0000-4000-8000-000000000099", actorRoles: ["tail_supervisor"], authorizationCapability: "tools:user", requestId: "request-1" };
const pdfBytes = Buffer.from("%PDF-1.4\n%%EOF\n");
const pdfSha256 = createHash("sha256").update(pdfBytes).digest("hex");
const input = { filename: "proof.pdf", mimeType: "application/pdf" as const, sizeBytes: pdfBytes.length, sha256: pdfSha256 };
const row = {
  attachment_id: "00000000-0000-4000-8000-000000000001",
  object_key: "private/proof.pdf",
  original_filename: "proof.pdf",
  mime_type: "application/pdf",
  size_bytes: String(pdfBytes.length),
  sha256: pdfSha256,
  uploaded_by: actor.actorId,
  entity_type: null,
  entity_id: null,
  status: "pending" as const,
  created_at: new Date("2026-08-01T00:00:00Z"),
};

type AttachmentTestRow = Omit<typeof row, "status"> & { status: "pending" | "ready" | "rejected" };

function poolWithOwnedRow(ownedRow: AttachmentTestRow = row) {
  const operations: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      operations.push(sql);
      if (sql.startsWith("UPDATE attachments SET status='ready'")) {
        return { rowCount: 1, rows: [{ ...ownedRow, status: "ready" as const }] };
      }
      if (sql.startsWith("UPDATE attachments")) return { rowCount: 1, rows: [ownedRow] };
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => ({ rowCount: 1, rows: [ownedRow] })),
    connect: vi.fn(async () => client),
  };
  return { pool, client, operations };
}

const emptyStorage = (): ObjectStorage => ({
  createExactSizeNonOverwritableUploadGrant: vi.fn(),
  createDownloadGrant: vi.fn(),
  head: vi.fn(),
  readBytes: vi.fn(async () => pdfBytes),
  computeSha256: vi.fn(async () => input.sha256),
  deleteObject: vi.fn(async () => undefined),
});

describe("AttachmentService failure consistency", () => {
  it("authorizes thumbnails before signing and refuses document transforms", async () => {
    const ready = { ...row, mime_type: "image/jpeg", status: "ready" as const };
    const { pool } = poolWithOwnedRow(ready);
    const storage = emptyStorage();
    vi.mocked(storage.createDownloadGrant).mockResolvedValue({ downloadUrl: "https://oss.test/thumbnail", expiresAt: "2030-01-01T00:00:00Z" });
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 1000 });
    expect(service.uploadLimits()).toEqual({ maxUploadBytes: 1000 });
    await expect(service.createDownloadIntent({ ...actor, actorId: "other" }, ready.attachment_id, undefined, "inline", "thumbnail")).rejects.toMatchObject({ statusCode: 403 });
    expect(storage.createDownloadGrant).not.toHaveBeenCalled();
    await service.createDownloadIntent(actor, ready.attachment_id, undefined, "inline", "thumbnail");
    expect(storage.createDownloadGrant).toHaveBeenCalledWith(ready.object_key, expect.objectContaining({ variant: "thumbnail", disposition: "inline", ttlSeconds: 300 }));
    const pdfPool = poolWithOwnedRow({ ...row, status: "ready" });
    const pdfService = new AttachmentService(pdfPool.pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 1000 });
    await expect(pdfService.createDownloadIntent(actor, row.attachment_id, undefined, "inline", "thumbnail")).rejects.toMatchObject({ statusCode: 400 });
    expect(storage.createDownloadGrant).toHaveBeenCalledTimes(1);
  });
  it("does not write a pending attachment when upload signing fails", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const storage: ObjectStorage = {
      ...emptyStorage(),
      createExactSizeNonOverwritableUploadGrant: vi.fn(async () => {
        throw new Error("temporary OSS failure");
      }),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.createUploadIntent(actor, input)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("caps one actor at the existing maximum business attachment batch while serializing quota checks", async () => {
    const operations: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        operations.push(sql);
        if (sql.includes("count(*)::int active_count")) {
          return { rowCount: 1, rows: [{ active_count: 50 }] };
        }
        return { rowCount: 1, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = { connect: vi.fn(async () => client), query: vi.fn() };
    const storage: ObjectStorage = {
      ...emptyStorage(),
      createExactSizeNonOverwritableUploadGrant: vi.fn(async () => ({
        method: "POST",
        uploadUrl: "https://oss.test/",
        fields: { key: "private/proof.pdf" },
        expiresAt: "2030-01-02T03:04:05.000Z",
      } as never)),
    };
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.createUploadIntent(actor, input)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      statusCode: 429,
    });
    expect(operations[0]).toBe("BEGIN");
    expect(operations[1]).toContain("pg_advisory_xact_lock");
    expect(operations[2]).toContain("count(*)::int active_count");
    expect(operations).not.toContain(expect.stringContaining("INSERT INTO attachments"));
    expect(operations.at(-1)).toBe("ROLLBACK");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("returns the storage grant expiry and POST fields without recomputing them", async () => {
    const { pool } = poolWithOwnedRow();
    const storage: ObjectStorage = {
      ...emptyStorage(),
      createExactSizeNonOverwritableUploadGrant: vi.fn(async (_objectKey, options) => ({
        method: "POST",
        uploadUrl: "https://oss.test/",
        fields: { policy: "signed", key: "private/generated.pdf" },
        expiresAt: "2030-01-02T03:04:05.000Z",
        options,
      } as never)),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.createUploadIntent(actor, input)).resolves.toMatchObject({
      uploadMethod: "POST",
      uploadUrl: "https://oss.test/",
      uploadFields: { policy: "signed", key: "private/generated.pdf" },
      expiresAt: "2030-01-02T03:04:05.000Z",
    });
  });

  it("preserves an explicit storage-unavailable 503 during finalize without changing state", async () => {
    const { pool } = poolWithOwnedRow();
    const service = new AttachmentService(pool as never, new DisabledObjectStorage(), {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("rejects a fifth concurrent finalize for the same actor before another storage read", async () => {
    let releaseHeads!: () => void;
    const headGate = new Promise<void>((resolve) => { releaseHeads = resolve; });
    const { pool } = poolWithOwnedRow();
    const storage: ObjectStorage = {
      ...emptyStorage(),
      head: vi.fn(async () => {
        await headGate;
        return { sizeBytes: pdfBytes.length, mimeType: "application/pdf", sha256: pdfSha256 };
      }),
    };
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    const firstFour = Array.from({ length: 4 }, (_, index) =>
      service.finalize(actor, `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`));
    await vi.waitFor(() => expect(storage.head).toHaveBeenCalledTimes(4));

    await expect(service.finalize(
      actor,
      "00000000-0000-4000-8000-000000000005",
    )).rejects.toMatchObject({ code: "RATE_LIMITED", statusCode: 429 });
    expect(storage.head).toHaveBeenCalledTimes(4);

    releaseHeads();
    await expect(Promise.all(firstFour)).resolves.toHaveLength(4);
  });

  it("maps a temporary HEAD failure to 503 without rejecting the attachment", async () => {
    const { pool } = poolWithOwnedRow();
    const storage: ObjectStorage = {
      ...emptyStorage(),
      head: vi.fn(async () => { throw new Error("timeout from upstream"); }),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({
      code: "STORAGE_UNAVAILABLE",
      statusCode: 503,
    });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["missing object", async () => { throw new ObjectStorageObjectNotFoundError(); }, "object_not_found"],
    ["metadata mismatch", async () => ({ sizeBytes: 99, mimeType: "application/pdf", sha256: pdfSha256 }), "metadata_mismatch"],
    ["missing SHA metadata", async () => ({ sizeBytes: pdfBytes.length, mimeType: "application/pdf" }), "metadata_mismatch"],
  ])("rejects and audits %s in one transaction", async (_name, head, reason) => {
    const { pool, client, operations } = poolWithOwnedRow();
    const storage: ObjectStorage = { ...emptyStorage(), head };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({
      code: "ATTACHMENT_METADATA_MISMATCH",
      statusCode: 422,
    });
    expect(operations).toHaveLength(4);
    expect(operations[0]).toBe("BEGIN");
    expect(operations[1]).toContain("UPDATE attachments SET status='rejected'");
    expect(operations[2]).toContain("INSERT INTO operation_events");
    expect(operations[3]).toBe("COMMIT");
    expect(client.query.mock.calls[1]?.[1]).toEqual([row.attachment_id, reason]);
    expect(client.query.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["attachment.rejected", reason]));
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("marks an attachment ready only after checking metadata, real bytes and the actual digest", async () => {
    const { pool, operations } = poolWithOwnedRow();
    const storage: ObjectStorage = {
      ...emptyStorage(),
      head: vi.fn(async () => ({ sizeBytes: pdfBytes.length, mimeType: "application/pdf", sha256: input.sha256 })),
      readBytes: vi.fn(async () => pdfBytes),
      computeSha256: vi.fn(async () => input.sha256),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).resolves.toMatchObject({ status: "ready" });
    expect(storage.head).toHaveBeenCalledWith(row.object_key);
    expect(storage.readBytes).toHaveBeenCalledWith(row.object_key, 100);
    expect(storage.computeSha256).not.toHaveBeenCalled();
    expect(operations[0]).toBe("BEGIN");
    expect(operations[1]).toContain("UPDATE attachments SET status='ready'");
    expect(operations[2]).toContain("INSERT INTO operation_events");
    expect(operations[3]).toBe("COMMIT");
  });

  it.each([
    ["size mismatch", Buffer.from("%PDF-1.4\nchanged\n%%EOF\n"), "content_size_mismatch"],
    ["digest mismatch", Buffer.from("%PDF-1.5\n%%EOF\n"), "content_sha256_mismatch"],
    ["invalid declared type", Buffer.alloc(pdfBytes.length, 0x41), "content_invalid"],
  ])("rejects real object bytes on %s", async (_name, bytes, reason) => {
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ownedRow = reason === "content_invalid"
      ? { ...row, sha256: digest }
      : row;
    const { pool, client } = poolWithOwnedRow(ownedRow);
    const storage: ObjectStorage = {
      ...emptyStorage(),
      head: vi.fn(async () => ({
        sizeBytes: Number(ownedRow.size_bytes),
        mimeType: ownedRow.mime_type,
        sha256: ownedRow.sha256,
      })),
      readBytes: vi.fn(async () => bytes),
    };
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({
      code: "ATTACHMENT_METADATA_MISMATCH",
      statusCode: 422,
    });
    expect(client.query.mock.calls[1]?.[1]).toEqual([row.attachment_id, reason]);
  });

  it("treats an already-ready finalize as idempotent without another HEAD or transaction", async () => {
    const readyRow = { ...row, status: "ready" as const };
    const { pool } = poolWithOwnedRow(readyRow);
    const storage = emptyStorage();
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).resolves.toMatchObject({ status: "ready" });
    expect(storage.head).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("serializes a PostgreSQL timestamp string after finalize without returning 500", async () => {
    const readyRow = {
      ...row,
      status: "ready" as const,
      created_at: "2026-08-01T00:00:00.000Z",
    };
    const { pool } = poolWithOwnedRow(readyRow as never);
    const storage = emptyStorage();
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.finalize(actor, row.attachment_id)).resolves.toMatchObject({
      status: "ready",
      createdAt: "2026-08-01T00:00:00.000Z",
    });
  });

  it("returns the exact storage download expiry without recomputing it", async () => {
    const readyRow = { ...row, status: "ready" as const };
    const { pool, operations, client } = poolWithOwnedRow(readyRow);
    const storage: ObjectStorage = {
      ...emptyStorage(),
      createDownloadGrant: vi.fn(async () => ({
        downloadUrl: "https://oss.test/private/proof.pdf?signature=signed",
        expiresAt: "2030-01-02T03:04:05.000Z",
      })),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.createDownloadIntent(actor, row.attachment_id)).resolves.toEqual({
      downloadUrl: "https://oss.test/private/proof.pdf?signature=signed",
      expiresAt: "2030-01-02T03:04:05.000Z",
    });
    expect(storage.createDownloadGrant).toHaveBeenCalledOnce();
    expect(operations).toEqual([
      "BEGIN",
      expect.stringContaining("INSERT INTO operation_events"),
      "COMMIT",
    ]);
    expect(client.query.mock.calls[1]?.[1]).toEqual(expect.arrayContaining([
      "attachment.download_grant_issued",
      row.attachment_id,
    ]));
  });

  it("deletes only an expired attachment that is still unbound while holding its row lock", async () => {
    const client = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes("SELECT object_key")) {
          return { rowCount: 1, rows: [{ object_key: row.object_key }] };
        }
        if (sql.startsWith("DELETE FROM attachments")) return { rowCount: 1, rows: [] };
        return { rowCount: 0, rows: [] };
      }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ attachment_id: row.attachment_id }],
      })),
      connect: vi.fn(async () => client),
    };
    const storage = emptyStorage();
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.cleanupExpiredUnbound(new Date("2026-09-01T00:00:00Z")))
      .resolves.toEqual({ candidates: 1, deleted: 1, failed: 0 });
    expect(storage.deleteObject).toHaveBeenCalledWith(row.object_key);
    expect(client.query.mock.calls[1]?.[0]).toContain("entity_type IS NULL");
    expect(client.query.mock.calls[1]?.[0]).toContain("FOR UPDATE");
    expect(client.query.mock.calls[2]?.[0]).toContain("entity_id IS NULL");
    expect(client.release).toHaveBeenCalledOnce();
  });

  it("skips deletion when an attachment became bound before the cleanup row lock", async () => {
    const client = {
      query: vi.fn(async (sql: string) => sql.includes("SELECT object_key")
        ? { rowCount: 0, rows: [] }
        : { rowCount: 0, rows: [] }),
      release: vi.fn(),
    };
    const pool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [{ attachment_id: row.attachment_id }],
      })),
      connect: vi.fn(async () => client),
    };
    const storage = emptyStorage();
    const service = new AttachmentService(pool as never, storage, {
      prefix: "private",
      ttlSeconds: 300,
      maxUploadBytes: 100,
    });

    await expect(service.cleanupExpiredUnbound(new Date("2026-09-01T00:00:00Z")))
      .resolves.toEqual({ candidates: 1, deleted: 0, failed: 0 });
    expect(storage.deleteObject).not.toHaveBeenCalled();
    expect(client.query).not.toHaveBeenCalledWith(
      expect.stringContaining("DELETE FROM attachments"),
      expect.anything(),
    );
  });
});
