import { describe, expect, it, vi } from "vitest";

import { WorkReportsBatchResponseSchema } from "@dx-rework/contracts";
import { WorkReportingService } from "../../apps/api/src/rework/work-reporting-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

const uuid = (value: number): string =>
  `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;

class MemoryIdempotency {
  private readonly completed = new Map<string, { statusCode: number; response: unknown }>();

  async execute<T>(
    _client: unknown,
    input: { scope: string; actorKey: string; key: string },
    work: () => Promise<{ statusCode: number; response: T }>,
  ): Promise<{ statusCode: number; response: T; reused: boolean }> {
    const cacheKey = `${input.scope}:${input.actorKey}:${input.key}`;
    const existing = this.completed.get(cacheKey);
    if (existing) return { ...existing, response: existing.response as T, reused: true };
    const result = await work();
    this.completed.set(cacheKey, result);
    return { ...result, reused: false };
  }
}

const createHarness = (input: {
  taskCount: number;
  membersPerTask: number;
  actorId: string;
  memberAppUserId?: (taskIndex: number, memberIndex: number) => string | null;
  executionKind?: (taskIndex: number) => "worker" | "tail_inspection";
  failShares?: boolean;
}) => {
  const orderId = uuid(1);
  const taskIds = Array.from({ length: input.taskCount }, (_, index) => uuid(100 + index));
  const tasks = taskIds.map((taskId, index) => ({
    work_task_id: taskId,
    rework_order_id: orderId,
    configuration_item_id: uuid(1_000 + index),
    task_version: 1,
    assignment_mode: "individual" as const,
    status: "active" as const,
    process_name: `极端工序${index + 1}`,
    execution_kind: input.executionKind?.(index) ?? "worker",
    pricing_unit: "piece" as const,
    planned_quantity: "5000",
    unit_price: "1",
  }));
  const members = tasks.flatMap((task, taskIndex) => Array.from(
    { length: input.membersPerTask },
    (_, memberIndex) => ({
      work_task_id: task.work_task_id,
      person_id: uuid(10_000 + taskIndex * input.membersPerTask + memberIndex),
      person_type: "temporary" as const,
      display_name: `临时工${taskIndex + 1}-${memberIndex + 1}`,
      app_user_id: input.memberAppUserId?.(taskIndex, memberIndex) ?? null,
    }),
  ));
  const commands: string[] = [];
  let insertedEventCount = 0;
  let insertedShareCount = 0;
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    commands.push(sql);
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rowCount: 0, rows: [] };
    if (sql.includes("SELECT task.work_task_id,task.rework_order_id") && sql.includes("task.work_task_id=ANY")) {
      return { rowCount: tasks.length, rows: tasks };
    }
    if (sql.includes("FROM rework_orders WHERE rework_order_id=$1")) {
      return {
        rowCount: 1,
        rows: [{
          rework_order_id: orderId,
          rework_no: "RW-STRESS-UNIT",
          status: "in_progress",
          version: 2,
          style_no: "STRESS",
          order_no: "STRESS-ORDER",
          merchandiser_user_id: null,
          processing_factory_type: "own_factory",
          processing_factory_supplier_id: null,
          processing_factory_supplier_version: null,
          problem_part: "全单",
          problem_description: "极端批量报数",
          rework_quantity: 5_000,
        }],
      };
    }
    if (sql.includes("FROM rework_work_task_members member") && sql.includes("work_task_id=ANY")) {
      return { rowCount: members.length, rows: members };
    }
    if (sql.includes("SELECT report.work_report_id,report.work_task_id") && sql.includes("work_task_id=ANY")) {
      return { rowCount: 0, rows: [] };
    }
    if (sql.includes(") AS ready")) return { rowCount: 1, rows: [{ ready: true }] };
    if (sql.includes("INSERT INTO operation_events(")) {
      const rows = JSON.parse(values[0] as string) as unknown[];
      insertedEventCount += rows.length;
      return { rowCount: rows.length, rows: [] };
    }
    if (sql.includes("SELECT set_config(")) return { rowCount: 1, rows: [{}] };
    if (sql.includes("INSERT INTO rework_work_reports(")) {
      const rows = JSON.parse(values[0] as string) as Array<{ work_report_id: string }>;
      return {
        rowCount: rows.length,
        rows: rows.map((row) => ({ work_report_id: row.work_report_id, completed_at: new Date("2026-08-23T08:00:00.000Z") })),
      };
    }
    if (sql.includes("INSERT INTO rework_work_report_member_shares")) {
      if (input.failShares) throw new Error("share insert failed");
      const rows = JSON.parse(values[0] as string) as unknown[];
      insertedShareCount += rows.length;
      return { rowCount: rows.length, rows: [] };
    }
    if (sql.includes("UPDATE rework_orders SET status='pending_order_review'")) {
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`Unexpected SQL in batch harness: ${sql}`);
  });
  const release = vi.fn();
  const database = { connect: vi.fn(async () => ({ query, release })) };
  const service = new WorkReportingService(database as never, new MemoryIdempotency() as never);
  return {
    service,
    orderId,
    taskIds,
    query,
    commands,
    release,
    insertedEvents: () => insertedEventCount,
    insertedShares: () => insertedShareCount,
  };
};

const root = (actorId: string): TrustedActorContext => ({
  actorId,
  actorRoles: ["root_superuser"],
  authorizationCapability: "work:report_for_worker",
  authorizationCapabilities: ["work:report_for_worker", "business:read_all"],
  requestId: "batch-performance-request",
});

describe("work report batch set-based persistence", () => {
  it("persists 50 reports and 400 member shares with one statement per data set and reuses the result", async () => {
    const actorId = uuid(2);
    const harness = createHarness({ taskCount: 50, membersPerTask: 8, actorId });
    const request = {
      expectedOrderVersion: 2,
      reports: harness.taskIds.map((workTaskId) => ({ workTaskId, actualQuantity: 5_000 })),
    };

    const first = await harness.service.submitReportsBatch(root(actorId), harness.orderId, request, "batch-50");
    const writesAfterFirst = harness.commands.filter((sql) => sql.includes("INSERT INTO operation_events(")
      || sql.includes("INSERT INTO rework_work_reports(")
      || sql.includes("INSERT INTO rework_work_report_member_shares"));
    const callsAfterFirst = harness.query.mock.calls.length;
    const second = await harness.service.submitReportsBatch(root(actorId), harness.orderId, request, "batch-50");

    expect(first.value.reports).toHaveLength(50);
    expect(WorkReportsBatchResponseSchema.parse(first.value)).toEqual(first.value);
    expect(first.value).toMatchObject({ reworkStatus: "pending_order_review", orderVersion: 3 });
    expect(first.value.reports.every((report) => report.memberShares.length === 8)).toBe(true);
    expect(harness.insertedEvents()).toBe(50);
    expect(harness.insertedShares()).toBe(400);
    expect(writesAfterFirst).toHaveLength(3);
    expect(callsAfterFirst).toBeLessThanOrEqual(13);
    expect(harness.commands.filter((sql) => sql.includes("INSERT INTO operation_events("))).toHaveLength(1);
    expect(harness.commands.filter((sql) => sql.includes("INSERT INTO rework_work_reports("))).toHaveLength(1);
    expect(harness.commands.filter((sql) => sql.includes("INSERT INTO rework_work_report_member_shares"))).toHaveLength(1);
    expect(second).toEqual({ value: first.value, reused: true });
    expect(harness.query.mock.calls.length).toBe(callsAfterFirst + 2);
  });

  it("rolls back the whole transaction when the set-based share insert fails", async () => {
    const actorId = uuid(2);
    const harness = createHarness({ taskCount: 6, membersPerTask: 8, actorId, failShares: true });
    await expect(harness.service.submitReportsBatch(root(actorId), harness.orderId, {
      expectedOrderVersion: 2,
      reports: harness.taskIds.map((workTaskId) => ({ workTaskId, actualQuantity: 5_000 })),
    }, "batch-rollback")).rejects.toThrow("share insert failed");

    expect(harness.commands).toContain("ROLLBACK");
    expect(harness.commands).not.toContain("COMMIT");
  });

  it("returns one valid response for 48 worker and 2 tail-inspection reports in the same 50-item Root batch", async () => {
    const actorId = uuid(2);
    const harness = createHarness({
      taskCount: 50,
      membersPerTask: 1,
      actorId,
      executionKind: (taskIndex) => taskIndex < 48 ? "worker" : "tail_inspection",
    });
    const result = await harness.service.submitReportsBatch(root(actorId), harness.orderId, {
      expectedOrderVersion: 2,
      reports: harness.taskIds.map((workTaskId) => ({ workTaskId, actualQuantity: 5_500 })),
    }, "batch-48-workers-2-tail");

    expect(WorkReportsBatchResponseSchema.parse(result.value)).toEqual(result.value);
    expect(result.value).toMatchObject({
      reworkStatus: "pending_order_review",
      orderVersion: 3,
    });
    expect(result.value.reports).toHaveLength(50);
    expect(harness.insertedEvents()).toBe(50);
    expect(harness.insertedShares()).toBe(50);
    expect(harness.commands.filter((sql) => sql.includes("INSERT INTO rework_work_reports("))).toHaveLength(2);
    expect(harness.commands.filter((sql) => sql.includes("INSERT INTO rework_work_report_member_shares"))).toHaveLength(2);
  });

  it("rejects an ordinary worker batch containing another worker's task before any audit or report write", async () => {
    const actorId = uuid(2);
    const harness = createHarness({
      taskCount: 2,
      membersPerTask: 1,
      actorId,
      memberAppUserId: (taskIndex) => taskIndex === 0 ? actorId : uuid(3),
    });
    const worker: TrustedActorContext = {
      actorId,
      actorRoles: ["worker"],
      authorizationCapability: "work:report",
      authorizationCapabilities: ["work:report"],
      requestId: "ordinary-worker-batch",
    };

    await expect(harness.service.submitReportsBatch(worker, harness.orderId, {
      expectedOrderVersion: 2,
      reports: harness.taskIds.map((workTaskId) => ({ workTaskId, actualQuantity: 5_000 })),
    }, "forbidden-batch")).rejects.toMatchObject({ code: "FORBIDDEN", statusCode: 403 });

    expect(harness.commands.some((sql) => sql.includes("INSERT INTO operation_events("))).toBe(false);
    expect(harness.commands.some((sql) => sql.includes("INSERT INTO rework_work_reports("))).toBe(false);
    expect(harness.commands).toContain("ROLLBACK");
  });
});
