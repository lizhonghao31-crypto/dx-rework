import type { FastifyInstance, FastifyRequest } from "fastify";
import type { Pool } from "pg";

export type OperationalOutcome = "permission" | "validation" | "conflict" | "technical";

type RuntimeLogger = Readonly<{
  info(value: unknown, message?: string): void;
  warn(value: unknown, message?: string): void;
}>;

type ObservablePool = Pick<Pool, "query"> & Readonly<{
  totalCount: number;
  idleCount: number;
  waitingCount: number;
}>;

const SAFE_CODE = /^[A-Z0-9_]{1,80}$/;

export function operationalOutcome(status: number): OperationalOutcome {
  if (status >= 500) return "technical";
  if (status === 401 || status === 403) return "permission";
  if (status === 409) return "conflict";
  return "validation";
}

export function safeOperationalErrorCode(value: unknown, status: number): string {
  if (typeof value === "string" && SAFE_CODE.test(value)) return value;
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 409) return "CONFLICT";
  return status >= 500 ? "INTERNAL_ERROR" : "UNCLASSIFIED";
}

export function registerRequestOutcomeObservability(app: FastifyInstance): void {
  const errorCodes = new WeakMap<FastifyRequest, string>();

  app.addHook("onError", async (request, _reply, error) => {
    errorCodes.set(
      request,
      safeOperationalErrorCode(
        (error as { code?: unknown }).code,
        Number((error as { statusCode?: unknown }).statusCode ?? 500),
      ),
    );
  });

  app.addHook("onResponse", async (request, reply) => {
    const statusCode = reply.statusCode;
    if (statusCode < 400) return;
    const record = {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url ?? "unmatched",
      statusCode,
      outcome: operationalOutcome(statusCode),
      errorCode: safeOperationalErrorCode(errorCodes.get(request), statusCode),
    };
    if (statusCode >= 500) request.log.warn({ operationalFailure: record }, "request outcome classified");
    else request.log.info({ operationalFailure: record }, "request outcome classified");
  });
}

export type RuntimeOperationalSnapshot = Readonly<{
  databasePool: Readonly<{ total: number; idle: number; waiting: number }>;
  database: Readonly<{ visibleLockWaiters: number }>;
  todos: Readonly<{
    pending: number;
    blockedRecipient: number;
    overdue: number;
    unknownProviderState: number;
    permanentProviderFailure: number;
  }>;
  outbox: Readonly<{ pending: number; processing: number; failed: number }>;
  process: Readonly<{ rssBytes: number; heapUsedBytes: number }>;
}>;

export async function readRuntimeOperationalSnapshot(database: ObservablePool): Promise<RuntimeOperationalSnapshot> {
  const result = await database.query<{
    pending_todos: number;
    blocked_todos: number;
    overdue_todos: number;
    unknown_provider_state: number;
    permanent_provider_failure: number;
    outbox_pending: number;
    outbox_processing: number;
    outbox_failed: number;
    visible_lock_waiters: number;
  }>(`
    SELECT
      (SELECT count(*)::int FROM rework_todos WHERE status='pending') pending_todos,
      (SELECT count(*)::int FROM rework_todos WHERE status='blocked_recipient') blocked_todos,
      (SELECT count(*)::int FROM rework_todos
        WHERE status='pending' AND due_at IS NOT NULL AND due_at<CURRENT_TIMESTAMP) overdue_todos,
      (SELECT count(*)::int FROM dingtalk_todo_external_bindings
        WHERE provider_state='unknown_response') unknown_provider_state,
      (SELECT count(*)::int FROM dingtalk_todo_external_bindings
        WHERE provider_state='permanent_failed') permanent_provider_failure,
      (SELECT count(*)::int FROM message_outbox WHERE status='pending') outbox_pending,
      (SELECT count(*)::int FROM message_outbox WHERE status='processing') outbox_processing,
      (SELECT count(*)::int FROM message_outbox WHERE status='failed') outbox_failed,
      (SELECT count(*)::int FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock') visible_lock_waiters
  `);
  const row = result.rows[0];
  if (!row) throw new Error("Operational snapshot query returned no row");
  const memory = process.memoryUsage();
  return {
    databasePool: {
      total: database.totalCount,
      idle: database.idleCount,
      waiting: database.waitingCount,
    },
    database: { visibleLockWaiters: row.visible_lock_waiters },
    todos: {
      pending: row.pending_todos,
      blockedRecipient: row.blocked_todos,
      overdue: row.overdue_todos,
      unknownProviderState: row.unknown_provider_state,
      permanentProviderFailure: row.permanent_provider_failure,
    },
    outbox: {
      pending: row.outbox_pending,
      processing: row.outbox_processing,
      failed: row.outbox_failed,
    },
    process: {
      rssBytes: memory.rss,
      heapUsedBytes: memory.heapUsed,
    },
  };
}

export class RuntimeOperationalMonitor {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly database: ObservablePool,
    private readonly logger: RuntimeLogger,
    private readonly intervalMs = 60_000,
  ) {
    if (!Number.isInteger(intervalMs) || intervalMs < 10_000 || intervalMs > 3_600_000) {
      throw new Error("Operational monitor interval must be between 10000 and 3600000 milliseconds");
    }
  }

  start(): void {
    if (this.timer) return;
    this.kick();
    this.timer = setInterval(() => this.kick(), this.intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await (this.running ?? Promise.resolve());
  }

  private kick(): void {
    if (this.running) return;
    this.running = this.capture().finally(() => { this.running = null; });
  }

  private async capture(): Promise<void> {
    try {
      const snapshot = await readRuntimeOperationalSnapshot(this.database);
      this.logger.info({ operationalSnapshot: snapshot }, "operational runtime snapshot");
    } catch {
      this.logger.warn({ operationalSnapshotUnavailable: true }, "operational runtime snapshot unavailable");
    }
  }
}
