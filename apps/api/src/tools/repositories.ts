import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { sanitizeOperationalError } from "@dx-rework/domain";
import { ApplicationError } from "../platform/errors.js";

export type SqlClient = Pick<PoolClient, "query">;
export type TrustedActorContext = Readonly<{ actorId: string; actorRole: string; requestId: string }>;

export class IdempotencyRepository {
  async begin(client: SqlClient, input: { scope: string; actorKey: string; key: string; requestHash: string; expiresAt: Date }): Promise<{ kind: "acquired" } | { kind: "completed"; statusCode: number; response: unknown }> {
    const inserted = await client.query(`INSERT INTO idempotency_records(scope, actor_key, idempotency_key, request_hash, expires_at) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING request_hash`, [input.scope, input.actorKey, input.key, input.requestHash, input.expiresAt]);
    if (inserted.rowCount === 1) return { kind: "acquired" };
    const existing = await client.query<{ request_hash: string; status: string; status_code: number | null; response: unknown }>(`SELECT request_hash,status,status_code,response FROM idempotency_records WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 FOR UPDATE`, [input.scope, input.actorKey, input.key]);
    const record = existing.rows[0];
    if (!record || record.request_hash !== input.requestHash) throw new ApplicationError("IDEMPOTENCY_CONFLICT", "Idempotency key was already used with a different request", 409);
    if (record.status !== "completed") throw new ApplicationError("IDEMPOTENCY_IN_PROGRESS", "Request with this idempotency key is still in progress", 409);
    return { kind: "completed", statusCode: record.status_code!, response: record.response };
  }
  async complete(client: SqlClient, input: { scope: string; actorKey: string; key: string; statusCode: number; response: unknown }): Promise<void> {
    await client.query(`UPDATE idempotency_records SET status='completed',status_code=$4,response=$5,updated_at=CURRENT_TIMESTAMP WHERE scope=$1 AND actor_key=$2 AND idempotency_key=$3 AND status='in_progress'`, [input.scope, input.actorKey, input.key, input.statusCode, input.response]);
  }
}

export class IdempotencyService {
  constructor(private readonly records = new IdempotencyRepository()) {}
  async execute<T>(client: SqlClient, input: { scope: string; actorKey: string; key: string; requestHash: string; expiresAt: Date }, work: () => Promise<{ statusCode: number; response: T }>): Promise<{ statusCode: number; response: T; reused: boolean }> {
    const begun = await this.records.begin(client, input);
    if (begun.kind === "completed") return { statusCode: begun.statusCode, response: begun.response as T, reused: true };
    const result = await work();
    await this.records.complete(client, { scope: input.scope, actorKey: input.actorKey, key: input.key, statusCode: result.statusCode, response: result.response });
    return { ...result, reused: false };
  }
}

export class OperationEventRepository {
  async append(client: SqlClient, actor: TrustedActorContext, input: { action: string; entityType: string; entityId: string; before?: unknown; after?: unknown; reason?: string }): Promise<string> {
    const eventId = randomUUID();
    await client.query(`INSERT INTO operation_events(event_id,request_id,actor_id,actor_role,action,entity_type,entity_id,before_state,after_state,reason) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [eventId, actor.requestId, actor.actorId, actor.actorRole, input.action, input.entityType, input.entityId, input.before ?? null, input.after ?? null, input.reason ?? null]);
    return eventId;
  }
}

export class MessageOutboxRepository {
  async enqueue(client: SqlClient, input: { topic: string; aggregateType: string; aggregateId: string; payload: unknown; recipientKey: string; idempotencyKey: string }): Promise<string> {
    const eventId = randomUUID();
    const result = await client.query<{ event_id: string }>(`INSERT INTO message_outbox(event_id,topic,aggregate_type,aggregate_id,payload,recipient_key,idempotency_key) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(topic,recipient_key,idempotency_key) DO UPDATE SET idempotency_key=EXCLUDED.idempotency_key RETURNING event_id`, [eventId,input.topic,input.aggregateType,input.aggregateId,input.payload,input.recipientKey,input.idempotencyKey]);
    return result.rows[0]!.event_id;
  }
  async claim(client: SqlClient, limit: number): Promise<Array<{ eventId: string; payload: unknown; attempts: number }>> {
    const result = await client.query<{ event_id: string; payload: unknown; attempts: number }>(`WITH candidates AS (SELECT event_id FROM message_outbox WHERE status IN ('pending','failed') AND available_at <= CURRENT_TIMESTAMP ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT $1) UPDATE message_outbox o SET status='processing',claimed_at=CURRENT_TIMESTAMP,attempts=o.attempts+1,updated_at=CURRENT_TIMESTAMP FROM candidates c WHERE o.event_id=c.event_id RETURNING o.event_id,o.payload,o.attempts`, [limit]);
    return result.rows.map((row) => ({ eventId: row.event_id, payload: row.payload, attempts: row.attempts }));
  }
  async markSent(client: SqlClient, eventId: string): Promise<void> { await client.query(`UPDATE message_outbox SET status='sent',sent_at=CURRENT_TIMESTAMP,last_error=NULL,updated_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND status='processing'`, [eventId]); }
  async markFailed(client: SqlClient, eventId: string, error: unknown, delaySeconds: number): Promise<void> { await client.query(`UPDATE message_outbox SET status='failed',available_at=CURRENT_TIMESTAMP + ($2 * interval '1 second'),last_error=$3,claimed_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND status='processing'`, [eventId, delaySeconds, sanitizeOperationalError(error)]); }
}
