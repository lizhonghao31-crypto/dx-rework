import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { TodoListResponseSchema } from "@dx-rework/contracts";
import { randomUUID } from "node:crypto";
import { readFile,readdir } from "node:fs/promises";
import pg from "pg";
import { afterAll,beforeAll,describe,expect,it,vi } from "vitest";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionNotificationService } from "../../apps/api/src/production-platform/notification-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { PatternOrderReader } from "../../apps/api/src/pattern-room/order-reader.js";
import type { DigitalTaskKind } from "../../apps/api/src/production-platform/task-access-repository.js";
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

  const worker=randomUUID(),otherWorker=randomUUID(),clerk=randomUUID(),supervisor=randomUUID();
  let operatorsReady=false;
  const operators=async()=>{
    if(!operatorsReady){
      await transaction(async database=>{
      await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
      for(const [id,roles] of [[worker,["pattern_room_worker"]],[otherWorker,["pattern_room_worker"]],
        [clerk,["development_clerk","pattern_room_tail_inspector"]],[supervisor,["pattern_room_supervisor"]]] as const){
        await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST context operator',true)",[id]);
        await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','P04',$2::uuid::text,$2::uuid::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);
        for(const role of roles)await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST context')",[randomUUID(),id,role,user]);
      }
      await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");
      });
      operatorsReady=true;
    }
    const effective=async(id:string):Promise<TrustedActorContext>=>{
      const roles=(await database.query("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL",[id])).rows.map(r=>r.role_code);
      const capabilities=(await database.query("SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])",[roles])).rows.map(r=>r.capability);
      return {actorId:id,actorRoles:roles,authorizationCapability:"todo:view",authorizationCapabilities:capabilities,requestId:randomUUID()};
    };
    return {craft:await effective(worker),other:await effective(otherWorker),clerk:await effective(clerk),manager:await effective(supervisor)};
  };
  const transaction=async<T,>(work:(c:pg.PoolClient)=>Promise<T>)=>{
    const c=await database.connect();try{await c.query("BEGIN");const result=await work(c);await c.query("COMMIT");return result;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}
  };
  const contextSource=async()=>{
    const source=await new DigitalProductionIdentityService(database,true).createSource(actor,
      {developmentType:"头版",designStyleNo:`TEST-SOURCE-${randomUUID()}`,temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const row=(await database.query("SELECT design_style_no FROM digital_production_sources WHERE source_id=$1",[source.sourceId])).rows[0];
    return {...source,designStyleNo:row.design_style_no as string};
  };
  const patternFixture=async()=>{
    const people=await operators(),source=await contextSource(),orderId=randomUUID(),roundId=randomUUID(),personId=randomUUID();
    const price=(await database.query("SELECT * FROM pattern_room_prices WHERE kind='category' ORDER BY sort_order LIMIT 1")).rows[0];
    await transaction(async c=>{
      // Fixture provisioning only, confined to this owned schema; runtime authorization remains real.
      await c.query("ALTER TABLE business_people DISABLE TRIGGER business_people_guard_creation");
      await c.query("INSERT INTO business_people(person_id,person_type,app_user_id,display_name,created_by) VALUES($1,'internal',$2,'TEST craft',$3) ON CONFLICT(app_user_id) DO NOTHING",[personId,worker,user]);
      await c.query("ALTER TABLE business_people ENABLE TRIGGER business_people_guard_creation");
      const person=(await c.query("SELECT person_id FROM business_people WHERE app_user_id=$1",[worker])).rows[0].person_id;
      await c.query("INSERT INTO pattern_room_orders(order_id,current_round_id,status,created_by,creator_name,style_no,customer) VALUES($1,$2,'in_progress',$3,'TEST creator','TEST-OWN-PATTERN','TEST-PRIVATE-CUSTOMER')",[orderId,roundId,user]);
      await c.query("INSERT INTO pattern_room_rounds(round_id,order_id,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount,requested_by) VALUES($1,$2,'in_progress',$3,$4,$5,$6,$7,1,$7,$8)",[roundId,orderId,price.price_id,price.version,price.name,price.unit,price.amount,user]);
      await c.query("INSERT INTO pattern_room_segments(segment_id,round_id,segment_index,person_id,worker_user_id,worker_name,person_type,amount) VALUES($1,$2,1,$3,$4,'TEST craft','internal',999)",[randomUUID(),roundId,person,worker]);
      await c.query("INSERT INTO digital_development_pattern_links(source_id,order_id,linked_by) VALUES($1,$2,$3)",[source.sourceId,orderId,user]);
    });
    const notices=new DigitalProductionNotificationService(database);
    const todo=async(recipient:TrustedActorContext)=>transaction(async c=>{
      const event=randomUUID();await c.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,reason) VALUES($1,$1::uuid::text,$2,ARRAY['root_superuser'],'todo:create','pattern_room.order.assigned','pattern_room_order',$3,'TEST')",[event,user,orderId]);
      return service.createInTransaction(c,actor,{todoType:"business_action",category:"pattern_room_execute",sourceEventId:event,sourceAction:"pattern_room.order.assigned",entityType:"pattern_room_order",entityId:orderId,recipientUserId:recipient.actorId,requiredRole:recipient.actorRoles[0]!,requiredCapability:"pattern_room:orders:view",route:{routeName:"pattern_room_order",entityId:orderId},policyKey:"general",dedupeKey:randomUUID()});
    });
    return {people,source,orderId,roundId,notices,todo};
  };
  it("supplies own pattern context without granting source or another worker's technical access",async()=>{
    const f=await patternFixture(),policy=new DigitalProductionAccessPolicy(database);
    expect(await policy.allowed(f.people.craft,"source",f.source.sourceId,"technical")).toBe(false);
    expect(await policy.allowed(f.people.manager,"source",f.source.sourceId,"technical")).toBe(true);
    await new PatternOrderReader(database,true).get(f.people.craft,f.orderId);
    await expect(new PatternOrderReader(database,true).get(f.people.other,f.orderId)).rejects.toMatchObject({statusCode:404});
    const own=await f.todo(f.people.craft);await f.todo(f.people.manager);await f.notices.runOnce();
    const notice=(await f.notices.claim(f.people.craft,true)).notification!;
    expect(notice.route.entityId).toBe(f.orderId);
    expect(notice.context).toEqual({styleNo:"TEST-OWN-PATTERN",orderId:null,colors:[],poNumbers:[]});
    expect((await f.notices.claim(f.people.manager)).notification?.context?.styleNo).toBe(f.source.designStyleNo);
    expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|999|budget|price|wage|customer/i);
    await f.notices.acknowledge(f.people.craft,notice.eventId);
    expect((await database.query("SELECT status FROM rework_todos WHERE todo_id=$1",[own.todoId])).rows[0].status).toBe("pending");
    expect(await policy.allowed(f.people.craft,"source",f.source.sourceId,"technical")).toBe(false);
  });
  it.each(["development_materials","development_washing_dispatch","development_tail_check"] as const)("supplies own task context for %s without source-wide access or business completion",async(kind:DigitalTaskKind)=>{
    const people=await operators(),source=await contextSource(),tasks=new DigitalProductionTaskService(database),notices=new DigitalProductionNotificationService(database),policy=new DigitalProductionAccessPolicy(database);
    const id=await transaction(async c=>{
      const {taskId}=await tasks.createWithClient(c,actor,{resource:{kind:"source",id:source.sourceId},kind,routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk});
      if(kind==="development_tail_check")await tasks.setConditionWithClient(c,actor,taskId,"washing_finished",true);
      return taskId;
    });
    expect(await policy.allowed(people.clerk,"source",source.sourceId,"technical")).toBe(false);
    expect(await policy.allowed(people.clerk,"task",id,"execute")).toBe(true);
    expect(await policy.allowed(people.manager,"source",source.sourceId,"technical")).toBe(true);
    const before=await tasks.read(people.clerk,id);await notices.runOnce();
    const notice=(await notices.claim(people.clerk,true)).notification!;expect(notice.route.entityId).toBe(id);
    expect(notice.context).toEqual({styleNo:source.designStyleNo,orderId:null,colors:[],poNumbers:[]});
    expect(JSON.stringify(notice)).not.toMatch(/PRIVATE|budget|price|wage|customer/i);
    expect((await notices.current(people.other,notice.eventId)).notification).toBeNull();
    await notices.acknowledge(people.clerk,notice.eventId);expect(await tasks.read(people.clerk,id)).toEqual(before);
    expect(await policy.allowed(people.clerk,"source",source.sourceId,"technical")).toBe(false);
  });
  it("does not expose pattern identity for a stale foreign recipient or cancelled child",async()=>{
    const f=await patternFixture();await f.todo(f.people.other);await f.todo(f.people.craft);await f.notices.runOnce();
    const foreign=(await f.notices.claim(f.people.other)).notification!;
    expect(foreign.context).toBeUndefined();
    await expect(new PatternOrderReader(database,true).get(f.people.other,f.orderId)).rejects.toMatchObject({statusCode:404});
    const own=(await f.notices.claim(f.people.craft)).notification!;expect(own.context?.styleNo).toBe("TEST-OWN-PATTERN");
    await database.query("UPDATE pattern_room_orders SET status='cancelled' WHERE order_id=$1",[f.orderId]);
    expect((await f.notices.current(f.people.craft,own.eventId)).notification?.context).toBeUndefined();
  });
  it("rechecks displayed pattern prompts after capability loss and account deactivation",async()=>{
    const f=await patternFixture();await f.todo(f.people.craft);await f.notices.runOnce();
    const own=(await f.notices.claim(f.people.craft)).notification!;
    expect((await f.notices.current({...f.people.craft,authorizationCapabilities:["todo:view"]},own.eventId)).notification).toBeNull();
    const setFixtureEnabled=async(enabled:boolean)=>transaction(async c=>{
      await c.query("ALTER TABLE app_users DISABLE TRIGGER app_users_employee_access_root_guard");
      await c.query("UPDATE app_users SET enabled=$2 WHERE id=$1",[worker,enabled]);
      await c.query("ALTER TABLE app_users ENABLE TRIGGER app_users_employee_access_root_guard");
    });
    await setFixtureEnabled(false);
    expect((await f.notices.current(f.people.craft,own.eventId)).notification).toBeNull();
    await setFixtureEnabled(true);
    expect((await f.notices.current(f.people.craft,own.eventId)).notification?.context?.styleNo).toBe("TEST-OWN-PATTERN");
    await new DigitalProductionTaskService(database).controlResource(actor,{kind:"source",id:f.source.sourceId},"pause","TEST pause",randomUUID());
    expect((await f.notices.current(f.people.craft,own.eventId)).notification?.context).toBeUndefined();
  });
  it("drops own development context when the source pauses or the task completes",async()=>{
    const people=await operators(),source=await contextSource(),tasks=new DigitalProductionTaskService(database),notices=new DigitalProductionNotificationService(database);
    const taskId=await transaction(async c=>(await tasks.createWithClient(c,actor,{resource:{kind:"source",id:source.sourceId},kind:"development_materials",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk})).taskId);
    await notices.runOnce();let own=(await notices.claim(people.clerk)).notification!;
    // Earlier matrix cases keep their business tasks open: claim until this exact task.
    for(let i=0;own.route.entityId!==taskId&&i<20;i++){await notices.acknowledge(people.clerk,own.eventId);own=(await notices.claim(people.clerk)).notification!;}
    expect(own.route.entityId).toBe(taskId);expect(own.context?.styleNo).toBe(source.designStyleNo);
    await tasks.controlResource(actor,{kind:"source",id:source.sourceId},"pause","TEST pause",randomUUID());
    expect((await notices.current(people.clerk,own.eventId)).notification).toBeNull();
    await tasks.controlResource(actor,{kind:"source",id:source.sourceId},"resume","TEST resume",randomUUID());
    await transaction(c=>tasks.setConditionWithClient(c,actor,taskId,"business_recorded",true));
    await tasks.complete(people.clerk,taskId,{note:"TEST completed"},randomUUID());
    expect((await notices.current(people.clerk,own.eventId)).notification).toBeNull();
    expect(await new DigitalProductionAccessPolicy(database).allowed(people.clerk,"source",source.sourceId,"technical")).toBe(false);
  });
});
