import { randomUUID } from "node:crypto";
import {acceptanceBusinessContext} from '../acceptance-clock/business-time.js';
import type { PoolClient } from "pg";

import { sanitizeOperationalError } from "@dx-rework/domain";
import { ApplicationError } from "../platform/errors.js";

export type SqlClient = Pick<PoolClient, "query">;
export type TrustedActorContext = Readonly<{ actorId: string; actorRoles: readonly string[]; authorizationCapability: string; authorizationCapabilities?: readonly string[]; requestId: string }>;
export type OperationEventInput = Readonly<{
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}>;

type IdempotencyInput = {
  scope: string;
  actorKey: string;
  key: string;
  requestHash: string;
  expiresAt: Date;
  /** This business command uses a saved receipt even after the generic retry window. */
  retainReceipt?: true;
};

const validateClaimOptions = (limit: number, leaseSeconds: number): void => {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ApplicationError("VALIDATION_ERROR", "Claim limit must be between 1 and 100", 400);
  }
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 3600) {
    throw new ApplicationError("VALIDATION_ERROR", "Claim lease must be between 30 and 3600 seconds", 400);
  }
};

const validateRetryDelay = (delaySeconds: number): void => {
  if (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 86_400) {
    throw new ApplicationError("VALIDATION_ERROR", "Retry delay must be between 1 and 86400 seconds", 400);
  }
};

export class IdempotencyRepository {
  async begin(client: SqlClient, input: IdempotencyInput): Promise<{ kind: "acquired"; acquisitionToken: string } | { kind: "completed"; statusCode: number; response: unknown }> {
    const acquisitionToken = randomUUID();
    const acquired = await client.query(
      `INSERT INTO idempotency_records(scope,actor_key,idempotency_key,request_hash,expires_at,acquisition_token)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(scope,actor_key,idempotency_key) DO UPDATE
       SET request_hash=EXCLUDED.request_hash,status='in_progress',status_code=NULL,response=NULL,
           acquisition_token=EXCLUDED.acquisition_token,created_at=CURRENT_TIMESTAMP,
           updated_at=CURRENT_TIMESTAMP,expires_at=EXCLUDED.expires_at
       WHERE idempotency_records.expires_at <= CURRENT_TIMESTAMP AND NOT $7::boolean
       RETURNING acquisition_token`,
      [input.scope, input.actorKey, input.key, input.requestHash, input.expiresAt, acquisitionToken, input.retainReceipt === true],
    );
    if (acquired.rowCount === 1) return { kind: "acquired", acquisitionToken };

    const existing = await client.query<{ request_hash: string; status: string; status_code: number | null; response: unknown }>(
      `SELECT request_hash,status,status_code,response
       FROM idempotency_records
       WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3
       FOR UPDATE`,
      [input.scope, input.actorKey, input.key],
    );
    const record = existing.rows[0];
    if (!record || record.request_hash !== input.requestHash) {
      throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request", 409);
    }
    if (record.status !== "completed") {
      throw new ApplicationError("IDEMPOTENCY_IN_PROGRESS", "Request with this idempotency key is still in progress", 409);
    }
    return { kind: "completed", statusCode: record.status_code!, response: record.response };
  }

  async complete(client: SqlClient, input: { scope: string; actorKey: string; key: string; acquisitionToken: string; statusCode: number; response: unknown }): Promise<void> {
    const result = await client.query(
      `UPDATE idempotency_records
       SET status='completed',status_code=$4,response=$5,updated_at=CURRENT_TIMESTAMP
       WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 AND status='in_progress' AND acquisition_token=$6`,
      [input.scope, input.actorKey, input.key, input.statusCode, input.response, input.acquisitionToken],
    );
    if (result.rowCount !== 1) {
      throw new ApplicationError("INVALID_STATE_TRANSITION", "Idempotency record is not in progress", 409);
    }
  }
}

