import {minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import { applyDigitalPoDateFixture } from "../helpers/digital-po-date-fixture.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DigitalOrderCreateSchema, DigitalSourceCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { DigitalTaskKind } from "../../apps/api/src/production-platform/task-access-repository.js";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("P03 task lifecycle PostgreSQL", () => {
  const schema = ownedPostgresSchema("digital_tasks");
  const admin = new pg.Pool({connectionString:databaseUrl!});
  const database = new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const designer=randomUUID(), other=randomUUID(), root=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create"],requestId:"P03"});
  const boss=actor(root,["root_superuser"]);
  const service=new DigitalProductionIdentityService(database,true), tasks=new DigitalProductionTaskService(database), app=Fastify();
  let currentStyle="TEST-P03";
  const input=()=>DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:currentStyle,orderDate:"2026-09-29",lines:[{color:"黑",customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:"M",quantity:5}]}]});
  const tx=async <T,>(action:(client:pg.PoolClient)=>Promise<T>)=>{const c=await database.connect();try{await c.query("BEGIN");const r=await action(c);await c.query("COMMIT");return r;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}};
  const order=async()=>{currentStyle=`TEST-P03-${randomUUID()}`;return {kind:"order" as const,id:(await service.createOrder(actor(),input(),randomUUID())).productionOrderId};};
  const create=async(resource:{kind:"order"|"source";id:string},kind:DigitalTaskKind="budget",extra:Partial<Parameters<DigitalProductionTaskService["createWithClient"]>[2]>={})=>tx(c=>tasks.createWithClient(c,boss,{resource,kind,routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:kind==="budget"?designer:null,...extra}));
  const condition=async(id:string,key:Parameters<DigitalProductionTaskService["setConditionWithClient"]>[3],at:string|null=null)=>tx(c=>tasks.setConditionWithClient(c,boss,id,key,true,at));
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0216_digital_production_order_roots.sql", "0217_digital_production_node_clocks.sql"])
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
    await applyDigitalPoDateFixture(database);
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
    app.setErrorHandler((error, _request, reply) => { const known = error as ApplicationError; reply.code(known.statusCode ?? 500).send({ error: { code: known.code, message: known.message } }); });
    registerDigitalIdentityRoutes(app, { service, taskService: tasks, accessService: new DigitalProductionAccessService(database), creationEnabled: true, authenticate: async token => {
      if (token !== designer && token !== other) throw new ApplicationError("UNAUTHORIZED", "请登录", 401);
      return { id: token, displayName: "TEST", businessRoles: ["sample_designer"], capabilities: ["pattern_room:orders:create"] };
    } });
    await app.ready();
  });
  afterAll(async () => { await app.close(); await database.end(); await releaseOwnedPostgresSchema(admin,schema); await admin.end(); });
  it("P15 scopes cockpit sources, preserves task deadlines and audits priority without changing clocks",async()=>{
    const source=await service.createSource(actor(),DigitalSourceCreateSchema.parse({developmentType:"头版",designStyleNo:"TEST-P15-COCKPIT",customerCode:"PD"}),randomUUID());
    const resource={kind:"source" as const,id:source.sourceId};
    const task=await create(resource,"budget");
    const cockpit=new DigitalCockpitQuery(database);
    const query={page:1,search:"TEST-P15-COCKPIT",stage:"development" as const};
    expect((await cockpit.list(actor(other),query)).total).toBe(0);
    const result=await cockpit.list(actor(),query);
    expect(result).toMatchObject({total:1,actorName:"TEST P01",canManagePolicies:false});
    expect(result.items[0]!.tasks[0]).toMatchObject({taskId:task.taskId,slaHours:null,priority:"normal"});
    const before=await tasks.read(boss,task.taskId);
    await expect(tasks.prioritize(actor(),task.taskId,"urgent",randomUUID())).rejects.toMatchObject({statusCode:403});
    const key=randomUUID();await tasks.prioritize(boss,task.taskId,"urgent",key);await tasks.prioritize(boss,task.taskId,"urgent",key);
    const after=await tasks.read(boss,task.taskId);expect(after).toMatchObject({priority:"urgent",enteredAt:before.enteredAt,dueAt:before.dueAt});
    expect((await tasks.history(boss,task.taskId)).events.filter(e=>e.kind==='priority_changed')).toHaveLength(1);
    await condition(task.taskId,"business_recorded");await tasks.complete(boss,task.taskId,{note:""},randomUUID());
    await expect(tasks.prioritize(boss,task.taskId,"normal",randomUUID())).rejects.toMatchObject({statusCode:409});
  });
  it("PR05 SQL scope preserves pagination and ignores historical source grants",async()=>{
    const search="TEST-P15-PAGE";
    const sources=[];
    for(let n=0;n<21;n++)sources.push(await service.createSource(actor(),DigitalSourceCreateSchema.parse({developmentType:"头版",designStyleNo:`${search}-${n}`,customerCode:"PD"}),randomUUID()));
    const cockpit=new DigitalCockpitQuery(database),query={page:1,search,stage:"development" as const};
    const first=await cockpit.list(actor(),query),second=await cockpit.list(actor(),{...query,page:2});
    expect(first.total).toBe(21);expect(first.items).toHaveLength(15);expect(second.items).toHaveLength(6);expect(second.total).toBe(21);
    expect(new Set([...first.items,...second.items].map(row=>row.id)).size).toBe(21);
    expect(first.summary).toEqual(second.summary);expect((await cockpit.list(actor(other),query)).total).toBe(0);
    const access=new DigitalProductionAccessService(database);
    await expect(access.delegate(boss,{resourceKind:"source",resourceId:sources[0]!.sourceId,delegateId:other,purpose:"technical",expiresAt:new Date(Date.now()+3600000).toISOString()})).rejects.toMatchObject({statusCode:403});
    await database.query("INSERT INTO digital_production_delegations(delegation_id,source_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP+interval '1 hour')",[randomUUID(),sources[0]!.sourceId,other,root]);
    expect((await cockpit.list(actor(other),query)).total).toBe(0);

  });
  it("PR05 preserves legitimate assigned sources and denies historical task grants",async()=>{
    const search='TEST-P15-ASSIGNED',workerId=randomUUID(),hiddenWorkerId=randomUUID();
    for(const id of [workerId,hiddenWorkerId])await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST assigned worker',true)",[id]);
    const first=await service.createSource(actor(),DigitalSourceCreateSchema.parse({developmentType:'头版',designStyleNo:search+'-A',customerCode:'PD'}),randomUUID());
    const second=await service.createSource(actor(),DigitalSourceCreateSchema.parse({developmentType:'头版',designStyleNo:search+'-B',customerCode:'PD'}),randomUUID());
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_worker'),($2,'pattern_room_worker')",[workerId,hiddenWorkerId]);
    const assigned=await create({kind:'source',id:first.sourceId},'development_pattern',{assigneeId:workerId});
    const hidden=await create({kind:'source',id:first.sourceId},'development_cutting',{assigneeId:hiddenWorkerId});
    const unrelated=await create({kind:'source',id:second.sourceId},'development_pattern',{assigneeId:hiddenWorkerId});
    const worker=actor(workerId,['pattern_room_worker']),cockpit=new DigitalCockpitQuery(database),input={page:1,search,stage:'development' as const};
    const visible=await cockpit.list(worker,input);expect(visible.total).toBe(1);expect(visible.items[0]!.sourceId).toBe(first.sourceId);
    expect(visible.items[0]!.tasks.map(task=>task.taskId)).toEqual([assigned.taskId]);expect(visible.items[0]!.tasks.some(task=>task.taskId===hidden.taskId)).toBe(false);
    expect(visible.summary.active).toBe(1);
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1 AND role_code='pattern_room_worker'",[workerId]);
    expect((await cockpit.list(worker,input)).total).toBe(0);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')",[workerId]);
    await database.query("INSERT INTO digital_production_delegations(delegation_id,task_id,delegate_id,purpose,granted_by,expires_at) VALUES($1,$2,$3,'technical',$4,CURRENT_TIMESTAMP+interval '1 hour')",[randomUUID(),unrelated.taskId,workerId,root]);
    expect((await cockpit.list(worker,input)).total).toBe(0);

  });
  it("keeps no-SLA tasks usable without creating a legacy clock and denies cross-order access", async()=>{
    const resource=await order();const {taskId}=await create(resource);
    expect(await tasks.read(actor(),taskId)).toMatchObject({state:"ready",dueAt:null,slaHours:null,canExecute:true});
    expect((await database.query("SELECT * FROM production_order_node_clocks WHERE node_instance_id=$1",[taskId])).rows).toHaveLength(0);
    await expect(tasks.read(actor(other),taskId)).rejects.toMatchObject({statusCode:404});
    await expect(tasks.complete(actor(),taskId,{note:""},randomUUID())).rejects.toMatchObject({statusCode:409});
    await condition(taskId,"business_recorded");
    const key=randomUUID();const results=await Promise.all([tasks.complete(actor(),taskId,{note:""},key),tasks.complete(actor(),taskId,{note:""},key)]);
    expect(results[0]).toEqual(results[1]);
    expect((await database.query("SELECT * FROM digital_production_task_events WHERE task_id=$1 AND event_kind='completed'",[taskId])).rows).toHaveLength(1);
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1",[designer]);
    await expect(tasks.complete(actor(),taskId,{note:""},key)).rejects.toMatchObject({statusCode:404});
    await database.query("UPDATE user_role_assignments SET revoked_at=NULL WHERE user_id=$1",[designer]);
  });
  it("does not time preassignment, releases once as concurrent facts arrive, and keeps immutable clocks",async()=>{
    const resource=await order();const {taskId}=await create(resource,"development_sewing");
    expect(await tasks.read(boss,taskId)).toMatchObject({state:"pending",enteredAt:null,dueAt:null});
    const at=new Date(Date.now()-36*3600000).toISOString();
    await Promise.all([condition(taskId,"materials_ready",at),condition(taskId,"handover_received",at)]);
    const ready=await tasks.read(boss,taskId);expect(ready.state).toBe("ready");expect(ready.enteredAt).toBe(at);
    expect(new Date(ready.dueAt!).getTime()-new Date(at).getTime()).toBe(24*3600000);
    expect((await database.query("SELECT * FROM digital_production_task_events WHERE task_id=$1 AND event_kind='ready'",[taskId])).rows).toHaveLength(1);
    await expect(database.query("UPDATE production_order_node_clocks SET entered_at=CURRENT_TIMESTAMP WHERE node_instance_id=$1",[taskId])).rejects.toBeTruthy();
  });
  it("classifies server conditions as live across a long transaction, while retaining manual prerequisite provenance",async()=>{
    const resource=await order(),live=await create(resource,'development_pattern');
    const client=await database.connect();
    try{
      await client.query('BEGIN');await client.query('SELECT pg_sleep(0.06)');
      await tasks.setConditionWithClient(client,boss,live.taskId,'materials_ready',true,undefined);
      await tasks.setConditionWithClient(client,boss,live.taskId,'handover_received',true,undefined);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const ready=await tasks.read(boss,live.taskId);
    expect(ready).toMatchObject({state:'ready',timeQuality:'现场登记',slaHours:48});
    expect(Date.parse(ready.dueAt!)-Date.parse(ready.enteredAt!)).toBe(48*3600000);
    const events=(await tasks.history(boss,live.taskId)).events.filter(event=>['condition','ready'].includes(event.kind));
    expect(events.length).toBe(3);expect(events.every(event=>event.quality==='现场登记')).toBe(true);
    // Timestamp ordering alone does not establish provenance; the 43ms case has a separate metrics regression.
    const manual=await create(await order(),'development_pattern');
    await condition(manual.taskId,'materials_ready',new Date(Date.now()-60000).toISOString());
    const c=await database.connect();try{await c.query('BEGIN');await tasks.setConditionWithClient(c,boss,manual.taskId,'handover_received',true,undefined);await c.query('COMMIT');}finally{c.release();}
    expect(await tasks.read(boss,manual.taskId)).toMatchObject({state:'ready',timeQuality:'补报未核实'});
  });
  it("applies SLA revisions to unfinished tasks only, including paused and blocked, then removes SLA",async()=>{
    const r=await order();const t1=await create(r,"development_cutting");const t2=await create(await order(),"development_cutting");
    const at=new Date(Date.now()-5*3600000).toISOString();
    await condition(t1.taskId,"handover_received",at);await condition(t2.taskId,"handover_received",at);await condition(t2.taskId,"business_recorded");
    await tasks.complete(boss,t2.taskId,{note:""},randomUUID());
    const completed=await tasks.read(boss,t2.taskId);
    await tasks.feedback(boss,t1.taskId,"待布",true,randomUUID());await tasks.controlResource(boss,r,"pause","等料",randomUUID());
    const policy=(await tasks.policies(boss)).find(p=>p.nodeKey==="development_cutting")!;
    await tasks.changePolicy(boss,"development_cutting",{expectedVersion:policy.version,slaHours:2,warningRatio:0.5,note:"收紧"},randomUUID());
    expect(new Date((await tasks.read(boss,t1.taskId)).dueAt!).getTime()).toBe(new Date(at).getTime()+2*3600000);
    expect((await tasks.read(boss,t2.taskId)).dueAt).toBe(completed.dueAt);
    await tasks.changePolicy(boss,"development_cutting",{expectedVersion:policy.version+1,slaHours:null,warningRatio:0.8,note:"无SLA"},randomUUID());
    expect(await tasks.read(boss,t1.taskId)).toMatchObject({dueAt:null,enteredAt:at,paused:true});
    await expect(tasks.changePolicy(actor(),"development_cutting",{expectedVersion:3,slaHours:1,warningRatio:0.8,note:""},randomUUID())).rejects.toMatchObject({statusCode:403});
  });
  it("keeps event and successor release atomic and does not double-release",async()=>{
    const resource=await order();const routeId=randomUUID();const first=await create(resource,"budget",{routeId});const next=await create(resource,"production_sheet",{routeId,predecessors:[first.taskId]});
    await condition(first.taskId,"business_recorded");
    await database.query(`CREATE FUNCTION reject_test_event() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_kind='completed' THEN RAISE EXCEPTION 'test rollback'; END IF;RETURN NEW;END $$; CREATE TRIGGER test_event BEFORE INSERT ON digital_production_event_intents FOR EACH ROW EXECUTE FUNCTION reject_test_event()`);
    await expect(tasks.complete(boss,first.taskId,{note:""},randomUUID())).rejects.toThrow("test rollback");
    expect((await tasks.read(boss,first.taskId)).state).toBe("ready");expect((await tasks.read(boss,next.taskId)).state).toBe("pending");
    await database.query("DROP TRIGGER test_event ON digital_production_event_intents");
    await Promise.all([tasks.complete(boss,first.taskId,{note:""},randomUUID()),tasks.complete(boss,first.taskId,{note:""},randomUUID())]);
    expect((await tasks.read(boss,next.taskId)).state).toBe("ready");
    expect((await database.query("SELECT * FROM digital_production_task_events WHERE task_id=$1 AND event_kind='ready'",[next.taskId])).rows).toHaveLength(1);
    expect((await database.query("SELECT e.event_id FROM digital_production_task_events e LEFT JOIN digital_production_event_intents i USING(event_id) WHERE e.task_id=$1 AND i.event_id IS NULL",[first.taskId])).rows).toHaveLength(0);
  });
  it("records downstream receipt without inventing the unknown upstream completion and blocks missing material",async()=>{
    const worker=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST receipt worker',true)",[worker]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_worker')",[worker]);
    const source=await service.createSource(actor(),DigitalSourceCreateSchema.parse({developmentType:"头版",designStyleNo:"TEST-SOURCE"}),randomUUID());
    const resource={kind:"source" as const,id:source.sourceId};const routeId=randomUUID();const a=await create(resource,"budget",{routeId,occurredAt:null});const b=await create(resource,"development_sewing",{routeId,predecessors:[a.taskId]});
    await tasks.handover(boss,b.taskId,{note:"补交接"},randomUUID());expect((await tasks.history(boss,b.taskId)).events.some(e=>e.kind==="condition"&&e.payload.note==="补交接")).toBe(true);expect((await tasks.read(boss,b.taskId)).state).toBe("pending");
    await condition(a.taskId,"business_recorded");await tasks.complete(boss,a.taskId,{occurredAt:null,note:"未知"},randomUUID());
    await condition(b.taskId,"materials_ready",new Date().toISOString());
    expect(await tasks.read(boss,b.taskId)).toMatchObject({state:"pending",enteredAt:null,dueAt:null});
    await tasks.reassign(boss,b.taskId,worker,randomUUID());
    expect(await tasks.read(boss,b.taskId)).toMatchObject({state:"ready",enteredAt:null,dueAt:null,timeQuality:"缺失"});
    expect((await tasks.read(boss,a.taskId)).completedAt).toBeNull();
    expect((await database.query("SELECT * FROM production_order_node_clocks WHERE node_instance_id=$1",[b.taskId])).rows).toHaveLength(0);
  });
  it("preserves original facts on correction and the completed policy snapshot",async()=>{
    const {taskId}=await create(await order(),"development_tail_check");const at=new Date(Date.now()-3600000).toISOString();await condition(taskId,"washing_finished",at);await condition(taskId,"business_recorded");await tasks.complete(boss,taskId,{note:""},randomUUID());
    const original=(await tasks.history(boss,taskId)).events.find(e=>e.kind==="ready")!;
    const before=await tasks.read(boss,taskId);const p=(await tasks.policies(boss)).find(p=>p.nodeKey==="development_tail_check")!;
    await tasks.changePolicy(boss,p.nodeKey,{expectedVersion:p.version,slaHours:1,warningRatio:0.8,note:"修改"},randomUUID());
    const corrected=new Date(new Date(at).getTime()-3600000).toISOString();await tasks.correctTime(boss,taskId,{eventId:original.eventId,occurredAt:corrected,reason:"核实"},randomUUID());
    const after=await tasks.read(boss,taskId);expect(after.policyVersion).toBe(before.policyVersion);expect(after.enteredAt).toBe(corrected);
    const history=await tasks.history(boss,taskId);expect(new Date(history.events.find(e=>e.eventId===original.eventId)!.occurredAt).toISOString()).toBe(at);expect(history.events.some(e=>e.correctsEventId===original.eventId)).toBe(true);
  });
  it("keeps original deadlines over pause, resumes ready facts, and cancels without successors",async()=>{
    const r=await order();const t=await create(r,"development_sewing");await tasks.controlResource(boss,r,"pause","等料",randomUUID());
    const at=new Date(Date.now()-3600000).toISOString();await condition(t.taskId,"materials_ready",at);await condition(t.taskId,"handover_received",at);expect((await tasks.read(boss,t.taskId)).state).toBe("pending");
    await tasks.controlResource(boss,r,"resume","已到",randomUUID());const ready=await tasks.read(boss,t.taskId);expect(ready.enteredAt).toBe(at);
    await tasks.controlResource(boss,r,"pause","再次等待",randomUUID());await expect(tasks.complete(boss,t.taskId,{note:""},randomUUID())).rejects.toMatchObject({statusCode:409});
    await tasks.controlResource(boss,r,"resume","恢复",randomUUID());expect((await tasks.read(boss,t.taskId)).dueAt).toBe(ready.dueAt);
    await tasks.controlResource(boss,r,"cancel","取消",randomUUID());await expect(create(r,"budget")).rejects.toMatchObject({statusCode:409});expect((await tasks.read(boss,t.taskId)).state).toBe("cancelled");
  });
  it("keeps rework occurrences separate and validates the route resource",async()=>{
    const r=await order();const old=await create(r,"budget");const next=await create(r,"budget",{occurrence:2,routeVersion:2});expect(next.taskId).not.toBe(old.taskId);
    await expect(create(await order(),"production_sheet",{predecessors:[old.taskId]})).rejects.toMatchObject({statusCode:409});
    expect((await tasks.read(boss,old.taskId)).routeVersion).toBe(1);
  });
  it("has authenticated task routes and no public bypass for business conditions",async()=>{
    expect((await app.inject({method:"GET",url:"/digital-production/tasks"})).statusCode).toBe(401);
    expect((await app.inject({method:"POST",url:"/digital-production/tasks",headers:{cookie:`dx_rework_session=${designer}`},payload:{}})).statusCode).toBe(404);
    const r=await order();const {taskId}=await create(r);
    expect((await app.inject({method:"POST",url:`/digital-production/tasks/${taskId}/complete`,headers:{cookie:`dx_rework_session=${designer}`,"idempotency-key":randomUUID()},payload:{note:""}})).statusCode).toBe(409);
  });

  it("creates a successor and completes the predecessor in one adapter transaction",async()=>{
    const resource=await order();const routeId=randomUUID();const first=await create(resource,"budget",{routeId});await condition(first.taskId,"business_recorded");
    const build=async(c:pg.PoolClient)=>{await tasks.completeWithClient(c,boss,first.taskId,{note:""},"atomic-adapter");return tasks.createWithClient(c,boss,{resource,kind:"production_sheet",routeId,routeVersion:1,occurrence:1,assigneeId:null,predecessors:[first.taskId]});};
    await expect(tx(async c=>{await build(c);throw new Error("adapter rollback");})).rejects.toThrow("adapter rollback");
    expect((await tasks.read(boss,first.taskId)).state).toBe("ready");
    const next=await tx(build);expect((await tasks.read(boss,next.taskId)).state).toBe("ready");expect((await tasks.read(boss,next.taskId)).routeProgress).toMatchObject({applicable:2,completed:1});
  });
  it("serializes policy changes against completion without rewriting completed history",async()=>{
    const {taskId}=await create(await order(),"development_materials");await condition(taskId,"business_recorded");
    const p=(await tasks.policies(boss)).find(p=>p.nodeKey==="development_materials")!;
    await Promise.all([tasks.complete(boss,taskId,{note:""},randomUUID()),tasks.changePolicy(boss,p.nodeKey,{expectedVersion:p.version,slaHours:2,warningRatio:0.8,note:"并发调整"},randomUUID())]);
    const history=await tasks.history(boss,taskId);expect(history.revisions.at(-1)?.reason).toBe("completion");
    const snapshot=await tasks.read(boss,taskId);await tasks.changePolicy(boss,p.nodeKey,{expectedVersion:p.version+1,slaHours:null,warningRatio:0.8,note:"取消时限"},randomUUID());
    expect((await tasks.read(boss,taskId)).dueAt).toBe(snapshot.dueAt);
  });

  it("reassignment revokes the old operator and limits clerks to development dispatch",async()=>{
    const clerk=randomUUID(),worker=randomUUID();for(const [id,role] of [[clerk,"development_clerk"],[worker,"pattern_room_worker"]]){await database.query("INSERT INTO app_users(id,display_name) VALUES($1,'TEST DISPATCH')",[id]);await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,$2)",[id,role]);}
    const {taskId}=await create(await order(),"development_cutting");await tasks.reassign(actor(clerk,["development_clerk"]),taskId,worker,randomUUID());
    expect((await tasks.read(actor(worker,["pattern_room_worker"]),taskId)).canExecute).toBe(true);
    await expect(tasks.reassign(actor(clerk,["development_clerk"]),taskId,designer,randomUUID())).rejects.toMatchObject({statusCode:403});
    const budget=await create(await order());await expect(tasks.reassign(actor(clerk,["development_clerk"]),budget.taskId,other,randomUUID())).rejects.toMatchObject({statusCode:403});
    await database.query("UPDATE app_users SET enabled=false WHERE id=$1",[worker]);await expect(tasks.handover(actor(worker,["pattern_room_worker"]),taskId,{note:""},randomUUID())).rejects.toMatchObject({statusCode:404});
  });

  it("does not invent an entry or deadline when only some activation times are known",async()=>{
    const {taskId}=await create(await order(),"development_sewing");
    await condition(taskId,"materials_ready",null);await condition(taskId,"handover_received",new Date().toISOString());
    expect(await tasks.read(boss,taskId)).toMatchObject({state:"ready",enteredAt:null,dueAt:null,slaHours:24,timeQuality:"缺失"});
    expect((await database.query("SELECT * FROM production_order_node_clocks WHERE node_instance_id=$1",[taskId])).rows).toHaveLength(0);
    const event=(await tasks.history(boss,taskId)).events.find(e=>e.kind==="ready")!;
    const known=new Date(Date.now()-1000).toISOString();await tasks.correctTime(boss,taskId,{eventId:event.eventId,occurredAt:known,reason:"核实真实进入时间"},randomUUID());
    expect((await tasks.read(boss,taskId)).dueAt).toBe(new Date(new Date(known).getTime()+24*3600000).toISOString());
    expect((await tasks.history(boss,taskId)).revisions).toHaveLength(2);
  });

  it("limits business-adapter task authority to the exact originating resource",async()=>{
    const first=await order(),second=await order(),origin=await create(first,"budget");
    await expect(tx(client=>tasks.createWithClient(client,boss,{resource:second,authorizingTaskId:origin.taskId,kind:"production_sheet",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null}))).rejects.toMatchObject({statusCode:403});
    const next=await tx(client=>tasks.createWithClient(client,boss,{resource:first,authorizingTaskId:origin.taskId,kind:"production_sheet",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null}));
    expect((await tasks.read(boss,next.taskId)).orderId).toBe(first.id);
  });

});
