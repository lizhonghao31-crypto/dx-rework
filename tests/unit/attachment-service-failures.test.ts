import { describe, expect, it, vi } from "vitest";
import { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import { DisabledObjectStorage, ObjectStorageObjectNotFoundError, type ObjectStorage } from "../../apps/api/src/tools/storage.js";

const actor = { actorId: "00000000-0000-4000-8000-000000000099", actorRole: "tools:user", requestId: "request-1" };
const input = { filename: "proof.pdf", mimeType: "application/pdf" as const, sizeBytes: 12, sha256: "a".repeat(64) };
const row = {
  attachment_id: "00000000-0000-4000-8000-000000000001",
  object_key: "private/proof.pdf",
  original_filename: "proof.pdf",
  mime_type: "application/pdf",
  size_bytes: "12",
  sha256: "a".repeat(64),
  uploaded_by: actor.actorId,
  entity_type: null,
  entity_id: null,
  status: "pending" as const,
  created_at: new Date("2026-08-01T00:00:00Z"),
};

function poolWithOwnedRow() {
  const operations: string[] = [];
  const client = {
    query: vi.fn(async (sql: string) => {
      operations.push(sql);
      if (sql.startsWith("UPDATE attachments")) return { rowCount: 1, rows: [] };
      return { rowCount: 1, rows: [] };
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async () => ({ rowCount: 1, rows: [row] })),
    connect: vi.fn(async () => client),
  };
  return { pool, client, operations };
}

describe("AttachmentService failure consistency", () => {
  it("does not write a pending attachment when upload signing fails", async () => {
    const pool = { connect: vi.fn(), query: vi.fn() };
    const storage: ObjectStorage = {
      createNonOverwritableUploadUrl: vi.fn(async () => { throw new Error("temporary OSS failure"); }),
      createDownloadUrl: vi.fn(),
      head: vi.fn(),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.createUploadIntent(actor, input)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    expect(pool.connect).not.toHaveBeenCalled();
    expect(pool.query).not.toHaveBeenCalled();
  });

  it("preserves an explicit storage-unavailable 503 during finalize without changing state", async () => {
    const { pool } = poolWithOwnedRow();
    const service = new AttachmentService(pool as never, new DisabledObjectStorage(), { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("maps a temporary HEAD failure to 503 without rejecting the attachment", async () => {
    const { pool } = poolWithOwnedRow();
    const storage: ObjectStorage = {
      createNonOverwritableUploadUrl: vi.fn(),
      createDownloadUrl: vi.fn(),
      head: vi.fn(async () => { throw new Error("timeout from upstream"); }),
    };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({ code: "STORAGE_UNAVAILABLE", statusCode: 503 });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["missing object", async () => { throw new ObjectStorageObjectNotFoundError(); }, "object_not_found"],
    ["metadata mismatch", async () => ({ sizeBytes: 99, mimeType: "application/pdf", sha256: "a".repeat(64) }), "metadata_mismatch"],
  ])("rejects and audits %s in one transaction", async (_name, head, reason) => {
    const { pool, client, operations } = poolWithOwnedRow();
    const storage: ObjectStorage = { createNonOverwritableUploadUrl: vi.fn(), createDownloadUrl: vi.fn(), head };
    const service = new AttachmentService(pool as never, storage, { prefix: "private", ttlSeconds: 300, maxUploadBytes: 100 });

    await expect(service.finalize(actor, row.attachment_id)).rejects.toMatchObject({ code: "ATTACHMENT_METADATA_MISMATCH", statusCode: 422 });
    expect(operations).toHaveLength(4);
    expect(operations[0]).toBe("BEGIN");
    expect(operations[1]).toContain("UPDATE attachments SET status='rejected'");
    expect(operations[2]).toContain("INSERT INTO operation_events");
    expect(operations[3]).toBe("COMMIT");
    expect(client.query.mock.calls[1]?.[1]).toEqual([row.attachment_id, reason]);
    expect(client.query.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(["attachment.rejected", reason]));
    expect(client.release).toHaveBeenCalledOnce();
  });
});