export class IdempotencyService {
  constructor(private readonly records = new IdempotencyRepository()) {}
  async execute<T>(client: SqlClient, input: IdempotencyInput, work: () => Promise<{ statusCode: number; response: T }>): Promise<{ statusCode: number; response: T; reused: boolean }> {
    const begun = await this.records.begin(client, input);
    if (begun.kind === "completed") return { statusCode: begun.statusCode, response: begun.response as T, reused: true };
    const result = await work();
    await this.records.complete(client, { scope: input.scope, actorKey: input.actorKey, key: input.key, acquisitionToken: begun.acquisitionToken, statusCode: result.statusCode, response: result.response });
    return { ...result, reused: false };
  }
}

const rethrowMemberPolicyError = (error: unknown): never => {
  if (error instanceof Error && error.message.includes("MEMBER_MODULE_READ_ONLY:")) {
    throw new ApplicationError("FORBIDDEN", "当前账号在此业务模块仅可查看", 403);
  }
  throw error;
};

export class OperationEventRepository {
  private after(input:unknown):unknown {
    const context=acceptanceBusinessContext();
    return context&&input!==null&&typeof input==='object'&&!Array.isArray(input)
      ?{...input,acceptanceClock:context.time}:input??null;
  }
  private actorRoles(actor: TrustedActorContext): string[] {
    const actorRoles = [...new Set(actor.actorRoles)].sort();
    const safeCode = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,127}$/;
    if (actorRoles.length === 0 || actorRoles.some((role) => !safeCode.test(role))) {
      throw new ApplicationError("NO_BUSINESS_ROLE", "A non-empty trusted business-role snapshot is required", 403);
    }
    if (!safeCode.test(actor.authorizationCapability)) {
      throw new ApplicationError("FORBIDDEN", "A trusted authorization capability is required", 403);
    }
    return actorRoles;
  }

  async append(client: SqlClient, actor: TrustedActorContext, input: OperationEventInput): Promise<string> {
    const actorRoles = this.actorRoles(actor);
    const eventId = randomUUID();
    await client.query(
      `INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,before_state,after_state,reason)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [eventId, actor.requestId, actor.actorId, actorRoles, actor.authorizationCapability, input.action, input.entityType, input.entityId, input.before ?? null, this.after(input.after), input.reason ?? null],
    ).catch(rethrowMemberPolicyError);
    return eventId;
  }

  async appendMany(
    client: SqlClient,
    entries: readonly Readonly<{ actor: TrustedActorContext; input: OperationEventInput }>[],
  ): Promise<string[]> {
    if (entries.length === 0) return [];
    const rows = entries.map(({ actor, input }) => ({
      event_id: randomUUID(),
      request_id: actor.requestId,
      actor_id: actor.actorId,
      actor_roles: this.actorRoles(actor),
      authorization_capability: actor.authorizationCapability,
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      before_state: input.before ?? null,
      after_state: this.after(input.after),
      reason: input.reason ?? null,
    }));
    await client.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id,before_state,after_state,reason
       )
       SELECT event.event_id::uuid,event.request_id,event.actor_id::uuid,event.actor_roles,
              event.authorization_capability,event.action,event.entity_type,event.entity_id,
              event.before_state,event.after_state,event.reason
       FROM jsonb_to_recordset($1::jsonb) AS event(
         event_id text,request_id text,actor_id text,actor_roles text[],
         authorization_capability text,action text,entity_type text,entity_id text,
         before_state jsonb,after_state jsonb,reason text
       )`,
      [JSON.stringify(rows)],
    ).catch(rethrowMemberPolicyError);
    return rows.map((row) => row.event_id);
  }
}

