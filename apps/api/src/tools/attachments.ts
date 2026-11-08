import { isPmcOnly } from "@dx-rework/contracts";
import { createHash, randomUUID } from "node:crypto";
import { readBudgetSourcing } from "../production-platform/budget-sourcing-adapter.js";
import type { Pool, PoolClient } from "pg";

import type {
  AttachmentResponse,
  CreateUploadIntent,
  DownloadIntentResponse,
  UploadIntentResponse,
} from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import { InvalidStoredFileError, validateStoredFileContent } from "./file-content-validation.js";
import {TechnicalPlotUploadSchema} from '@dx-rework/contracts/digital-development-technical';
import {validateOpaquePlotContent} from './plot-file-content.js';
import {DigitalProductionAccessPolicy} from '../production-platform/access-policy.js';
import {technicalEnrollment} from '../production-platform/development-technical-repository.js';
import { createPrivateObjectKey, ObjectStorageObjectNotFoundError, type ObjectStorage } from "./storage.js";
import type { TrustedActorContext } from "./repositories.js";
import { OperationEventRepository } from "./repositories.js";
import {AttachmentImagePreviews,type PreviewSource} from './attachment-image-preview.js';

const MIME_EXTENSIONS: Record<string, readonly string[]> = {
  "image/jpeg": ["jpg", "jpeg"],
  "image/png": ["png"],
  "image/webp": ["webp"],
  "application/pdf": ["pdf"],
};

