import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import { MessageOutboxRepository } from "../../apps/api/src/tools/repositories.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { digitalTodoOrder } from "../../apps/api/src/production-platform/notification-policy.js";
import { linkNewDigitalChild } from "../../apps/api/src/production-platform/child-link-repository.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { DigitalTaskKind } from "../../apps/api/src/production-platform/task-access-repository.js";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("P04 in-app notifications PostgreSQL", () => {
  const schema = ownedPostgresSchema("digital_notifications");
  const admin = new pg.Pool({connectionString:databaseUrl!});
  const database = new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const designer=randomUUID(), other=randomUUID(), root=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create","todo:view"],requestId:"P03"});
  const boss=actor(root,["root_superuser"]);
  const service=new DigitalProductionIdentityService(database,true), tasks=new DigitalProductionTaskService(database), app=Fastify();
  const notifications=new DigitalProductionNotificationService(database);
  const input=()=>DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:"TEST-P03",orderDate:"2026-09-29",lines:[{color:"黑",sizes:[{size:"M",quantity:5}]}]});
  const tx=async <T,>(action:(client:pg.PoolClient)=>Promise<T>)=>{const c=await database.connect();try{await c.query("BEGIN");const r=await action(c);await c.query("COMMIT");return r;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}};
  const order=async()=>({kind:"order" as const,id:(await service.createOrder(actor(),input(),randomUUID())).productionOrderId});
  const create=async(resource:{kind:"order"|"source";id:string},kind:DigitalTaskKind="budget",extra:Partial<Parameters<DigitalProductionTaskService["createWithClient"]>[2]>={})=>tx(c=>tasks.createWithClient(c,boss,{resource,kind,routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:kind==="budget"?designer:null,...extra}));
  const condition=async(id:string,key:Parameters<DigitalProductionTaskService["setConditionWithClient"]>[3],at:string|null=null)=>tx(c=>tasks.setConditionWithClient(c,boss,id,key,true,at));
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0004_public_tools_foundation.sql", "0216_digital_production_order_roots.sql", "0217_digital_production_node_clocks.sql"])
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    // Existing-domain tables are represented only by referenced identity columns in this isolated fixture.
    // Full Gate separately replays the full real schema and original business chain.
    await database.query(`CREATE TABLE sourcing_cases(sourcing_case_id uuid PRIMARY KEY);
      CREATE TABLE cutting_orders(cutting_order_id uuid PRIMARY KEY,sourcing_case_id uuid REFERENCES sourcing_cases);
      CREATE TABLE sourcing_production_orders(production_order_id uuid PRIMARY KEY,sourcing_case_id uuid REFERENCES sourcing_cases);
      CREATE TABLE receiving_receipts(receipt_id uuid PRIMARY KEY);
      CREATE TABLE rework_orders(rework_order_id uuid PRIMARY KEY);
      CREATE TABLE pattern_room_orders(order_id uuid PRIMARY KEY);`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0218_digital_production_identity.sql", import.meta.url), "utf8"));
    await database.query(`CREATE TABLE business_roles(role_code text PRIMARY KEY,display_name text,description text,enabled boolean DEFAULT true,updated_at timestamptz);
      CREATE FUNCTION fixture_role_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE TRIGGER business_roles_no_update BEFORE UPDATE ON business_roles FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE capability_catalog(capability text,display_name text,description text);
      CREATE TRIGGER capability_catalog_no_update BEFORE UPDATE ON capability_catalog FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE role_capabilities(role_code text,capability text);
      CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION fixture_role_guard();
      CREATE TABLE user_role_assignments(user_id uuid,role_code text,revoked_at timestamptz);
      INSERT INTO business_roles(role_code) VALUES('sample_designer'),('order_merchandiser'),('pattern_room_supervisor'),('pattern_room_worker'),('production_management'),('quality_control'),('embroidery_washing_merchandiser'),('warehouse_receiver');`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0219_digital_production_access.sql", import.meta.url), "utf8"));
    await database.query(`CREATE FUNCTION fixture_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES(NEW.id,NEW.id,'dingtalk','TEST',NEW.id::text,NEW.id::text,true,true,CURRENT_TIMESTAMP); RETURN NEW; END $$;
      CREATE TRIGGER fixture_user_identity AFTER INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION fixture_identity();`);
    for (const id of [designer, other, root]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    for (const id of [designer, other]) await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')", [id]);
    await database.query(await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0221_digital_production_notifications.sql", import.meta.url), "utf8"));
    app.setErrorHandler((error, _request, reply) => { const known = error as ApplicationError; reply.code(known.statusCode ?? 500).send({ error: { code: known.code, message: known.message } }); });
    registerDigitalIdentityRoutes(app, { service, notificationService:notifications, taskService: tasks, accessService: new DigitalProductionAccessService(database), creationEnabled: true, authenticate: async token => {
      if (token !== designer && token !== other) throw new ApplicationError("UNAUTHORIZED", "请登录", 401);
      return { id: token, displayName: "TEST", businessRoles: ["sample_designer"], capabilities: ["pattern_room:orders:create","todo:view"] };
    } });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await database.end(); await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); await admin.end(); });
  const drain=async(id=designer)=>{for(let i=0;i<100;i++){if(!(await notifications.claim(actor(id))).notification)return;}throw new Error("queue did not drain");};
  it("atomically claims across tabs, persists across refresh, and acknowledgement never finishes a task or its SLA",async()=>{
    const resource=await order(),{taskId}=await create(resource);
    await notifications.runOnce();await notifications.runOnce();
    const before=await tasks.read(actor(),taskId),count=(await notifications.todos(actor())).length;
    const claims=await Promise.all([notifications.claim(actor()),notifications.claim(actor())]);
    const notice=claims.flatMap(r=>r.notification?[r.notification]:[]);
    expect(notice).toHaveLength(1);expect(notice[0]?.route.entityId).toBe(taskId);
    await notifications.acknowledge(actor(),notice[0]!.eventId);
    expect((await notifications.claim(actor())).notification).toBeNull();
    expect(await tasks.read(actor(),taskId)).toEqual(before);
    expect((await notifications.todos(actor())).length).toBe(count);
    expect((await database.query("SELECT * FROM digital_production_notification_receipts WHERE event_id=$1",[notice[0]!.eventId])).rows[0].acknowledged_at).not.toBeNull();
    expect(JSON.stringify(notice)).not.toMatch(/price|budget|cost|amount|单价|金额/);
  });
  it("immediately removes old operator todo and unshown or displayed prompts on reassignment",async()=>{
    const {taskId}=await create(await order());await notifications.runOnce();
    const shown=(await notifications.claim(actor())).notification!;
    await tasks.reassign(boss,taskId,other,randomUUID());
    expect((await notifications.todos(actor())).find(t=>t.todoId===taskId)).toBeUndefined();
    expect((await notifications.current(actor(),shown.eventId)).notification).toBeNull();
    await notifications.runOnce();
    expect((await notifications.todos(actor(other))).some(t=>t.todoId===taskId)).toBe(true);
    expect((await notifications.claim(actor(other))).notification?.route.entityId).toBe(taskId);
  });
  it("filters revoked roles and outsider receipts without leaking count or payload",async()=>{
    await drain();const {taskId}=await create(await order());await notifications.runOnce();
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1",[designer]);
    expect(await notifications.todos(actor())).toEqual([]);
    expect((await notifications.claim(actor())).notification).toBeNull();
    expect((await notifications.todos(actor(other))).some(t=>t.todoId===taskId)).toBe(false);
    await database.query("UPDATE user_role_assignments SET revoked_at=NULL WHERE user_id=$1",[designer]);
  });
  it("does not show stale action after another operator completes, pauses or cancels the resource",async()=>{
    await drain();const resource=await order(),{taskId}=await create(resource);await notifications.runOnce();
    await condition(taskId,"business_recorded");await tasks.complete(boss,taskId,{note:"done"},randomUUID());
    expect((await notifications.claim(actor())).notification).toBeNull();
    expect((await notifications.todos(actor())).some(t=>t.todoId===taskId)).toBe(false);
    expect((await tasks.read(actor(),taskId)).state).toBe("completed");
    const r=await order(),task=await create(r);await notifications.runOnce();
    await tasks.controlResource(boss,r,"pause","test",randomUUID());
    expect((await notifications.claim(actor())).notification).toBeNull();
    expect((await notifications.todos(actor())).some(t=>t.todoId===task.taskId)).toBe(false);
    await tasks.controlResource(boss,r,"cancel","test",randomUUID());
  });
  it("server monitoring creates one overdue event with no open page, and a changed deadline invalidates old prompts",async()=>{
    await drain();await tasks.changePolicy(boss,"budget",{expectedVersion:1,slaHours:1,warningRatio:.8,note:"test"},randomUUID());
    const {taskId}=await create(await order(),"budget",{occurredAt:new Date(Date.now()-7200000).toISOString()});
    await notifications.runOnce();await notifications.runOnce();
    const rows=(await database.query("SELECT * FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[taskId])).rows;
    expect(rows).toHaveLength(1);
    await tasks.changePolicy(boss,"budget",{expectedVersion:2,slaHours:null,warningRatio:.8,note:"unlimited"},randomUUID());
    const received=[];for(let i=0;i<20;i++){const item=(await notifications.claim(actor())).notification;if(!item)break;received.push(item.eventId);}
    expect(received).not.toContain(rows[0].event_id);
  });
  it("missing main operator creates an upstream routing task, never a broadcast to every craft worker",async()=>{
    const manager=randomUUID(),worker=randomUUID();
    for(const [id,role] of [[manager,"pattern_room_supervisor"],[worker,"pattern_room_worker"]]){
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST',true)",[id]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)",[id,role]);
    }
    const {taskId}=await create(await order(),"development_sewing");await notifications.runOnce();
    const manage=actor(manager,["pattern_room_supervisor"]),craft=actor(worker,["pattern_room_worker"]);
    expect((await notifications.todos(manage)).find(t=>t.todoId===taskId)?.todoType).toBe("recipient_routing_exception");
    expect(await notifications.todos(craft)).toEqual([]);expect((await notifications.claim(craft)).notification).toBeNull();
  });
  it("authenticates incremental API and never lets acknowledgement mutate someone else's receipt",async()=>{
    await drain();await create(await order());await notifications.runOnce();
    expect((await app.inject({method:"POST",url:"/digital-production/notifications/claim"})).statusCode).toBe(401);
    const response=await app.inject({method:"POST",url:"/digital-production/notifications/claim",headers:{cookie:`dx_rework_session=${designer}`}});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.headers["x-dx-rework-actor-id"]).toBe(designer);
    const eventId=response.json().notification.eventId;
    await notifications.acknowledge(actor(other),eventId);
    expect((await database.query("SELECT acknowledged_at FROM digital_production_notification_receipts WHERE event_id=$1 AND recipient_id=$2",[eventId,designer])).rows[0].acknowledged_at).toBeNull();
  });
  it("inherits IN_APP_ONLY by stable child linkage while an unrelated legacy order stays external",async()=>{
    const child=randomUUID(),legacy=randomUUID(),resource=await order();
    for(const id of [child,legacy])await database.query("INSERT INTO sourcing_cases(sourcing_case_id) VALUES($1)",[id]);
    const route=(id:string)=>({routeName:"sourcing_detail" as const,entityId:id,todoId:randomUUID()});
    expect(await digitalTodoOrder(database,route(child))).toBeNull();
    await tx(c=>linkNewDigitalChild(c,{module:"sourcing",childId:child,productionOrderId:resource.id,lines:[]}));
    expect(await digitalTodoOrder(database,route(child))).toBe(resource.id);
    expect(await digitalTodoOrder(database,route(legacy))).toBeNull();
  });
  it("suppresses every queued delivery kind when child linking occurs after enqueue in the same transaction",async()=>{
    const child=randomUUID(),resource=await order(),outbox=new MessageOutboxRepository();
    const provider={createTodo:vi.fn(async()=>{throw new Error("external call forbidden");}),updateTodo:vi.fn(async()=>{throw new Error("external call forbidden");}),completeTodo:vi.fn(async()=>{throw new Error("external call forbidden");})};
    await tx(async c=>{
      await c.query("INSERT INTO sourcing_cases(sourcing_case_id) VALUES($1)",[child]);
      for(const deliveryKind of ["create","information","complete","reminder","escalation","update"]){
        const todoId=randomUUID(),eventId=randomUUID(),requestId=randomUUID();
        const action=deliveryKind==="complete"?"todo.complete":["escalation","update"].includes(deliveryKind)?"todo.escalate":deliveryKind==="reminder"?"todo.remind":"todo.create";
        await c.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id) VALUES($1,$2,$3,ARRAY['sample_designer'],'todo:view',$4,'rework_todo',$5)",[eventId,requestId,designer,action,todoId]);
        await outbox.enqueue(c,{topic:"todo.delivery",aggregateType:"rework_todo",aggregateId:todoId,recipientKey:`user:${designer}`,idempotencyKey:randomUUID(),payload:{todoId,recipientUserId:designer,category:"sourcing_contract_return",deliveryKind,route:{routeName:"sourcing_detail",entityId:child,todoId},operationEventId:eventId,operationRequestId:requestId}});
      }
      await linkNewDigitalChild(c,{module:"sourcing",childId:child,productionOrderId:resource.id,lines:[]});
    });
    expect(await new TodoDeliveryWorker(database,provider,"https://acceptance.example/").runOnce()).toEqual({claimed:6,suppressed:6,sent:0,failed:0});
    expect(provider.createTodo).not.toHaveBeenCalled();expect(provider.updateTodo).not.toHaveBeenCalled();expect(provider.completeTodo).not.toHaveBeenCalled();
    expect((await database.query("SELECT count(*)::int count FROM message_outbox WHERE status='sent'")).rows[0].count).toBe(6);
  });
  it("projects child notices only in-app, deduplicates one business event for one recipient and hides price payload",async()=>{
    await drain();const child=randomUUID(),resource=await order(),source=randomUUID();
    await database.query("INSERT INTO sourcing_cases(sourcing_case_id) VALUES($1)",[child]);
    await tx(c=>linkNewDigitalChild(c,{module:"sourcing",childId:child,productionOrderId:resource.id,lines:[]}));
    await database.query(`CREATE TABLE rework_todos(todo_id uuid PRIMARY KEY,recipient_user_id uuid,source_event_id uuid,route_descriptor jsonb,status text,todo_type text,due_at timestamptz,required_role text,required_capability text)`);
    for(let i=0;i<2;i++) {const todoId=randomUUID();await database.query("INSERT INTO rework_todos VALUES($1,$2,$3,$4,'pending','business_action',NULL,'sample_designer',NULL)",[todoId,designer,source,JSON.stringify({routeName:"sourcing_detail",entityId:child,todoId})]);}
    await notifications.runOnce();await notifications.runOnce();
    expect((await database.query("SELECT count(*)::int count FROM digital_production_notification_receipts WHERE source_event_id=$1 AND recipient_id=$2",[source,designer])).rows[0].count).toBe(1);
    const claim=(await notifications.claim(actor())).notification!;
    expect(claim.route.routeName).toBe("sourcing_detail");expect(claim.title).toBe("你有新的订单待办");
    await database.query("UPDATE rework_todos SET status='completed'");
    expect((await notifications.current(actor(),claim.eventId)).notification).toBeNull();
  });
});
