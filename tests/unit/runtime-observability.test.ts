import { describe, expect, it, vi } from "vitest";

import {
  RuntimeOperationalMonitor,
  operationalOutcome,
  readRuntimeOperationalSnapshot,
  safeOperationalErrorCode,
} from "../../apps/api/src/platform/runtime-observability.js";

const row = {
  pending_todos: 12,
  blocked_todos: 2,
  overdue_todos: 3,
  unknown_provider_state: 1,
  permanent_provider_failure: 4,
  outbox_pending: 5,
  outbox_processing: 1,
  outbox_failed: 2,
  visible_lock_waiters: 6,
};

describe("runtime observability", () => {
  it("classifies permission, validation, conflict and technical outcomes without logging arbitrary values", () => {
    expect([400, 401, 403, 409, 500].map(operationalOutcome)).toEqual([
      "validation",
      "permission",
      "permission",
      "conflict",
      "technical",
    ]);
    expect(safeOperationalErrorCode("VERSION_CONFLICT", 409)).toBe("VERSION_CONFLICT");
    expect(safeOperationalErrorCode("cookie=secret", 500)).toBe("INTERNAL_ERROR");
    expect(safeOperationalErrorCode(undefined, 404)).toBe("NOT_FOUND");
  });

  it("captures only aggregate pool, lock, queue and process facts", async () => {
    const database = {
      totalCount: 10,
      idleCount: 7,
      waitingCount: 2,
      query: vi.fn(async () => ({ rows: [row] })),
    };
    const snapshot = await readRuntimeOperationalSnapshot(database as never);
    expect(snapshot).toMatchObject({
      databasePool: { total: 10, idle: 7, waiting: 2 },
      database: { visibleLockWaiters: 6 },
      todos: {
        pending: 12,
        blockedRecipient: 2,
        overdue: 3,
        unknownProviderState: 1,
        permanentProviderFailure: 4,
      },
      outbox: { pending: 5, processing: 1, failed: 2 },
    });
    expect(snapshot.process.rssBytes).toBeGreaterThan(0);
    expect(snapshot.process.heapUsedBytes).toBeGreaterThan(0);
    const sql = String(database.query.mock.calls[0]?.[0]);
    expect(sql).toContain("pg_stat_activity");
    expect(sql).toContain("wait_event_type='Lock'");
    expect(sql).toContain("provider_state='unknown_response'");
    expect(sql).not.toMatch(/cookie|token|secret|password|payload/);
  });

  it("never turns snapshot failure into an application failure or logs raw database error text", async () => {
    const database = {
      totalCount: 1,
      idleCount: 1,
      waitingCount: 0,
      query: vi.fn(async () => { throw new Error("postgresql://user:secret@example.invalid/private"); }),
    };
    const logger = { info: vi.fn(), warn: vi.fn() };
    const monitor = new RuntimeOperationalMonitor(database as never, logger, 10_000);
    monitor.start();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await monitor.stop();
    expect(logger.warn).toHaveBeenCalledWith(
      { operationalSnapshotUnavailable: true },
      "operational runtime snapshot unavailable",
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("secret");
  });
});
