import {AccessMasterDataService} from "../../apps/api/src/access/service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {SlaOrderService} from "../../apps/api/src/production-platform/sla-order-service.js";
import {installAcceptanceClockReader} from "../../apps/api/src/acceptance-clock/business-time.js";
import {SystemBusinessClock} from '@dx-rework/domain/business-clock';
import { migrationExecutionSql } from "../../scripts/deploy/migration-execution-compatibility.mjs";
import { DevelopmentDocumentSchema } from "@dx-rework/contracts/digital-development";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JourneyFilterSchema } from "@dx-rework/contracts/digital-production-journey";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalProductionAccessPolicy } from "../../apps/api/src/production-platform/access-policy.js";
import { selectJourneys } from "../../apps/api/src/production-platform/journey-projection.js";
import { DigitalJourneyQuery } from "../../apps/api/src/production-platform/journey-query.js";
import { developmentView, patternTasks, DevelopmentWorkspaceQuery } from "../../apps/api/src/production-platform/development-workspace-query.js";
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";
import { RootAuthority } from "../../apps/api/src/access/root-authority.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("V2 Journey with full original PostgreSQL schema",()=>{
  const schema=ownedPostgresSchema("digital_journey");
  const admin=new pg.Pool({connectionString:databaseUrl});
  const db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
  const root=randomUUID(),designer=randomUUID(),stranger=randomUUID(),worker=randomUUID(),clerk=randomUUID(),tail=randomUUID(),merchandiser=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create"],requestId:"TEST-v2-journey"});
  const identity=new DigitalProductionIdentityService(db,true,undefined,()=>new Date("2026-09-01T00:00:00Z"),new SystemBusinessClock()),journeys=new DigitalJourneyQuery(db),tasks=new DigitalProductionTaskService(db);
  const input=(suffix="0001")=>DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:`TEST-J-${suffix}`,temporaryStyleNo:`TEST-T-${suffix}`,orderDate:"2026-09-01",lines:[{poNumber:"PO-J1",color:"黑",sizes:[{size:"M",quantity:100}],deliveryDate:"2026-10-20"},{poNumber:"PO-J2",color:"白",sizes:[{size:"L",quantity:200}],deliveryDate:"2026-10-22"}]});
  const publishSource=async(sourceId:string)=>{
    const fileId=randomUUID();
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`TEST/journey/${fileId}`,"a".repeat(64),designer]);
    const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:"上衣",quantity:1,sampleSize:"M",orderDate:null,returnDate:null,unit:"cm",sizes:["M"],measurements:[],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[],files:[{attachmentId:fileId,kind:"款图"}]});
    const forms=new DigitalDevelopmentService(db,true),draft=await forms.save(actor(),sourceId,{expectedVersion:0,document},randomUUID());
    await forms.publish(actor(),sourceId,draft.version,randomUUID());
  };
  const createTask=async(input:Parameters<DigitalProductionTaskService["createWithClient"]>[2])=>{
    const client=await db.connect();try{await client.query("BEGIN");const task=await tasks.createWithClient(client,actor(root,["root_superuser"]),input);await client.query("COMMIT");return task;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  };
  const app=Fastify();
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:Array<{version:string;checksum:string}>};
    await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    const serverVersion=Number((await db.query("SHOW server_version_num")).rows[0].server_version_num);
    for(const migration of manifest.migrations){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),"utf8");await db.query(migrationExecutionSql({...migration,sql},serverVersion));await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]);}
    for(const [id,role] of [[root,"owner_group"],[designer,"sample_designer"],[stranger,"sample_designer"],[worker,"pattern_room_worker"],[clerk,"development_clerk"],[tail,"pattern_room_tail_inspector"],[merchandiser,"order_merchandiser"]]){
      await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,`TEST-J ${role}`]);
      await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);
      await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST Journey fixture')",[randomUUID(),id,role,root]);
    }
    await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1::uuid,$1::uuid::text,'TEST')",[root]);
    app.setErrorHandler((error,_request,reply)=>{const known=error as ApplicationError;reply.code(known.statusCode??500).send({error:{code:known.code,message:known.message}});});
    registerDigitalIdentityRoutes(app,{service:identity,journeys,taskService:tasks,root:new RootAuthority(db,"TEST",undefined),creationEnabled:true,authenticate:async token=>{
      if(!token||![root,designer,stranger,merchandiser,worker,clerk,tail].includes(token))throw new ApplicationError("UNAUTHORIZED","请登录",401);
      const roles=(await db.query("SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL",[token])).rows.map(row=>row.role_code as string);
      const capabilities=(await db.query("SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])",[roles])).rows.map(row=>row.capability as string);
      return {id:token,displayName:"TEST",businessRoles:roles,capabilities};
    }});
    await app.ready();
  },120000);
  afterAll(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  it("uses the original assignment, upstream and completion reasons in both management summary and detail",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-A02-BLOCKERS",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    const routeId=randomUUID();
    const pattern=await createTask({resource:{kind:"source",id:sourceId},kind:"development_pattern",routeId,routeVersion:1,occurrence:1,assigneeId:null});
    const upstream=await createTask({resource:{kind:"source",id:sourceId},kind:"development_cutting",routeId,routeVersion:1,occurrence:1,assigneeId:worker,conditions:["handover_received"],predecessors:[pattern.taskId]});
    const sewing=await createTask({resource:{kind:"source",id:sourceId},kind:"development_sewing",routeId,routeVersion:1,occurrence:1,assigneeId:worker,conditions:["pattern_assignment_ready"]});
    const completion=await createTask({resource:{kind:"source",id:sourceId},kind:"development_shipping",routeId,routeVersion:1,occurrence:1,assigneeId:designer});
    const boss=actor(root,["owner_group"]);
    const summaries=await journeys.list(boss,JourneyFilterSchema.parse({scope:"development",search:"TEST-A02-BLOCKERS"}),false,undefined,{details:false});
    const detail=await journeys.read(boss,sourceId,1);
    const from=(value:typeof detail,id:string)=>value.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===id)!;
    for(const projection of [summaries.items[0]!,detail]){
      const missing=from(projection,pattern.taskId);expect(missing.blockers.map(b=>b.label).join("；")).toMatch(/尚未安排办理人.*开发文员/);
      expect(missing.blockers.some(b=>/业务角色|业务结果尚未提交/.test(b.label))).toBe(false);
      expect(missing.records[0]?.mode).toBe("read");expect(missing.records[0]?.url).toContain(pattern.taskId);
      const waiting=from(projection,upstream.taskId);expect(waiting.blockers.map(b=>b.label).join("；")).toContain("尚未完成");expect(waiting.blockers.some(b=>b.key.startsWith("completion:"))).toBe(false);
      expect(from(projection,sewing.taskId).blockers.map(b=>b.label).join("；")).toMatch(/尚未建立本单原执行记录.*设计师/);
      const ready=from(projection,completion.taskId);expect(ready.state).toBe("active");expect(ready.blockers.find(b=>b.key==="completion:business_recorded")?.label).toMatch(/完成办理前.*设计师/);
    }
    await expect(journeys.read(actor(stranger),sourceId,1)).rejects.toMatchObject({statusCode:404});
  });
  it("reads five real log events first and cursor-pages every scoped event without ties, new events or foreign cursors leaking",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-COCKPIT-LOG",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    const task=await createTask({resource:{kind:"source",id:sourceId},kind:"development_materials",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk});
    for(let i=0;i<43;i++)await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,recorded_at,time_quality) VALUES($1,$2,'source',$3,'condition',$4,'2026-10-01T12:00:00.000001Z','缺失')",[randomUUID(),task.taskId,sourceId,clerk]);
    const expected=Number((await db.query("SELECT count(*) FROM digital_production_task_events WHERE task_id=$1",[task.taskId])).rows[0].count);
    const read=await journeys.read(actor(),sourceId),summary=read.operationLog!;
    expect(summary.items).toHaveLength(5);expect(summary.nextCursor).not.toBeNull();
    const inserted=randomUUID();await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,time_quality) VALUES($1,$2,'source',$3,'condition',$4,'缺失')",[inserted,task.taskId,sourceId,clerk]);
    const seen=summary.items.map(item=>item.id);let cursor=summary.nextCursor;
    while(cursor){const page=await journeys.logs(actor(),sourceId,cursor);expect(page.asOf).toBe(summary.asOf);expect(page.items.length).toBeGreaterThan(0);expect(page.items.length).toBeLessThanOrEqual(20);if(page.nextCursor)expect(page.items).toHaveLength(20);else expect(page.items).toHaveLength(expected-seen.length);seen.push(...page.items.map(item=>item.id));cursor=page.nextCursor;}
    expect(seen).toHaveLength(expected);expect(new Set(seen).size).toBe(expected);expect(seen).not.toContain(`task:${inserted}`);
    const other=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-COCKPIT-OTHER",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    await expect(journeys.logs(actor(),other,summary.nextCursor!)).rejects.toMatchObject({statusCode:400});
    await expect(journeys.logs(actor(stranger),sourceId,summary.nextCursor!)).rejects.toMatchObject({statusCode:404});
    await expect(journeys.logs(actor(root,["root_superuser"]),sourceId,summary.nextCursor!)).rejects.toMatchObject({statusCode:400});
    const response=await app.inject({url:`/digital-production/journeys/${sourceId}/logs`,headers:{cookie:`dx_rework_session=${designer}`}});
    expect(response.statusCode,response.body).toBe(200);expect(response.json().items).toHaveLength(20);expect(response.headers["cache-control"]).toBe("no-store");
  });
  it("keeps compact flow dates and current risks on the effective round while reading an older round",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-FLOW-CURRENT-ROUND",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    await publishSource(sourceId);
    const published=(await db.query("SELECT document FROM digital_development_documents WHERE source_id=$1",[sourceId])).rows[0].document;
    const routeId=randomUUID();
    await db.query("INSERT INTO digital_development_rounds(source_id,round_number,based_on_round,document_version,document,origin,customer_comment,internal_problem,explanation,categories,affected_nodes,output_kind,route_nodes,inherited,route_id,created_by) VALUES($1,2,1,2,$2,'客户新增要求','TEST第二轮','','TEST当前有效轮',ARRAY['纸样'],ARRAY['development_pattern'],'整件样板',ARRAY['development_pattern'],'{}',$3,$4)",[sourceId,JSON.stringify(published),routeId,designer]);
    const task=await createTask({resource:{kind:"source",id:sourceId},kind:"development_pattern",routeId,routeVersion:2,occurrence:1,assigneeId:worker});
    const activate=await db.connect();try{await activate.query("BEGIN");await tasks.setConditionWithClient(activate,actor(root,["root_superuser"]),task.taskId,"materials_ready",true);await tasks.setConditionWithClient(activate,actor(root,["root_superuser"]),task.taskId,"handover_received",true);await activate.query("COMMIT");}catch(error){await activate.query("ROLLBACK");throw error;}finally{activate.release();}
    const current=await journeys.read(actor(),sourceId,undefined,true),older=await journeys.read(actor(),sourceId,1,true);
    const flowNode=older.flowStages?.flatMap(stage=>stage.nodes).find(node=>node.instanceId===task.taskId);
    expect(older.selectedRound).toBe(1);expect(flowNode).toMatchObject({round:2,current:true});// Ready conditions do not prove a real R2 material-check completion.
    expect(flowNode?.expectedAt).toBeNull();
    expect(flowNode?.expectedAt).toBe(current.flowStages?.flatMap(stage=>stage.nodes).find(node=>node.instanceId===task.taskId)?.expectedAt);
    expect(older.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===task.taskId)?.current).toBe(false);
    expect(older.display).toEqual(current.display);expect(older.currentRiskNodes?.every(node=>node.stage!=="development"||node.round===2)).toBe(true);
    await expect(journeys.read(actor(stranger),sourceId,1,true)).rejects.toMatchObject({statusCode:404});
  });
  it("reads only pending original assignment facts and never starts its digital sewing context",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-J-NATIVE-ASSIGN",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    const task=await createTask({resource:{kind:"source",id:sourceId},kind:"development_sewing_transfer",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk});
    const price=(await db.query("SELECT price_id,version,name,unit,amount FROM pattern_room_prices WHERE kind='category' AND enabled AND amount IS NOT NULL LIMIT 1")).rows[0];
    const orderId=randomUUID(),roundId=randomUUID(),client=await db.connect();
    try{
      await client.query("BEGIN");
      await client.query("INSERT INTO pattern_room_orders(order_id,current_round_id,status,created_by,creator_name,style_no) VALUES($1,$2,'pending_assignment',$3,'TEST设计师','TEST-J-NATIVE-ASSIGN')",[orderId,roundId,designer]);
      await client.query("INSERT INTO pattern_room_rounds(round_id,order_id,status,category_id,price_version,category_name,unit,unit_price,quantity,agreed_amount,requested_by) VALUES($1,$2,'pending_assignment',$3,$4,$5,$6,$7,1,$7,$8)",[roundId,orderId,price.price_id,price.version,price.name,price.unit,price.amount,designer]);
      await client.query("INSERT INTO digital_development_pattern_links(source_id,order_id,linked_by) VALUES($1,$2,$3)",[sourceId,orderId,designer]);
      await client.query("COMMIT");
    }catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
    const rootActor=actor(root,["root_superuser"]);
    expect(await journeys.pendingPatternAssignments(rootActor,[sourceId])).toEqual([{sourceId,orderId}]);
    await expect(journeys.pendingPatternAssignments(actor(worker,["pattern_room_worker"]),[sourceId])).rejects.toMatchObject({statusCode:403});
    await expect(journeys.pendingPatternAssignments(actor(clerk,["development_clerk"]),[sourceId])).rejects.toMatchObject({statusCode:403});
    const before=await tasks.read(rootActor,task.taskId);
    await db.query("UPDATE pattern_room_orders SET status='in_progress' WHERE order_id=$1",[orderId]);
    await db.query("UPDATE pattern_room_rounds SET status='in_progress' WHERE round_id=$1",[roundId]);
    expect(await journeys.pendingPatternAssignments(rootActor,[sourceId])).toEqual([]);
    expect((await tasks.read(rootActor,task.taskId)).state).toBe(before.state);
  });
  it("shows a cancelled pure-development source as cancelled without manufacturing completion",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-CANCELLED-SOURCE",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    await tasks.controlResource(actor(),{kind:"source",id:sourceId},"cancel","TEST取消纯开发",randomUUID());
    expect((await journeys.read(actor(),sourceId)).display).toMatchObject({mainState:"cancelled",awaitingClosure:false});
    const list=await journeys.list(actor(),JourneyFilterSchema.parse({scope:"development",search:"TEST-CANCELLED-SOURCE"}));
    expect(list.items).toHaveLength(1);expect(list.items[0]?.display?.mainState).toBe("cancelled");expect(list.summary).toMatchObject({completed:0,active:0,notStarted:0});
    await expect(journeys.read(actor(stranger),sourceId)).rejects.toMatchObject({statusCode:404});
  });
  it("evaluates history from the completion-linked deadline, and reports missing original evidence",async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-COCKPIT-HISTORY",temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    const task=await createTask({resource:{kind:"source",id:sourceId},kind:"development_materials",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk});
    const eventId=randomUUID(),missingId=randomUUID();
    await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality) VALUES($1,$2,'source',$3,'completed',$4,'2026-10-02T02:00:00Z','现场登记'),($5,$2,'source',$3,'completed',$4,NULL,'缺失')",[eventId,task.taskId,sourceId,clerk,missingId]);
    const version=(await db.query("SELECT max(version) AS version FROM digital_production_deadline_policies WHERE node_key='development_materials'")).rows[0].version;
    await db.query("INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,event_id,changed_by) VALUES($1,'development_materials',$2,'2026-10-01T00:00:00Z','2026-10-01T18:00:00Z','2026-10-02T00:00:00Z','completion',$3,$4)",[task.taskId,version,eventId,root]);
    // A later revision cannot rewrite the historical completed event's evaluation.
    await db.query("INSERT INTO digital_production_deadline_revisions(task_id,policy_node_key,policy_version,entered_at,warning_at,due_at,reason,changed_by) VALUES($1,'development_materials',$2,'2026-10-01T00:00:00Z','2026-10-03T00:00:00Z','2026-10-04T00:00:00Z','policy',$3)",[task.taskId,version,root]);
    const history=(await journeys.read(actor(),sourceId,undefined,true)).riskHistory!;
    expect(history.find(item=>item.eventId===eventId)).toMatchObject({assessment:"late",overdueSeconds:7200,deadline:"2026-10-02T00:00:00.000Z"});
    expect(history.find(item=>item.eventId===missingId)).toMatchObject({assessment:"insufficient",overdueSeconds:null});
  });
  it("retains authorized sourcing-task events when a sourcing case replaces its display node, including between cursor pages",async()=>{
    const rootActor=actor(root,["root_superuser"]);
    const order=await identity.createOrder(rootActor,{...input("SOURCING-LOG"),primaryMerchandiserId:merchandiser},randomUUID());
    const task=await createTask({resource:{kind:"order",id:order.productionOrderId},kind:"sourcing_preparation",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:merchandiser});
    const reassigned=randomUUID(),completed=randomUUID();
    await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,recorded_at,time_quality) SELECT gen_random_uuid(),$1,'order',$2,'condition',$3,'2026-10-01T12:01:00.000001Z','缺失' FROM generate_series(1,43)",[task.taskId,order.productionOrderId,root]);
    await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,recorded_at,time_quality) VALUES($1,$3,'order',$4,'reassigned',$5,'2026-10-01T11:59:00Z','2026-10-01T11:59:00Z','现场登记'),($2,$3,'order',$4,'completed',$5,'2026-10-01T12:00:00Z','2026-10-01T12:00:00Z','现场登记')",[reassigned,completed,task.taskId,order.productionOrderId,root]);
    const first=(await journeys.read(rootActor,order.productionOrderId,undefined,true)).operationLog!;
    expect(first.items).toHaveLength(5);expect(first.nextCursor).not.toBeNull();
    const expected=(await db.query("SELECT e.event_id FROM digital_production_task_events e JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1",[order.productionOrderId])).rows.map(row=>`task:${row.event_id}`).sort();
    const caseId=randomUUID(),operation=randomUUID();
    const seed=await db.connect();
    try{await seed.query("BEGIN");
    await seed.query("INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,reason) VALUES($1,'TEST-cockpit-case',$2,ARRAY['root_superuser'],'sourcing:inquiry:create','sourcing.case.create','sourcing_case',$3,'TEST')",[operation,root,caseId]);
    await seed.query("INSERT INTO sourcing_cases(sourcing_case_id,erp_order_id,erp_order_no,style_no,lane_key,order_quantity,created_by,operation_event_id,request_id,creation_reason,workflow_generation) VALUES($1,$1::uuid::text,'TEST','TEST-SOURCING-LOG','garment_processing',300,$2,$3,'TEST-cockpit-case','TEST','digital_production_v1')",[caseId,root,operation]);
    await seed.query("INSERT INTO sourcing_case_transitions(sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,business_action,transition_reason,actor_id,operation_event_id,request_id) VALUES($1,$2,1,NULL,'pending_ie_quote','created','TEST',$3,$4,'TEST-cockpit-case')",[randomUUID(),caseId,root,operation]);
    await seed.query("INSERT INTO digital_production_child_links(module,child_id,production_order_id) VALUES('sourcing',$1,$2)",[caseId,order.productionOrderId]);
    await seed.query("UPDATE digital_production_tasks SET state='completed',entered_at='2026-10-01T00:00:00Z',completed_at='2026-10-01T12:00:00Z',completed_quality='现场登记' WHERE task_id=$1",[task.taskId]);
      await seed.query("COMMIT");
    }catch(error){await seed.query("ROLLBACK");throw error;}finally{seed.release();}
    const replaced=await journeys.read(rootActor,order.productionOrderId,undefined,true);
    expect(replaced.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='sourcing_preparation')?.records.map(record=>record.domain)).toEqual(['sourcing']);
    expect(replaced.riskHistory?.some(item=>item.eventId===completed)).toBe(true);
    const seen=first.items.map(item=>item.id);let cursor=first.nextCursor;
    while(cursor){const page=await journeys.logs(rootActor,order.productionOrderId,cursor);expect(page.asOf).toBe(first.asOf);seen.push(...page.items.map(item=>item.id));cursor=page.nextCursor;}
    expect([...seen].sort()).toEqual(expected);expect(new Set(seen).size).toBe(seen.length);expect(seen).toContain(`task:${reassigned}`);expect(seen).toContain(`task:${completed}`);
    const refreshed=replaced.operationLog!,all=refreshed.items.map(item=>item.id);cursor=refreshed.nextCursor;
    while(cursor){const page=await journeys.logs(rootActor,order.productionOrderId,cursor);all.push(...page.items.map(item=>item.id));cursor=page.nextCursor;}
    expect(all.sort()).toEqual(expected);
    await expect(journeys.logs(actor(stranger),order.productionOrderId)).rejects.toMatchObject({statusCode:404});
  });
  it("allows Root JSON all-match export but rejects an ordinary merchandiser with legitimate list access",{timeout:60_000},async()=>{
    const search="TEST-J-EXPORT-SCOPE";
    for(let index=0;index<21;index++)await identity.createOrder(actor(root,["root_superuser"]),{...input(`EXPORT-SCOPE-${index}`),primaryMerchandiserId:merchandiser},randomUUID());
    const before=(await db.query("SELECT (SELECT count(*) FROM digital_production_tasks)::int tasks,(SELECT count(*) FROM rework_wage_items)::int wages")).rows[0];
    const ordinary=await app.inject({url:`/digital-production/journeys?search=${search}`,headers:{cookie:`dx_rework_session=${merchandiser}`}});
    expect(ordinary.statusCode,ordinary.body).toBe(200);expect(ordinary.json().total).toBe(21);
    const exported=await app.inject({url:`/digital-production/journeys/export?search=${search}&page=2`,headers:{cookie:`dx_rework_session=${root}`}});
    expect(exported.statusCode,exported.body).toBe(200);expect(exported.headers["cache-control"]).toBe("no-store");
    expect(exported.json()).toMatchObject({total:21,items:expect.any(Array)});expect(exported.json().items).toHaveLength(21);expect(exported.json()).not.toHaveProperty("page");
    const denied=await app.inject({url:`/digital-production/journeys/export?search=${search}`,headers:{cookie:`dx_rework_session=${merchandiser}`}});
    expect(denied.statusCode,denied.body.slice(0,300)).toBe(403);expect(denied.json()).toEqual({error:{code:"FORBIDDEN",message:"当前身份无权导出业务数据"}});
    expect((await app.inject({url:`/digital-production/journeys/export?search=${search}`,headers:{cookie:`dx_rework_session=${designer}`}})).statusCode).toBe(403);
    await expect(journeys.export(actor(merchandiser,["order_merchandiser"]),JourneyFilterSchema.parse({search}))).rejects.toMatchObject({statusCode:403});
    expect((await db.query("SELECT (SELECT count(*) FROM digital_production_tasks)::int tasks,(SELECT count(*) FROM rework_wage_items)::int wages")).rows[0]).toEqual(before);
  });
  it("joins a source and confirmed two-PO order once, resolves either ID, and rejects other identities",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:input().designStyleNo,temporaryStyleNo:input().temporaryStyleNo,customerCode:"PD"},randomUUID());
    expect((await journeys.read(actor(),source.sourceId)).orderId).toBeNull();
    expect((await journeys.read(actor(),source.sourceId)).stages.flatMap(stage=>stage.nodes).find(node=>node.key==="product_development")?.records[0]?.url).toBe(`/ui/digital-production?development=${source.sourceId}`);
    await publishSource(source.sourceId);
    const order=await identity.createOrder(actor(),input(),randomUUID(),source.sourceId);
    const item=await journeys.read(actor(),source.sourceId);
    expect(item.stages.flatMap(stage=>stage.nodes).find(node=>node.key==="product_development")?.operator).toEqual({id:designer,name:"TEST-J sample_designer"});
    expect(item.id).toBe(source.sourceId);expect(item.orderId).toBe(order.productionOrderId);
    expect(item.lines.map(line=>[line.po,line.orderedQuantity])).toEqual([["PO-J1",100],["PO-J2",200]]);
    expect((await journeys.read(actor(),order.productionOrderId)).id).toBe(source.sourceId);
    expect(item.stages).toHaveLength(7);expect(item.stages.at(-1)?.label).toBe("回货与装箱");
    expect(item.stages.flatMap(stage=>stage.nodes).find(node=>node.key==="receipts")?.state).toBe("uncreated");
    expect((await journeys.list(actor(),JourneyFilterSchema.parse({search:"TEST-J-0001"}))).total).toBe(1);
    await expect(journeys.read(actor(stranger),order.productionOrderId)).rejects.toMatchObject({statusCode:404});
    expect((await journeys.list(actor(stranger),JourneyFilterSchema.parse({search:"TEST-J-0001"}))).total).toBe(0);
    const allowedFacets=await journeys.list(actor(),JourneyFilterSchema.parse({search:"no-result"}));
    expect(allowedFacets.facets.customers).toContain("PD");
    expect(allowedFacets.canManagePolicies).toBe(false);
    expect((await journeys.list(actor(stranger),JourneyFilterSchema.parse({}))).facets.customers).not.toContain("PD");
    expect((await journeys.list(actor(root,["root_superuser"]),JourneyFilterSchema.parse({}))).canManagePolicies).toBe(true);
  });
  it("does not invent cutting or normal packing completion from a recorded special closure without actual cuts",async()=>{
    const order=await identity.createOrder(actor(),input("CLOSED-NO-CUT"),randomUUID());
    const auditId=randomUUID();
    await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'production_management',$2,'TEST historical closure director')",[randomUUID(),root]);
    // A trusted historical closure fixture exercises the read projection independently
    // of the current close command's production preconditions. All DB guards remain on.
    await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id) VALUES($1,'TEST-no-cut-closure',$2,'digital.order.special_close','digital_production_order',$3)",[auditId,root,order.productionOrderId]);
    await db.query("INSERT INTO digital_order_closures(production_order_id,reason,outstanding,source_revision,closed_by,audit_event_id) VALUES($1,'TEST历史未开裁结案','[\"尚无实裁\"]',$2,$3,$4)",[order.productionOrderId,'a'.repeat(64),root,auditId]);
    const before=(await db.query("SELECT count(*)::int n FROM cutting_records")).rows[0]!.n;
    const journey=await journeys.read(actor(),order.productionOrderId),nodes=journey.stages.flatMap(stage=>stage.nodes);
    expect(nodes.find(node=>node.key==='special_closure')).toMatchObject({state:'completed',operator:{id:root,name:'TEST-J owner_group'}});
    expect(nodes.find(node=>node.key==='cutting_gate')?.state).toBe('pending');
    expect(nodes.filter(node=>node.key==='bulk_cutting').every(node=>node.state!=='completed')).toBe(true);
    expect(nodes.find(node=>node.key==='packing')?.state).toBe('uncreated');
    expect(journey.deliveryRisks).toEqual([]);
    expect(nodes.find(node=>node.key==='receipts')?.state).toBe('uncreated');
    expect((await db.query("SELECT count(*)::int n FROM cutting_records")).rows[0]!.n).toBe(before);
  });

  it("projects original per-material plan revisions without inventing node SLA or arrival times",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-MATERIAL-PLAN",temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const fileId=randomUUID(),materialId=randomUUID();
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-plan.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`TEST/plan/${fileId}`,"a".repeat(64),designer]);
    const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:"上衣",quantity:1,sampleSize:"M",orderDate:null,returnDate:null,unit:"cm",sizes:["M"],measurements:[{name:"胸围",values:["50"]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[{materialId,category:"辅料",label:"TEST 拉链",supplier:"",name:"拉链",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"",quantity:"1",requiredThisRound:true,available:false,expectedDate:"2026-10-08"}],files:[{attachmentId:fileId,kind:"款图"}]});
    const mainId=randomUUID();
    document.materials.push({...document.materials[0]!,materialId:mainId,category:"主布",label:"TEST 主布",name:"主布",specification:"TEST 40支",expectedDate:null});
    const forms=new DigitalDevelopmentService(db,true);
    const saved=await forms.save(actor(),source.sourceId,{expectedVersion:0,document},randomUUID());
    const published=await forms.publish(actor(),source.sourceId,saved.version,randomUUID());
    const node=()=>journeys.read(actor(),source.sourceId).then(value=>value.stages.flatMap(stage=>stage.nodes).find(item=>item.instanceId===`material:${materialId}:1`)!);
    expect(await node()).toMatchObject({state:"pending",expectedAt:"2026-10-08",expectedKind:"plan",expectedPrecision:"date",enteredAt:null,sla:"not_set",actualAt:null,actualQuality:"missing",countsInProgress:false});
    await forms.materialEvent(actor(),source.sourceId,materialId,{expectedVersion:published.version,expectedMaterialRevision:0,action:"修改预计日期",expectedDate:"2026-10-09",note:"TEST 原计划修订"},randomUUID());
    expect((await node()).expectedAt).toBe("2026-10-09");
    expect((await node()).records[0]?.url).toContain(`#material-${materialId}`);
    const before=(await db.query("SELECT count(*)::int n FROM digital_production_deadline_revisions")).rows[0].n;
    await node();expect((await db.query("SELECT count(*)::int n FROM digital_production_deadline_revisions")).rows[0].n).toBe(before);
    const execution=new DevelopmentExecutionService(db,true),rootActor=actor(root,["root_superuser"]);
    const initialVerification=(await execution.read(rootActor,source.sourceId)).materialVerification!;
    const initialEntries=initialVerification.entries.map(row=>({materialId:row.materialId,usage:'use' as const,physical:false,quantity:false,color:false,specification:false,note:'',confirmedWith:''}));
    await execution.saveMaterials(rootActor,source.sourceId,{taskId:published.taskId!,expectedDocumentVersion:published.version,expectedVersion:0,entries:initialEntries},randomUUID());
    await execution.check(rootActor,source.sourceId,{taskId:published.taskId!,expectedVerificationVersion:1,result:"缺项退回",note:"TEST 物料补齐接续",returnIssues:initialEntries.map(row=>({materialId:row.materialId,field:"physical" as const,need:"supply" as const,reason:"TEST实物未到，待补齐"})),items:initialEntries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
    const supply=(await execution.read(rootActor,source.sourceId)).tasks.find(task=>task.taskKind==="development_material_supply")!;
    expect((await tasks.read(actor(), supply.taskId)).identity).toEqual({designStyleNo:"TEST-MATERIAL-PLAN",customerCode:"PD"});
    await expect(tasks.read(actor(stranger), supply.taskId)).rejects.toMatchObject({statusCode:404});
    const taskNode=()=>journeys.read(actor(),source.sourceId).then(value=>value.stages.flatMap(stage=>stage.nodes).find(item=>item.instanceId===supply.taskId));
    expect(await taskNode()).toMatchObject({key:"development_material_supply",state:"active",current:true,owner:{id:designer},expectedAt:supply.dueAt,enteredAt:supply.enteredAt});
    expect((await taskNode())?.records).toContainEqual(expect.objectContaining({domain:"task",id:supply.taskId,url:`/ui/digital-production?task=${supply.taskId}`}));
    await forms.materialEvent(actor(),source.sourceId,materialId,{expectedVersion:published.version,expectedMaterialRevision:1,action:"到货",expectedDate:null,note:"TEST 原到货记录"},randomUUID());
    expect(await node()).toMatchObject({state:"pending",actualAt:null});
    await forms.materialEvent(actor(),source.sourceId,mainId,{expectedVersion:published.version,expectedMaterialRevision:0,action:"到货",expectedDate:null,note:"TEST 主布到货"},randomUUID());
    const recheck=await execution.resubmit(actor(),source.sourceId,supply.taskId,randomUUID()) as {taskId:string};
    await execution.saveMaterials(rootActor,source.sourceId,{taskId:recheck.taskId,expectedDocumentVersion:published.version,expectedVersion:1,entries:initialEntries.map(row=>({...row,physical:true,quantity:true,color:true,specification:true}))},randomUUID());
    await execution.check(rootActor,source.sourceId,{taskId:recheck.taskId,expectedVerificationVersion:2,result:"通过",note:"实际核验普通辅料和主布",items:[mainId,materialId].map(materialId=>({materialId,physical:true,quantity:true,color:true,specification:true}))},randomUUID());
    expect(await node()).toMatchObject({state:"completed",actualAt:null,completionResult:"unknown"});
    const summary=await journeys.list(rootActor,JourneyFilterSchema.parse({search:"TEST-MATERIAL-PLAN"}),true,undefined,{details:false});
    expect(summary.items.find(item=>item.sourceId===source.sourceId)?.stages.flatMap(stage=>stage.nodes).find(item=>item.instanceId===`material:${materialId}:1`)?.state).toBe("completed");
    expect(await taskNode()).toMatchObject({state:"completed",actualQuality:"verified",operator:{id:designer}});
    await expect(journeys.read(actor(stranger),source.sourceId)).rejects.toMatchObject({statusCode:404});
  });
  it("preserves the direct-order origin when development is attached later",async()=>{
    const request=input("ORDER-FIRST"),order=await identity.createOrder(actor(),request,randomUUID());
    expect((await journeys.read(actor(),order.productionOrderId)).id).toBe(order.productionOrderId);
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:request.designStyleNo,temporaryStyleNo:request.temporaryStyleNo,customerCode:request.customerCode},randomUUID());
    await identity.attachSource(actor(),order.productionOrderId,source.sourceId,randomUUID());
    const result=await journeys.list(actor(),JourneyFilterSchema.parse({search:"TEST-J-ORDER-FIRST"}));
    expect(result.total).toBe(1);expect(result.items[0]?.id).toBe(order.productionOrderId);expect(result.items[0]?.sourceId).toBe(source.sourceId);
    expect((await journeys.read(actor(),source.sourceId)).id).toBe(order.productionOrderId);
  });
  it("does not correlate equal style suffixes and only searches authorized formal/PO rows",async()=>{
    const a=await identity.createOrder(actor(),input("SHARED-STYLESUFFIX-1234"),randomUUID());
    const b=await identity.createOrder(actor(stranger),{...input("SHARED-STYLESUFFIX-1234"),designStyleNo:"OTHER-STYLESUFFIX-1234"},randomUUID());
    const item=await journeys.read(actor(),a.productionOrderId);
    expect(item.lines.map(line=>line.id)).toEqual(a.lines.map(line=>line.lineId));
    expect(item.lines.some(line=>b.lines.some(other=>other.lineId===line.id))).toBe(false);
    expect((await journeys.list(actor(),JourneyFilterSchema.parse({search:"OTHER-STYLESUFFIX-1234"}))).total).toBe(0);
    // UUID substring search is supported; isolate the style fixture from random ID matches.
    expect((await journeys.list(actor(root,["root_superuser"]),JourneyFilterSchema.parse({search:"STYLESUFFIX-1234"}))).total).toBe(2);
  });
  it("keeps own-task metadata isolated from sibling tasks and does not start pending SLA",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-WORKER",temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const assigned=await createTask({resource:{kind:"source",id:source.sourceId},kind:"development_pattern",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:worker,conditions:["handover_received"]});
    const sibling=await createTask({resource:{kind:"source",id:source.sourceId},kind:"development_cutting",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null,conditions:["handover_received"]});
    const item=await journeys.read(actor(worker,["pattern_room_worker"]),source.sourceId),nodes=item.stages.flatMap(stage=>stage.nodes);
    expect(nodes.some(node=>node.instanceId===assigned.taskId)).toBe(true);
    expect(JSON.stringify(item)).not.toContain(sibling.taskId);
    const node=nodes.find(node=>node.instanceId===assigned.taskId)!;
    const summary=await tasks.read(actor(worker,["pattern_room_worker"]), assigned.taskId);
    expect(summary.identity).toEqual({designStyleNo:'TEST-WORKER',customerCode:'PD'});
    expect(summary).not.toHaveProperty('budget');
    await expect(tasks.read(actor(worker,["pattern_room_worker"]),sibling.taskId)).rejects.toMatchObject({statusCode:404});
    await expect(tasks.read(actor(stranger),assigned.taskId)).rejects.toMatchObject({statusCode:404});
    const headers={cookie:`dx_rework_session=${worker}`};
    expect((await app.inject({url:`/digital-production/tasks/${assigned.taskId}`,headers})).statusCode).toBe(200);
    expect((await app.inject({url:`/digital-production/tasks/${assigned.taskId}/history`,headers})).statusCode).toBe(200);
    for(const path of [`/digital-production/tasks/${sibling.taskId}`,`/digital-production/tasks/${sibling.taskId}/history`]){
      const rejected=await app.inject({url:path,headers});expect(rejected.statusCode).toBe(404);expect(rejected.body).not.toContain(sibling.taskId);
    }
    expect(node.state).toBe("pending");expect(node.enteredAt).toBeNull();expect(node.sla).toBe("not_started");expect(node.risks).not.toContain("overdue");
    expect(nodes.find(node=>node.key==="development_cutting")?.state).toBe("unavailable");
    await expect(journeys.read(actor(worker,["pattern_room_worker"]),source.sourceId,1)).rejects.toMatchObject({statusCode:404});
  });
  it("keeps queries read-only under concurrent confirmation and official-number correction",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-CONCURRENT",temporaryStyleNo:"TEST-CONCURRENT-T",customerCode:"PD"},randomUUID());
    const request={...input("CONCURRENT"),designStyleNo:"TEST-CONCURRENT",temporaryStyleNo:"TEST-CONCURRENT-T"};
    await publishSource(source.sourceId);
    const key=randomUUID();const results=await Promise.all([identity.createOrder(actor(),request,key,source.sourceId),identity.createOrder(actor(),request,key,source.sourceId),journeys.read(actor(),source.sourceId)]);
    expect(results[0].productionOrderId).toBe(results[1].productionOrderId);
    const order=results[0];const count=async()=> (await db.query("SELECT (SELECT count(*) FROM digital_production_tasks)::int tasks,(SELECT count(*) FROM rework_wage_items)::int wages,(SELECT count(*) FROM digital_production_commands)::int commands")).rows[0];
    const before=await count();
    await Promise.all(Array.from({length:8},()=>journeys.read(actor(),source.sourceId)));
    expect(await count()).toEqual(before);
    const corrected=await identity.correctNumbers(actor(),order.productionOrderId,order.lines[0]!.lineId,{expectedVersion:order.version,formalStyleNo:"TEST-FORMAL-CONCURRENT"},randomUUID());
    const afterCorrection=await count();
    const filtered=await journeys.list(actor(),JourneyFilterSchema.parse({search:"TEST-FORMAL-CONCURRENT"}));
    expect(filtered.total).toBe(1);expect(filtered.summary.all).toBe(1);expect(filtered.items[0]?.lines[0]?.id).toBe(corrected.lines[0]?.lineId);
    expect(await count()).toEqual(afterCorrection);expect(afterCorrection.tasks).toBe(before.tasks);expect(afterCorrection.wages).toBe(before.wages);
  });
  it.each([[clerk,'development_clerk','development_materials'],[tail,'pattern_room_tail_inspector','development_tail_check']] as const)('shows basic source identity for authorized %s task without widening source access',async(id,role,kind)=>{
    const source=await identity.createSource(actor(),{developmentType:'头版',designStyleNo:`TEST-SUMMARY-${role}`,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
    const assigned=await createTask({resource:{kind:'source',id:source.sourceId},kind,routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:id});
    const viewer=actor(id,[role]),policy=new DigitalProductionAccessPolicy(db);
    expect(await policy.allowed(viewer,'source',source.sourceId,'technical')).toBe(false);
    expect((await tasks.read(viewer,assigned.taskId)).identity).toEqual({designStyleNo:`TEST-SUMMARY-${role}`,customerCode:'PD'});
    expect((await new DigitalDevelopmentService(db,true).read(viewer,source.sourceId)).designStyleNo).toBe(`TEST-SUMMARY-${role}`);
    await expect(tasks.read(actor(stranger),assigned.taskId)).rejects.toMatchObject({statusCode:404});
  });
  it("resolves names only on visible task reassignment facts while preserving stable IDs",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-J-NAMED-HISTORY",temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const {taskId}=await createTask({resource:{kind:"source",id:source.sourceId},kind:"development_pattern",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null,conditions:["handover_received"]});
    await expect(tasks.reassign(actor(root,["root_superuser"]),taskId,worker,randomUUID())).rejects.toThrow('总委派');
    // Seed a real reassignment event via the transaction adapter used by total arrangement;
    // this test covers authorized history projection, not a second dispatch entry.
    const client=await db.connect();try{await client.query('BEGIN');await tasks.reassignWithClient(client,actor(root,["root_superuser"]),taskId,worker);await client.query('COMMIT');}catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    const item=await journeys.read(actor(),source.sourceId);
    const node=item.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===taskId)!;
    expect(node.assignmentHistory).toContainEqual(expect.objectContaining({actorId:root,actorName:"TEST-J owner_group",from:null,fromName:null,to:worker,toName:"TEST-J pattern_room_worker"}));
    expect((await tasks.read(actor(),taskId)).identity).toEqual({designStyleNo:"TEST-J-NAMED-HISTORY",customerCode:"PD"});
    await expect(journeys.read(actor(stranger),source.sourceId)).rejects.toMatchObject({statusCode:404});
  });
  it("reads the deployed cockpit HTTP detail for Root across direct and source-linked mothers",async()=>{
    const direct=await identity.createOrder(actor(),input("ROOT-HTTP-DIRECT"),randomUUID());
    const linkedInput=input("ROOT-HTTP-LINKED");
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:linkedInput.designStyleNo,temporaryStyleNo:linkedInput.temporaryStyleNo,customerCode:linkedInput.customerCode},randomUUID());
    await publishSource(source.sourceId);
    const linked=await identity.createOrder(actor(),linkedInput,randomUUID(),source.sourceId);
    const headers={cookie:`dx_rework_session=${root}`};
    const initialLogs=await app.inject({url:`/digital-production/journeys/${direct.productionOrderId}/logs`,headers});
    expect(initialLogs.statusCode,initialLogs.body).toBe(200);
    // Confirmation creates the early ship-sample task; reads must expose its original
    // creation/readiness facts, without inventing completion or mutating the log.
    const sampleEvents=await db.query("SELECT e.event_id,e.event_kind,e.actor_id FROM digital_production_task_events e JOIN digital_production_task_access a USING(task_id) WHERE a.production_order_id=$1 AND a.task_kind='bulk_ship_sample'",[direct.productionOrderId]);
    expect(sampleEvents.rows.map(row=>row.event_kind).sort()).toEqual(['created','ready']);
    const expectedIds=sampleEvents.rows.map(row=>`task:${row.event_id}`).sort();
    expect(initialLogs.json()).toMatchObject({nextCursor:null});
    expect(initialLogs.json().items.map((entry:{id:string})=>entry.id).sort()).toEqual(expectedIds);
    expect(initialLogs.json().items).toEqual(expect.arrayContaining(['创建节点','进入办理'].map(action=>expect.objectContaining({action,nodeKey:'bulk_ship_sample',object:'船样',source:'task_event',actor:{id:designer,name:'TEST-J sample_designer'}}))));
    const repeatedLogs=await app.inject({url:`/digital-production/journeys/${direct.productionOrderId}/logs`,headers});
    expect(repeatedLogs.statusCode,repeatedLogs.body).toBe(200);
    expect(repeatedLogs.json().items).toEqual(initialLogs.json().items);
    expect((await app.inject({url:`/digital-production/journeys/${direct.productionOrderId}/logs`,headers:{cookie:`dx_rework_session=${stranger}`}})).statusCode).toBe(404);
    for(const id of [direct.productionOrderId,linked.productionOrderId,source.sourceId]){
      const response=await app.inject({url:`/digital-production/journeys/${id}?view=cockpit`,headers});
      expect(response.statusCode,response.body).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.json()).toMatchObject({display:{ruleVersion:'cockpit-display-v1'},operationLog:{items:expect.any(Array)}});
    }
    const list=await app.inject({url:'/digital-production/journeys?scope=production&search=ROOT-HTTP',headers});
    expect(list.statusCode,list.body).toBe(200);expect(list.json().items).toHaveLength(2);
    expect(list.json().items.every((item:{display?:unknown})=>item.display)).toBe(true);
  });
  it("validates read routes and preserves no-store and permission rejection",async()=>{
    const order=await identity.createOrder(actor(),input("HTTP"),randomUUID());
    const headers={cookie:`dx_rework_session=${designer}`};
    const response=await app.inject({url:"/digital-production/journeys?search=TEST-J-HTTP",headers});
    expect(response.statusCode).toBe(200);expect(response.headers["cache-control"]).toBe("no-store");expect(response.json().total).toBe(1);
    expect((await app.inject({url:"/digital-production/journeys?startDate=2026-10-05&endDate=2026-10-01",headers})).statusCode).toBe(400);
    expect((await app.inject({url:"/digital-production/journeys?unexpected=yes",headers})).statusCode).toBe(400);
    expect((await app.inject({url:`/digital-production/journeys/${order.productionOrderId}`,headers:{cookie:`dx_rework_session=${stranger}`}})).statusCode).toBe(404);
    expect((await app.inject({url:"/digital-production/journeys"})).statusCode).toBe(401);
  });
  it("projects designer business views and pattern scope through original facts and no-store HTTP",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:input("WORKSPACE").designStyleNo,temporaryStyleNo:input("WORKSPACE").temporaryStyleNo,customerCode:"PD"},randomUUID());
    const workspaces=new DevelopmentWorkspaceQuery(journeys);
    expect((await workspaces.designer(actor(),DevelopmentWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE"}))).counts.draft).toBe(1);
    await publishSource(source.sourceId);
    await identity.createOrder(actor(),input("WORKSPACE"),randomUUID(),source.sourceId);
    expect((await workspaces.designer(actor(),DevelopmentWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE",view:"ordered"}))).total).toBe(1);
    expect((await workspaces.designer(actor(stranger),DevelopmentWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE"}))).total).toBe(0);
    await expect(workspaces.designer(actor(worker,["pattern_room_worker"]),DevelopmentWorkspaceFilterSchema.parse({}))).rejects.toMatchObject({statusCode:403});
    expect((await workspaces.pattern(actor(stranger),PatternWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE"}))).total).toBe(0);
    const allowed=await app.inject({method:"GET",url:"/digital-production/workspaces/designer?search=TEST-J-WORKSPACE&view=ordered",headers:{cookie:`dx_rework_session=${designer}`}});
    expect(allowed.statusCode).toBe(200);expect(allowed.json().total).toBe(1);expect(allowed.headers["cache-control"]).toBe("no-store");
  });
  it("paginates full authorized facts before hydrating only current-page tasks, and rechecks live roles",async()=>{
    for(let index=0;index<25;index++){
      const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-PR12-PAGE-${index}`,temporaryStyleNo:null,customerCode:null},randomUUID());
      const routeId=randomUUID();
      for(const kind of ["development_pattern","development_cutting"]){await createTask({resource:{kind:"source",id:source.sourceId},kind,routeId,routeVersion:1,occurrence:1,assigneeId:kind==='development_pattern'?worker:null});}
    }
    const normalize=(value:unknown)=>JSON.parse(JSON.stringify(value,(key,item)=>key==='asOf'||key==='overdueSeconds'?undefined:item));
    for(const context of [actor(root,["root_superuser"]),actor(),actor(worker,["pattern_room_worker"]),actor(stranger)]){
      const full=await journeys.list(context,JourneyFilterSchema.parse({search:'TEST-PR12-PAGE'}),true);
      for(const patch of [{page:1},{page:2},{page:3},{page:2,risk:'unknown'},{page:1,state:'pending'},{page:1,kpi:'active'},{page:1,kpi:'blocked'}]){
        const filter=JourneyFilterSchema.parse({search:'TEST-PR12-PAGE',...patch});
        const reads=vi.spyOn(DigitalProductionTaskService.prototype,'read');
        const paged=await journeys.list(context,filter);
        const hydrated=reads.mock.calls.map(call=>call[1]);reads.mockRestore();
        const expected=selectJourneys(full.items,filter,paged.asOf);
        expect(normalize(paged)).toEqual(normalize({...expected,facets:full.facets,canManagePolicies:full.canManagePolicies}));
        const pageTasks=paged.items.flatMap(item=>item.stages.flatMap(stage=>stage.nodes).filter(node=>node.records.some(record=>record.domain==='task'&&record.id===node.instanceId)).map(node=>node.instanceId));
        expect(hydrated.every(id=>pageTasks.includes(id))).toBe(true);
        expect(hydrated.length).toBeLessThanOrEqual(paged.items.length*2);
        if(context.actorId===designer&&patch.page===2&&!('risk' in patch)){expect(paged.total).toBe(25);expect(paged.items).toHaveLength(10);}
        if(context.actorId===designer&&patch.page===3){expect(paged.total).toBe(25);expect(paged.items).toHaveLength(0);}
        if(context.actorId===stranger){expect(paged.total).toBe(0);}
        if(context.actorId===worker){expect(paged.items.every(item=>item.developmentType===null&&item.requiredCompletionDate===null)).toBe(true);}
        if(context.actorId===designer){expect(paged.items.every(item=>item.developmentType==='头版'&&item.requiredCompletionDate===null)).toBe(true);}
      }
    }
    const workspaces=new DevelopmentWorkspaceQuery(journeys);
    for(const context of [actor(root,["root_superuser"]),actor(),actor(stranger)]){
      const full=await journeys.list(context,JourneyFilterSchema.parse({search:'TEST-PR12-PAGE'}),true);
      for(const patch of [{page:1},{page:2},{page:3},{page:2,view:'draft'},{view:'ordered'},{designer:'not-the-designer'}]){
        const filter=DevelopmentWorkspaceFilterSchema.parse({search:'TEST-PR12-PAGE',...patch});
        const all=full.items.filter(item=>!filter.designer||item.designer===filter.designer);
        const filtered=all.filter(item=>filter.view==='all'||developmentView(item)===filter.view);
        const reads=vi.spyOn(DigitalProductionTaskService.prototype,'read');
        const result=await workspaces.designer(context,filter),hydrated=reads.mock.calls.map(call=>call[1]);reads.mockRestore();
        expect(result.total).toBe(filtered.length);expect(result.counts.all).toBe(all.length);
        expect(result.items.map(item=>normalize(item.journey))).toEqual(filtered.slice((filter.page-1)*15,filter.page*15).map(normalize));
        expect(hydrated.length).toBeLessThanOrEqual(result.items.length*2);
      }
    }
    // Compare mixed published/returned/closed/order fixtures created by the existing tests.
    const context=actor(root,["root_superuser"]),full=await journeys.list(context,JourneyFilterSchema.parse({}),true);
    for(const patch of [{page:1},{page:2},{risk:'blocked'},{risk:'overdue'},{state:'completed'},{kpi:'completed'},{node:'development_materials'}]){
      const filter=JourneyFilterSchema.parse(patch),paged=await journeys.list(context,filter);
      expect(normalize(paged)).toEqual(normalize({...selectJourneys(full.items,filter,paged.asOf),facets:full.facets,canManagePolicies:full.canManagePolicies}));
    }
    // Workroom previews retain every business card fact without hydrating executable DTOs.
    for(const offset of [0,1]){
      const completedSource=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-PR05-COMPLETED-OWNER-${offset}`,temporaryStyleNo:null,customerCode:"PD"},randomUUID());
      const completedTask=await createTask({resource:{kind:"source",id:completedSource.sourceId},kind:"development_pattern",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:worker});
      const instant=Date.now(),completedAt=new Date(instant).toISOString().replace('Z','100Z'),reassignedAt=new Date(instant+offset).toISOString().replace('Z','200Z');
      await db.query("UPDATE digital_production_tasks SET state='completed',completed_at=$2,completed_quality='现场登记' WHERE task_id=$1",[completedTask.taskId,completedAt]);
      await db.query("INSERT INTO digital_production_task_events(event_id,task_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,recorded_at,time_quality) VALUES($1,$2,'source',$3,'completed',$4,$5,$5,'现场登记')",[randomUUID(),completedTask.taskId,completedSource.sourceId,worker,completedAt]);
      // Imported audits can predate today's prohibition on ended-task reassignment.
      // Same millisecond (different microseconds) must match rich JS Date semantics;
      // an audit in the following millisecond restores the original completed owner.
      await db.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id,before_state,after_state,created_at) VALUES($1,'TEST historical owner audit',$2,'digital_task_reassigned','digital_task',$3,$4,$5,$6)",[randomUUID(),root,completedTask.taskId,JSON.stringify({assigneeId:worker}),JSON.stringify({assigneeId:null}),reassignedAt]);
      await db.query("UPDATE digital_production_task_access SET assignee_id=NULL WHERE task_id=$1",[completedTask.taskId]);
      const richNode=(await journeys.read(actor(root,["root_superuser"]),completedSource.sourceId)).stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===completedTask.taskId)!;
      expect(richNode.owner).toEqual(offset?{id:worker,name:"TEST-J pattern_room_worker"}:null);
    }
    const cardFacts=(items:ReturnType<typeof patternTasks>)=>normalize(items.map(item=>({...item,node:{...item.node,assignmentHistory:[],records:item.node.records.map(record=>({...record,mode:'read'})),blockers:item.node.blockers.map(blocker=>({...blocker,record:{...blocker.record,mode:'read'}})).sort((a,b)=>a.key.localeCompare(b.key))}})));
    for(const context of [actor(root,["root_superuser"]),actor(clerk,["development_clerk"]),actor(worker,["pattern_room_worker"]),actor(),actor(stranger)]){
      const rich=await journeys.list(context,JourneyFilterSchema.parse({}),true);
      const reads=vi.spyOn(DigitalProductionTaskService.prototype,'read');
      const preview=await journeys.list(context,JourneyFilterSchema.parse({}),true,undefined,{details:false});
      expect(reads).not.toHaveBeenCalled();reads.mockRestore();
      expect(cardFacts(patternTasks(preview.items))).toEqual(cardFacts(patternTasks(rich.items)));
      const reference=new DevelopmentWorkspaceQuery({list:async()=>rich} as unknown as DigitalJourneyQuery);
      for(const patch of [{page:1},{page:2},{page:3},{search:'TEST-J pattern_room_worker',state:'all'},{search:'TEST-PR12-PAGE'},{lane:'pattern'},{risk:'blocked'},{state:'completed'}]){
        const filter=PatternWorkspaceFilterSchema.parse({...patch,scope:context.actorId===root||context.actorId===clerk?'all':'mine'});
        const expected=await reference.pattern(context,filter),actual=await workspaces.pattern(context,filter);
        expect({...normalize(actual),items:cardFacts(actual.items),risks:cardFacts(actual.risks??[]),boardPreview:cardFacts(actual.boardPreview??[])}).toEqual({...normalize(expected),items:cardFacts(expected.items),risks:cardFacts(expected.risks??[]),boardPreview:cardFacts(expected.boardPreview??[])});
      }
    }
    const previewFilter=PatternWorkspaceFilterSchema.parse({scope:'mine',search:'TEST-PR12-PAGE'});
    const lanePreview=await workspaces.pattern(actor(worker,["pattern_room_worker"]),previewFilter);
    expect(lanePreview.total).toBe(25);expect(lanePreview.items).toHaveLength(15);
    expect(lanePreview.counts.pattern).toBe(25);expect(lanePreview.boardPreview).toHaveLength(3);
    expect(lanePreview.boardPreview?.every(task=>task.node.owner?.id===worker)).toBe(true);
    const fullLaneSecond=await workspaces.pattern(actor(worker,["pattern_room_worker"]),{...previewFilter,lane:'pattern',page:2});
    expect(fullLaneSecond.total).toBe(25);expect(fullLaneSecond.items).toHaveLength(10);
    const workerContext=actor(worker,["pattern_room_worker"]);
    const visibleBeforeRevocation=(await journeys.list(workerContext,JourneyFilterSchema.parse({search:'TEST-PR12-PAGE'}))).items[0]!;
    expect(visibleBeforeRevocation).toBeDefined();
    expect((await journeys.read(workerContext,visibleBeforeRevocation.id)).id).toBe(visibleBeforeRevocation.id);
    const client=await db.connect();try{await client.query('BEGIN');
      await client.query("INSERT INTO access_security_policy(policy_key,dingtalk_corp_id) VALUES('primary','TEST') ON CONFLICT DO NOTHING");
      await client.query("SELECT set_config('dx_rework.role_revoke_event_id',$1,true),set_config('dx_rework.role_revoke_request_id','TEST-PR12-revoke',true)",[randomUUID()]);
      await client.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP,revoked_by=$2,revoke_reason='TEST PR12 live role withdrawal' WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[worker,root]);
      await client.query('COMMIT');
    }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    expect((await journeys.list(workerContext,JourneyFilterSchema.parse({search:'TEST-PR12-PAGE'}))).total).toBe(0);
    await expect(journeys.read(workerContext,visibleBeforeRevocation.id)).rejects.toMatchObject({statusCode:404});
  },120000);

  it("R2 board summary preserves complete task counts while avoiding downstream full-domain reads",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:input("R2-PERF").designStyleNo,temporaryStyleNo:input("R2-PERF").temporaryStyleNo,customerCode:"PD"},randomUUID());
    await publishSource(source.sourceId);
    await identity.createOrder(actor(),input("R2-PERF"),randomUUID(),source.sourceId);
    const statements:string[]=[];
    const measured={connect:async()=>{
      const client=await db.connect();
      return new Proxy(client,{get(target,key){
        if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string')statements.push(args[0]);return Reflect.apply(target.query,target,args);};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    }} as unknown as pg.Pool;
    const measuredJourneys=new DigitalJourneyQuery(measured),context=actor(root,["root_superuser"]);
    const baseline=await measuredJourneys.list(context,JourneyFilterSchema.parse({}),true,undefined,{details:false});
    const baselineCount=statements.length;statements.length=0;
    const filter=PatternWorkspaceFilterSchema.parse({business:'all',scope:'all',state:'all'});
    const expected=await new DevelopmentWorkspaceQuery({list:async()=>baseline} as unknown as DigitalJourneyQuery).pattern(context,filter);
    const actual=await new DevelopmentWorkspaceQuery(measuredJourneys).pattern(context,filter);
    expect(actual.total).toBe(expected.total);expect(actual.counts).toEqual(expected.counts);expect(actual.riskCounts).toEqual(expected.riskCounts);expect(actual.owners).toEqual(expected.owners);
    expect(actual.items.map(row=>row.node.instanceId)).toEqual(expected.items.map(row=>row.node.instanceId));
    expect(statements.length).toBeLessThan(baselineCount);
    expect(statements.some(sql=>sql.includes('FROM digital_budget_documents')||sql.includes('FROM digital_order_closures'))).toBe(false);
    expect(statements.some(sql=>sql.includes('board_task.task_kind=ANY($5::text[])'))).toBe(true);
    console.info(JSON.stringify({evidence:'R2 board SQL count',baseline:baselineCount,optimized:statements.length,cards:actual.total}));
  },120000);

  it("SLA10 projects one canonical mother plan inside the original authorized snapshot without changing business progress or P0",async()=>{
    const rootActor=actor(root,["root_superuser"]),created=await identity.createOrder(rootActor,{...input("SLA10"),primaryMerchandiserId:merchandiser},randomUUID());
    const id=created.productionOrderId;
    const before=(await db.query("SELECT plan_json FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision",[id])).rows;
    const expected=await new SlaOrderService(db).read(rootActor,id),detail=await journeys.read(rootActor,id,undefined,true);
    expect(expected.status).toBe("planned");expect(detail.supervision?.status).toBe("planned");
    if(expected.status!=="planned")throw Error("fixture must enroll");
    const sheet=detail.supervision!.nodes.find(n=>n.id==='production_sheet')!,canonical=expected.nodes.find(n=>n.id==='production_sheet')!;
    expect(sheet.target).toEqual(canonical.deadline);expect(sheet.forecast).toEqual(canonical.forecast);expect(sheet.original).toEqual(expected.original.plan.nodes.length?expected.nodes.find(n=>n.id==='production_sheet')!.end:null);
    expect(detail.supervision!.coverage.some(c=>c.key==='factory_date')).toBe(true);
    const listed=await journeys.list(rootActor,JourneyFilterSchema.parse({scope:'production',search:'TEST-J-SLA10'}));
    expect(listed.items).toHaveLength(1);expect(listed.items[0]!.supervision!.nodes.find(n=>n.id==='production_sheet')!.target).toEqual(sheet.target);
    expect(listed.supervision?.coverage.some(c=>c.key==='factory_date'&&c.orders===1)).toBe(true);
    expect((await db.query("SELECT plan_json FROM digital_sla_plans WHERE production_order_id=$1 ORDER BY revision",[id])).rows).toEqual(before);
    await expect(journeys.read(actor(stranger),id,undefined,true)).rejects.toMatchObject({statusCode:404});
    const isolatedWorker=randomUUID();
    await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST-SLA10 isolated worker',true)",[isolatedWorker]);
    await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),isolatedWorker]);
    const authorization=new AccessMasterDataService(db,'TEST');await authorization.ensureOrganizationPolicy();
    await authorization.assignRole(rootActor,{userId:isolatedWorker,roleCode:'pattern_room_worker',reason:'TEST isolated SLA10 scope, independent of the revoked paging fixture'});
    const scoped=await createTask({resource:{kind:'order',id},kind:'bulk_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:isolatedWorker});
    const workerRead=await journeys.read(actor(isolatedWorker,['pattern_room_worker']),id,undefined,true);
    expect(workerRead.supervision).toMatchObject({status:"limited",nodes:[],currentRevision:null});
    expect((await journeys.read(actor(isolatedWorker,["pattern_room_worker","production_management"]),id,undefined,true)).supervision).toMatchObject({status:"limited",nodes:[],currentRevision:null});expect(workerRead.stages.flatMap(s=>s.nodes).some(n=>n.records.some(r=>r.id===scoped.taskId))).toBe(true);
  });
  it("SLA10 source supervision follows the trusted business clock and preserves prior-round dates and read-only facts",async()=>{
    const source=(await identity.createSource(actor(),{developmentType:'头版',designStyleNo:'TEST-SLA10-SOURCE',temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    await publishSource(source);
    const normal=await journeys.read(actor(),source,undefined,true);expect(normal.supervision?.status).toBe('planned');
    const observed=normal.supervision!.asOf,next=new Date(Date.parse(observed)+5*86400000).toISOString();
    const scoped={connect:db.connect.bind(db),query:db.query.bind(db)} as unknown as pg.Pool;
    installAcceptanceClockReader(scoped,{read:async()=>({now:next,scenarioId:null,revision:0}),nativeScenario:async()=>null});
    const later=await new DigitalJourneyQuery(scoped).read(actor(),source,undefined,true);
    expect(later.supervision?.asOf).toBe(next);expect(later.display?.actualRatio).toEqual(normal.display?.actualRatio);
    const first=normal.supervision!.nodes.find(n=>n.id==='development_materials')!,second=later.supervision!.nodes.find(n=>n.id==='development_materials')!;
    expect(second.original).toEqual(first.original);expect(second.target).toEqual(first.target);expect(second.status).toBe('overdue');
    expect(later.stages.flatMap(s=>s.nodes).find(n=>n.key==='development_materials')!.state).toEqual(normal.stages.flatMap(s=>s.nodes).find(n=>n.key==='development_materials')!.state);
  });

  it('SLA10 keeps the same original task target, read receipt and business state while its trusted scene time advances',async()=>{
    const sourceId=(await identity.createSource(actor(),{developmentType:'头版',designStyleNo:'TEST-SLA10-TODO',temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    const task=await createTask({resource:{kind:'source',id:sourceId},kind:'development_materials',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:clerk});
    const f={taskId:task.taskId,sourceId},notices=new DigitalProductionNotificationService(db),todos=new TodoService(db,undefined,undefined,undefined,notices),clerkActor={...actor(clerk,['development_clerk']),authorizationCapability:'todo:view',authorizationCapabilities:['todo:view']},rootActor=actor(root,['root_superuser']);
    const initial=(await notices.todos(clerkActor)).find(t=>t.todoId===f.taskId)!;
    expect(initial.timing).toBeDefined();
    await todos.markReadForActor(clerkActor,f.taskId,{contentToken:initial.contentToken!,route:initial.route});
    const snapshot=await tasks.read(rootActor,f.taskId),future=new Date(Date.parse(initial.timing!.asOf)+8*86400000).toISOString();
    const scoped={connect:db.connect.bind(db),query:db.query.bind(db)} as unknown as pg.Pool;
    installAcceptanceClockReader(scoped,{read:async scope=>scope.id===f.sourceId?{now:future,scenarioId:null,revision:0}:null,nativeScenario:async()=>null});
    const next=(await new DigitalProductionNotificationService(scoped).todos(clerkActor)).find(t=>t.todoId===f.taskId)!;
    expect(next.timing!.asOf).toBe(future);expect(next.dueAt).toBe(initial.dueAt);expect(next.contentToken).toBe(initial.contentToken);expect(next.unread).toBe(false);expect(next.status).toBe('pending');
    expect(next.timing!.status).toBe(initial.dueAt?'overdue':'unknown');
    expect(await tasks.read(rootActor,f.taskId)).toEqual(snapshot);
    expect((await new DigitalProductionNotificationService(scoped).todos(actor(stranger,['sample_designer']))).some(t=>t.todoId===f.taskId)).toBe(false);
  });

});
