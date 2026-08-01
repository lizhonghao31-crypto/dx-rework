import { randomUUID } from "node:crypto";
import type { Pool } from "pg";

import type {
  AttachmentResponse,
  CreateUploadIntent,
  DownloadIntentResponse,
  UploadIntentResponse,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { createPrivateObjectKey, ObjectStorageObjectNotFoundError, type ObjectStorage } from "./storage.js";
import type { TrustedActorContext } from "./repositories.js";
import { OperationEventRepository } from "./repositories.js";

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
};

type AttachmentRow = {
  attachment_id: string;
  object_key: string;
  original_filename: string;
  mime_type: string;
  size_bytes: string;
  sha256: string;
  uploaded_by: string;
  entity_type: string | null;
  entity_id: string | null;
  status: "pending" | "ready" | "rejected";
  created_at: Date;
};

export class AttachmentService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: ObjectStorage,
    private readonly options: { prefix: string; ttlSeconds: number; maxUploadBytes: number },
    private readonly events = new OperationEventRepository(),
  ) {}

  async createUploadIntent(actor: TrustedActorContext, input: CreateUploadIntent): Promise<UploadIntentResponse> {
    this.validate(input);
    const attachmentId = randomUUID();
    const objectKey = createPrivateObjectKey(this.options.prefix, input.filename);
    const uploadUrl = await this.storageCall(() => this.storage.createUploadUrl(objectKey, {
      mimeType: input.mimeType,
      sizeBytes: input.sizeBytes,
      sha256: input.sha256,
      ttlSeconds: this.options.ttlSeconds,
    }));

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by) VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [attachmentId, objectKey, input.filename, input.mimeType, input.sizeBytes, input.sha256, actor.actorId],
      );
      await this.events.append(client, actor, {
        action: "attachment.upload_requested",
        entityType: "attachment",
        entityId: attachmentId,
        after: { objectKey, mimeType: input.mimeType, sizeBytes: input.sizeBytes },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    return {
      attachmentId,
      objectKey,
      uploadUrl,
      expiresAt: new Date(Date.now() + this.options.ttlSeconds * 1000).toISOString(),
    };
  }

  async finalize(actor: TrustedActorContext, attachmentId: string): Promise<AttachmentResponse> {
    const row = await this.owned(attachmentId, actor.actorId);
    if (row.status !== "pending") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Attachment is not pending", 409);
    }

    let metadata;
    try {
      metadata = await this.storage.head(row.object_key);
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      if (error instanceof ObjectStorageObjectNotFoundError) {
        await this.rejectMetadata(actor, row, "object_not_found");
        throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH", "Uploaded object does not exist", 422);
      }
      throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage is temporarily unavailable", 503);
    }

    if (
      metadata.sizeBytes !== Number(row.size_bytes)
      || metadata.mimeType.toLowerCase() !== row.mime_type
      || (metadata.sha256 !== undefined && metadata.sha256 !== row.sha256)
    ) {
      await this.rejectMetadata(actor, row, "metadata_mismatch");
      throw new ApplicationError(
        "ATTACHMENT_METADATA_MISMATCH",
        "Uploaded object metadata does not match the upload intent",
        422,
      );
    }

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query<AttachmentRow>(
        `UPDATE attachments SET status='ready',ready_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1 AND status='pending' RETURNING *`,
        [attachmentId],
      );
      if (updated.rowCount !== 1) throw new ApplicationError("CONFLICT", "Attachment changed concurrently", 409);
      await this.events.append(client, actor, {
        action: "attachment.ready",
        entityType: "attachment",
        entityId: attachmentId,
        before: { status: "pending" },
        after: { status: "ready" },
      });
      await client.query("COMMIT");
      return this.dto(updated.rows[0]!);
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async createDownloadIntent(
    actorId: string,
    attachmentId: string,
    authorizeBound?: (row: Readonly<{ entityType: string; entityId: string; uploadedBy: string }>) => Promise<boolean>,
  ): Promise<DownloadIntentResponse> {
    const row = await this.ownedOrBound(attachmentId, actorId, authorizeBound);
    if (row.status !== "ready") throw new ApplicationError("ATTACHMENT_NOT_READY", "Attachment is not ready", 409);
    const downloadUrl = await this.storageCall(() => this.storage.createDownloadUrl(row.object_key, {
      ttlSeconds: this.options.ttlSeconds,
      filename: row.original_filename,
    }));
    return { downloadUrl, expiresAt: new Date(Date.now() + this.options.ttlSeconds * 1000).toISOString() };
  }

  private async rejectMetadata(actor: TrustedActorContext, row: AttachmentRow, reason: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const updated = await client.query(
        `UPDATE attachments SET status='rejected',rejection_reason=$2,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1 AND status='pending'`,
        [row.attachment_id, reason],
      );
      if (updated.rowCount !== 1) throw new ApplicationError("CONFLICT", "Attachment changed concurrently", 409);
      await this.events.append(client, actor, {
        action: "attachment.rejected",
        entityType: "attachment",
        entityId: row.attachment_id,
        before: { status: "pending" },
        after: { status: "rejected", reason },
        reason,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async storageCall<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ApplicationError) throw error;
      throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage is temporarily unavailable", 503);
    }
  }

  private validate(input: CreateUploadIntent): void {
    if (input.sizeBytes > this.options.maxUploadBytes) {
      throw new ApplicationError("VALIDATION_ERROR", "File exceeds the configured size limit", 413);
    }
    const extension = input.filename.toLowerCase().split(".").at(-1) ?? "";
    if (!MIME_EXTENSIONS[input.mimeType]?.includes(extension)) {
      throw new ApplicationError("VALIDATION_ERROR", "Filename extension does not match MIME type", 400);
    }
    if (input.filename.includes("/") || input.filename.includes("\\") || input.filename.includes("..")) {
      throw new ApplicationError("VALIDATION_ERROR", "Unsafe filename", 400);
    }
  }

  private async owned(id: string, userId: string): Promise<AttachmentRow> {
    const result = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments WHERE attachment_id=$1 AND uploaded_by=$2`,
      [id, userId],
    );
    if (!result.rows[0]) throw new ApplicationError("FORBIDDEN", "Attachment access denied", 403);
    return result.rows[0];
  }

  private async ownedOrBound(
    id: string,
    userId: string,
    authorizeBound?: (row: { entityType: string; entityId: string; uploadedBy: string }) => Promise<boolean>,
  ): Promise<AttachmentRow> {
    const result = await this.pool.query<AttachmentRow>(`SELECT * FROM attachments WHERE attachment_id=$1`, [id]);
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "Attachment not found", 404);
    if (row.uploaded_by !== userId) {
      if (
        !row.entity_type
        || !row.entity_id
        || !authorizeBound
        || !(await authorizeBound({ entityType: row.entity_type, entityId: row.entity_id, uploadedBy: row.uploaded_by }))
      ) {
        throw new ApplicationError("FORBIDDEN", "Attachment access denied", 403);
      }
    }
    return row;
  }

  private dto(row: AttachmentRow): AttachmentResponse {
    return {
      attachmentId: row.attachment_id,
      filename: row.original_filename,
      mimeType: row.mime_type,
      sizeBytes: Number(row.size_bytes),
      sha256: row.sha256,
      status: row.status,
      createdAt: row.created_at.toISOString(),
    };
  }
}
