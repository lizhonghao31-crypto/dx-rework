import { DevelopmentDocumentSchema } from "@dx-rework/contracts/digital-development";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { JourneyFilterSchema } from "@dx-rework/contracts/digital-production-journey";
import { DigitalOrderCreateSchema } from "@dx-rework/contracts/digital-production";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalJourneyQuery } from "../../apps/api/src/production-platform/journey-query.js";
import { DevelopmentWorkspaceQuery } from "../../apps/api/src/production-platform/development-workspace-query.js";
import { DevelopmentWorkspaceFilterSchema, PatternWorkspaceFilterSchema } from "@dx-rework/contracts/digital-development-workspace";
import { registerDigitalIdentityRoutes } from "../../apps/api/src/production-platform/identity-routes.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import { ApplicationError } from "../../apps/api/src/platform/errors.js";

const databaseUrl=process.env.TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)("V2 Journey with full original PostgreSQL schema",()=>{
  const schema=ownedPostgresSchema("digital_journey");
  const admin=new pg.Pool({connectionString:databaseUrl});
  const db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
  const root=randomUUID(),designer=randomUUID(),stranger=randomUUID(),worker=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create"],requestId:"TEST-v2-journey"});
  const identity=new DigitalProductionIdentityService(db,true),journeys=new DigitalJourneyQuery(db),tasks=new DigitalProductionTaskService(db);
  const input=(suffix="0001")=>DigitalOrderCreateSchema.parse({customerCode:"PD",productGroup:"男装",designStyleNo:`TEST-J-${suffix}`,temporaryStyleNo:`TEST-T-${suffix}`,orderDate:"2026-10-01",lines:[{poNumber:"PO-J1",color:"黑",sizes:[{size:"M",quantity:100}],deliveryDate:"2026-10-20"},{poNumber:"PO-J2",color:"白",sizes:[{size:"L",quantity:200}],deliveryDate:"2026-10-22"}]});
  const createTask=async(input:Parameters<DigitalProductionTaskService["createWithClient"]>[2])=>{
    const client=await db.connect();try{await client.query("BEGIN");const task=await tasks.createWithClient(client,actor(root,["root_superuser"]),input);await client.query("COMMIT");return task;}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  };
  const app=Fastify();
  beforeAll(async()=>{
    await admin.query(`CREATE SCHEMA ${schema}`);
    const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8")) as {migrations:Array<{version:string;checksum:string}>};
    await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
    for(const migration of manifest.migrations){await db.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),"utf8"));await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[migration.version,migration.checksum]);}
    for(const [id,role] of [[root,"owner_group"],[designer,"sample_designer"],[stranger,"sample_designer"],[worker,"pattern_room_worker"]]){
      await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,`TEST-J ${role}`]);
      await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);
      await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST Journey fixture')",[randomUUID(),id,role,root]);
    }
    await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1::uuid,$1::uuid::text,'TEST')",[root]);
    app.setErrorHandler((error,_request,reply)=>{const known=error as ApplicationError;reply.code(known.statusCode??500).send({error:{code:known.code,message:known.message}});});
    registerDigitalIdentityRoutes(app,{service:identity,journeys,creationEnabled:true,authenticate:async token=>{
      if(token!==designer&&token!==stranger)throw new ApplicationError("UNAUTHORIZED","请登录",401);
      return {id:token,displayName:"TEST",businessRoles:["sample_designer"],capabilities:["pattern_room:orders:create"]};
    }});
    await app.ready();
  },120000);
  afterAll(async()=>{await app.close();await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  it("joins a source and confirmed two-PO order once, resolves either ID, and rejects other identities",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:input().designStyleNo,temporaryStyleNo:input().temporaryStyleNo,customerCode:"PD"},randomUUID());
    expect((await journeys.read(actor(),source.sourceId)).orderId).toBeNull();
    expect((await journeys.read(actor(),source.sourceId)).stages.flatMap(stage=>stage.nodes).find(node=>node.key==="product_development")?.records[0]?.url).toBe(`/ui/digital-production?development=${source.sourceId}`);
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
    expect(nodes.find(node=>node.key==='receipts')?.state).toBe('uncreated');
    expect((await db.query("SELECT count(*)::int n FROM cutting_records")).rows[0]!.n).toBe(before);
  });

  it("projects original per-material plan revisions without inventing node SLA or arrival times",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-MATERIAL-PLAN",temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const fileId=randomUUID(),materialId=randomUUID();
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-plan.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`TEST/plan/${fileId}`,"a".repeat(64),designer]);
    const document=DevelopmentDocumentSchema.parse({template:"上衣",quantity:1,sampleSize:"M",orderDate:"2026-10-01",returnDate:null,unit:"cm",sizes:["M"],measurements:[{name:"胸围",values:["50"]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[{materialId,category:"辅料",label:"TEST 拉链",supplier:"",name:"拉链",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"",quantity:"1",requiredThisRound:true,available:false,expectedDate:"2026-10-08"}],files:[{attachmentId:fileId,kind:"款图"}]});
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
    await execution.check(rootActor,source.sourceId,{taskId:published.taskId!,result:"缺项退回",note:"TEST 物料补齐接续",items:[]},randomUUID());
    const supply=(await execution.read(rootActor,source.sourceId)).tasks.find(task=>task.taskKind==="development_material_supply")!;
    expect((await tasks.read(actor(), supply.taskId)).identity).toEqual({designStyleNo:"TEST-MATERIAL-PLAN",customerCode:"PD"});
    await expect(tasks.read(actor(stranger), supply.taskId)).rejects.toMatchObject({statusCode:404});
    const taskNode=()=>journeys.read(actor(),source.sourceId).then(value=>value.stages.flatMap(stage=>stage.nodes).find(item=>item.instanceId===supply.taskId));
    expect(await taskNode()).toMatchObject({key:"development_material_supply",state:"active",current:true,owner:{id:designer},expectedAt:supply.dueAt,enteredAt:supply.enteredAt});
    expect((await taskNode())?.records).toContainEqual(expect.objectContaining({domain:"task",id:supply.taskId,url:`/ui/digital-production?task=${supply.taskId}`}));
    await forms.materialEvent(actor(),source.sourceId,materialId,{expectedVersion:published.version,expectedMaterialRevision:1,action:"到货",expectedDate:null,note:"TEST 原到货记录"},randomUUID());
    expect(await node()).toMatchObject({state:"completed",actualAt:null,completionResult:"unknown"});
    await execution.resubmit(actor(),source.sourceId,supply.taskId,randomUUID());
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
    expect((await tasks.read(actor(worker,["pattern_room_worker"]), assigned.taskId)).identity).toBeNull();
    expect(node.state).toBe("pending");expect(node.enteredAt).toBeNull();expect(node.sla).toBe("not_started");expect(node.risks).not.toContain("overdue");
    expect(nodes.find(node=>node.key==="development_cutting")?.state).toBe("unavailable");
    await expect(journeys.read(actor(worker,["pattern_room_worker"]),source.sourceId,1)).rejects.toMatchObject({statusCode:404});
  });
  it("keeps queries read-only under concurrent confirmation and official-number correction",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-CONCURRENT",temporaryStyleNo:"TEST-CONCURRENT-T",customerCode:"PD"},randomUUID());
    const request={...input("CONCURRENT"),designStyleNo:"TEST-CONCURRENT",temporaryStyleNo:"TEST-CONCURRENT-T"};
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
  it("resolves names only on visible task reassignment facts while preserving stable IDs",async()=>{
    const source=await identity.createSource(actor(),{developmentType:"头版",designStyleNo:"TEST-J-NAMED-HISTORY",temporaryStyleNo:null,customerCode:"PD"},randomUUID());
    const {taskId}=await createTask({resource:{kind:"source",id:source.sourceId},kind:"development_cutting",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null,conditions:["handover_received"]});
    await tasks.reassign(actor(root,["root_superuser"]),taskId,worker,randomUUID());
    const item=await journeys.read(actor(),source.sourceId);
    const node=item.stages.flatMap(stage=>stage.nodes).find(node=>node.instanceId===taskId)!;
    expect(node.assignmentHistory).toContainEqual(expect.objectContaining({actorId:root,actorName:"TEST-J owner_group",from:null,fromName:null,to:worker,toName:"TEST-J pattern_room_worker"}));
    expect((await tasks.read(actor(),taskId)).identity).toEqual({designStyleNo:"TEST-J-NAMED-HISTORY",customerCode:"PD"});
    await expect(journeys.read(actor(stranger),source.sourceId)).rejects.toMatchObject({statusCode:404});
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
    await identity.createOrder(actor(),input("WORKSPACE"),randomUUID(),source.sourceId);
    expect((await workspaces.designer(actor(),DevelopmentWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE",view:"ordered"}))).total).toBe(1);
    expect((await workspaces.designer(actor(stranger),DevelopmentWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE"}))).total).toBe(0);
    await expect(workspaces.designer(actor(worker,["pattern_room_worker"]),DevelopmentWorkspaceFilterSchema.parse({}))).rejects.toMatchObject({statusCode:403});
    expect((await workspaces.pattern(actor(stranger),PatternWorkspaceFilterSchema.parse({search:"TEST-J-WORKSPACE"}))).total).toBe(0);
    const allowed=await app.inject({method:"GET",url:"/digital-production/workspaces/designer?search=TEST-J-WORKSPACE&view=ordered",headers:{cookie:`dx_rework_session=${designer}`}});
    expect(allowed.statusCode).toBe(200);expect(allowed.json().total).toBe(1);expect(allowed.headers["cache-control"]).toBe("no-store");
  });
});
