import type { AdminAttachment, AdminAttachmentsPage, AdminAttachmentsQuery, AdminDelegation, AdminDelegationsPage, AdminDelegationsQuery, AdminException, AdminExceptionRetryBody, AdminExceptionRetryResponse, AdminExceptionsPage, AdminExceptionsQuery } from "@dx-rework/contracts/admin-console";
import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";

import { ApplicationError } from "./platform/errors.js";
import { OperationEventRepository, type TrustedActorContext } from "./tools/repositories.js";

type SeekRow = { created_at: Date; id: string };
type Cursor = { createdAt: string; id: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const encodeCursor = (row: SeekRow): string => Buffer.from(JSON.stringify({ createdAt: row.created_at.toISOString(), id: row.id }), "utf8").toString("base64url");
const decodeCursor = (value: string | undefined): Cursor | null => {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (typeof parsed?.createdAt !== "string" || typeof parsed?.id !== "string" || Number.isNaN(Date.parse(parsed.createdAt))) throw new Error("bad cursor");
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new ApplicationError("VALIDATION_ERROR", "Invalid admin cursor", 400);
  }
};

const sanitize = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  let text = typeof value === "string" ? value : JSON.stringify(value);
  text = text.replace(/(password|secret|token|cookie|authorization|database_url|connectionString)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]");
  text = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[REDACTED]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

const hashBody = (body: unknown): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

export class AdminConsoleService {
  private readonly events = new OperationEventRepository();
  constructor(private readonly db: Pool) {}

  async attachments(query: AdminAttachmentsQuery): Promise<AdminAttachmentsPage> {
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.attachmentId) where.push(`attachment.attachment_id=$${params.push(query.attachmentId)}::uuid`);
    if (query.uploadedBy) where.push(`attachment.uploaded_by=$${params.push(query.uploadedBy)}::uuid`);
    if (query.entityType) where.push(`attachment.entity_type=$${params.push(query.entityType)}`);
    if (query.entityId) where.push(`attachment.entity_id=$${params.push(query.entityId)}`);
    if (query.status) where.push(`attachment.status=$${params.push(query.status)}`);
    if (query.mimeType) where.push(`attachment.mime_type=$${params.push(query.mimeType)}`);
    if (query.from) where.push(`attachment.created_at >= $${params.push(query.from)}::timestamptz`);
    if (query.to) where.push(`attachment.created_at <= $${params.push(query.to)}::timestamptz`);
    if (cursor) where.push(`(attachment.created_at,attachment.attachment_id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.id)}::uuid)`);
    const rows = (await this.db.query<SeekRow & {
      attachment_id: string; original_filename: string; mime_type: string; size_bytes: string; sha256: string; uploaded_by: string; uploader_display_name: string | null; entity_type: string | null; entity_id: string | null; status: "pending" | "ready" | "rejected"; rejection_reason: string | null; ready_at: Date | null;
    }>(`SELECT attachment.created_at,attachment.attachment_id id,attachment.attachment_id,attachment.original_filename,attachment.mime_type,attachment.size_bytes::text,attachment.sha256,attachment.uploaded_by,uploader.display_name uploader_display_name,attachment.entity_type,attachment.entity_id,attachment.status,attachment.rejection_reason,attachment.ready_at FROM attachments attachment LEFT JOIN app_users uploader ON uploader.id=attachment.uploaded_by ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY attachment.created_at DESC,attachment.attachment_id DESC LIMIT $${params.push(query.limit + 1)}`, params)).rows;
    const page = rows.slice(0, query.limit);
    return { items: page.map((row): AdminAttachment => ({ attachmentId: row.attachment_id, filename: row.original_filename, mimeType: row.mime_type, sizeBytes: row.size_bytes, sha256: row.sha256, uploadedBy: row.uploaded_by, uploaderDisplayName: row.uploader_display_name, entityType: row.entity_type, entityId: row.entity_id, status: row.status, rejectionReason: row.rejection_reason, createdAt: row.created_at.toISOString(), readyAt: row.ready_at?.toISOString() ?? null })), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
  }

