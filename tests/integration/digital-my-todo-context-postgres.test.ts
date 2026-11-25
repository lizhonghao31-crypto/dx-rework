import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { migrationExecutionSql } from "../../scripts/deploy/migration-execution-compatibility.mjs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { TodoListResponseSchema } from "@dx-rework/contracts";
import { loadConfig } from "@dx-rework/config";
import { buildApp } from "../../apps/api/src/app.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { exceptions } from "../../apps/api/src/reporting/management-reporting-exceptions.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from "../helpers/owned-postgres-schema.js";

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
    await createOwnedPostgresSchema(admin,schema);
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
  }, testExecutionConfig.correctnessTimeoutMs);
  afterAll(async () => { await db.end(); await releaseOwnedPostgresSchema(admin,schema); await admin.end(); });
  const sourceTask = async (assignee: string | null = ids.clerk, pending = false, stylePrefix = "TEST-DOC-SOURCE-") => {
    const style = `${stylePrefix}${randomUUID()}`;
    const source = await new DigitalProductionIdentityService(db, true).createSource(root, { developmentType: "头版", designStyleNo: style, temporaryStyleNo: null, customerCode: "PD" }, randomUUID());
    const task = await tx(c => tasks.createWithClient(c, root, { resource: { kind: "source", id: source.sourceId }, kind: "development_materials", routeId: randomUUID(), routeVersion: 1, occurrence: 1, assigneeId: assignee, ...(pending ? { conditions: ["washing_finished" as const] } : {}) }));
    return { style, sourceId: source.sourceId, taskId: task.taskId };
  };
  const list = async (actor: TrustedActorContext, query?: string) => TodoListResponseSchema.parse(await todos.listForActor(actor, { module: "digital_production", ...(query ? { query } : {}) }));
  it('P07 persists one first-read receipt per person and stable content while the task stays pending',async()=>{
    const f=await sourceTask(),item=(await list(actors.clerk!,f.style)).todos[0]!,before=await tasks.read(root,f.taskId),counts=await todos.countIndicatorForActor(actors.clerk!);
    expect(item).toMatchObject({unread:true,readAt:null});expect(item.contentToken).toMatch(/^[a-f0-9]{64}$/);
    const input={contentToken:item.contentToken!,route:item.route},[a,b]=await Promise.all([todos.markReadForActor(actors.clerk!,f.taskId,input),todos.markReadForActor(actors.clerk!,f.taskId,input)]);
    expect(a).toEqual(b);expect((await list(actors.clerk!,f.style)).todos[0]).toMatchObject({unread:false,readAt:a.readAt,status:'pending',contentToken:item.contentToken});
    expect(await todos.markReadForActor(actors.clerk!,f.taskId,input)).toEqual(a);
    expect((await db.query('SELECT count(*)::int n FROM todo_content_reads WHERE recipient_id=$1 AND todo_id=$2',[ids.clerk,f.taskId])).rows[0].n).toBe(1);
    const after=await todos.countIndicatorForActor(actors.clerk!);expect(after.pendingCount).toBe(counts.pendingCount);expect(after.unreadCount).toBe(counts.unreadCount!-1);expect(await tasks.read(root,f.taskId)).toEqual(before);
    await expect(todos.markReadForActor(actors.peer!,f.taskId,input)).rejects.toMatchObject({statusCode:404});await expect(todos.markReadForActor(root,f.taskId,input)).rejects.toMatchObject({statusCode:404});
  });
  it('P07 rejects late tokens and old recipients after actual content change and reassignment',async()=>{
    const f=await sourceTask(),old=(await list(actors.clerk!,f.style)).todos[0]!,oldInput={contentToken:old.contentToken!,route:old.route};
    await tasks.prioritize(root,f.taskId,'urgent',randomUUID());
    const changed=(await list(actors.clerk!,f.style)).todos[0]!;expect(changed.contentToken).not.toBe(old.contentToken);expect(changed.unread).toBe(true);
    await expect(todos.markReadForActor(actors.clerk!,f.taskId,oldInput)).rejects.toMatchObject({statusCode:409});
    expect((await db.query('SELECT count(*)::int n FROM todo_content_reads WHERE todo_id=$1',[f.taskId])).rows[0].n).toBe(0);
    await todos.markReadForActor(actors.clerk!,f.taskId,{contentToken:changed.contentToken!,route:changed.route});
    await tasks.reassign(root,f.taskId,ids.peer,randomUUID());await expect(todos.markReadForActor(actors.clerk!,f.taskId,{contentToken:changed.contentToken!,route:changed.route})).rejects.toMatchObject({statusCode:404});
    const peer=(await list(actors.peer!,f.style)).todos[0]!;expect(peer).toMatchObject({unread:true,readAt:null});expect(peer.contentToken).not.toBe(changed.contentToken);
    await todos.markReadForActor(actors.peer!,f.taskId,{contentToken:peer.contentToken!,route:peer.route});await tasks.reassign(root,f.taskId,ids.clerk,randomUUID());
    expect((await list(actors.clerk!,f.style)).todos[0]).toMatchObject({unread:true,readAt:null});expect((await db.query('SELECT count(*)::int n FROM todo_content_reads WHERE todo_id=$1',[f.taskId])).rows[0].n).toBe(2);
  });
  it('P07 refuses wrong entity/round, forged recipient and capability denial without a receipt',async()=>{
    const f=await sourceTask(),item=(await list(actors.clerk!,f.style)).todos[0]!,input={contentToken:item.contentToken!,route:item.route};
    await expect(todos.markReadForActor(actors.clerk!,f.taskId,{...input,route:{...item.route,entityId:randomUUID()}})).rejects.toMatchObject({statusCode:409});
    await expect(todos.markReadForActor(actors.clerk!,f.taskId,{...input,route:{...item.route,developmentRound:2}})).rejects.toMatchObject({statusCode:409});
    const forged={...input,recipientUserId:ids.peer};await expect(todos.markReadForActor(actors.clerk!,f.taskId,forged)).rejects.toMatchObject({statusCode:400});
    await expect(todos.markReadForActor({...actors.clerk!,authorizationCapabilities:[],authorizationCapability:'digital_production:view'},f.taskId,input)).rejects.toMatchObject({statusCode:403});
    expect((await db.query('SELECT count(*)::int n FROM todo_content_reads WHERE todo_id=$1',[f.taskId])).rows[0].n).toBe(0);
  });
  it("searches the actual primary merchandiser order style and keeps node title separate", async () => {
    const style = `TEST-DOC-ORDER-${randomUUID()}`;
    const order = await new DigitalProductionIdentityService(db, true).createOrder(root, { customerCode: "PD", primaryMerchandiserId: ids.merch, productGroup: "男装", designStyleNo: style, orderDate: "2026-10-06", lines: [{ color: "TEST PRIVATE COLOR", customerWarehouseArrivalDate: minimumInitialCustomerDate(), sizes: [{ size: "M", quantity: 9 }] }] }, randomUUID());
    const task = await tx(c => tasks.createWithClient(c, root, { resource: { kind: "order", id: order.productionOrderId }, kind: "sourcing_preparation", routeId: randomUUID(), routeVersion: 5, occurrence: 1, assigneeId: ids.merch }));
    const before = await tasks.read(actors.merch!, task.taskId);
    const found = await list(actors.merch!, style.toLowerCase());
    expect(found.todos.map(t=>t.todoId)).toContain(task.taskId);
    for(const item of found.todos){expect(await policy.allowed(actors.merch!, 'task',item.todoId,'technical')).toBe(true);expect(item.orderContext?.styleNo).toBe(style);}
    const selected=found.todos.find(item=>item.todoId===task.taskId)!;
    expect(selected.orderContext).toEqual({ reworkNo: null, orderNo: null, styleNo: style, supplierName: null, status: "ready", updatedAt: selected.createdAt });
    expect(selected.taskTitle).toBe("跟单核实并发起外发");
    const workbench=(await todos.merchandiserActionSources(actors.merch!)).find(item=>item.candidate.itemId===task.taskId);
    expect(workbench?.candidate).toMatchObject({kind:'sourcing',itemId:task.taskId,title:selected.taskTitle,route:selected.route,dueAt:selected.dueAt});
    await expect(todos.merchandiserActionSources(actors.peer!)).rejects.toMatchObject({statusCode:403});
    const page=await todos.merchandiserActionPage(actors.merch!,{kind:'sourcing',search:style,page:1});
    expect(page).toMatchObject({page:1,total:1,items:[{itemId:task.taskId,route:selected.route,orderNumber:style,customer:'PD',state:'mine'}]});
    expect(await todos.merchandiserActionPage(actors.merch!,{kind:'sourcing',search:style,page:2})).toEqual({page:2,total:1,items:[]});
    await expect(todos.merchandiserActionPage(actors.peer!,{search:style,page:1})).rejects.toMatchObject({statusCode:403});
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
      if (key !== "connect") {
        const value=Reflect.get(target,key);
        return typeof value==='function'?value.bind(target):value;
      }
      return async () => {
        const client = await target.connect();
        return new Proxy(client, { get(current, property) {
          if (property !== "query") {
            const value=Reflect.get(current,property);
            return typeof value==='function'?value.bind(current):value;
          }
          return async (text: string, values?: unknown[]) => {
            const result = await current.query(text, values);
            // Only the joined identity is unavailable. Access and state remain native.
            if (text.includes("AS source_style_no")) result.rows = result.rows.map(row => row.task_id === f.taskId ? { ...row, source_style_no: null } : row);
            return result;
          };
        } });
      };
    } });
    const projected = (await new DigitalProductionNotificationService(unavailable).todos(actors.clerk!)).find(t => t.todoId === f.taskId)!;
    expect(projected.orderContext).toBeNull(); expect(projected.taskTitle).toBe("文员核配委派");
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
  it("identifies routing exceptions only for authorized readers without granting execution and keeps stale identities out", async () => {
    const missing = await sourceTask(null);
    const queue = (await notices.todos(actors.tech!)).find(t => t.todoId === missing.taskId)!;
    expect(queue.status).toBe("blocked_recipient"); expect(queue.orderContext?.styleNo).toBe(missing.style);
    expect(queue.route.developmentRound).toBe(1);
    expect(await policy.allowed(actors.tech!, "task", missing.taskId, "execute")).toBe(false);
    expect((await tasks.read(actors.tech!, missing.taskId)).canExecute).toBe(false);
    expect((await notices.todos(actors.merch!)).some(t=>t.todoId===missing.taskId)).toBe(false);
    expect(await policy.allowed(actors.merch!, "task", missing.taskId, "technical")).toBe(false);
    await expect(tasks.read(actors.merch!, missing.taskId)).rejects.toMatchObject({statusCode:404});
    expect(queue.taskTitle).toBe("文员核配委派");
    expect((await list(actors.tech!, missing.style)).todos.map(t=>t.entityId)).toContain(missing.taskId);
    const identity=new DigitalProductionIdentityService(db,true);
    const linked=await identity.createOrder(root,{customerCode:'PD',primaryMerchandiserId:ids.merch,productGroup:'男装',designStyleNo:missing.style,orderDate:'2026-10-22',lines:[{poNumber:'TEST-ROUTING-PO',color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:2}]}]},randomUUID());
    await identity.attachSource(root,linked.productionOrderId,missing.sourceId,randomUUID());
    expect((await notices.todos(actors.tech!)).find(t=>t.todoId===missing.taskId)?.orderContext?.poNumbers).toEqual(['TEST-ROUTING-PO']);
    expect((await list(actors.tech!,'TEST-ROUTING-PO')).todos.map(t=>t.entityId)).toContain(missing.taskId);
    expect((await list(actors.merch!,missing.style)).todos.some(t=>t.entityId===missing.taskId)).toBe(false);
    const f = await sourceTask();
    await db.query("UPDATE identity_mappings SET employed=false WHERE user_id=$1", [ids.clerk]);
    expect(await notices.todos(actors.clerk!)).toEqual([]);
    expect((await notices.todos(actors.tech!)).find(t => t.todoId === f.taskId)?.orderContext?.styleNo).toBe(f.style);
    await db.query("UPDATE identity_mappings SET employed=true WHERE user_id=$1", [ids.clerk]);
    expect((await list(actors.clerk!, f.style)).todos).toHaveLength(1);
  });
  it("keeps each native task's own context and receipt in a multi-result search", async () => {
    const search = `TEST-TODO-COHORT-${randomUUID().slice(0, 8)}-`;
    const first = await sourceTask(ids.clerk, false, search);
    const second = await sourceTask(ids.clerk, false, search);
    const other = await sourceTask(ids.peer, false, search);
    const expectedIds = [first.taskId, second.taskId].sort();

    const result = await list(actors.clerk!, search);
    expect(result.totalCount).toBe(2);
    expect(result.todos.map(todo => todo.entityId).sort()).toEqual(expectedIds);

    for (const task of [first, second]) {
      const selected = result.todos.find(todo => todo.entityId === task.taskId)!;
      const native = await notices.todo(actors.clerk!, task.taskId);
      expect(selected.orderContext?.styleNo).toBe(task.style);
      expect(selected.route).toMatchObject({ entityId: task.taskId, developmentRound: 1 });
      expect(selected.contentToken).toMatch(/^[a-f0-9]{64}$/);
      expect(selected.contentToken).toBe(native?.contentToken);
    }

    const unrelated = await list(actors.peer!, search);
    expect(unrelated.todos.map(todo => [todo.entityId, todo.orderContext?.styleNo])).toEqual([[other.taskId, other.style]]);
    expect(await notices.todo(actors.peer!, first.taskId)).toBeNull();
  });
  it("keeps native search query growth bounded across 1, 15 and 50 task candidates", async () => {
    const search = `TEST-TODO-GROWTH-${randomUUID().slice(0, 8)}-`;
    const contextCalls: number[] = [];
    const candidateIds = new Set<string>();
    const connection = await db.connect();
    const prototype = Object.getPrototypeOf(connection) as pg.PoolClient;
    connection.release();

    // Observe physical requests including those issued by the snapshot client.
    const query = vi.spyOn(prototype, "query");
    try {
      for (const size of [1, 15, 50]) {
        while (candidateIds.size < size) candidateIds.add((await sourceTask(ids.clerk, false, search)).taskId);
        query.mockClear();
        const result = await list(actors.clerk!, search);
        contextCalls.push(query.mock.calls.filter(([sql]) => typeof sql === "string" &&
          sql.includes("SELECT * FROM digital_production_task_access WHERE task_id=")).length);
        expect(result.totalCount).toBe(size);
        expect(result.todos).toHaveLength(Math.min(15, size));
        expect(result.todos.every(todo => candidateIds.has(todo.entityId))).toBe(true);
      }
      expect(contextCalls[0]).toBeGreaterThan(0);
      // Hold the displayed page size constant and allow bounded cohort overhead.
      // A dedicated lookup for each of the added 35 candidates fails this check.
      expect(contextCalls[2]! - contextCalls[1]!).toBeLessThan(10);
    } finally { query.mockRestore(); }
  });
  it("serves Acceptance search URLs through the real HTTP and PostgreSQL path for Root and ordinary users", async () => {
    const config = loadConfig({
      NODE_ENV: "test", DATABASE_URL: url!,
      DINGTALK_CORP_ID: "OWN-TODO", DINGTALK_H5_APP_KEY: "TEST", DINGTALK_H5_APP_SECRET: "TEST",
      DINGTALK_WEB_CLIENT_ID: "TEST", DINGTALK_WEB_CLIENT_SECRET: "TEST",
      DINGTALK_QR_REDIRECT_URI: "https://example.test/acceptance/ui",
      SESSION_SECRET: "TEST-only-isolated-session-key-000000",
      ACCEPTANCE_LAB_ENABLED: "true", ACCEPTANCE_LAB_SECRET: "TEST-only-isolated-lab-key-0000000000",
      ROOT_DINGTALK_USER_ID: "uat-root",
      DIGITAL_PRODUCTION_ENABLED: "true", DIGITAL_PRODUCTION_CREATION_ENABLED: "true",
    });
    const app = buildApp({
      config, checkDatabase: async () => { await db.query("SELECT 1"); }, getAppliedSchemaHistory: async () => [],
      todos: {
        service: todos,
        authenticate: async token => {
          const actor = token === "TEST-root" ? root : actors.manager!;
          return { id: actor.actorId, displayName: "TEST", businessRoles: actor.actorRoles, capabilities: actor.authorizationCapabilities ?? [] };
        },
      },
    });
    try {
      // Run this same suite on PG13 and PG16: older PG rejects the implicit `value` alias.
      for (const [token, query] of [
        ["TEST-root", ""], ["TEST-manager", "&module=suppliers"],
        ["TEST-root", "&q=回传合同"], ["TEST-root", "&q=财务核对"],
        ["TEST-manager", "&module=suppliers&q=本厂整款开裁"],
        ["TEST-manager", "&module=suppliers&q=回传合同"],
        ["TEST-root", "&q=TEST-NO-MATCH-" + randomUUID()],
      ] as const) {
        const response = await app.inject({ method: "GET", url: `/todos/mine?page=1${query}`, headers: { cookie: `dx_rework_session=${token}` } });
        expect(response.statusCode, query).toBe(200);
        const result = TodoListResponseSchema.parse(response.json());
        expect(result.page).toBe(1);
        expect(result.searchScope).toBe(query.includes("&q=") ? "all" : undefined);
        if (query.includes("TEST-NO-MATCH-")) expect(result).toMatchObject({ todos: [], totalCount: 0, totalPages: 0 });
      }
    } finally { await app.close(); }
  });
  it("opens an overdue sourcing finance exception through its stored original route", async () => {
    const todoId=randomUUID(),eventId=randomUUID(),caseId=randomUUID();
    await tx(async client=>{
      await client.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id) VALUES($1,'TEST-exception-route',$2,ARRAY['root_superuser'],'todo:view','todo.create','sourcing_case',$3)",[eventId,ids.root,caseId]);
      await client.query("SELECT set_config('dx_rework.todo_event_id',$1,true),set_config('dx_rework.todo_request_id','TEST-exception-route',true)",[eventId]);
      await client.query("INSERT INTO rework_todos(todo_id,todo_type,category,source_event_id,source_action,entity_type,entity_id,recipient_user_id,required_role,required_capability,route_descriptor,policy_key,dedupe_key,created_operation_event_id,created_request_id,due_at) VALUES($1,'business_action','sourcing_finance_reconcile',$2,'todo.create','sourcing_case',$3,$4,'finance_read','todo:view',$5::jsonb,'general',$1::uuid::text,$2,'TEST-exception-route',CURRENT_TIMESTAMP-interval '1 hour')",[todoId,eventId,caseId,ids.root,JSON.stringify({routeName:'sourcing_detail',entityId:caseId,todoId})]);
    });
    const result=await exceptions(100,db,{q:'财务核对'});
    expect(result.find(row=>row.entityId===todoId)).toMatchObject({exceptionType:'overdue_todo',reworkOrderId:null,deepLink:`/ui/sourcing/orders/${caseId}?todo=${todoId}`});
  });

});
