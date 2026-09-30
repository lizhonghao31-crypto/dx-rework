import type {
  AdminAttachment,
  AdminAttachmentsPage,
  AdminAttachmentsQuery,
  AdminDelegation,
  AdminDelegationsPage,
  AdminDelegationsQuery,
  AdminException,
  AdminExceptionRetryBody,
  AdminExceptionRetryResponse,
  AdminExceptionsPage,
  AdminExceptionsQuery,
} from "@dx-rework/contracts/admin-console";
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
  text = text.replace(/(app[_-]?secret|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*[^\s,;}]+/gi, "$1=[REDACTED]");
  text = text.replace(/postgres(?:ql)?:\/\/\S+/gi, "postgres://[REDACTED]");
  text = text.replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/g, "[PHONE REDACTED]");
  text = text.replace(/(?<!\d)(?:\d{17}[\dXx]|\d{15})(?![\dXx])/g, "[IDENTITY REDACTED]");
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
};

const hashBody = (body: unknown): string => createHash("sha256").update(JSON.stringify(body)).digest("hex");

export class AdminConsoleService {
  private readonly events = new OperationEventRepository();
  constructor(private readonly db: Pool) {}

  async attachments(query: AdminAttachmentsQuery): Promise<AdminAttachmentsPage> {
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
    const rows = (await this.db.query<SeekRow & {
      attachment_id: string;
      original_filename: string;
      mime_type: string;
      size_bytes: string;
      sha256: string;
      uploaded_by: string;
      uploader_display_name: string | null;
      entity_type: string | null;
      entity_id: string | null;
      status: "pending" | "ready" | "rejected";
      rejection_reason: string | null;
      ready_at: Date | null;
      total_count: string;
    }>(`SELECT attachment.created_at,attachment.attachment_id id,attachment.attachment_id,attachment.original_filename,attachment.mime_type,attachment.size_bytes::text,attachment.sha256,attachment.uploaded_by,uploader.display_name uploader_display_name,attachment.entity_type,attachment.entity_id,attachment.status,attachment.rejection_reason,attachment.ready_at,count(*) OVER()::text total_count FROM attachments attachment LEFT JOIN app_users uploader ON uploader.id=attachment.uploaded_by ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY attachment.created_at DESC,attachment.attachment_id DESC LIMIT $${params.push(query.limit)} OFFSET $${params.push((query.page - 1) * query.limit)}`, params)).rows;
    const page = rows;
    const totalCount = Number(page[0]?.total_count ?? "0");
    return {
      items: page.map((row): AdminAttachment => ({
        attachmentId: row.attachment_id,
        filename: row.original_filename,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        sha256: row.sha256,
        uploadedBy: row.uploaded_by,
        uploaderDisplayName: row.uploader_display_name,
        entityType: row.entity_type,
        entityId: row.entity_id,
        status: row.status,
        rejectionReason: row.rejection_reason,
        createdAt: row.created_at.toISOString(),
        readyAt: row.ready_at?.toISOString() ?? null,
      })),
      page: query.page,
      pageSize: query.limit,
      totalCount,
      totalPages: Math.max(1, Math.ceil(totalCount / query.limit)),
    };
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
    const rows = (await this.db.query<SeekRow & {
      delegation_id: string;
      grantor_user_id: string;
      grantor_display_name: string | null;
      grantee_user_id: string;
      grantee_display_name: string | null;
      capability: string;
      scope_type: string;
      scope_id: string | null;
      valid_from: Date;
      valid_until: Date;
      granted_by: string;
      grant_reason: string;
      revoked_at: Date | null;
      revoked_by: string | null;
      revoke_reason: string | null;
      effective_now: boolean;
    }>(`SELECT delegation.created_at,delegation.delegation_id id,delegation.delegation_id,delegation.grantor_user_id,grantor.display_name grantor_display_name,delegation.grantee_user_id,grantee.display_name grantee_display_name,delegation.capability,delegation.scope_type,delegation.scope_id,delegation.valid_from,delegation.valid_until,delegation.granted_by,delegation.grant_reason,delegation.revoked_at,delegation.revoked_by,delegation.revoke_reason,(delegation.revoked_at IS NULL AND delegation.valid_from<=CURRENT_TIMESTAMP AND delegation.valid_until>CURRENT_TIMESTAMP) effective_now FROM delegated_authorizations delegation LEFT JOIN app_users grantor ON grantor.id=delegation.grantor_user_id LEFT JOIN app_users grantee ON grantee.id=delegation.grantee_user_id ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY delegation.created_at DESC,delegation.delegation_id DESC LIMIT $${params.push(query.limit + 1)}`, params)).rows;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row): AdminDelegation => ({
        delegationId: row.delegation_id,
        grantor: { userId: row.grantor_user_id, displayName: row.grantor_display_name },
        grantee: { userId: row.grantee_user_id, displayName: row.grantee_display_name },
        capability: row.capability,
        scopeType: row.scope_type,
        scopeId: row.scope_id,
        validFrom: row.valid_from.toISOString(),
        validUntil: row.valid_until.toISOString(),
        grantedBy: row.granted_by,
        grantReason: row.grant_reason,
        createdAt: row.created_at.toISOString(),
        revokedAt: row.revoked_at?.toISOString() ?? null,
        revokedBy: row.revoked_by,
        revokeReason: row.revoke_reason,
        effectiveNow: row.effective_now,
      })),
      nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
    };
  }

  async exceptions(query: AdminExceptionsQuery): Promise<AdminExceptionsPage> {
    const cursor = decodeCursor(query.cursor);
    const params: unknown[] = [];
    const where: string[] = [];
    if (query.exceptionType) where.push(`exception_type=$${params.push(query.exceptionType)}`);
    if (query.sourceEntityType) where.push(`source_entity_type=$${params.push(query.sourceEntityType)}`);
    if (query.retryable !== undefined) where.push(`retryable=$${params.push(query.retryable)}`);
    if (cursor) where.push(`(occurred_at,source_entity_id) < ($${params.push(cursor.createdAt)}::timestamptz,$${params.push(cursor.id)})`);
    const rows = (await this.db.query<SeekRow & {
      exception_type: string;
      source_entity_type: string;
      source_entity_id: string;
      rework_order_id: string | null;
      business_action: string;
      failure_stage: string;
      request_id: string | null;
      status: string;
      occurred_at: Date;
      last_updated_at: Date;
      safe_error: string | null;
      retryable: boolean;
      deep_link: string | null;
      details: unknown;
    }>(`WITH todo_order AS (
      SELECT todo.todo_id,todo.category,
        COALESCE(
          CASE WHEN NULLIF(todo.route_descriptor->>'reworkOrderId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN NULLIF(todo.route_descriptor->>'reworkOrderId','')::uuid END,
          CASE todo.entity_type
            WHEN 'rework_order' THEN CASE WHEN todo.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' THEN todo.entity_id::uuid END
            WHEN 'own_factory_approval' THEN approval.rework_order_id
            WHEN 'external_responsibility_case' THEN external_case.rework_order_id
            WHEN 'responsibility_determination' THEN determination.rework_order_id
            ELSE NULL
          END
        ) rework_order_id
      FROM rework_todos todo
      LEFT JOIN rework_own_factory_approvals approval
        ON todo.entity_type='own_factory_approval' AND approval.approval_id::text=todo.entity_id
      LEFT JOIN rework_external_responsibility_cases external_case
        ON todo.entity_type='external_responsibility_case' AND external_case.case_id::text=todo.entity_id
      LEFT JOIN rework_responsibility_determinations determination
        ON todo.entity_type='responsibility_determination' AND determination.determination_id::text=todo.entity_id
    ), latest_binding_event AS (
      SELECT DISTINCT ON (binding_id) binding_id,request_id,action
      FROM dingtalk_todo_external_binding_events
      ORDER BY binding_id,created_at DESC,binding_event_id DESC
    ), exceptions AS (
      SELECT 'message_outbox_failed' exception_type,'message_outbox' source_entity_type,
        outbox.event_id::text source_entity_id,
        COALESCE(
          mapped.rework_order_id,
          CASE WHEN outbox.aggregate_type='rework_order'
            AND outbox.aggregate_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN outbox.aggregate_id::uuid END,
          CASE WHEN NULLIF(outbox.payload->>'reworkOrderId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
            THEN NULLIF(outbox.payload->>'reworkOrderId','')::uuid END
        ) rework_order_id,
        COALESCE(NULLIF(outbox.payload->>'category',''),NULLIF(outbox.payload->>'deliveryKind',''),outbox.topic) business_action,
        '后台消息投递' failure_stage,NULLIF(outbox.payload->>'operationRequestId','') request_id,
        outbox.status,COALESCE(outbox.claimed_at,outbox.updated_at,outbox.created_at) occurred_at,
        outbox.updated_at last_updated_at,outbox.last_error safe_error,true retryable,
        jsonb_build_object('topic',outbox.topic,'aggregateType',outbox.aggregate_type,'aggregateId',outbox.aggregate_id,'attempts',outbox.attempts,'version',outbox.attempts) details
      FROM message_outbox outbox
      LEFT JOIN todo_order mapped
        ON outbox.aggregate_type='rework_todo' AND mapped.todo_id::text=outbox.aggregate_id
      WHERE outbox.status='failed' OR (outbox.status='processing' AND outbox.claimed_at<CURRENT_TIMESTAMP - interval '30 minutes')
      UNION ALL
      SELECT 'export_job_failed','export_job',job.export_job_id::text,
        CASE WHEN NULLIF(job.filters->>'reworkOrderId','') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN NULLIF(job.filters->>'reworkOrderId','')::uuid END,
        job.export_type,'报表导出',(
          SELECT event.request_id FROM operation_events event
          WHERE event.entity_type='export_job' AND event.entity_id=job.export_job_id::text
          ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
        ),job.status,COALESCE(job.completed_at,job.claimed_at,job.updated_at,job.created_at),
        job.updated_at,job.last_error,false,
        jsonb_build_object('exportType',job.export_type,'requestedBy',job.requested_by,'version',0)
      FROM export_jobs job
      WHERE job.status='failed' OR (job.status='running' AND job.claimed_at<CURRENT_TIMESTAMP - interval '30 minutes')
      UNION ALL
      SELECT 'todo_delivery_failed','todo_delivery_attempt',attempt.delivery_attempt_id::text,
        mapped.rework_order_id,COALESCE(mapped.category,attempt.delivery_kind),
        '钉钉待办投递',attempt.operation_request_id,attempt.outcome,attempt.attempted_at,attempt.attempted_at,
        COALESCE(attempt.error_code||': '||attempt.error_message,attempt.error_message,attempt.error_code),false,
        jsonb_build_object('todoId',attempt.todo_id,'messageOutboxEventId',attempt.message_outbox_event_id,'deliveryKind',attempt.delivery_kind,'version',0)
      FROM todo_delivery_attempts attempt
      LEFT JOIN todo_order mapped USING(todo_id)
      WHERE attempt.outcome IN ('failed','unknown_response')
      UNION ALL
      SELECT 'dingtalk_binding_permanent_failed','dingtalk_todo_external_binding',binding.binding_id::text,
        mapped.rework_order_id,COALESCE(mapped.category,latest.action,'dingtalk_todo'),
        '钉钉待办绑定',latest.request_id,binding.provider_state,binding.updated_at,binding.updated_at,
        COALESCE((
          SELECT NULLIF(concat_ws(': ',attempt.error_code,attempt.error_message),'')
          FROM todo_delivery_attempts attempt
          WHERE attempt.todo_id=binding.todo_id AND attempt.outcome IN ('failed','unknown_response')
          ORDER BY attempt.attempted_at DESC,attempt.delivery_attempt_id DESC LIMIT 1
        ),'DingTalk binding permanent failure'),false,
        jsonb_build_object('todoId',binding.todo_id,'provider',binding.provider,'version',binding.version)
      FROM dingtalk_todo_external_bindings binding
      LEFT JOIN todo_order mapped USING(todo_id)
      LEFT JOIN latest_binding_event latest USING(binding_id)
      WHERE binding.provider_state='permanent_failed'
      UNION ALL
      SELECT 'attachment_upload_not_completed','attachment',attachment.attachment_id::text,
        CASE WHEN attachment.entity_type='rework_order'
          AND attachment.entity_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
          THEN attachment.entity_id::uuid END,
        'attachment.upload','附件上传',(
          SELECT event.request_id FROM operation_events event
          WHERE event.entity_type='attachment' AND event.entity_id=attachment.attachment_id::text
          ORDER BY event.created_at DESC,event.event_id DESC LIMIT 1
        ),attachment.status,attachment.created_at,attachment.updated_at,attachment.rejection_reason,false,
        jsonb_build_object('entityType',attachment.entity_type,'entityId',attachment.entity_id,'version',0)
      FROM attachments attachment
      WHERE attachment.status='pending' AND attachment.created_at<CURRENT_TIMESTAMP - interval '30 minutes'
    ) SELECT occurred_at created_at,source_entity_id id,exceptions.*,
      CASE WHEN rework_order_id IS NULL THEN NULL ELSE '/ui/tasks/'||rework_order_id::text END deep_link
    FROM exceptions ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
    ORDER BY occurred_at DESC,source_entity_id DESC LIMIT $${params.push(query.limit + 1)}`, params)).rows;
    const page = rows.slice(0, query.limit);
    return {
      items: page.map((row): AdminException => ({
        exceptionType: row.exception_type,
        sourceEntityType: row.source_entity_type,
        sourceEntityId: row.source_entity_id,
        reworkOrderId: row.rework_order_id,
        businessAction: row.business_action,
        failureStage: row.failure_stage,
        requestId: row.request_id,
        status: row.status,
        occurredAt: row.occurred_at.toISOString(),
        lastUpdatedAt: row.last_updated_at.toISOString(),
        safeError: sanitize(row.safe_error),
        retryable: row.retryable,
        deepLink: row.deep_link,
        details: row.details,
      })),
      nextCursor: rows.length > query.limit ? encodeCursor(page.at(-1)!) : null,
    };
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
      if (idem.rows[0]?.response) {
        await client.query("COMMIT");
        return idem.rows[0].response;
      }
      const before = (await client.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        claimed_at: Date | null;
        stale_processing: boolean;
      }>("SELECT status,attempts,last_error,claimed_at,(status='processing' AND claimed_at<CURRENT_TIMESTAMP - interval '30 minutes') stale_processing FROM message_outbox WHERE event_id=$1 FOR UPDATE", [sourceEntityId])).rows[0];
      if (!before) throw new ApplicationError("NOT_FOUND", "Exception source not found", 404);
      if (before.attempts !== body.expectedVersion) throw new ApplicationError("CONFLICT", "Exception source version changed", 409);
      if (before.status !== "failed" && !before.stale_processing) {
        throw new ApplicationError("INVALID_STATE_TRANSITION", "Only failed or stale processing outbox messages can be retried", 409);
      }
      const beforeState = {
        status: before.status,
        attempts: before.attempts,
        last_error: before.last_error,
        claimed_at: before.claimed_at?.toISOString() ?? null,
      };
      const updated = (await client.query<{ status: string; attempts: number; last_error: string | null }>("UPDATE message_outbox SET status='pending',claimed_at=NULL,claim_token=NULL,last_error=NULL,available_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE event_id=$1 RETURNING status,attempts,last_error", [sourceEntityId])).rows[0]!;
      const eventId = await this.events.append(client, actor, {
        action: "admin.exception.retry",
        entityType: "message_outbox",
        entityId: sourceEntityId,
        before: beforeState,
        after: updated,
        reason: body.reason,
      });
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