const MAX_ACTIVE_UNBOUND_ATTACHMENTS_PER_ACTOR = 50;
const MAX_CONCURRENT_FINALIZATIONS_PER_ACTOR = 4;

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
  private readonly activeFinalizationsByActor = new Map<string, number>();
  private readonly imagePreviews:AttachmentImagePreviews;

  constructor(
    private readonly pool: Pool,
    private readonly storage: ObjectStorage,
    private readonly options: { prefix: string; ttlSeconds: number; maxUploadBytes: number },
    private readonly events = new OperationEventRepository(),
  ) {this.imagePreviews=new AttachmentImagePreviews(storage,options.prefix,options.maxUploadBytes);}

  uploadLimits(): { maxUploadBytes: number } { return { maxUploadBytes: this.options.maxUploadBytes }; }

  async copyDigitalBudgetImage(actor: TrustedActorContext, orderId: string, budgetVersion: number, sourceId: string): Promise<AttachmentResponse> {
    if (isPmcOnly(actor.actorRoles)) throw new ApplicationError("FORBIDDEN", "PMC不能上传或确认附件", 403);
    const client = await this.pool.connect();
    let createdKey: string | null = null;
    try {
      await client.query("BEGIN");
      await client.query("SELECT production_order_id FROM digital_production_orders WHERE production_order_id=$1 FOR UPDATE", [orderId]);
      const source = await readBudgetSourcing(client, actor, orderId);
      if (source.budgetVersion !== budgetVersion || !source.document.imageAttachmentIds.includes(sourceId)) throw new ApplicationError("BUDGET_CONFLICT", "预算图片已更新，请重新进入外发发起", 409);
      const prior = (await client.query<AttachmentRow>(`SELECT a.* FROM digital_budget_image_copies c JOIN attachments a USING(attachment_id)
        WHERE c.production_order_id=$1 AND c.budget_version=$2 AND c.source_attachment_id=$3 AND c.actor_id=$4`, [orderId, budgetVersion, sourceId, actor.actorId])).rows[0];
      if (prior) { await client.query("COMMIT"); return this.dto(prior); }
      const original = (await client.query<AttachmentRow>(`SELECT a.* FROM attachments a JOIN digital_budget_attachment_bindings b USING(attachment_id)
        WHERE a.attachment_id=$1 AND b.production_order_id=$2::uuid AND a.entity_type='digital_budget' AND a.entity_id=$2::text
        AND a.status='ready' AND a.mime_type IN ('image/jpeg','image/png','image/webp')`, [sourceId, orderId])).rows[0];
      if (!original) throw new ApplicationError("ATTACHMENT_NOT_READY", "预算图片不可用", 409);
      const { bytes, sha256 } = await this.readVerifiedSourcingImage(original);
      const attachmentId = randomUUID();
      createdKey = createPrivateObjectKey(this.options.prefix, original.original_filename);
      await this.storageCall(() => this.storage.writeImmutable(createdKey!, bytes, { mimeType: original.mime_type, sha256 }));
      const copied = (await client.query<AttachmentRow>(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,'ready',CURRENT_TIMESTAMP) RETURNING *`, [attachmentId, createdKey, original.original_filename, original.mime_type, bytes.byteLength, sha256, actor.actorId])).rows[0]!;
      await client.query("INSERT INTO digital_budget_image_copies(production_order_id,budget_version,source_attachment_id,actor_id,attachment_id) VALUES($1,$2,$3,$4,$5)", [orderId, budgetVersion, sourceId, actor.actorId, attachmentId]);
      await this.events.append(client, actor, { action: "attachment.budget_sourcing_copy", entityType: "attachment", entityId: attachmentId, after: { sourceAttachmentId: sourceId, productionOrderId: orderId, budgetVersion } });
      await client.query("COMMIT"); return this.dto(copied);
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      if (createdKey) await this.storage.deleteObject(createdKey).catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  // Internal contract rendering only: callers supply the already-frozen case and image IDs.
  // Read private storage directly; never accept a URL or issue a public download grant.
  async readSourcingContractImage(sourcingCaseId: string, attachmentId: string): Promise<{ bytes: Buffer; sha256: string }> {
    const row = (await this.pool.query<AttachmentRow>(`SELECT * FROM attachments
      WHERE attachment_id=$1 AND entity_type='sourcing_case' AND entity_id=$2 AND status='ready'
        AND mime_type IN ('image/jpeg','image/png','image/webp')`,[attachmentId,sourcingCaseId])).rows[0];
    if (!row) throw new ApplicationError("ATTACHMENT_NOT_READY","合同款图不存在或不属于本订单",409);
    return this.readVerifiedSourcingImage(row);
  }

  async readContractContentImage(sourcingCaseId: string, attachmentId: string): Promise<{bytes:Buffer;sha256:string}> {
    const row = (await this.pool.query<AttachmentRow>(`SELECT a.* FROM attachments a
      WHERE a.attachment_id=$1 AND a.status='ready' AND a.mime_type IN ('image/jpeg','image/png','image/webp')
        AND (a.entity_type='sourcing_case' AND a.entity_id=$2 OR a.entity_type='sourcing_contract_document' AND EXISTS(
          SELECT 1 FROM sourcing_contract_documents d WHERE d.sourcing_contract_document_id::text=a.entity_id AND d.sourcing_case_id=$2::uuid))`,[attachmentId,sourcingCaseId])).rows[0];
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
    if (isPmcOnly(actor.actorRoles)) throw new ApplicationError("FORBIDDEN", "PMC不能上传或确认附件", 403);
    this.validate(input);
    return this.createUploadIntentCore(actor,input);
  }
  /** Scoped PLT entry only. Generic /tools upload schema and MIME allowlist remain unchanged. */
  async createTechnicalPlotUploadIntent(actor:TrustedActorContext,sourceId:string,taskId:string,raw:unknown):Promise<UploadIntentResponse>{
    if (isPmcOnly(actor.actorRoles)) throw new ApplicationError("FORBIDDEN", "PMC不能上传或确认附件", 403);
    const parsed=TechnicalPlotUploadSchema.safeParse(raw);
    if(!parsed.success)throw new ApplicationError('VALIDATION_ERROR','请上传有效.plt原件并保留文件校验信息',400);
    await this.assertTechnicalPlotTask(actor,sourceId,taskId);
    this.validate(parsed.data,true);
    return this.createUploadIntentCore(actor,parsed.data,true);
  }
  private async assertTechnicalPlotTask(actor:TrustedActorContext,sourceId:string,taskId:string){
    await new DigitalProductionAccessPolicy(this.pool).assert(actor,'task',taskId,'execute');
    const task=(await this.pool.query(`SELECT t.state,a.task_kind FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
      WHERE t.task_id=$1 AND a.source_id=$2`,[taskId,sourceId])).rows[0];
    if(!task||task.state!=='ready'||!['development_pattern','development_size_review'].includes(task.task_kind)||!await technicalEnrollment(this.pool,sourceId))throw new ApplicationError('FORBIDDEN','当前任务不具备PLT原件上传权限',403);
  }
  private async createUploadIntentCore(actor:TrustedActorContext,input:Omit<CreateUploadIntent,'mimeType'>&{mimeType:string},plot=false):Promise<UploadIntentResponse>{
    const attachmentId = randomUUID();
    const objectKey = createPrivateObjectKey(this.options.prefix, input.filename,undefined,plot?{technicalPlot:true}:{});
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
        "SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
        [`attachment-upload:${actor.actorId}`],
      );
      const active = await client.query<{ active_count: number }>(
        `SELECT count(*)::int active_count
         FROM attachments
         WHERE uploaded_by=$1
           AND entity_type IS NULL
           AND entity_id IS NULL
           AND status IN ('pending','ready')`,
        [actor.actorId],
      );
      if ((active.rows[0]?.active_count ?? 0) >= MAX_ACTIVE_UNBOUND_ATTACHMENTS_PER_ACTOR) {
        throw new ApplicationError(
          "RATE_LIMITED",
          "待处理附件过多，请先完成当前上传后再试",
          429,
        );
      }
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
    if (isPmcOnly(actor.actorRoles)) throw new ApplicationError("FORBIDDEN", "PMC不能上传或确认附件", 403);
    const row = await this.owned(attachmentId, actor.actorId);
    if (row.status === "ready") return this.dto(row);
    if (row.status !== "pending") {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Attachment is not pending", 409);
    }

    const active = this.activeFinalizationsByActor.get(actor.actorId) ?? 0;
    if (active >= MAX_CONCURRENT_FINALIZATIONS_PER_ACTOR) {
      throw new ApplicationError(
        "RATE_LIMITED",
        "附件校验请求过多，请稍后重试",
        429,
      );
    }
    this.activeFinalizationsByActor.set(actor.actorId, active + 1);
    try {
      const result=await this.finalizePending(actor, row, attachmentId);
      // The ready transaction and connection have already completed. A failed
      // derivative must never undo or misreport a successful original upload.
      await this.prepareImagePreview(row).catch(()=>null);
      return result;
    } finally {
      const remaining = (this.activeFinalizationsByActor.get(actor.actorId) ?? 1) - 1;
      if (remaining <= 0) this.activeFinalizationsByActor.delete(actor.actorId);
      else this.activeFinalizationsByActor.set(actor.actorId, remaining);
    }
  }

  private async finalizePending(
    actor: TrustedActorContext,
    row: AttachmentRow,
    attachmentId: string,
  ): Promise<AttachmentResponse> {
    if(row.mime_type==='application/octet-stream'){
      const purpose=(await this.pool.query("SELECT source_id,task_id FROM digital_development_upload_purposes WHERE attachment_id=$1 AND purpose='纸样成果' AND task_id IS NOT NULL AND uploaded_by=$2",[attachmentId,actor.actorId])).rows[0];
      if(!purpose)throw new ApplicationError('FORBIDDEN','PLT原件没有本任务上传用途',403);
      await this.assertTechnicalPlotTask(actor,purpose.source_id,purpose.task_id);
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
      if(row.mime_type==='application/octet-stream')validateOpaquePlotContent(content);
      else await validateStoredFileContent(content, row.mime_type);
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

  /** Read-only identity, behind the same ownership/binding check as downloading. */
  async readIdentity(
    actor: TrustedActorContext,
    attachmentId: string,
    authorizeBound?: (row: Readonly<{ attachmentId: string; entityType: string; entityId: string; uploadedBy: string; mimeType: string }>) => Promise<boolean>,
  ): Promise<Pick<AttachmentResponse,"attachmentId"|"filename"|"mimeType"|"sizeBytes">> {
    const row=await this.ownedOrBound(attachmentId,actor.actorId,authorizeBound);
    if(row.status!=="ready")throw new ApplicationError("ATTACHMENT_NOT_READY","Attachment is not ready",409);
    return {attachmentId:row.attachment_id,filename:row.original_filename,mimeType:row.mime_type,sizeBytes:Number(row.size_bytes)};
  }

  async createDownloadIntent(
    actor: TrustedActorContext,
    attachmentId: string,
    authorizeBound?: (row: Readonly<{ attachmentId: string; entityType: string; entityId: string; uploadedBy: string; mimeType: string }>) => Promise<boolean>,
    disposition: "attachment" | "inline" = "attachment",
    variant?: "thumbnail",
  ): Promise<DownloadIntentResponse> {
    const row = await this.ownedOrBound(attachmentId, actor.actorId, authorizeBound);
    if (row.status !== "ready") throw new ApplicationError("ATTACHMENT_NOT_READY", "Attachment is not ready", 409);
    if (variant === "thumbnail" && !row.mime_type.startsWith("image/")) throw new ApplicationError("VALIDATION_ERROR", "该文件不是图片", 400);
    return this.issueDownloadGrant(actor,row,row.object_key,disposition,variant);
  }

  async createImagePreviewDownloadIntent(
    readActor:()=>Promise<TrustedActorContext>,
    attachmentId:string,
    authorizeBound:(actor:TrustedActorContext,row:Readonly<{attachmentId:string;entityType:string;entityId:string;uploadedBy:string;mimeType:string}>)=>Promise<boolean>,
  ):Promise<DownloadIntentResponse>{
    const actor=await readActor(),row=await this.ownedOrBound(attachmentId,actor.actorId,bound=>authorizeBound(actor,bound));
    if(row.status!=='ready')throw new ApplicationError('ATTACHMENT_NOT_READY','Attachment is not ready',409);
    if(!row.mime_type.startsWith('image/'))throw new ApplicationError('VALIDATION_ERROR','该文件不是图片',400);
    const preview=await this.prepareImagePreview(row);
    // A generation can take longer than a normal grant. Re-read the original
    // session, scope and binding rather than caching any authorization result.
    const latest=await readActor(),current=await this.ownedOrBound(attachmentId,latest.actorId,bound=>authorizeBound(latest,bound));
    if(current.status!=='ready')throw new ApplicationError('ATTACHMENT_NOT_READY','Attachment is not ready',409);
    const same=current.sha256===row.sha256&&current.object_key===row.object_key;
    return this.issueDownloadGrant(latest,current,same&&preview?preview:current.object_key,'inline',undefined,Boolean(same&&preview));
  }

  private prepareImagePreview(row:AttachmentRow){
    const source:PreviewSource={attachmentId:row.attachment_id,objectKey:row.object_key,mimeType:row.mime_type,sizeBytes:Number(row.size_bytes),sha256:row.sha256};
    return this.imagePreviews.prepare(source,async()=>Boolean((await this.pool.query(`SELECT 1 FROM attachments WHERE attachment_id=$1 AND status='ready' AND object_key=$2 AND sha256=$3`,[source.attachmentId,source.objectKey,source.sha256])).rowCount));
  }

  private async issueDownloadGrant(actor:TrustedActorContext,row:AttachmentRow,objectKey:string,disposition:'attachment'|'inline',variant?:'thumbnail',preview=false):Promise<DownloadIntentResponse>{
    const attachmentId=row.attachment_id;
    const grant = await this.storageCall(() => this.storage.createDownloadGrant(objectKey, {
      ttlSeconds: this.options.ttlSeconds,
      filename:preview?'preview.webp':row.original_filename,
      disposition:row.mime_type==='application/octet-stream'?'attachment':disposition,
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
      const locked = await client.query<Pick<AttachmentRow, "object_key"|"sha256">>(
        `SELECT object_key,sha256
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
      if(result.rowCount===1&&row.sha256){
        try{await this.storage.deleteObject(this.imagePreviews.key({attachmentId,sha256:row.sha256}));}
        catch{/* The original deletion already committed; a derived-cache failure cannot undo it. */}
      }
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

  private validate(input: Omit<CreateUploadIntent,'mimeType'>&{mimeType:string},plot=false): void {
    if (input.sizeBytes > this.options.maxUploadBytes) {
      throw new ApplicationError("VALIDATION_ERROR", "File exceeds the configured size limit", 413);
    }
    const extension = input.filename.toLowerCase().split(".").at(-1) ?? "";
    if (!(plot&&input.mimeType==='application/octet-stream'&&extension==='plt')&&!MIME_EXTENSIONS[input.mimeType]?.includes(extension)) {
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
    authorizeBound?: (row: { attachmentId: string; entityType: string; entityId: string; uploadedBy: string; mimeType: string }) => Promise<boolean>,
  ): Promise<AttachmentRow> {
    const result = await this.pool.query<AttachmentRow>(`SELECT * FROM attachments WHERE attachment_id=$1`, [id]);
    const row = result.rows[0];
    if (!row) throw new ApplicationError("NOT_FOUND", "Attachment not found", 404);
    if (row.entity_type && row.entity_id) {
      if (!authorizeBound || !(await authorizeBound({ attachmentId: row.attachment_id, entityType: row.entity_type, entityId: row.entity_id, uploadedBy: row.uploaded_by, mimeType: row.mime_type }))) {
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