export class MessageOutboxRepository {
  async enqueue(client: SqlClient, input: { topic: string; aggregateType: string; aggregateId: string; payload: unknown; recipientKey: string; idempotencyKey: string }): Promise<string> {
    const eventId = randomUUID();
    const result = await client.query<{ event_id: string }>(
      `INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key)
       VALUES($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT(topic,recipient_key,idempotency_key) DO UPDATE
       SET idempotency_key=EXCLUDED.idempotency_key
       WHERE message_outbox.aggregate_type=EXCLUDED.aggregate_type
         AND message_outbox.aggregate_id=EXCLUDED.aggregate_id
         AND message_outbox.payload=EXCLUDED.payload
       RETURNING event_id`,
      [eventId, input.topic, input.aggregateType, input.aggregateId, input.payload, input.recipientKey, input.idempotencyKey],
    );
    const row = result.rows[0];
    if (!row) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Outbox idempotency key was used with different semantics", 409);
    return row.event_id;
  }

  async claim(client: SqlClient, limit = 1, leaseSeconds = 300, topic?: string): Promise<Array<{
    eventId: string;
    topic: string;
    aggregateType: string;
    aggregateId: string;
    payload: unknown;
    recipientKey: string;
    idempotencyKey: string;
    claimToken: string;
    attempts: number;
  }>> {
    validateClaimOptions(limit, leaseSeconds);
    const claimToken = randomUUID();
    const result = await client.query<{
      event_id: string;
      topic: string;
      aggregate_type: string;
      aggregate_id: string;
      payload: unknown;
      recipient_key: string;
      idempotency_key: string;
      claim_token: string;
      attempts: number;
    }>(
       `WITH candidates AS (
         SELECT event_id FROM message_outbox
         WHERE (
              (status IN ('pending','failed') AND available_at <= CURRENT_TIMESTAMP)
              OR (status='processing' AND claimed_at <= CURRENT_TIMESTAMP - ($2 * interval '1 second'))
            )
           AND ($4::text IS NULL OR topic=$4)
         ORDER BY COALESCE(claimed_at,available_at),created_at
         FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE message_outbox o
       SET status='processing',claimed_at=CURRENT_TIMESTAMP,claim_token=$3,attempts=o.attempts+1,updated_at=CURRENT_TIMESTAMP
       FROM candidates c WHERE o.event_id=c.event_id
       RETURNING o.event_id,o.topic,o.aggregate_type,o.aggregate_id,o.payload,o.recipient_key,o.idempotency_key,o.claim_token,o.attempts`,
      [limit, leaseSeconds, claimToken, topic ?? null],
    );
    return result.rows.map((row) => ({
      eventId: row.event_id,
      topic: row.topic,
      aggregateType: row.aggregate_type,
      aggregateId: row.aggregate_id,
      payload: row.payload,
      recipientKey: row.recipient_key,
      idempotencyKey: row.idempotency_key,
      claimToken: row.claim_token,
      attempts: row.attempts,
    }));
  }

  async markSent(client: SqlClient, eventId: string, claimToken: string): Promise<void> {
    const result = await client.query(
      `UPDATE message_outbox SET status='sent',claimed_at=NULL,claim_token=NULL,sent_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE event_id=$1 AND status='processing' AND claim_token=$2`,
      [eventId, claimToken],
    );
    if (result.rowCount !== 1) throw new ApplicationError("INVALID_STATE_TRANSITION", "Outbox event is not processing", 409);
  }

  async markFailed(client: SqlClient, eventId: string, claimToken: string, error: unknown, delaySeconds: number): Promise<void> {
    validateRetryDelay(delaySeconds);
    const result = await client.query(
      `UPDATE message_outbox
       SET status='failed',available_at=CURRENT_TIMESTAMP + ($3 * interval '1 second'),last_error=$4,claimed_at=NULL,claim_token=NULL,updated_at=CURRENT_TIMESTAMP
       WHERE event_id=$1 AND status='processing' AND claim_token=$2`,
      [eventId, claimToken, delaySeconds, sanitizeOperationalError(error)],
    );
    if (result.rowCount !== 1) throw new ApplicationError("INVALID_STATE_TRANSITION", "Outbox event is not processing", 409);
  }
}