  async delegations(query: AdminDelegationsQuery): Promise<AdminDelegationsPage> {
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.grantorUserId) where.push(`delegation.grantor_user_id=$${params.push(query.grantorUserId)}::uuid`);
    if (query.granteeUserId) where.push(`delegation.grantee_user_id=$${params.push(query.granteeUserId)}::uuid`);
    if (query.capability) where.push(`delegation.capability=$${params.push(query.capability)}`);
    if (query.scopeType) where.push(`delegation.scope_type=$${params.push(query.scopeType)}`);
    if (query.scopeId) where.push(`delegation.scope_id=$${params.push(query.scopeId)}`);
    if (!query.includeRevoked) where.push("delegation.revoked_at IS NULL");
    if (query.activeAt) where.push(`delegation.valid_from <= $${params.push(query.activeAt)}::timestamptz AND delegation.valid_until > $${params.push(query.activeAt)}::timestamptz AND delegation.revoked_at IS NULL`);
    if (cursor) where.push(`(delegation.created_at,delegation.delegation_id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.id)}::uuid)`);
    const rows = (await this.db.query<SeekRow & { delegation_id: string; grantor_user_id: string; grantor_display_name: string | null; grantee_user_id: string; grantee_display_name: string | null; capability: string; scope_type: string; scope_id: string | null; valid_from: Date; valid_until: Date; granted_by: string; grant_reason: string; revoked_at: Date | null; revoked_by: string | null; revoke_reason: string | null; effective_now: boolean }>(`SELECT delegation.created_at,delegation.delegation_id id,delegation.delegation_id,delegation.grantor_user_id,grantor.display_name grantor_display_name,delegation.grantee_user_id,grantee.display_name grantee_display_name,delegation.capability,delegation.scope_type,delegation.scope_id,delegation.valid_from,delegation.valid_until,delegation.granted_by,delegation.grant_reason,delegation.revoked_at,delegation.revoked_by,delegation.revoke_reason,(delegation.revoked_at IS NULL AND delegation.valid_from<=CURRENT_TIMESTAMP AND delegation.valid_until>CURRENT_TIMESTAMP) effective_now FROM delegated_authorizations delegation LEFT JOIN app_users grantor ON grantor.id=delegation.grantor_user_id LEFT JOIN app_users grantee ON grantee.id=delegation.grantee_user_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY delegation.created_at DESC,delegation.delegation_id DESC LIMIT $${params.push(query.limit + 1)}`, params)).rows;
    const page = rows.slice(0, query.limit);
    return { items: page.map((row): AdminDelegation => ({ delegationId: row.delegation_id, grantor: { userId: row.grantor_user_id, displayName: row.grantor_display_name }, grantee: { userId: row.grantee_user_id, displayName: row.grantee_display_name }, capability: row.capability, scopeType: row.scope_type, scopeId: row.scope_id, validFrom: row.valid_from.toISOString(), validUntil: row.valid_until.toISOString(), grantedBy: row.granted_by, grantReason: row.grant_reason, createdAt: row.created_at.toISOString(), revokedAt: row.revoked_at?.toISOString() ?? null, revokedBy: row.revoked_by, revokeReason: row.revoke_reason, effectiveNow: row.effective_now })), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
  }

