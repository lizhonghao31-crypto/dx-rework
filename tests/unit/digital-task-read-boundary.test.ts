import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { BulkPreparationService } from "../../apps/api/src/production-platform/bulk-preparation-service.js";
import { FactoryFlowService } from "../../apps/api/src/production-platform/factory-flow-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

function fixture() {
  const orderId = randomUUID(), sourceId = randomUUID(), preparationId = randomUUID();
  const workerId = randomUUID(), warehouseId = randomUUID(), designerId = randomUUID(), primaryId = randomUUID();
  const actor = (id = workerId, roles = ["pattern_room_worker"]): TrustedActorContext => ({
    actorId: id, actorRoles: roles, authorizationCapability: "digital_production:view",
    authorizationCapabilities: ["digital_production:view"], requestId: "TEST-task-scope",
  });
  const activeRoles = new Map([[workerId, ["pattern_room_worker"]], [warehouseId, ["warehouse_receiver"]], [primaryId, ["order_merchandiser"]]]);
  const order = { production_order_id: orderId, source_id: sourceId, created_by: designerId, primary_merchandiser_id: primaryId, design_style_no: "TEST-scope", customer_code: "PD" };
  const source = { source_id: sourceId, created_by: designerId, design_style_no: "TEST-scope", customer_code: "PD" };
  const task = (kind: string, assignee: string, role: string) => ({ task_id: randomUUID(), production_order_id: orderId, source_id: null,
    task_kind: kind, assignee_id: assignee, required_role: role, route_instance_id: preparationId, route_version: 2, occurrence: 1,
    state: "ready", entered_at: "2026-10-06T14:00:00Z", created_at: "2026-10-06T14:00:00Z", completed_at: null,
    entered_quality: "现场登记", completed_quality: "缺失", blocked_reason: null });
  const own = task("bulk_pattern", workerId, "pattern_room_worker"), foreign = task("warehouse_preshrink", warehouseId, "warehouse_receiver");
  const rows = [own, foreign];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    let found: object[] = [];
    if (sql.startsWith("SELECT * FROM digital_production_task_access WHERE")) found = rows.filter(row => row.task_id === params[0]);
    else if (sql.includes("SELECT 1 FROM app_users u JOIN user_role_assignments")) found = activeRoles.get(String(params[0]))?.includes(String(params[1])) ? [{}] : [];
    else if (sql.startsWith("SELECT * FROM digital_production_orders")) found = params[0] === orderId ? [order] : [];
    else if (sql.startsWith("SELECT * FROM digital_production_sources")) found = params[0] === sourceId ? [source] : [];
    else if (sql.includes("to_regclass('digital_bulk_preparations')")) found = [{ relation: "digital_bulk_preparations" }];
    else if (sql.includes("to_regclass('digital_development_documents')")) found = [{ relation: null }];
    else if (sql.startsWith("SELECT a.task_id,a.assignee_id,a.required_role")) found = rows.filter(row => row.production_order_id === params[0]);
    else if (sql.startsWith("SELECT t.*,a.production_order_id")) found = rows.filter(row => row.task_id === params[0]);
    else if (sql.startsWith("SELECT r.entered_at")) found = [];
    else if (sql.startsWith("SELECT * FROM digital_production_deadline_policies")) found = [{ label: "TEST task", version: 1, sla_seconds: 3600 }];
    else if (sql.startsWith("SELECT state FROM digital_production_resource_lifecycle")) found = [];
    else if (sql.startsWith("SELECT created_by,primary_merchandiser_id")) found = [order];
    else if (sql.startsWith("SELECT created_by,design_style_no")) found = [source];
    else if (sql.startsWith("SELECT display_name FROM app_users")) found = [{ display_name: params[0] === workerId ? "TEST本人" : "TEST仓管" }];
    else if (sql.startsWith("SELECT count(*)::int AS applicable")) found = [{ applicable: 2, completed: 0, cancelled: 0 }];
    else if (sql.startsWith("SELECT 1 FROM digital_production_task_conditions")) found = [{}];
    else if (sql.startsWith("SELECT payload->>'priority'")) found = [];
    else if (sql.startsWith("SELECT event_id AS")) found = [{ eventId: randomUUID(), kind: "ready", actorName: "TEST历史主办" }];
    else if (sql.startsWith("SELECT r.revision_id AS")) found = [];
    else if (sql.startsWith("SELECT * FROM digital_bulk_preparations")) found = [{ preparation_id: preparationId }];
    else if (sql.startsWith("SELECT * FROM digital_bulk_dispatch")) found = [{ version: 1, pattern_worker_id: workerId, warehouse_worker_id: warehouseId, cutting_worker_id: randomUUID() }];
    else if (sql.startsWith("SELECT po.line_id AS")) found = [];
    else if (sql.startsWith("SELECT kind,recorded_at")) found = [{ kind: "预缩完成", recordedAt: "2026-10-06T14:30:00Z" }];
    else if (sql.startsWith("SELECT t.*,a.task_kind,a.assignee_id")) found = rows;
    else if (sql.startsWith("SELECT min(customer_warehouse_arrival_date")) found = [{ day: "2026-10-20" }];
    else if (sql.startsWith("SELECT child_id FROM digital_production_child_links")) found = [];
    else throw new Error(`Unexpected isolated query: ${sql}`);
    return { rows: found, rowCount: found.length };
  });
  const pool = { query } as unknown as Pool, policy = new DigitalProductionAccessPolicy(pool), service = new DigitalProductionTaskService(pool);
  return { orderId, sourceId, preparationId, workerId, warehouseId, designerId, primaryId, own, foreign, rows, actor, activeRoles, order, source, pool, query, policy, service };
}

