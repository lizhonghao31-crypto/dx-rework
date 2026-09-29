import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { TodoListResponseSchema } from "@dx-rework/contracts";
import { randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import pg from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { linkNewDigitalChild } from "../../apps/api/src/production-platform/child-link-repository.js";
import { TodoService } from "../../apps/api/src/todos/service.js";
import { TodoDeliveryWorker } from "../../apps/api/src/todos/delivery-worker.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL??process.env.DATABASE_URL;
(url?describe:describe.skip)("P04 full-schema legacy and digital notification delivery",()=>{
  const schema=ownedPostgresSchema("digital_delivery"),admin=new pg.Pool({connectionString:url!}),database=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
  const user=randomUUID();
  const actor:TrustedActorContext={actorId:user,actorRoles:["root_superuser","order_merchandiser"],authorizationCapability:"sourcing:inquiry:create",authorizationCapabilities:["sourcing:inquiry:create","todo:view"],requestId:randomUUID()};
  const service=new TodoService(database);
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    await database.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz DEFAULT CURRENT_TIMESTAMP)");
    const directory=new URL("../../apps/api/migrations/",import.meta.url);
    for(const file of (await readdir(directory)).filter(f=>f.endsWith(".sql")).sort())await database.query(await readFile(new URL(file,directory),"utf8"));
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P04',true)",[user]);
    await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','P04',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),user]);
    await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'order_merchandiser',$2,'TEST')",[randomUUID(),user]);
    await database.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','P04') ON CONFLICT(policy_key) DO UPDATE SET dingtalk_corp_id='P04'");
  },60000);
  afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  const create=async(digital:boolean,linkAfter=false)=>{
    const child=randomUUID(),source=randomUUID(),requestId=randomUUID();
    const order=digital?await new DigitalProductionIdentityService(database,true).createOrder(actor,DigitalOrderCreateSchema.parse({customerCode:"PD",primaryMerchandiserId:user,productGroup:"男装",designStyleNo:"TEST-P04",orderDate:"2026-09-29",lines:[{color:"黑",sizes:[{size:"M",quantity:5}]}]}),randomUUID()):null;
    const c=await database.connect();
    try{await c.query("BEGIN");
      await c.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,reason) VALUES($1,$2,$3,ARRAY['order_merchandiser'],'sourcing:inquiry:create','sourcing.case.create','sourcing_case',$4,'TEST')",[source,requestId,user,child]);
      await c.query("INSERT INTO sourcing_cases(sourcing_case_id,erp_order_id,erp_order_no,style_no,lane_key,order_quantity,created_by,operation_event_id,request_id,creation_reason) VALUES($1,$1::uuid::text,'TEST','TEST','garment_processing',5,$2,$3,$4,'TEST')",[child,user,source,requestId]);
      await c.query("INSERT INTO sourcing_case_transitions(sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,business_action,transition_reason,actor_id,operation_event_id,request_id) VALUES($1,$2,1,NULL,'pending_ie_quote','created','TEST',$3,$4,$5)",[randomUUID(),child,user,source,requestId]);
      if(order&&!linkAfter)await linkNewDigitalChild(c,{module:"sourcing",childId:child,productionOrderId:order.productionOrderId,lines:[]});
      const todo=await service.createInTransaction(c,actor,{todoType:"information",category:"configuration_notice",sourceEventId:source,sourceAction:"sourcing.case.create",entityType:"sourcing_case",entityId:child,recipientUserId:user,route:{routeName:"sourcing_detail",entityId:child},dedupeKey:randomUUID()});
      if(order&&linkAfter)await linkNewDigitalChild(c,{module:"sourcing",childId:child,productionOrderId:order.productionOrderId,lines:[]});
      await c.query("COMMIT");return todo;
    }catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  };
  it("retains legacy DingTalk delivery, suppresses new children before enqueue and after commit, and keeps in-app receipts independent",async()=>{
    const legacy=await create(false),digital=await create(true),late=await create(true,true);
    expect((await database.query("SELECT aggregate_id FROM message_outbox WHERE topic='todo.delivery'")).rows.map(r=>r.aggregate_id).sort()).toEqual([legacy.todoId,late.todoId].sort());
    const provider={createTodo:vi.fn(async(input:{todoId:string})=>({providerMessageId:"TEST",providerTodoId:input.todoId,state:"created" as const})),completeTodo:vi.fn(),updateTodo:vi.fn()};
    expect(await new TodoDeliveryWorker(database,provider,"https://acceptance.example/").runOnce()).toEqual({claimed:2,sent:1,suppressed:1,failed:0});
    expect(provider.createTodo).toHaveBeenCalledTimes(1);expect(provider.createTodo.mock.calls[0]?.[0].todoId).toBe(legacy.todoId);
    const notifications=new DigitalProductionNotificationService(database);await notifications.runOnce();
    const first=(await notifications.claim({...actor,actorRoles:["order_merchandiser"]})).notification!,second=(await notifications.claim({...actor,actorRoles:["order_merchandiser"]})).notification!;
    expect([first.route.todoId,second.route.todoId].sort()).toEqual([digital.todoId,late.todoId].sort());
    await notifications.acknowledge(actor,first.eventId);
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[first.route.todoId])).rows[0].status).toBe("pending");
  });
  it("integrates actionable tasks into the original todo list and badge without letting prompt acknowledgement clear either",async()=>{
    const order=await new DigitalProductionIdentityService(database,true).createOrder(actor,DigitalOrderCreateSchema.parse({customerCode:"PD",primaryMerchandiserId:user,productGroup:"男装",designStyleNo:"TEST-P04",orderDate:"2026-09-29",lines:[{color:"黑",sizes:[{size:"M",quantity:5}]}]}),randomUUID());
    const tasks=new DigitalProductionTaskService(database),notifications=new DigitalProductionNotificationService(database),todos=new TodoService(database,undefined,undefined,undefined,notifications);
    const c=await database.connect();let taskId:string;
    try{await c.query("BEGIN");taskId=(await tasks.createWithClient(c,actor,{resource:{kind:"order",id:order.productionOrderId},kind:"production_sheet",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:user})).taskId;await c.query("COMMIT");}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
    const todoActor={...actor,authorizationCapability:"todo:view"};
    const list=TodoListResponseSchema.parse(await todos.listForActor(todoActor,{module:"digital_production"}));
    expect(list.moduleCounts.digital_production).toBe(1);expect(list.todos[0]?.todoId).toBe(taskId);
    const before=await todos.countIndicatorForActor(todoActor);expect(before.pendingCount).toBe(1);
    await notifications.runOnce();const notice=(await notifications.claim({...actor,actorRoles:["order_merchandiser"]})).notification!;expect(notice.route.entityId).toBe(taskId);
    await notifications.acknowledge(actor,notice.eventId);
    expect(await todos.countIndicatorForActor(todoActor)).toEqual(before);
    expect((await todos.getForActor(todoActor,taskId)).status).toBe("pending");
  });
});