  async exceptions(query: AdminExceptionsQuery): Promise<AdminExceptionsPage> {
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.exceptionType) where.push(`exception_type=$${params.push(query.exceptionType)}`);
    if (query.sourceEntityType) where.push(`source_entity_type=$${params.push(query.sourceEntityType)}`);
    if (query.retryable !== undefined) where.push(`retryable=$${params.push(query.retryable)}`);
    if (cursor) where.push(`(occurred_at,source_entity_id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.id)})`);
    const rows = (await this.db.query<SeekRow & { exception_type: string; source_entity_type: string; source_entity_id: string; status: string; occurred_at: Date; last_updated_at: Date; safe_error: string | null; retryable: boolean; deep_link: string | null; details: unknown }>(`WITH exceptions AS (
      SELECT 'message_outbox_failed' exception_type,'message_outbox' source_entity_type,event_id::text source_entity_id,status,COALESCE(claimed_at,updated_at,created_at) occurred_at,updated_at last_updated_at,last_error safe_error,true retryable,NULL::text deep_link,jsonb_build_object('topic',topic,'aggregateType',aggregate_type,'aggregateId',aggregate_id,'attempts',attempts,'version',attempts) details FROM message_outbox WHERE status='failed' OR (status='processing' AND claimed_at<CURRENT_TIMESTAMP - interval '30 minutes')
      UNION ALL SELECT 'export_job_failed','export_job',export_job_id::text,status,COALESCE(completed_at,claimed_at,updated_at,created_at),updated_at,last_error,true,NULL::text,jsonb_build_object('exportType',export_type,'requestedBy',requested_by,'version',0) FROM export_jobs WHERE status='failed' OR (status='running' AND claimed_at<CURRENT_TIMESTAMP - interval '30 minutes')
      UNION ALL SELECT 'todo_delivery_failed','todo_delivery_attempt',delivery_attempt_id::text,outcome,attempted_at,attempted_at,COALESCE(error_code||': '||error_message,error_message,error_code),false,NULL::text,jsonb_build_object('todoId',todo_id,'messageOutboxEventId',message_outbox_event_id,'deliveryKind',delivery_kind,'version',0) FROM todo_delivery_attempts WHERE outcome IN ('failed','unknown_response')
      UNION ALL SELECT 'dingtalk_binding_permanent_failed','dingtalk_todo_external_binding',binding_id::text,provider_state,updated_at,updated_at,'DingTalk binding permanent failure',false,NULL::text,jsonb_build_object('todoId',todo_id,'provider',provider,'version',version) FROM dingtalk_todo_external_bindings WHERE provider_state='permanent_failed'
      UNION ALL SELECT 'attachment_pending_overdue','attachment',attachment_id::text,status,created_at,updated_at,rejection_reason,false,NULL::text,jsonb_build_object('entityType',entity_type,'entityId',entity_id,'version',0) FROM attachments WHERE status='pending' AND created_at<CURRENT_TIMESTAMP - interval '30 minutes'
    ) SELECT occurred_at created_at,source_entity_id id,* FROM exceptions ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY occurred_at DESC,source_entity_id DESC LIMIT $${params.push(query.limit + 1)}`, params)).rows;
    const page = rows.slice(0, query.limit);
    return { items: page.map((row): AdminException => ({ exceptionType: row.exception_type, sourceEntityType: row.source_entity_type, sourceEntityId: row.source_entity_id, status: row.status, occurredAt: row.occurred_at.toISOString(), lastUpdatedAt: row.last_updated_at.toISOString(), safeError: sanitize(row.safe_error), retryable: row.retryable, deepLink: row.deep_link, details: row.details })), nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null };
  }

  async retry(actor: TrustedActorContext, exceptionType: string, sourceEntityId: string, body: AdminExceptionRetryBody, idempotencyKey: string | undefined): Promise<AdminExceptionRetryResponse> {
    if (!idempotencyKey) throw new ApplicationError("VALIDATION_ERROR", "Idempotency-Key header is required", 400);
    if (exceptionType !== "message_outbox_failed") throw new ApplicationError("INVALID_STATE_TRANSITION", "This exception is not safely retryable by administrators", 422);
    if (!UUID_RE.test(sourceEntityId)) throw new ApplicationError("VALIDATION_ERROR", "Invalid source entity id", 400);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN");
      const requestHash = hashBody({ exceptionType, sourceEntityId, body });
      const idem = await client.query<{ response: AdminExceptionRetryResponse }>(`INSERT INTO idempotency_records(scope,actor_key,idempotency_key,request_hash,acquisition_token,expires_at) VALUES('admin-exception-retry',$1,$2,$3,$4,CURRENT_TIMESTAMP + interval '1 day') ON CONFLICT(scope,actor_key,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key WHERE idempotency_records.request_hash=EXCLUDED.request_hash AND idempotency_records.status='completed' RETURNING response`, [actor.actorId, idempotencyKey, requestHash, randomUUID()]);
      if (idem.rows[0]?.response) { await client.query("COMMIT"); return idem.rows[0].response; }
      const before = (await client.query<{ status: string; attempts: number; last_error: string | null }>("SELECT status,attempts,last_error FROM message_outbox WHERE event_id=$1 FOR UPDATE", [sourceEntityId])).rows[0];
      if (!before) throw new ApplicationError("NOT_FOUND", "Exception source not found", 404);
      if (before.attempts !== body.expectedVersion) throw new ApplicationError("CONFLICT", "Exception source version changed", 409);
      if (before.status !== "failed" && before.status !== "processing") throw new ApplicationError("INVALID_STATE_TRANSITION", "Only failed or stale processing outbox messages can be retried", 409);
      const updated = (await client.query<{ status: string; attempts: number; last_error: string | null }>("UPDATE message_outbox SET status='pending',claimed_at=NULL,claim_token=NULL,last_error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE event_id=$1 RETURNING status,attempts,last_error", [sourceEntityId])).rows[0]!;
      const eventId = await this.events.append(client, actor, { action: "admin.exception.retry", entityType: "message_outbox", entityId: sourceEntityId, before, after: updated, reason: body.reason });
      const response: AdminExceptionRetryResponse = { retried: true, exceptionType, sourceEntityId, operationEventId: eventId, status: updated.status };
      await client.query("UPDATE idempotency_records SET status='completed',status_code=200,response=$4,updated_at=CURRENT_TIMESTAMP WHERE scope='admin-exception-retry' AND actor_key=$1 AND idempotency_key=$2 AND request_hash=$3", [actor.actorId, idempotencyKey, requestHash, response]);
      await client.query("COMMIT");
      return response;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}
