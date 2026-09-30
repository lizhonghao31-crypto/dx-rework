import type { Pool, PoolClient } from "pg";
import { SampleAttachmentListSchema } from "@dx-rework/contracts";
import { ApplicationError } from "../platform/errors.js";
import type { TrustedActorContext } from "../tools/repositories.js";
import { isRootActor } from "../access/business-authority.js";
import { canUseSampleCapability, requireSampleCapability } from "./sample-authority.js";

export type SampleAttachmentPurpose = "sample_image" | "purchase_receipt" | "return_photo" | "disposal_proof" | "payment_proof";
export async function bindSampleAttachments(client: PoolClient, actor: TrustedActorContext, sampleId: string,
  ids: readonly string[], purpose: SampleAttachmentPurpose, currentBatchSampleIds: ReadonlySet<string> = new Set()): Promise<void> {
  for (const attachmentId of [...new Set(ids)].sort()) {
    const result = await client.query<{ status: string; uploaded_by: string; entity_type: string | null; entity_id: string | null; mime_type: string }>(
      "SELECT status,uploaded_by,entity_type,entity_id,mime_type FROM attachments WHERE attachment_id=$1 FOR UPDATE", [attachmentId]);
    const file = result.rows[0];
    if (!file || file.status !== "ready" || !file.mime_type.startsWith("image/")) throw new ApplicationError("VALIDATION_ERROR", "附件必须是已上传完成的样衣图片", 400);
    if (file.uploaded_by !== actor.actorId && !isRootActor(actor)) throw new ApplicationError("FORBIDDEN", "不能绑定其他人上传的附件", 403);
    if (file.entity_type && (file.entity_type !== "sample_attachment" || file.entity_id !== attachmentId)) throw new ApplicationError("CONFLICT", "附件已用于其他业务", 409);
    const prior = await client.query<{ purpose: string; sample_id: string }>("SELECT purpose,sample_id FROM sample_attachment_bindings WHERE attachment_id=$1", [attachmentId]);
    if (prior.rows.some(row => (row.purpose === "purchase_receipt") !== (purpose === "purchase_receipt"))) {
      throw new ApplicationError("FORBIDDEN", "采购小票不能转作普通图片", 403);
    }
    if (purpose === "purchase_receipt" && prior.rows.some(row => row.sample_id !== sampleId && !currentBatchSampleIds.has(row.sample_id))) {
      throw new ApplicationError("CONFLICT", "采购小票只能在本次录入的同一批样衣内共用", 409);
    }
    await client.query("UPDATE attachments SET entity_type='sample_attachment',entity_id=attachment_id::text,updated_at=CURRENT_TIMESTAMP WHERE attachment_id=$1", [attachmentId]);
    await client.query(`INSERT INTO sample_attachment_bindings(sample_id,attachment_id,purpose,bound_by) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [sampleId, attachmentId, purpose, actor.actorId]);
  }
}

export class SampleAttachmentService {
  constructor(private readonly database: Pool) {}
  async canDownloadForSample(actor: TrustedActorContext, sampleId: string, attachmentId: string): Promise<boolean> {
    requireSampleCapability(actor, "sample:view_basic");
    const bound = await this.database.query(`SELECT 1 FROM sample_attachment_bindings b JOIN sample_items s USING(sample_id)
      WHERE b.sample_id=$1 AND b.attachment_id=$2 AND (s.status<>'archived' OR $3)`, [sampleId, attachmentId, isRootActor(actor)]);
    return bound.rows.length > 0 && this.canDownload(actor, { entityType: "sample_attachment", entityId: attachmentId });
  }
  async canDownload(actor: TrustedActorContext, binding: { entityType: string; entityId: string }): Promise<boolean> {
    if (binding.entityType !== "sample_attachment" || !canUseSampleCapability(actor, "sample:view_basic")) return false;
    const result = await this.database.query<{ purpose: string; status: string }>(`SELECT b.purpose,s.status FROM sample_attachment_bindings b
      JOIN sample_items s ON s.sample_id=b.sample_id WHERE b.attachment_id::text=$1`, [binding.entityId]);
    if (!result.rows.length) return false;
    // A private receipt remains private even when another sample shares the same object.
    if (result.rows.some(row => row.purpose === "purchase_receipt") && !canUseSampleCapability(actor, "sample:view_finance")) return false;
    return isRootActor(actor) || result.rows.some(row => row.status !== "archived");
  }
  async list(actor: TrustedActorContext, sampleId: string) {
    requireSampleCapability(actor, "sample:view_basic");
    const exists = await this.database.query("SELECT 1 FROM sample_items WHERE sample_id=$1 AND (status<>'archived' OR $2)", [sampleId, isRootActor(actor)]);
    if (!exists.rows.length) throw new ApplicationError("NOT_FOUND", "样衣不存在或已归档", 404);
    const result = await this.database.query(`SELECT a.attachment_id AS "attachmentId",b.purpose,a.original_filename AS filename,a.mime_type AS "mimeType",a.size_bytes::int AS "sizeBytes"
      FROM sample_attachment_bindings b JOIN attachments a ON a.attachment_id=b.attachment_id
      WHERE b.sample_id=$1 AND b.active AND a.status='ready' AND (b.purpose<>'purchase_receipt' OR $2)
      ORDER BY b.bound_at,b.attachment_id`, [sampleId, canUseSampleCapability(actor, "sample:view_finance")]);
    return SampleAttachmentListSchema.parse({ attachments: result.rows });
  }
}