describe("task metadata is authorized independently from necessary order documents", () => {
  afterEach(() => vi.restoreAllMocks());

  it("keeps the assigned worker's task and technical order readable, but refuses a sibling task and its history", async () => {
    const f = fixture(), worker = f.actor();
    expect(f.sourceId).not.toBe(f.orderId);
    expect(await f.policy.allowed(worker, "order", f.orderId, "technical")).toBe(true);
    expect(await f.policy.allowed(worker, "task", f.own.task_id, "technical")).toBe(true);
    expect(await f.policy.allowed(worker, "task", f.own.task_id, "execute")).toBe(true);
    expect((await f.service.read(worker, f.own.task_id)).assigneeId).toBe(f.workerId);
    expect((await f.service.history(worker, f.own.task_id)).events).toHaveLength(1);
    f.query.mockClear();
    await expect(f.service.read(worker, f.foreign.task_id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.history(worker, f.foreign.task_id)).rejects.toMatchObject({ statusCode: 404 });
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("SELECT event_id AS") || sql.startsWith("SELECT r.entered_at"))).toBe(false);
    expect(await f.policy.allowed(worker, "task", f.foreign.task_id, "execute")).toBe(false);
  });

  it.each(["root_superuser", "owner_group", "production_management", "pattern_room_supervisor", "development_clerk"])("preserves the existing %s task reader without granting execution", async role => {
    const f = fixture(), reader = f.actor(randomUUID(), [role]);
    f.activeRoles.set(reader.actorId, [role]);
    expect(await f.policy.allowed(reader, "task", f.foreign.task_id, "technical")).toBe(true);
    expect(await f.policy.allowed(reader, "task", f.foreign.task_id, "execute")).toBe(role === "root_superuser");
  });

  it("preserves the source owner and primary merchandiser scope, while rejecting another source owner", async () => {
    const f = fixture();
    expect(await f.policy.allowed(f.actor(f.designerId, ["sample_designer"]), "task", f.foreign.task_id, "technical")).toBe(true);
    expect(await f.policy.allowed(f.actor(f.primaryId, ["order_merchandiser"]), "task", f.foreign.task_id, "technical")).toBe(true);
    expect(await f.policy.allowed(f.actor(randomUUID(), ["sample_designer"]), "task", f.foreign.task_id, "technical")).toBe(false);
  });

  it("does not let an unrelated additional merchandiser role turn task participation into broader metadata access", async () => {
    const f = fixture(), worker = f.actor(f.workerId, ["pattern_room_worker", "order_merchandiser"]);
    f.activeRoles.set(f.workerId, worker.actorRoles);
    expect(await f.policy.allowed(worker, "order", f.orderId, "technical")).toBe(true);
    expect(await f.policy.allowed(worker, "task", f.foreign.task_id, "technical")).toBe(false);
  });

  it("revokes own-task read and execution when the assigned role is no longer active", async () => {
    const f = fixture(); f.activeRoles.delete(f.workerId);
    for (const purpose of ["technical", "execute"] as const) expect(await f.policy.allowed(f.actor(), "task", f.own.task_id, purpose)).toBe(false);
    expect(await f.policy.allowed(f.actor(), "order", f.orderId, "technical")).toBe(false);
  });

  it("keeps a source task's owner-readable identity without granting source-wide or sibling-task access", async () => {
    const f = fixture(); Object.assign(f.own, { production_order_id: null, source_id: f.sourceId, task_kind: "development_pattern" });
    Object.assign(f.foreign, { production_order_id: null, source_id: f.sourceId, task_kind: "development_cutting" });
    expect(await f.policy.allowed(f.actor(), "source", f.sourceId, "technical")).toBe(false);
    expect((await f.service.read(f.actor(), f.own.task_id)).identity).toEqual({ designStyleNo: "TEST-scope", customerCode: "PD" });
    await expect(f.service.read(f.actor(), f.foreign.task_id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("keeps the worker's preparation sheet and prerequisite facts while returning only authorized tasks and dispatch identities", async () => {
    const f = fixture(), bulk = new BulkPreparationService(f.pool);
    vi.spyOn(bulk, "gates").mockResolvedValue({ order: f.order, source: { round_number: 2 }, instruction: { version: 2, document: { preshrink: "需要预缩" } }, approval: { cutting_process: "in_house" }, customerConfirmed: true, ownerApproved: true, instructionValid: true, reasons: [] } as never);
    const sheet = await bulk.read(f.actor(), f.orderId);
    expect(sheet).toMatchObject({ sourceRound: 2, instructionVersion: 2, customerConfirmed: true, ownerApproved: true, instructionValid: true, dispatch: { patternWorkerId: f.workerId, warehouseWorkerId: null, cuttingWorkerId: null } });
    expect(sheet.tasks.map(task => task.taskId)).toEqual([f.own.task_id]);
    expect(sheet.facts[0]?.kind).toBe("预缩完成");
    expect(JSON.stringify(sheet)).not.toContain(f.warehouseId);
    const manager = f.actor(randomUUID(), ["production_management"]);
    expect((await bulk.read(manager, f.orderId)).tasks).toHaveLength(2);
    for (const reader of [f.actor(f.designerId, ["sample_designer"]), f.actor(f.primaryId, ["order_merchandiser"])]) {
      const readable = await bulk.read(reader, f.orderId);
      expect(readable.tasks).toHaveLength(2);
      expect(readable.dispatch.warehouseWorkerId).toBe(f.warehouseId);
      expect(readable.dispatch.cuttingWorkerId).toBeTruthy();
    }
  });

  it("keeps the warehouse's factory work and prerequisite state without sibling-task details", async () => {
    const f = fixture(); f.foreign.task_kind = "warehouse_dispatch";
    const flow = new FactoryFlowService(f.pool);
    vi.spyOn(flow as unknown as { state(...args: unknown[]): Promise<unknown> }, "state").mockResolvedValue({ gate: { order: f.order, reasons: [], approval: {}, instruction: {} }, route: { preparation_id: f.preparationId, secondary_craft: "无" }, returned: null, revision: 1, tasks: f.rows, latest: [], facts: [], checks: [], allQc: true, lastMovement: null, dispatched: false, contract: { status: "ready" } });
    const sheet = await flow.read(f.actor(f.warehouseId, ["warehouse_receiver"]), f.orderId);
    expect(sheet).toMatchObject({ allCut: true, allQc: true, canWarehouse: true });
    expect(sheet.tasks.map(task => task.taskId)).toEqual([f.foreign.task_id]);
    expect(JSON.stringify(sheet)).not.toContain(f.workerId);
    expect((await flow.read(f.actor(randomUUID(), ["production_management"]), f.orderId)).tasks).toHaveLength(2);
  });
});
