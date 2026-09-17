import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import type {
  AttachmentResponse,
  CreateUploadIntent,
  DownloadIntentResponse,
  UploadIntentResponse,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { InvalidStoredFileError, validateStoredFileContent } from "./file-content-validation.js";
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
  created_at: Date | string;
};

export type AttachmentCleanupResult = Readonly<{
  candidates: number;
  deleted: number;
  failed: number;
}>;

export class AttachmentService {
  constructor(
    private readonly pool: Pool,
    private readonly storage: ObjectStorage,
    private readonly options: { prefix: string; ttlSeconds: number; maxUploadBytes: number },
    private readonly events = new OperationEventRepository(),
  ) {}

  uploadLimits(): { maxUploadBytes: number } { return { maxUploadBytes: this.options.maxUploadBytes }; }

  // Internal contract rendering only: callers supply the already-frozen case and image IDs.
  // Read private storage directly; never accept a URL or issue a public download grant.
  async readSourcingContractImage(sourcingCaseId: string, attachmentId: string): Promise<{ bytes: Buffer; sha256: string }> {
    const row = (await this.pool.query<AttachmentRow>(`SELECT * FROM attachments
      WHERE attachment_id=$1 AND entity_type='sourcing_case' AND entity_id=$2 AND status='ready'
        AND mime_type IN ('image/jpeg','image/png','image/webp')`,[attachmentId,sourcingCaseId])).rows[0];
    if (!row) throw new ApplicationError("ATTACHMENT_NOT_READY","合同款图不存在或不属于本订单",409);
    return this.readVerifiedSourcingImage(row);
  }

  async readUnboundSourcingImage(client: Pick<PoolClient, "query">, actorId: string, attachmentId: string): Promise<{ bytes: Buffer; sha256: string; filename: string }> {
    const row = (await client.query<AttachmentRow>(`SELECT * FROM attachments
      WHERE attachment_id=$1 AND uploaded_by=$2 AND status='ready'
        AND entity_type IS NULL AND entity_id IS NULL
        AND mime_type IN ('image/jpeg','image/png','image/webp')`,[attachmentId,actorId])).rows[0];
    if (!row) throw new ApplicationError("ATTACHMENT_NOT_READY","款图必须已上传完成、属于当前账号且尚未绑定",400);
    return {...await this.readVerifiedSourcingImage(row),filename:row.original_filename};
  }

  private async readVerifiedSourcingImage(row: AttachmentRow): Promise<{ bytes: Buffer; sha256: string }> {
    const bytes = Buffer.from(await this.storageCall(() => this.storage.readBytes(row.object_key,this.options.maxUploadBytes)));
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (bytes.byteLength !== Number(row.size_bytes) || sha256 !== row.sha256) {
      throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH","合同款图校验失败",422);
    }
    return {bytes,sha256};
  }

