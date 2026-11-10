import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { BulkPreparationService } from "../../apps/api/src/production-platform/bulk-preparation-service.js";
import { FactoryFlowService } from "../../apps/api/src/production-platform/factory-flow-service.js";
import { ProductionInstructionService } from "../../apps/api/src/production-platform/production-instruction-service.js";
import { registerInstructionRoutes } from "../../apps/api/src/production-platform/production-instruction-routes.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";

function fixture(sla: "absent" | "unenrolled" | "frozen" = "absent") {
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
    if (["SELECT to_regclass('digital_timeline_adoptions') AS relation", "SELECT to_regclass('digital_preparation_responsibilities') AS relation", "SELECT to_regclass('digital_preparation_material_versions') AS relation"].includes(sql)) found = [{relation:null}];
    else if (sql === "SELECT to_regclass('digital_bulk_preshrink_corrections') AS relation") found = [{relation:'digital_bulk_preshrink_corrections'}];
    else if (sql === 'SELECT preshrink_task_id FROM digital_bulk_preshrink_corrections ORDER BY preshrink_task_id') found = [];
    else if (sql === "SELECT to_regclass('digital_sla_configurations') AS relation") found = [{relation:sla==='absent'?null:'digital_sla_configurations'}];
    else if (sql === "SELECT to_regclass('digital_sla_order_snapshots') AS relation") found = [{relation:'digital_sla_order_snapshots'}];
    else if ((sql === 'SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision DESC LIMIT 1'||sql === 'SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1 ORDER BY revision LIMIT 1')) {expect(params[0]).toBe(orderId);found=[];}
    else if (sql.startsWith('SELECT line_id, customer_warehouse_arrival_date::text AS customer_date, (customer_warehouse_arrival_date-$2::int)::text AS target_date,') && sql.includes('FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position')) {expect(params[0]).toBe(orderId);found=[];}
    else if (sql === "SELECT e.event_id,e.occurred_at,e.payload,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id\n WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='ship_sample_sent' ORDER BY e.recorded_at,e.event_id") {expect(params[0]).toBe(orderId);found=[];}
    else if (sql === "SELECT to_regclass('digital_factory_facts') AS relation") found = [{relation:'digital_factory_facts'}];
    else if (sql.startsWith('SELECT f.*,u.display_name,v.order_snapshot FROM digital_factory_facts f JOIN digital_factory_routes r USING(preparation_id)') && sql.includes("WHERE r.production_order_id=$1 AND f.kind='船样寄出' ORDER BY f.recorded_at")) {expect(params[0]).toBe(orderId);found=[];}
    else if (sql.startsWith('SELECT s.production_order_id,s.factory_decision_id,s.shipped_on::text AS shipped_on,s.operation_event_id,p.supplier_name_snapshot,') && sql.includes("WHERE link.module='production' AND link.production_order_id=$1 ORDER BY s.shipped_on,s.production_order_id,s.factory_decision_id")) {expect(params[0]).toBe(orderId);found=[];}
    else if (sql === "SELECT to_regclass('digital_development_sla_plans') AS relation") found = [{relation:null}];
    else if (sql.startsWith('SELECT t.created_at,a.production_order_id,a.source_id,')) found = rows.filter(row=>row.task_id===params[0]).map(row=>({...row,resource_created_at:row.created_at}));
    else if (sql.startsWith('SELECT p.* FROM digital_production_deadline_revisions r')) found = [];
    else if (sql.startsWith('SELECT c.* FROM digital_sla_order_snapshots s')&&sql.includes('JOIN digital_sla_configurations c')) found = sla==='frozen'&&params[0]===orderId?[{policy_refs_json:{policies:{bulk_pattern:{nodeKey:'bulk_pattern',version:7}}}}]:[];
    else if (sql === 'SELECT * FROM digital_production_deadline_policies WHERE node_key=$1 AND version=$2') found = params[0]==='bulk_pattern'&&params[1]===7?[{label:'TEST frozen task',version:7,sla_seconds:7200,warning_ratio:0.7}]:[];
    else if (sql.startsWith("SELECT * FROM digital_production_task_access WHERE")) found = rows.filter(row => row.task_id === params[0]);
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
    else if (sql.startsWith("SELECT condition_key FROM digital_production_task_conditions")) found = [];
    else if (sql.startsWith("SELECT p.task_id,p.state,a.task_kind")) found = [];
    else if (sql.includes("to_regclass('digital_development_round_arrangements')")) found = [{relation:null}];
    else if (sql.includes("to_regclass('digital_development_execution_facts')")) found = [{relation:null}];
    else if (sql.startsWith("SELECT payload->>'priority'")) found = [];
    else if (sql.startsWith("SELECT event_id AS")) found = [{ eventId: randomUUID(), kind: "ready", actorName: "TEST历史主办" }];
    else if (sql.startsWith("SELECT r.revision_id AS")) found = [];
    else if (sql.startsWith("SELECT * FROM digital_bulk_preparations")) found = [{ preparation_id: preparationId }];
    else if (sql.startsWith("SELECT * FROM digital_bulk_dispatch")) found = [{ version: 1, pattern_worker_id: workerId, warehouse_worker_id: warehouseId, cutting_worker_id: randomUUID() }];
    else if (sql.startsWith("SELECT po.line_id AS")) found = [];
    else if (sql.startsWith("SELECT kind,recorded_at")) found = [{ kind: "预缩完成", recordedAt: "2026-10-06T14:30:00Z" }];
    else if (sql.startsWith("SELECT t.*,a.task_kind,a.assignee_id")) found = rows;
    else if (sql === "SELECT e.event_id,e.occurred_at,e.payload,u.display_name FROM digital_production_task_events e JOIN app_users u ON u.id=e.actor_id WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='bulk_materials_dispatched' ORDER BY e.recorded_at,e.event_id") found = params[0] === orderId ? [{event_id:'TEST-material-dispatch',occurred_at:'2026-10-06T14:30:00Z',payload:{note:'TEST原辅料已发出',items:[]},display_name:'TEST仓库'}] : [];
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

  it.each(['absent','unenrolled','frozen'] as const)('keeps the %s SLA read inside the authorized order and rejects unknown queries',async mode=>{
    const f=fixture(mode),read=await f.service.read(f.actor(),f.own.task_id);
    expect(read.policyVersion).toBe(mode==='frozen'?7:1);expect(read.slaHours).toBe(mode==='frozen'?2:1);
    expect(read.canExecute).toBe(true);expect(read.orderId).toBe(f.orderId);
    f.query.mockClear();
    for(const id of [f.foreign.task_id,randomUUID()]){
      await expect(f.service.read(f.actor(),id)).rejects.toMatchObject({statusCode:404});
      await expect(f.service.history(f.actor(),id)).rejects.toMatchObject({statusCode:404});
    }
    expect(f.query.mock.calls.some(([sql])=>sql.includes('digital_sla_configurations')||sql.startsWith('SELECT event_id AS'))).toBe(false);
    await expect(f.pool.query('SELECT unexpected_isolated_query')).rejects.toThrow('Unexpected isolated query');
  });

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
    vi.spyOn(bulk, "gates").mockResolvedValue({ order: f.order, source: { round_number: 2 }, instruction: { version: 2, document: { preshrink: "需要预缩" } }, approval: { cutting_process: "in_house" }, customerConfirmed: true, ownerApproved: true, instructionValid: true, technicalReasons: [], parallel: false, snapshotId: null, fabric: null, terminal: false, reasons: [] } as never);
    const sheet = await bulk.read(f.actor(), f.orderId);
    expect(sheet).toMatchObject({ sourceRound: 2, instructionVersion: 2, customerConfirmed: true, ownerApproved: true, instructionValid: true, dispatch: { patternWorkerId: f.workerId, warehouseWorkerId: null, cuttingWorkerId: null } });
    expect(sheet.tasks.map(task => task.taskId)).toEqual([f.own.task_id]);
    expect(sheet.facts[0]?.kind).toBe("预缩完成");
    expect(sheet.materials?.history).toMatchObject([{eventId:"TEST-material-dispatch",note:"TEST原辅料已发出",items:[]}]);
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

  it.each(["pattern_room_worker", "warehouse_receiver"])("returns only current instruction reference fields for an assigned %s", async role => {
    const f = fixture(), bulk = new BulkPreparationService(f.pool), imageId = randomUUID();
    const reader = role === "pattern_room_worker" ? f.actor() : f.actor(f.warehouseId, [role]);
    const other = role === "pattern_room_worker" ? f.foreign : f.own;
    vi.spyOn(bulk, "gates").mockResolvedValue({ order: f.order, source: { round_number: 2, document: { files: [{ attachmentId: randomUUID(), kind: "款图" }] } },
      instruction: { version: 2, source_round: 2, order_snapshot: { productionOrderId: f.orderId, designStyleNo: "TEST-PUBLISHED-V2", customerCode: "TEST-CUSTOMER-V2", budget: "TEST-HIDDEN-BUDGET", primaryMerchandiserId: "TEST-HIDDEN-PERSON" },
        document: { preshrink: "需要预缩", images: [{ attachmentId: randomUUID(), kind: "其它工艺" }, { attachmentId: imageId, kind: "款图" }] } },
      approval: { cutting_process: "in_house" }, customerConfirmed: true, ownerApproved: true, instructionValid: true, technicalReasons: [], parallel: false, snapshotId: null, fabric: null, terminal: false, reasons: [] } as never);
    const sheet = await bulk.read(reader, f.orderId);
    expect(sheet.reference).toEqual({ designStyleNo: "TEST-PUBLISHED-V2", customerCode: "TEST-CUSTOMER-V2", styleImageUrl: `/api/digital-production/orders/${f.orderId}/instruction/attachments/${imageId}`, instructionVersion: 2, sourceRound: 2 });
    expect(sheet.tasks).toHaveLength(1);
    expect(JSON.stringify(sheet)).not.toContain(other.task_id);
    expect(JSON.stringify(sheet)).not.toContain("TEST-HIDDEN-BUDGET");
    expect(JSON.stringify(sheet)).not.toContain("TEST-HIDDEN-PERSON");
    expect(await f.policy.allowed(reader, "source", f.sourceId, "technical")).toBe(false);
    expect(await f.policy.allowed(reader, "order", f.orderId, "budget")).toBe(false);
    await expect(f.service.read(reader, other.task_id)).rejects.toMatchObject({ statusCode: 404 });
    await expect(f.service.history(reader, other.task_id)).rejects.toMatchObject({ statusCode: 404 });
  });

  it("does not use an old instruction snapshot or image for another source round", async () => {
    const f = fixture(), bulk = new BulkPreparationService(f.pool), oldImageId = randomUUID();
    vi.spyOn(bulk, "gates").mockResolvedValue({ order: f.order, source: { round_number: 3 },
      instruction: { version: 2, source_round: 2, order_snapshot: { designStyleNo: "TEST-OLD-STYLE", customerCode: "TEST-OLD-CUSTOMER" }, document: { preshrink: "需要预缩", images: [{ attachmentId: oldImageId, kind: "款图" }] } },
      approval: { cutting_process: "in_house" }, customerConfirmed: true, ownerApproved: true, instructionValid: false, technicalReasons: ["请核对当前开发资料并发布有效大货制单"], parallel: false, snapshotId: null, fabric: null, terminal: false, reasons: ["请核对当前开发资料并发布有效大货制单"] } as never);
    const sheet = await bulk.read(f.actor(randomUUID(), ["pattern_room_supervisor"]), f.orderId);
    expect(sheet.reference).toEqual({ designStyleNo: f.order.design_style_no, customerCode: f.order.customer_code, styleImageUrl: null, instructionVersion: null, sourceRound: null });
    expect(sheet).toMatchObject({ sourceRound: 3, instructionVersion: 2, instructionValid: false });
    expect(sheet.reasons).toContain("请核对当前开发资料并发布有效大货制单");
    expect(JSON.stringify(sheet)).not.toContain(oldImageId);
    expect(JSON.stringify(sheet)).not.toContain("TEST-OLD-STYLE");
  });

  it("does not fall back to development images when the bound published instruction has no style image", async () => {
    const f = fixture(), bulk = new BulkPreparationService(f.pool), sourceImageId = randomUUID(), processImageId = randomUUID();
    vi.spyOn(bulk, "gates").mockResolvedValue({ order: f.order, source: { round_number: 2, document: { files: [{ attachmentId: sourceImageId, kind: "款图" }] } },
      instruction: { version: 2, source_round: 2, order_snapshot: { designStyleNo: "TEST-PUBLISHED-V2", customerCode: "TEST-CUSTOMER-V2" }, document: { preshrink: "需要预缩", images: [{ attachmentId: processImageId, kind: "其它工艺" }] } },
      approval: { cutting_process: "in_house" }, customerConfirmed: true, ownerApproved: true, instructionValid: true, technicalReasons: [], parallel: false, snapshotId: null, fabric: null, terminal: false, reasons: [] } as never);
    const sheet = await bulk.read(f.actor(), f.orderId);
    expect(sheet.reference).toMatchObject({ designStyleNo: "TEST-PUBLISHED-V2", customerCode: "TEST-CUSTOMER-V2", styleImageUrl: null, instructionVersion: 2, sourceRound: 2 });
    expect(JSON.stringify(sheet)).not.toContain(sourceImageId);
    expect(JSON.stringify(sheet)).not.toContain(processImageId);
  });

  it("does not add reference scope for an unrelated or newly ineligible worker", async () => {
    const f = fixture(), bulk = new BulkPreparationService(f.pool);
    const gates = vi.spyOn(bulk, "gates");
    await expect(bulk.read(f.actor(randomUUID()), f.orderId)).rejects.toMatchObject({ statusCode: 404 });
    f.activeRoles.set(f.workerId, []);
    await expect(bulk.read(f.actor(), f.orderId)).rejects.toMatchObject({ statusCode: 404 });
    expect(gates).not.toHaveBeenCalled();
  });

  it.each(["pattern_room_worker", "warehouse_receiver"])("keeps the native instruction attachment route scoped for %s", async role => {
    const f = fixture(), imageId = randomUUID(), unpublishedImageId = randomUUID(), foreignOrderId = randomUUID();
    const reader = role === "pattern_room_worker" ? f.actor() : f.actor(f.warehouseId, [role]);
    Object.assign(f.order, { created_at: "2026-10-12T04:00:00Z", order_date: "2026-10-12", version: 2, product_group: "TEST" });
    const version = { version: 2, source_round: 2, document: { images: [{ attachmentId: imageId, kind: "款图" }] }, order_snapshot: { productionOrderId: f.orderId, lines: [] } };
    const originalQuery = f.query.getMockImplementation()!;
    const query = vi.fn(async (sql: string, args: unknown[] = []) => {
      let rows: object[];
      if (sql.startsWith("SELECT o.* FROM digital_production_orders")) rows = args[0] === f.orderId ? [f.order] : [];
      else if (sql.startsWith("SELECT l.line_id") || sql.startsWith("SELECT line_id,po_number,color") || sql.startsWith("SELECT 1 FROM digital_production_child_links l JOIN cutting_orders")) rows = [];
      else if (sql.startsWith("SELECT published_version FROM digital_instruction_documents")) rows = [{ published_version: 2 }];
      else if (sql.startsWith("SELECT * FROM digital_instruction_versions")) rows = args[0] === f.orderId && args[1] === 2 ? [version] : [];
      else if (sql.startsWith("SELECT version,primary_merchandiser_id FROM digital_production_orders")) rows = [f.order];
      else if (sql.startsWith("SELECT to_regclass('digital_production_resource_lifecycle')") || sql.startsWith("SELECT to_regclass('digital_order_closures')") || sql.startsWith("SELECT to_regclass($1)")) rows = [{ relation: null }];
      else if (sql.startsWith("SELECT * FROM digital_development_documents") || sql.startsWith("SELECT a.after_state,a.created_at,u.display_name")) rows = [];
      else if (sql.startsWith("SELECT version FROM digital_instruction_versions")) rows = [{ version: 2 }];
      else if (sql.startsWith("SELECT 1 FROM digital_instruction_versions v CROSS JOIN LATERAL")) rows = args[0] === f.orderId && args[1] === imageId ? [{}] : [];
      else return originalQuery(sql, args);
      return { rows, rowCount: rows.length };
    });
    const service = new ProductionInstructionService({ query } as unknown as Pool, false), app = Fastify();
    let issued = 0;
    registerInstructionRoutes(app, { authenticate: async () => ({ id: reader.actorId, displayName: "TEST本人", businessRoles: [role], capabilities: ["digital_production:view"] }) } as never, service,
      { createDownloadIntent: async (_actor: TrustedActorContext, _attachmentId: string, authorize: () => Promise<boolean>) => {
        if (!await authorize()) throw new ApplicationError("FORBIDDEN", "TEST附件未在已发布制单引用", 403);
        issued++; return { downloadUrl: "/TEST-current-instruction-image" };
      } } as never);
    try {
      expect(await service.canDownload(reader, f.orderId, imageId)).toBe(true);
      expect(await service.canDownload(reader, f.orderId, unpublishedImageId)).toBe(false);
      await expect(service.canDownload(reader, foreignOrderId, imageId)).rejects.toMatchObject({ statusCode: 404 });
      const current = await app.inject({ method: "GET", url: `/digital-production/orders/${f.orderId}/instruction/attachments/${imageId}` });
      expect(current.statusCode).toBe(302); expect(current.headers.location).toBe("/TEST-current-instruction-image");
      const foreign = await app.inject({ method: "GET", url: `/digital-production/orders/${foreignOrderId}/instruction/attachments/${imageId}` });
      expect(foreign.statusCode).toBe(404); expect(issued).toBe(1);
      const unpublished = await app.inject({ method: "GET", url: `/digital-production/orders/${f.orderId}/instruction/attachments/${unpublishedImageId}` });
      expect(unpublished.statusCode).toBe(403); expect(issued).toBe(1);
    } finally { await app.close(); }
  });

  it("keeps the warehouse's factory work and prerequisite state without sibling-task details", async () => {
    const f = fixture(); f.foreign.task_kind = "warehouse_dispatch";
    const flow = new FactoryFlowService(f.pool);
    vi.spyOn(flow as unknown as { state(...args: unknown[]): Promise<unknown> }, "state").mockResolvedValue({ gate: { order: f.order, reasons: [], approval: {}, instruction: {} }, route: { preparation_id: f.preparationId, secondary_craft: "无" }, returned: null, revision: 1, production: {history: [], checks: [], complete: false, facts: {}}, tasks: f.rows, latest: [], facts: [], checks: [], allQc: true, lastMovement: null, dispatched: false, contract: { status: "ready" } });
    const sheet = await flow.read(f.actor(f.warehouseId, ["warehouse_receiver"]), f.orderId);
    expect(sheet).toMatchObject({ allCut: true, allQc: true, canWarehouse: true });
    expect(sheet.returnLogistics).toEqual([]);
    expect(sheet.productionChecks).toEqual([]);expect(sheet.shipSamples).toEqual([]);expect(sheet.canProductionQc).toBe(false);expect(sheet.canRecordShipSample).toBe(false);
    expect(sheet.tasks.map(task => task.taskId)).toEqual([f.foreign.task_id]);
    expect(JSON.stringify(sheet)).not.toContain(f.workerId);
    expect((await flow.read(f.actor(randomUUID(), ["production_management"]), f.orderId)).tasks).toHaveLength(2);
  });
});
