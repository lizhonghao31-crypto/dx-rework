import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrationExecutionSql } from "../../scripts/deploy/migration-execution-compatibility.mjs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TodoListResponseSchema } from "@dx-rework/contracts";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(url ? describe : describe.skip)("digital own todo identity and existing search", () => {
  const schema = ownedPostgresSchema("digital_own_todo"), admin = new pg.Pool({ connectionString: url! });
  const db = new pg.Pool({ connectionString: url!, options: `-c search_path=${schema}` });
  const ids = { root: randomUUID(), merch: randomUUID(), clerk: randomUUID(), peer: randomUUID(), tech: randomUUID(), manager: randomUUID() };
  const root: TrustedActorContext = { actorId: ids.root, actorRoles: ["root_superuser"], authorizationCapability: "todo:view", authorizationCapabilities: ["todo:view", "digital_production:source:create", "digital_production:order:create"], requestId: randomUUID() };
  const actors: Record<string, TrustedActorContext> = {};
  const tasks = new DigitalProductionTaskService(db), notices = new DigitalProductionNotificationService(db);
  const todos = new TodoService(db, undefined, undefined, undefined, notices), access = new DigitalProductionAccessService(db), policy = new DigitalProductionAccessPolicy(db);
  const tx = async <T,>(work: (client: pg.PoolClient) => Promise<T>): Promise<T> => {
    const client = await db.connect();
    try { await client.query("BEGIN"); const result = await work(client); await client.query("COMMIT"); return result; }
    catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
  };
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)");
    const directory = new URL("../../apps/api/migrations/", import.meta.url);
    const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:{version:string;checksum:string}[]};
    const serverVersion=Number((await db.query("SHOW server_version_num")).rows[0].server_version_num);
    for(const migration of manifest.migrations){
      const sql=await readFile(new URL(`${migration.version}.sql`,directory),"utf8");
      await tx(async client=>{
        await client.query(migrationExecutionSql({...migration,sql},serverVersion));
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]);
      });
    }
    // Identities exist only in this owned test schema. Runtime policies and delegation services are real.
    await tx(async c => {
      await c.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
      for (const [name, roles] of [["root", ["order_merchandiser"]], ["merch", ["order_merchandiser"]], ["clerk", ["development_clerk"]], ["peer", ["development_clerk"]], ["tech", ["pattern_room_supervisor"]], ["manager", ["production_management"]]] as const) {
        const id = ids[name];
        await c.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, `TEST ${name}`]);
        await c.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','OWN-TODO',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)", [randomUUID(), id]);
        for (const role of roles) await c.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST')", [randomUUID(), id, role, ids.root]);
        const capabilities = (await c.query("SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])", [roles])).rows.map(r => r.capability as string);
        actors[name] = { actorId: id, actorRoles: [...roles], authorizationCapability: "todo:view", authorizationCapabilities: capabilities, requestId: randomUUID() };
      }
      await c.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");
    });
    await db.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','OWN-TODO') ON CONFLICT(policy_key) DO UPDATE SET dingtalk_corp_id='OWN-TODO'");
  }, 60000);
  afterAll(async () => { await db.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  const sourceTask = async (assignee: string | null = ids.clerk, pending = false) => {
    const style = `TEST-DOC-SOURCE-${randomUUID()}`;
    const source = await new DigitalProductionIdentityService(db, true).createSource(root, { developmentType: "头版", designStyleNo: style, temporaryStyleNo: null, customerCode: "PD" }, randomUUID());
    const task = await tx(c => tasks.createWithClient(c, root, { resource: { kind: "source", id: source.sourceId }, kind: "development_materials", routeId: randomUUID(), routeVersion: 1, occurrence: 1, assigneeId: assignee, ...(pending ? { conditions: ["washing_finished" as const] } : {}) }));
    return { style, sourceId: source.sourceId, taskId: task.taskId };
  };
  const list = async (actor: TrustedActorContext, query?: string) => TodoListResponseSchema.parse(await todos.listForActor(actor, { module: "digital_production", ...(query ? { query } : {}) }));
  it("searches the actual primary merchandiser order style and keeps node title separate", async () => {
    const style = `TEST-DOC-ORDER-${randomUUID()}`;
    const order = await new DigitalProductionIdentityService(db, true).createOrder(root, { customerCode: "PD", primaryMerchandiserId: ids.merch, productGroup: "男装", designStyleNo: style, orderDate: "2026-10-06", lines: [{ color: "TEST PRIVATE COLOR", sizes: [{ size: "M", quantity: 9 }] }] }, randomUUID());
    const task = await tx(c => tasks.createWithClient(c, root, { resource: { kind: "order", id: order.productionOrderId }, kind: "sourcing_preparation", routeId: randomUUID(), routeVersion: 5, occurrence: 1, assigneeId: ids.merch }));
    const before = await tasks.read(actors.merch!, task.taskId);
    const found = await list(actors.merch!, style.toLowerCase());
    expect(found.todos.map(t => t.todoId)).toEqual([task.taskId]);
    expect(found.todos[0]!.orderContext).toEqual({ reworkNo: null, orderNo: null, styleNo: style, supplierName: null, status: "ready", updatedAt: found.todos[0]!.createdAt });
    expect(found.todos[0]!.taskTitle).toBe("跟单核实并发起外发");
    expect(await policy.allowed(actors.merch!, "order", order.productionOrderId, "technical")).toBe(true);
    expect(await tasks.read(actors.merch!, task.taskId)).toEqual(before);
    expect((await list(actors.peer!, style)).todos).toEqual([]);
    expect(JSON.stringify(found.todos)).not.toMatch(/PRIVATE COLOR|customerCode|price|wage|budget/);
  });
  it("PR05 ignores historical execute grants and preserves legitimate task handover", async () => {
    const f = await sourceTask(), unrelated = await sourceTask(ids.peer);
    expect(await policy.allowed(actors.clerk!, "source", f.sourceId, "technical")).toBe(false);
    const own = (await list(actors.clerk!, f.style)).todos;
    expect(own.map(t => t.todoId)).toEqual([f.taskId]);
    expect(own[0]!.orderContext?.styleNo).toBe(f.style);
    expect((await list(actors.clerk!, unrelated.style)).todos).toEqual([]);
    expect((await list(actors.peer!, f.style)).todos).toEqual([]);
    await expect(access.delegate(root,{resourceKind:"task",resourceId:f.taskId,delegateId:ids.peer,purpose:"execute",expiresAt:new Date(Date.now()+60000).toISOString()})).rejects.toMatchObject({statusCode:403});
    await db.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'execute',$4,CURRENT_TIMESTAMP+interval '1 hour')",[randomUUID(),f.taskId,ids.peer,ids.root]);
    expect((await list(actors.peer!,f.style)).todos).toEqual([]);
    expect(await policy.allowed(actors.peer!,"task",f.taskId,"execute")).toBe(false);
    expect(await policy.allowed(actors.peer!, "source", f.sourceId, "technical")).toBe(false);
    await db.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP+interval '1 hour')",[randomUUID(),f.taskId,ids.tech,ids.root]);
    expect((await list(actors.tech!, f.style)).todos).toEqual([]);
    // Historical expired grant fixture; the immutable grant is never edited.
    await db.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,created_at,expires_at) VALUES($1,$2,$3,'execute',$4,CURRENT_TIMESTAMP-interval '2 days',CURRENT_TIMESTAMP-interval '1 day')", [randomUUID(), f.taskId, ids.peer, ids.root]);
    expect((await list(actors.peer!, f.style)).todos).toEqual([]);
    const before=await tasks.read(root,f.taskId);
    await tasks.reassign(root,f.taskId,ids.peer,randomUUID());
    expect((await list(actors.peer!,f.style)).todos.map(t=>t.todoId)).toEqual([f.taskId]);
    expect((await list(actors.clerk!,f.style)).todos).toEqual([]);
    expect(await tasks.read(root,f.taskId)).toMatchObject({enteredAt:before.enteredAt,dueAt:before.dueAt});
    expect(await policy.allowed(actors.peer!,"source",f.sourceId,"technical")).toBe(false);
  });
  it("does not invent a style when the exact resource identity is unavailable", async () => {
    const f = await sourceTask();
    const unavailable = new Proxy(db, { get(target, key) {
      if (key !== "query") return Reflect.get(target, key);
      return async (text: string, values?: unknown[]) => {
        const result = await target.query(text, values);
        // Simulate an unavailable joined identity, preserving all real access/state checks.
        if (text.includes("AS source_style_no")) result.rows = result.rows.map(row => row.task_id === f.taskId ? { ...row, source_style_no: null } : row);
        return result;
      };
    } });
    const projected = (await new DigitalProductionNotificationService(unavailable).todos(actors.clerk!)).find(t => t.todoId === f.taskId)!;
    expect(projected.orderContext).toBeNull(); expect(projected.taskTitle).toBe("开发核配委派");
    const safeTodos = new TodoService(db, undefined, undefined, undefined, new DigitalProductionNotificationService(unavailable));
    expect((await safeTodos.listForActor(actors.clerk!, { module: "digital_production", query: f.style })).todos).toEqual([]);
    await tx(async c => {
      await c.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_revoke_only");
      await c.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason='TEST revoked role' WHERE user_id=$1 AND role_code='development_clerk' AND revoked_at IS NULL", [ids.clerk, ids.root]);
      await c.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_revoke_only");
    });
    expect(await notices.todos(actors.clerk!)).toEqual([]);
    await tx(async c => {
      await c.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
      await c.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'development_clerk',$3,'TEST restore')", [randomUUID(), ids.clerk, ids.root]);
      await c.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");
    });
  });
  it("preserves pending, blocked, paused, completed and cancelled task visibility", async () => {
    const pending = await sourceTask(ids.clerk, true);
    expect((await list(actors.clerk!, pending.style)).todos).toEqual([]);
    const f = await sourceTask();
    await tasks.feedback(actors.clerk!, f.taskId, "TEST blocked", true, randomUUID());
    expect((await list(actors.clerk!, f.style)).todos[0]?.orderContext?.status).toBe("blocked");
    await tasks.controlResource(root, { kind: "source", id: f.sourceId }, "pause", "TEST pause", randomUUID());
    expect((await list(actors.clerk!, f.style)).todos).toEqual([]);
    await tasks.controlResource(root, { kind: "source", id: f.sourceId }, "resume", "TEST resume", randomUUID());
    expect((await list(actors.clerk!, f.style)).todos).toHaveLength(1);
    const done = await sourceTask();
    await tx(c => tasks.setConditionWithClient(c, root, done.taskId, "business_recorded", true));
    await tasks.complete(actors.clerk!, done.taskId, { note: "TEST completed" }, randomUUID());
    expect((await list(actors.clerk!, done.style)).todos).toEqual([]);
    await tasks.controlResource(root, { kind: "source", id: f.sourceId }, "cancel", "TEST cancel", randomUUID());
    expect((await list(actors.clerk!, f.style)).todos).toEqual([]);
  });
  it("keeps upstream routing exceptions free of style context and stale identities out of queues", async () => {
    const missing = await sourceTask(null);
    const queue = (await notices.todos(actors.tech!)).find(t => t.todoId === missing.taskId)!;
    expect(queue.status).toBe("blocked_recipient"); expect(queue.orderContext).toBeNull();
    expect(queue.taskTitle).toBe("开发核配委派");
    expect((await list(actors.tech!, missing.style)).todos).toEqual([]);
    const f = await sourceTask();
    await db.query("UPDATE identity_mappings SET employed=false WHERE user_id=$1", [ids.clerk]);
    expect(await notices.todos(actors.clerk!)).toEqual([]);
    expect((await notices.todos(actors.tech!)).find(t => t.todoId === f.taskId)?.orderContext).toBeNull();
    await db.query("UPDATE identity_mappings SET employed=true WHERE user_id=$1", [ids.clerk]);
    expect((await list(actors.clerk!, f.style)).todos).toHaveLength(1);
  });
});