  async createUploadIntent(actor: TrustedActorContext, input: CreateUploadIntent): Promise<UploadIntentResponse> {
    this.validate(input);
    const attachmentId = randomUUID();
    const objectKey = createPrivateObjectKey(this.options.prefix, input.filename);
    const uploadGrant = await this.storageCall(() => this.storage.createExactSizeNonOverwritableUploadGrant(objectKey, {
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
      uploadMethod: uploadGrant.method,
      uploadUrl: uploadGrant.uploadUrl,
      uploadFields: uploadGrant.fields,
      expiresAt: uploadGrant.expiresAt,
    };
  }

  async finalize(actor: TrustedActorContext, attachmentId: string): Promise<AttachmentResponse> {
    const row = await this.owned(attachmentId, actor.actorId);
    if (row.status === "ready") return this.dto(row);
    if (row.status !== "pending") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Attachment is not pending", 409);
    }

    const metadata = await this.verificationCall(actor, row, () => this.storage.head(row.object_key));

    if (
      metadata.sizeBytes !== Number(row.size_bytes)
      || metadata.mimeType.toLowerCase() !== row.mime_type
      || metadata.sha256 !== row.sha256
    ) {
      await this.rejectVerification(actor, row, "metadata_mismatch", "Uploaded object metadata does not match the upload intent");
    }

    const content = await this.verificationCall(
      actor,
      row,
      () => this.storage.readBytes(row.object_key, this.options.maxUploadBytes),
    );
    if (content.byteLength !== Number(row.size_bytes)) {
      await this.rejectVerification(actor, row, "content_size_mismatch", "Uploaded object size does not match the upload intent");
    }
    const actualSha256 = createHash("sha256").update(content).digest("hex");
    if (actualSha256 !== row.sha256) {
      await this.rejectVerification(actor, row, "content_sha256_mismatch", "Uploaded object digest does not match the upload intent");
    }
    try {
      await validateStoredFileContent(content, row.mime_type);
    } catch (error) {
      if (error instanceof InvalidStoredFileError) {
        await this.rejectVerification(actor, row, "content_invalid", "Uploaded object is not a valid file of the declared type");
      }
      throw error;
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

  async storeGenerated(
    actor: TrustedActorContext,
    input: Readonly<{
      filename: string;
      mimeType: "application/pdf";
      content: Uint8Array;
      entityType: string;
      entityId: string;
    }>,
  ): Promise<AttachmentResponse> {
    const sha256 = createHash("sha256").update(input.content).digest("hex");
    const existing = await this.pool.query<AttachmentRow>(
      `SELECT * FROM attachments
       WHERE entity_type=$1 AND entity_id=$2 AND mime_type=$3
         AND sha256=$4 AND status='ready'
       ORDER BY created_at DESC LIMIT 1`,
      [input.entityType,input.entityId,input.mimeType,sha256],
    );
    if (existing.rows[0]) return this.dto(existing.rows[0]);
    if (input.content.byteLength < 1 || input.content.byteLength > this.options.maxUploadBytes) {
      throw new ApplicationError("VALIDATION_ERROR", "Generated file exceeds the configured size limit", 413);
    }
    this.validate({ filename: input.filename, mimeType: input.mimeType,
      sizeBytes: input.content.byteLength, sha256 });
    const attachmentId = randomUUID();
    const objectKey = createPrivateObjectKey(this.options.prefix, input.filename);
    await this.storageCall(() => this.storage.writeImmutable(objectKey, input.content, {
      mimeType: input.mimeType,sha256,
    }));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const inserted = await client.query<AttachmentRow>(
        `INSERT INTO attachments(
           attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,
           uploaded_by,entity_type,entity_id,status,ready_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'ready',CURRENT_TIMESTAMP)
         ON CONFLICT DO NOTHING
         RETURNING *`,
        [attachmentId,objectKey,input.filename,input.mimeType,input.content.byteLength,
          sha256,actor.actorId,input.entityType,input.entityId],
      );
      const stored = inserted.rows[0];
      if (!stored) {
        await client.query("ROLLBACK");
        await this.storage.deleteObject(objectKey).catch(() => undefined);
        const concurrent = await this.pool.query<AttachmentRow>(
          `SELECT * FROM attachments
           WHERE entity_type=$1 AND entity_id=$2 AND mime_type=$3
             AND sha256=$4 AND status='ready'
           ORDER BY created_at DESC LIMIT 1`,
          [input.entityType,input.entityId,input.mimeType,sha256],
        );
        if (concurrent.rows[0]) return this.dto(concurrent.rows[0]);
        throw new ApplicationError("CONFLICT", "Generated attachment changed concurrently", 409);
      }
      await this.events.append(client, actor, {
        action: "attachment.generated",
        entityType: "attachment",
        entityId: attachmentId,
        after: { boundEntityType: input.entityType, boundEntityId: input.entityId,
          mimeType: input.mimeType, sizeBytes: input.content.byteLength, sha256 },
      });
      await client.query("COMMIT");
      return this.dto(stored);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      await this.storage.deleteObject(objectKey).catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async createDownloadIntent(
    actor: TrustedActorContext,
    attachmentId: string,
    authorizeBound?: (row: Readonly<{ entityType: string; entityId: string; uploadedBy: string; mimeType: string }>) => Promise<boolean>,
    disposition: "attachment" | "inline" = "attachment",
    variant?: "thumbnail",
  ): Promise<DownloadIntentResponse> {
    const row = await this.ownedOrBound(attachmentId, actor.actorId, authorizeBound);
    if (row.status !== "ready") throw new ApplicationError("ATTACHMENT_NOT_READY", "Attachment is not ready", 409);
    if (variant === "thumbnail" && !row.mime_type.startsWith("image/")) throw new ApplicationError("VALIDATION_ERROR", "该文件不是图片", 400);
    const grant = await this.storageCall(() => this.storage.createDownloadGrant(row.object_key, {
      ttlSeconds: this.options.ttlSeconds,
      filename: row.original_filename,
      disposition,
      ...(variant ? { variant } : {}),
    }));
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await this.events.append(client, actor, {
        action: "attachment.download_grant_issued",
        entityType: "attachment",
        entityId: attachmentId,
        after: {
          boundEntityType: row.entity_type,
          boundEntityId: row.entity_id,
          expiresAt: grant.expiresAt,
        },
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return grant;
  }

  async cleanupExpiredUnbound(
    now = new Date(),
    requestedLimit = 50,
  ): Promise<AttachmentCleanupResult> {
    const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit)));
    const shortCutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const readyCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const candidates = await this.pool.query<Pick<AttachmentRow, "attachment_id">>(
      `SELECT attachment_id
       FROM attachments
       WHERE entity_type IS NULL
         AND entity_id IS NULL
         AND (
           (status IN ('pending','rejected') AND created_at<$1)
           OR (status='ready' AND created_at<$2)
         )
       ORDER BY created_at,attachment_id
       LIMIT $3`,
      [shortCutoff, readyCutoff, limit],
    );

    let deleted = 0;
    let failed = 0;
    for (const candidate of candidates.rows) {
      try {
        if (await this.cleanupOne(candidate.attachment_id, shortCutoff, readyCutoff)) deleted += 1;
      } catch {
        failed += 1;
      }
    }
    return { candidates: candidates.rows.length, deleted, failed };
  }

  private async cleanupOne(
    attachmentId: string,
    shortCutoff: Date,
    readyCutoff: Date,
  ): Promise<boolean> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const locked = await client.query<Pick<AttachmentRow, "object_key">>(
        `SELECT object_key
         FROM attachments
         WHERE attachment_id=$1
           AND entity_type IS NULL
           AND entity_id IS NULL
           AND (
             (status IN ('pending','rejected') AND created_at<$2)
             OR (status='ready' AND created_at<$3)
           )
         FOR UPDATE`,
        [attachmentId, shortCutoff, readyCutoff],
      );
      const row = locked.rows[0];
      if (!row) {
        await client.query("COMMIT");
        return false;
      }
      await this.storage.deleteObject(row.object_key);
      const result = await client.query(
        `DELETE FROM attachments
         WHERE attachment_id=$1 AND entity_type IS NULL AND entity_id IS NULL`,
        [attachmentId],
      );
      await client.query("COMMIT");
      return result.rowCount === 1;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  private async verificationCall<T>(
    actor: TrustedActorContext,
    row: AttachmentRow,
    operation: () => Promise<T>,
  ): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      return this.handleVerificationFailure(actor, row, error);
    }
  }

  private async handleVerificationFailure(actor: TrustedActorContext, row: AttachmentRow, error: unknown): Promise<never> {
    if (error instanceof ApplicationError) {
      if (error.code === "ATTACHMENT_METADATA_MISMATCH") {
        await this.rejectVerification(actor, row, "content_size_mismatch", error.message);
      }
      throw error;
    }
    if (error instanceof ObjectStorageObjectNotFoundError) {
      await this.rejectVerification(actor, row, "object_not_found", "Uploaded object does not exist");
    }
    throw new ApplicationError("STORAGE_UNAVAILABLE", "Object storage is temporarily unavailable", 503);
  }

  private async rejectVerification(actor: TrustedActorContext, row: AttachmentRow, reason: string, message: string): Promise<never> {
    await this.rejectMetadata(actor, row, reason);
    throw new ApplicationError("ATTACHMENT_METADATA_MISMATCH", message, 422);
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
    authorizeBound?: (row: { entityType: string; entityId: string; uploadedBy: string; mimeType: string }) => Promise<boolean>,
  ): Promise<AttachmentRow> {
    const result = await this.pool.query<AttachmentRow>(`SELECT * FROM attachments WHERE attachment_id=$1`, [id]);
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "Attachment not found", 404);
    if (row.entity_type && row.entity_id) {
      if (!authorizeBound || !(await authorizeBound({ entityType: row.entity_type, entityId: row.entity_id, uploadedBy: row.uploaded_by, mimeType: row.mime_type }))) {
        throw new ApplicationError("FORBIDDEN", "Attachment access denied", 403);
      }
    } else if (row.uploaded_by !== userId) {
      throw new ApplicationError("FORBIDDEN", "Attachment access denied", 403);
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
      createdAt: row.created_at instanceof Date
        ? row.created_at.toISOString()
        : new Date(row.created_at).toISOString(),
    };
  }
}
