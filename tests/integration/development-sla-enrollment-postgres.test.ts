import {DevelopmentRoundService} from "../../apps/api/src/production-platform/development-round-service.js";
import {businessNow as currentBusinessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import type {DevelopmentRevision} from "@dx-rework/contracts/digital-development-rounds";
import {applyDigitalPoDateFixture} from "../helpers/digital-po-date-fixture.js";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {afterAll,beforeAll,describe,expect,it} from "vitest";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";
import {DevelopmentExecutionService} from "../../apps/api/src/production-platform/development-execution-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {receivedDevelopmentAccessories} from "../../apps/api/src/production-platform/development-accessory-receipts.js";
import {projectDevelopmentNotices} from "../../apps/api/src/production-platform/development-notifications.js";
import {captureDevelopmentSla,developmentSlaPlan} from "../../apps/api/src/production-platform/development-sla-enrollment.js";
import {SlaConfigurationRepository} from "../../apps/api/src/production-platform/sla-configuration-repository.js";
import {developmentSlaEvidence} from "../../apps/api/src/production-platform/development-sla-evidence.js";
import Fastify from "fastify";
import {registerDevelopmentExecutionRoutes} from "../../apps/api/src/production-platform/development-execution-routes.js";
import {ApplicationError} from "../../apps/api/src/platform/errors.js";
import {digitalSlaDefaults} from "@dx-rework/contracts/digital-sla";
import {DevelopmentDocumentSchema,type DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {ownedPostgresSchema,createOwnedPostgresSchema,dropOwnedPostgresSchema} from "../helpers/owned-postgres-schema.js";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
const databaseUrl=process.env.TEST_DATABASE_URL;
const run=databaseUrl?describe:describe.skip;
run("development SLA enrollment and legacy isolation",()=>{
  const schema=ownedPostgresSchema("development_sla");
  const admin=new pg.Pool({connectionString:databaseUrl!});
  const database=new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const designer=randomUUID(),other=randomUUID(),root=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create","todo:view"],requestId:"SLA03"});
  let legacyId:string;
  const legacyPolicySources=new Map<string,string>();
  let businessNow="2026-10-23T00:00:00.000Z";
  const clock={read:async()=>({now:businessNow,scenarioId:"isolated-development-fixture",revision:1})};
  const service=new DigitalProductionIdentityService(database,true,undefined,()=>new Date(),clock);
  const development=new DigitalDevelopmentService(database,true,undefined,()=>new Date(),clock);
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
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
      INSERT INTO business_roles(role_code) VALUES('sample_designer'),('order_merchandiser'),('pattern_room_supervisor'),('pattern_room_worker'),('production_management'),('quality_control'),('embroidery_washing_merchandiser'),('warehouse_receiver'),('owner_group');`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0219_digital_production_access.sql", import.meta.url), "utf8"));
    await database.query(`CREATE FUNCTION fixture_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)
      VALUES(NEW.id,NEW.id,'dingtalk','TEST',NEW.id::text,NEW.id::text,true,true,CURRENT_TIMESTAMP); RETURN NEW; END $$;
      CREATE TRIGGER fixture_user_identity AFTER INSERT ON app_users FOR EACH ROW EXECUTE FUNCTION fixture_identity();`);
    for (const id of [designer, other, root]) await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST P01',true)", [id]);
    for (const id of [designer, other]) await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'sample_designer')", [id]);
    await database.query(await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0221_digital_production_notifications.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0222_digital_development_documents.sql", import.meta.url), "utf8"));
    legacyId=(await service.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-LEGACY-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
    // These sources really exist before SLA enrollment is installed; no historical timestamp is rewritten.
    for(const timing of ['before','after'])legacyPolicySources.set(timing,(await service.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-LEGACY-POLICY-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId);
    for(const name of ["0223_digital_development_execution.sql","0224_digital_development_route.sql","0225_digital_development_rounds.sql","0244_development_sewing_result_attachments.sql","0245_development_pattern_result_attachments.sql","0252_digital_sla_configuration_snapshots.sql", "0253_digital_sla_plan_history.sql","0254_digital_sla_policy_references.sql","0255_development_sla_enrollment.sql","0258_ship_sample_date_target.sql"])
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`,import.meta.url),"utf8"));
    // Actual management authority and the native0230 policy are required even in
    // this intentionally historical partial-schema fixture. Do not bypass either guard.
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'owner_group')",[root]);
    await database.query("INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio) VALUES('bulk_ship_sample',1,'大货船样寄出',NULL,0.8)");
  });

  afterAll(async()=>{await database.end();await dropOwnedPostgresSchema(admin,schema);await admin.end();});
  const source=async()=> (await service.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-P05-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
  const draft=():DevelopmentDocument=>DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[null],template:"上衣",quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M"],measurements:[{name:"胸围",values:[""]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[],files:[]});
  const ready=async()=>{
    const doc=draft(),id=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$4,'test.png','image/png',100,$2,$3,'ready',CURRENT_TIMESTAMP)`,[id,"a".repeat(64),designer,`test/${id}`]);
    return {...doc,quantity:1,sizeQuantities:[1],sampleSize:"M",orderDate:null,files:[{attachmentId:id,kind:"款图" as const}]};
  };

  it("freezes at creation, starts clerk window at publication, and never takes a later global standard",async()=>{
    const id=await source(),initial=await developmentSlaPlan(database,id);
    expect(initial.revision).toBe(1);expect(initial.plan_json.anchors.development_published).toBeUndefined();
    expect(initial.parameters_json.development_tail_check.value).toEqual({kind:'duration',minutes:30});
    const db=await database.connect();try{
      await db.query("BEGIN");const repo=new SlaConfigurationRepository(db),current=(await repo.current())!;
      const values=digitalSlaDefaults();values.development_materials={kind:"duration",minutes:300};
      await repo.publish({expectedVersion:current.version,values,actorId:root,reason:"test new orders only",requestKey:randomUUID()});
      await db.query("COMMIT");
    }finally{db.release();}
    const doc=await ready(),saved=await development.save(actor(),id,{expectedVersion:0,document:doc},randomUUID());
    businessNow="2026-10-23T02:00:00.000Z";
    const key=randomUUID();await development.publish(actor(),id,saved.version,key);
    await development.publish(actor(),id,saved.version,key);
    const published=await developmentSlaPlan(database,id);
    expect(published.revision).toBe(2);
    expect(published.parameters_json.development_materials.value.minutes).toBe(240);
    expect(published.plan_json.anchors.development_published.value).toBe(businessNow);
    expect(new Date((await database.query("SELECT published_at FROM digital_development_documents WHERE source_id=$1",[id])).rows[0].published_at).toISOString()).toBe(businessNow);
    expect(published.route_nodes).not.toContain("development_pre_wash_check");
    expect((await database.query("SELECT count(*)::int n FROM digital_development_sla_plans WHERE source_id=$1",[id])).rows[0].n).toBe(2);
    const next=await developmentSlaPlan(database,await source());expect(next.parameters_json.development_materials.value.minutes).toBe(300);
    await expect(database.query("UPDATE digital_development_sla_plans SET reason='overwrite' WHERE source_id=$1",[id])).rejects.toThrow();
  });
  it("does not enroll a historical draft just because it is published",async()=>{
    const saved=await development.save(actor(),legacyId,{expectedVersion:0,document:await ready()},randomUUID());
    await development.publish(actor(),legacyId,saved.version,randomUUID());
    expect(await developmentSlaPlan(database,legacyId)).toBeNull();
  });
  it("requires creator scope and rolls back publication and tasks when snapshot recording fails",async()=>{
    const id=await source(),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    await expect(development.publish(actor(other),id,saved.version,randomUUID())).rejects.toMatchObject({statusCode:403});
    await database.query(`CREATE FUNCTION reject_test_publication() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.revision=2 THEN RAISE EXCEPTION 'test snapshot failure'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER reject_test_publication BEFORE INSERT ON digital_development_sla_plans FOR EACH ROW EXECUTE FUNCTION reject_test_publication();`);
    try{await expect(development.publish(actor(),id,saved.version,randomUUID())).rejects.toThrow("test snapshot failure");}
    finally{await database.query("DROP TRIGGER reject_test_publication ON digital_development_sla_plans");}
    expect((await development.read(actor(),id)).status).toBe("draft");
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1",[id])).rows[0].n).toBe(0);
    expect((await developmentSlaPlan(database,id)).revision).toBe(1);
  });
  it("rejects a fabricated enrollment event and clock scope regression",async()=>{
    const id=await source(),db=await database.connect();try{
      await db.query("BEGIN");
      await expect(captureDevelopmentSla(db,actor(),id,await ready(),{now:businessNow,scenarioId:null,revision:0},randomUUID())).rejects.toThrow(/scope/);
      await db.query("ROLLBACK");await db.query("BEGIN");
      await expect(captureDevelopmentSla(db,actor(),legacyId,null,{now:businessNow,scenarioId:null,revision:0},randomUUID())).rejects.toThrow(/creation event/);
      await db.query("ROLLBACK");
    }finally{db.release();}
  });
  it("allows the original designer to record sample shipment immediately without completing development",async()=>{
    const id=await source(),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const task=(await database.query("SELECT a.task_id,t.state FROM digital_production_task_access a JOIN digital_production_tasks t USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_shipping'",[id])).rows[0];
    expect(task.state).toBe("ready");
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_dependencies WHERE task_id=$1",[task.task_id])).rows[0].n).toBe(0);
    const execute=new DevelopmentExecutionService(database,true);
    const input={taskId:task.task_id,craftExecution:null,note:"TEST early sample",result:"通过" as const,nextAssigneeId:null,sentDate:beijingCalendarDate(currentBusinessNow()),trackingNo:"TEST-TRACKING"};
    await expect(execute.route(actor(other),id,input,randomUUID())).rejects.toThrow();
    await expect(execute.route(actor(),id,{...input,sentDate:'2026-10-22'},randomUUID())).rejects.toMatchObject({code:'DEVELOPMENT_OCCURRENCE_CONFLICT'});
    const key=randomUUID();await execute.route(actor(),id,input,key);await execute.route(actor(),id,input,key);
    expect((await database.query("SELECT count(*)::int n FROM digital_development_route_facts WHERE task_id=$1 AND kind='寄出'",[task.task_id])).rows[0].n).toBe(1);
    expect((await database.query("SELECT payload FROM digital_development_route_facts WHERE task_id=$1 AND kind='寄出'",[task.task_id])).rows[0].payload).toMatchObject({actualCompletedAt:null,actualCompletedDate:input.sentDate,timeQuality:'补报未核实'});
    expect((await database.query("SELECT state FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials'",[id])).rows[0].state).not.toBe("completed");
  });
  it("preserves separate before/after measurement evidence and requires exact-task tail photos",async()=>{
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'development_clerk'),($2,'pattern_room_tail_inspector')",[root,other]);
    const id=await source(),document={...await ready(),washing:"内洗" as const};
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    // Explicit fixture starts at the inspection boundary; it does not claim a full native sewing/wage chain test.
    const db=await database.connect(),taskService=new DigitalProductionTaskService(database),execute=new DevelopmentExecutionService(database,true);
    const rootActor=actor(root,["root_superuser"]),inspector=actor(other,["pattern_room_tail_inspector"]);
    let taskId:string;try{await db.query("BEGIN");taskId=(await taskService.createWithClient(db,rootActor,{resource:{kind:"source",id},kind:"development_pre_wash_check",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:other})).taskId;await db.query("COMMIT");}finally{db.release();}
    const action={taskId,craftExecution:null,note:"TEST dimensions",result:"通过" as const,nextAssigneeId:null,sentDate:null,trackingNo:null};
    await expect(execute.route(inspector,id,action,randomUUID())).rejects.toThrow("实际尺寸");
    const before=[{name:"胸围",values:["90"]}],key=randomUUID();
    await execute.route(inspector,id,{...action,measurements:before},key);await execute.route(inspector,id,{...action,measurements:before},key);
    const dispatch=(await database.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_washing_dispatch'",[id])).rows[0];
    await execute.sendWashing(rootActor,id,dispatch.task_id,"TEST dispatch",randomUUID());
    const wash=(await database.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_washing'",[id])).rows[0];
    await execute.route(rootActor,id,{...action,taskId:wash.task_id},randomUUID());
    const tail=(await database.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_tail_check'",[id])).rows[0];
    const after=[{name:"胸围",values:["89"]}],tailInput={...action,taskId:tail.task_id,measurements:after};
    await expect(execute.route(inspector,id,tailInput,randomUUID())).rejects.toThrow("尾查提交前");
    const photo=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-tail.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[photo,`test-tail/${photo}`,'e'.repeat(64),other]);
    await execute.recordUploadPurpose(inspector,id,photo,"尾查照片",tail.task_id);
    await execute.route(inspector,id,{...tailInput,attachmentIds:[photo]},randomUUID());
    const facts=(await database.query("SELECT kind,payload FROM digital_development_route_facts WHERE source_id=$1 AND kind IN ('洗前检查','尾查通过') ORDER BY sequence",[id])).rows;
    expect(facts).toHaveLength(2);expect(facts[0].payload.inspection).toMatchObject({phase:"洗前",sizes:["M"],unit:"cm",measurements:before});
    expect(facts[1].payload.inspection).toMatchObject({phase:"洗后",measurements:after});
    expect(facts[1].payload.attachmentIds).toEqual([photo]);
  });
  it("allows boss and root fabric decisions while preserving rejection and immutable evidence",async()=>{
    const boss=randomUUID();await database.query("INSERT INTO business_roles(role_code) VALUES('owner_group') ON CONFLICT DO NOTHING");
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST owner',true)",[boss]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'owner_group')",[boss]);
    const id=await source(),doc=await ready(),saved=await development.save(actor(),id,{expectedVersion:0,document:doc},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const execution=new DevelopmentExecutionService(database,true),rootActor=actor(root,['root_superuser']);
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-report.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST/${file}`,'a'.repeat(64),root]);
    await execution.recordUploadPurpose(rootActor,id,file,'面料报告');
    const report=await execution.report(rootActor,id,{recommendation:'建议停用',note:'TEST quality issue',attachmentIds:[file]},randomUUID()) as {reportId:string};
    const input={reportId:report.reportId,decision:'允许使用',note:'TEST explicit decision',expectedDecisionId:null};
    await expect(execution.decideFabric(actor(),id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    const decision=await execution.decideFabric(actor(boss,['owner_group']),id,input,randomUUID());
    await execution.decideFabric(rootActor,id,{...input,decision:'先处理',expectedDecisionId:decision.factId},randomUUID());
    const records=(await database.query("SELECT kind,payload FROM digital_development_execution_facts WHERE source_id=$1 AND kind IN ('面料报告','面料决定') ORDER BY sequence",[id])).rows;
    expect(records.map(r=>r.kind)).toEqual(['面料报告','面料决定','面料决定']);expect(records[0].payload.recommendation).toBe('建议停用');
  });
  it("projects rejected prior tail and valid later round without erasing the original attempt",async()=>{
    // Read-model fixture at the tail boundary; not a substitute for the native sewing/rework workflow.
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_tail_inspector')",[root]);
    const id=await source(),document=await ready();
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const client=await database.connect(),tasks=new DigitalProductionTaskService(database),rootActor=actor(root,['root_superuser']);
    let first:string,second:string;
    try{
      await client.query('BEGIN');
      first=(await tasks.createWithClient(client,rootActor,{resource:{kind:'source',id},kind:'development_tail_check',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:root})).taskId;
      await client.query("UPDATE digital_production_tasks SET state='completed',completed_at=CURRENT_TIMESTAMP,completed_quality='现场登记' WHERE task_id=$1",[first]);
      await client.query("INSERT INTO digital_development_route_facts(fact_id,source_id,task_id,route_version,kind,payload,actor_id) VALUES($1,$2,$3,1,'尾查退回','{}',$4)",[randomUUID(),id,first,root]);
      const routeId=randomUUID();
      await client.query(`INSERT INTO digital_development_rounds(source_id,round_number,based_on_round,document_version,document,origin,customer_comment,internal_problem,explanation,categories,affected_nodes,output_kind,route_nodes,inherited,return_task_id,route_id,created_by)
        VALUES($1,2,1,3,$2,'内部发现','','TEST tail correction','TEST projection boundary',ARRAY['尺寸'],ARRAY['车板'],'整件样板',ARRAY['development_tail_check'],'{}',$3,$4,$5)`,[id,JSON.stringify(document),first,routeId,root]);
      second=(await tasks.createWithClient(client,rootActor,{resource:{kind:'source',id},kind:'development_tail_check',routeId,routeVersion:2,occurrence:2,assigneeId:root})).taskId;
      await client.query('COMMIT');
    }finally{client.release();}
    const now=()=>({now:new Date(Date.now()+1000).toISOString(),scenarioId:'isolated-development-fixture',revision:1});
    const pending=await developmentSlaEvidence(database,id,now());
    expect(pending!.originalFacts.development_tail_check?.businessCompleted).toBe(false);
    expect(pending!.facts.development_tail_check?.businessCompleted).toBe(false);
    await database.query("UPDATE digital_production_tasks SET state='completed',completed_at=CURRENT_TIMESTAMP,completed_quality='现场登记' WHERE task_id=$1",[second!]);
    const passed=await developmentSlaEvidence(database,id,now());
    expect(passed!.facts.development_tail_check?.businessCompleted).toBe(true);
    expect(passed!.facts.development_tail_check?.completedAt).toBeTruthy();
    expect(passed!.originalFacts.development_tail_check?.businessCompleted).toBe(false);
    expect((await database.query("SELECT count(*)::int n FROM digital_development_route_facts WHERE task_id=$1 AND kind='尾查退回'",[first!])).rows[0].n).toBe(1);
  });
  it("counts assignment waiting from the real predecessor completion and never restarts the window on assignment",async()=>{
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_worker')",[other]);
    const id=await source(),document=await ready(),materialId=randomUUID();
    document.materials=[{materialId,category:"主布",label:"主布A",supplier:"",name:"棉布",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"40支",quantity:"1",requiredThisRound:true,available:true,expectedDate:null}];
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID()),published=await development.publish(actor(),id,saved.version,randomUUID());
    const execute=new DevelopmentExecutionService(database,true),tasks=new DigitalProductionTaskService(database),rootActor=actor(root,["root_superuser"]);
    const clerk=await tasks.read(rootActor,published.taskId!);
    expect(clerk.enteredAt).toBe(businessNow);
    expect(Date.parse(clerk.dueAt!)-Date.parse(clerk.enteredAt!)).toBe(clerk.slaHours!*3600000);
    await execute.check(rootActor,id,{taskId:published.taskId!,result:"通过",note:"TEST queue boundary",items:[{materialId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
    const paperId=(await database.query("SELECT task_id FROM digital_production_task_access WHERE source_id=$1 AND task_kind='development_pattern'",[id])).rows[0].task_id;
    const waiting=await tasks.read(rootActor,paperId);
    expect(waiting.state).toBe("pending");expect(waiting.assigneeId).toBeNull();
    const completed=(await database.query("SELECT completed_at FROM digital_production_tasks WHERE task_id=$1",[published.taskId])).rows[0].completed_at;
    expect(waiting.enteredAt).toBe(new Date(completed).toISOString());
    expect(Date.parse(waiting.dueAt!)-Date.parse(waiting.enteredAt!)).toBe(48*3600000);
    await tasks.reassign(rootActor,paperId,other,randomUUID());
    const assigned=await tasks.read(rootActor,paperId);
    expect(assigned.enteredAt).toBe(waiting.enteredAt);expect(assigned.dueAt).toBe(waiting.dueAt);
    const basis=(await database.query("SELECT sla_basis FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id DESC LIMIT 1",[paperId])).rows[0].sla_basis;
    expect(basis.sourceId).toBe(id);expect(basis.basis).toContain(`task:${published.taskId}:completed`);
  });
  it("clears accessory reminders only from the submitted clerk receipt, not designer arrival",async()=>{
    const id=await source(),document=await ready(),materialId=randomUUID();
    document.materials=[{materialId,category:"辅料",label:"纽扣",supplier:"",name:"纽扣",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"18L",quantity:"1",requiredThisRound:true,available:true,expectedDate:"2026-10-21"}];
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID()),published=await development.publish(actor(),id,saved.version,randomUUID());
    await expect(development.materialEvent(actor(),id,materialId,{action:"到货",expectedRound:1,expectedDate:null,note:"TEST 禁止设计师登记实到",expectedVersion:published.version,expectedMaterialRevision:0},randomUUID())).rejects.toMatchObject({statusCode:403});
    expect((await receivedDevelopmentAccessories(database,id,1,document)).has(materialId)).toBe(false);
    const db=await database.connect();try{await db.query('BEGIN');await projectDevelopmentNotices(db,[actor()],new Date('2026-10-23T03:00:00Z'));await db.query('COMMIT');}finally{db.release();}
    const notices=await database.query("SELECT event_id FROM digital_development_notices WHERE source_id=$1 AND material_id=$2",[id,materialId]);expect(notices.rowCount).toBe(1);
    // Existing clerk submission keeps the physical receipt even when a different dimension is returned.
    const execute=new DevelopmentExecutionService(database,true),clerkId=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST reminder clerk',true)",[clerkId]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'development_clerk')",[clerkId]);
    await new DigitalProductionTaskService(database).reassign(actor(root,["root_superuser"]),published.taskId!,clerkId,randomUUID());
    await execute.check(actor(clerkId,["development_clerk"]),id,{taskId:published.taskId!,result:"缺项退回",note:"TEST count differs",items:[{materialId,physical:true,quantity:false,color:true,specification:true}]},randomUUID());
    expect((await receivedDevelopmentAccessories(database,id,1,document)).has(materialId)).toBe(true);
    expect((await database.query("SELECT count(*)::int n FROM digital_development_notices WHERE source_id=$1 AND material_id=$2",[id,materialId])).rows[0].n).toBe(1);
  });
  it("uses a global fixed cutter without allowing per-order dispatch and preserves idempotent setting history",async()=>{
    const id=await source(),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const tasks=new DigitalProductionTaskService(database),execute=new DevelopmentExecutionService(database,true),rootActor=actor(root,["root_superuser"]);
    const db=await database.connect();let cut:string;try{await db.query("BEGIN");cut=(await tasks.createWithClient(db,rootActor,{resource:{kind:"source",id},kind:"development_cutting",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null})).taskId;await db.query("COMMIT");}finally{db.release();}
    const input={expectedVersion:0,assigneeId:other,reason:"TEST fixed cutting"},key=randomUUID();
    await expect(execute.configureFixedCutting(actor(root,["development_clerk"]),id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(tasks.reassign(rootActor,cut,other,randomUUID())).rejects.toThrow("固定人员");
    const first=await execute.configureFixedCutting(rootActor,id,input,key);
    expect(await execute.configureFixedCutting(rootActor,id,input,key)).toEqual(first);
    expect((await tasks.read(rootActor,cut)).assigneeId).toBe(other);
    await expect(execute.configureFixedCutting(rootActor,id,input,randomUUID())).rejects.toThrow("已更新");
    expect((await database.query("SELECT count(*)::int n FROM digital_development_fixed_cutting")).rows[0].n).toBe(1);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'owner_group')",[other]);
    // Other cases may already seed this role. Build the invalid state explicitly;
    // a valid active owner must retain the approved configuration authority.
    const priorRole=(await database.query("SELECT enabled FROM business_roles WHERE role_code='owner_group'")).rows[0];
    await database.query("INSERT INTO business_roles(role_code,enabled) VALUES('owner_group',false) ON CONFLICT(role_code) DO UPDATE SET enabled=false");
    try{
      await expect(execute.configureFixedCutting(actor(other,["owner_group"]),id,{...input,expectedVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});
      expect((await database.query("SELECT count(*)::int n FROM digital_development_fixed_cutting")).rows[0].n).toBe(1);
      await database.query("UPDATE business_roles SET enabled=true WHERE role_code='owner_group'");
      await execute.configureFixedCutting(actor(other,["owner_group"]),id,{...input,expectedVersion:1},randomUUID());
      expect((await database.query("SELECT max(version) n FROM digital_development_fixed_cutting")).rows[0].n).toBe(2);
    }finally{
      if(priorRole)await database.query("UPDATE business_roles SET enabled=$1 WHERE role_code='owner_group'",[priorRole.enabled]);
      else await database.query("DELETE FROM business_roles WHERE role_code='owner_group'");
    }
  });
  it("records external pattern request to receipt in a supervisor task without gating development",async()=>{
    const supervisor=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST supervisor',true)",[supervisor]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_supervisor')",[supervisor]);
    const manager=actor(supervisor,['pattern_room_supervisor']),execute=new DevelopmentExecutionService(database,true);
    const id=await source(),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const input={action:'request' as const,roundNumber:1,note:'TEST requested'},key=randomUUID();
    await expect(execute.externalPattern(actor(),id,input,randomUUID())).rejects.toMatchObject({statusCode:403});
    // Real route/schema/service/PostgreSQL connection; authentication identity is an isolated fixture.
    const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;reply.code(value.statusCode??500).send({message:value.message});});
    registerDevelopmentExecutionRoutes(app,{service,creationEnabled:true,authenticate:async token=>{
      if(!['TEST-supervisor','TEST-designer'].includes(token??''))throw new ApplicationError('UNAUTHORIZED','请登录',401);
      return {id:token==='TEST-supervisor'?supervisor:designer,displayName:'TEST',businessRoles:token==='TEST-supervisor'?['pattern_room_supervisor']:['sample_designer'],capabilities:['digital_production:view']};
    }},execute,undefined as never);
    let requested:{requestId:string;taskId:string};
    try{
      const url=`/digital-production/sources/${id}/execution/external-pattern`;
      expect((await app.inject({method:'POST',url,payload:input,headers:{'idempotency-key':key}})).statusCode).toBe(401);
      expect((await app.inject({method:'POST',url,payload:input,headers:{cookie:'dx_rework_session=TEST-designer','idempotency-key':key}})).statusCode).toBe(403);
      const response=await app.inject({method:'POST',url,payload:input,headers:{cookie:'dx_rework_session=TEST-supervisor','idempotency-key':key}});
      expect(response.statusCode).toBe(200);requested=response.json();
    }finally{await app.close();}
    expect(await execute.externalPattern(manager,id,input,key)).toEqual(requested);
    const task=await new DigitalProductionTaskService(database).read(manager,requested.taskId);
    expect(task.state).toBe('ready');expect(task.slaHours).toBe(48);expect(task.assigneeId).toBe(supervisor);
    expect(Date.parse(task.dueAt!)-Date.parse(task.enteredAt!)).toBe(48*3600000);
    expect((await database.query('SELECT count(*)::int n FROM digital_production_task_dependencies WHERE predecessor_id=$1 OR task_id=$1',[requested.taskId])).rows[0].n).toBe(0);
    await expect(execute.externalPattern(manager,id,input,randomUUID())).rejects.toThrow('已经记录请求');
    const file=randomUUID();await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at)
      VALUES($1,$2,'TEST external.pdf','application/pdf',12,$3,$4,'ready',CURRENT_TIMESTAMP)`,[file,`test/${file}`,'e'.repeat(64),supervisor]);
    const receipt={action:'receive' as const,requestId:requested.requestId,attachmentIds:[file],note:'TEST received'};
    await expect(execute.externalPattern(manager,id,receipt,randomUUID())).rejects.toThrow('附件用途不符');
    await execute.recordUploadPurpose(manager,id,file,'外部纸样');
    const receiveKey=randomUUID();await execute.externalPattern(manager,id,receipt,receiveKey);await execute.externalPattern(manager,id,receipt,receiveKey);
    expect((await new DigitalProductionTaskService(database).read(manager,requested.taskId)).state).toBe('completed');
    expect((await database.query("SELECT count(*)::int n FROM digital_production_task_events WHERE event_kind='external_pattern_received' AND payload->>'requestId'=$1",[requested.requestId])).rows[0].n).toBe(1);
    expect(await development.canDownload(actor(),id,file)).toBe(true);
    expect((await database.query("SELECT state FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_materials'",[id])).rows[0].state).not.toBe('completed');
    const db=await database.connect();try{await db.query('BEGIN');await projectDevelopmentNotices(db,[actor(),manager,actor(other)]);await projectDevelopmentNotices(db,[actor(),manager,actor(other)]);await db.query('COMMIT');}finally{db.release();}
    const recipients=(await database.query(`SELECT r.recipient_id FROM digital_production_notification_receipts r
      JOIN digital_production_notification_events e ON e.event_id=r.event_id WHERE e.source_key=$1`,[`external-pattern-received:${requested.requestId}`])).rows.map(row=>row.recipient_id);
    expect(recipients).toEqual([designer]);
    await expect(database.query("UPDATE digital_production_task_events SET occurred_at=CURRENT_TIMESTAMP WHERE event_id=$1",[requested.requestId])).rejects.toThrow();
    expect((await database.query('SELECT count(*)::int n FROM digital_development_external_patterns WHERE source_id=$1',[id])).rows[0].n).toBe(0);
    const another=await execute.externalPattern(manager,id,input,randomUUID()) as {requestId:string;taskId:string};
    expect(another.requestId).not.toBe(requested.requestId);
    expect((await new DigitalProductionTaskService(database).read(manager,another.taskId)).state).toBe('ready');
    const evidence=await developmentSlaEvidence(database,id,{now:new Date(Date.now()+1000).toISOString(),scenarioId:"isolated-development-fixture",revision:1});
    expect(evidence!.facts.external_pattern?.completedAt).toBeUndefined();
    expect(evidence!.facts.external_pattern?.evidence).toContain(another.taskId);
  });

  it("creates an independent numbered customer revision without copying completion, receipt, shipment or customer quantity",async()=>{
    const id=await source(),doc=await ready(),materialId=randomUUID();
    doc.materials=[{materialId,category:'辅料',label:'纽扣',supplier:'',name:'纽扣',width:'',weight:'',composition:'',consumption:'',color:'黑',specification:'18L',quantity:'1',requiredThisRound:true,available:true,expectedDate:'2026-10-24'}];
    const saved=await development.save(actor(),id,{expectedVersion:0,document:doc},randomUUID());
    const original=await development.publish(actor(),id,saved.version,randomUUID());
    const beforeTasks=(await database.query('SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY task_id',[id])).rows;
    const rounds=new DevelopmentRoundService(database,true),revision:DevelopmentRevision={basedOnRound:1,document:original.document!,origin:'客户新增要求',customerComment:'TEST 领口加宽',internalProblem:'',explanation:'TEST customer request',categories:['尺寸'],affectedNodes:['纸样','裁板','车板'],outputKind:'整件样板'};
    await expect(rounds.save(actor(other),id,{expectedDraftVersion:0,revision},randomUUID())).rejects.toThrow();
    const draft=await rounds.save(actor(),id,{expectedDraftVersion:0,revision},randomUUID());
    const input={expectedDraftVersion:draft.draftVersion,basedOnRound:1},key=randomUUID();
    const outcomes=await Promise.allSettled([rounds.publish(actor(),id,input,key),rounds.publish(actor(),id,input,key)]);
    expect(outcomes.every(row=>row.status==='fulfilled')).toBe(true);
    const created=(outcomes[0] as PromiseFulfilledResult<{sourceId:string}>).value;
    expect((outcomes[1] as PromiseFulfilledResult<unknown>).value).toEqual(created);
    expect(created.sourceId).not.toBe(id);
    const fresh=await development.read(actor(),created.sourceId);
    expect(fresh.status).toBe('draft');expect(fresh.publishedAt).toBeNull();expect(fresh.taskId).toBeNull();expect(fresh.productionOrderId).toBeNull();
    expect(fresh.designStyleNo).toContain('复版1');expect(fresh.revisionSource).toMatchObject({rootSourceId:id,parentSourceId:id,revisionNumber:1,customerComment:'TEST 领口加宽',categories:['尺寸']});
    expect(fresh.document!.customerOrderDraft).toBeUndefined();expect(fresh.materialEvents).toHaveLength(0);
    expect(fresh.document!.materials[0]).toMatchObject({available:false,expectedDate:null});expect(fresh.document!.materials[0]!.materialId).not.toBe(materialId);
    expect((await database.query('SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1',[created.sourceId])).rows[0].n).toBe(0);
    expect((await database.query('SELECT t.* FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 ORDER BY task_id',[id])).rows).toEqual(beforeTasks);
    expect(await development.read(actor(),id)).toMatchObject({version:original.version,roundNumber:1});
    expect(await development.canDownload(actor(),created.sourceId,doc.files[0]!.attachmentId)).toBe(true);
    await expect(development.canDownload(actor(other),created.sourceId,doc.files[0]!.attachmentId)).rejects.toThrow();
    expect((await database.query('SELECT entity_id FROM attachments WHERE attachment_id=$1',[doc.files[0]!.attachmentId])).rows[0].entity_id).toBe(id);
    const unrelated=await source();expect(await development.canDownload(actor(),unrelated,doc.files[0]!.attachmentId)).toBe(false);
    await development.save(actor(),created.sourceId,{expectedVersion:fresh.version,document:fresh.document!},randomUUID());
    const secondDraft=await rounds.save(actor(),id,{expectedDraftVersion:0,revision},randomUUID());
    const second=await rounds.publish(actor(),id,{expectedDraftVersion:secondDraft.draftVersion,basedOnRound:1},randomUUID());
    expect((await development.read(actor(),second.sourceId)).designStyleNo).toContain('复版2');
    expect((await database.query('SELECT count(*)::int n FROM digital_production_orders WHERE source_id=ANY($1::uuid[])',[[created.sourceId,second.sourceId]])).rows[0].n).toBe(0);
  });
  it("keeps a new independent craft-piece revision free of garment sewing and old completion facts",async()=>{
    const id=await source(),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    const original=await development.publish(actor(),id,saved.version,randomUUID()),rounds=new DevelopmentRoundService(database,true);
    const revision:DevelopmentRevision={basedOnRound:1,document:{...original.document!,craft:'印花'},origin:'未达原要求',customerComment:'TEST 印花色差，先做布片',internalProblem:'',explanation:'',categories:['工艺'],affectedNodes:['工艺'],outputKind:'工艺布片'};
    const draft=await rounds.save(actor(),id,{expectedDraftVersion:0,revision},randomUUID());
    const created=await rounds.publish(actor(),id,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
    const fresh=await development.read(actor(),created.sourceId);
    const realForms=new DigitalDevelopmentService(database,true);
    await realForms.publish(actor(),created.sourceId,fresh.version,randomUUID());
    const plan=await developmentSlaPlan(database,created.sourceId);
    expect(plan.route_nodes).toContain('development_printing');expect(plan.route_nodes).not.toContain('development_sewing');expect(plan.route_nodes).not.toContain('development_tail_check');
    expect(plan.plan_json.nodes.find((n:{id:string})=>n.id==='development_sewing').applicable).toBe('no');
    expect((await database.query('SELECT count(*)::int n FROM digital_development_pattern_links WHERE source_id=$1',[created.sourceId])).rows[0].n).toBe(0);
    expect((await database.query('SELECT count(*)::int n FROM digital_development_route_facts WHERE source_id=$1',[created.sourceId])).rows[0].n).toBe(0);
  });

  it("keeps pending development policy frozen when the old settings entry publishes a new standard",async()=>{
    const id=await source(),before=await developmentSlaPlan(database,id),saved=await development.save(actor(),id,{expectedVersion:0,document:await ready()},randomUUID());
    await development.publish(actor(),id,saved.version,randomUUID());
    const tasks=new DigitalProductionTaskService(database),leader=actor(root,["owner_group"]);
    const client=await database.connect();
    let taskId:string;
    try {
      await client.query("BEGIN");
      taskId=(await tasks.createWithClient(client,leader,{resource:{kind:"source",id},kind:"development_pattern",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null})).taskId;
      await client.query("COMMIT");
    } catch(error) {await client.query("ROLLBACK");throw error;} finally {client.release();}
    const policies=await tasks.policies(leader),policy=policies.find(p=>p.nodeKey==="development_pattern")!;
    expect(policy.applicationScope).toBe("new_orders");
    const input={expectedVersion:policy.version,slaHours:60,warningRatio:0.7,note:"only later orders"},key=`legacy-${randomUUID()}`;
    const changed=await tasks.changePolicy(leader,"development_pattern",input,key);
    expect(changed).toMatchObject({scope:"new_orders",affectedTasks:0});
    expect(await tasks.changePolicy(leader,"development_pattern",input,key)).toEqual(changed);
    await expect(tasks.changePolicy(actor(),"development_pattern",input,randomUUID())).rejects.toMatchObject({statusCode:403});
    await expect(tasks.changePolicy(leader,"development_pattern",input,randomUUID())).rejects.toMatchObject({statusCode:409});
    const read=await tasks.read(leader,taskId);
    expect(read.slaHours).toBe(before.parameters_json.development_pattern.value.minutes/60);
    expect((await developmentSlaPlan(database,await source())).parameters_json.development_pattern.value.minutes).toBe(3600);
  });

  // Source-to-order correction coverage runs on the complete native schema in development-technical-postgres.test.ts.
  it.each(['before','after'] as const)('keeps historical and enrolled tail policies frozen when the legacy task is created %s a default change',async timing=>{
    const legacySourceId=legacyPolicySources.get(timing)!;
    const leader=actor(root,['root_superuser']),tasks=new DigitalProductionTaskService(database);
    const createTail=async(id:string)=>{
      const client=await database.connect();
      try{
        await client.query('BEGIN');
        const task=await tasks.createWithClient(client,leader,{resource:{kind:'source',id},kind:'development_tail_check',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null});
        // Readiness alone does not prove an actual completion/start time.
        await tasks.setConditionWithClient(client,leader,task.taskId,'washing_finished',true,null);
        await client.query('COMMIT');return task.taskId;
      }catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
    };
    const history=async(id:string)=>(await database.query('SELECT * FROM digital_production_deadline_revisions WHERE task_id=$1 ORDER BY revision_id',[id])).rows;
    let legacyTaskId=timing==='before'?await createTail(legacySourceId):null;
    const earlierHistory=legacyTaskId?await history(legacyTaskId):null;
    // Explicitly initialize/read the standard in this case, even when run without the preceding cases.
    const enrolledId=await source(),frozenPlan=await developmentSlaPlan(database,enrolledId);
    const frozenConfig=(await database.query('SELECT * FROM digital_sla_configurations WHERE configuration_id=$1',[frozenPlan.configuration_id])).rows[0];
    const frozenTail=frozenConfig.policy_refs_json.policies.development_tail_check;
    const oldPolicies=(await database.query("SELECT * FROM digital_production_deadline_policies WHERE node_key='development_tail_check' ORDER BY version")).rows;
    const policy=(await tasks.policies(leader)).find(row=>row.nodeKey==='development_tail_check')!;
    const nextHours=policy.slaHours!+0.5;
    const changed=await tasks.changePolicy(leader,'development_tail_check',{expectedVersion:policy.version,slaHours:nextHours,warningRatio:policy.warningRatio,note:'TEST only later sources'},randomUUID());
    expect(changed).toMatchObject({scope:'new_orders',affectedTasks:0});
    legacyTaskId??=await createTail(legacySourceId);
    const enrolledTaskId=await createTail(enrolledId);
    const nextId=await source(),nextPlan=await developmentSlaPlan(database,nextId),nextTaskId=await createTail(nextId);
    expect(await tasks.read(leader,legacyTaskId)).toMatchObject({state:'ready',slaHours:4,policyVersion:1,enteredAt:null,dueAt:null});
    expect(await tasks.read(leader,enrolledTaskId)).toMatchObject({state:'ready',slaHours:frozenPlan.parameters_json.development_tail_check.value.minutes/60,policyVersion:frozenTail.version,enteredAt:null,dueAt:null});
    expect(await tasks.read(leader,nextTaskId)).toMatchObject({state:'ready',slaHours:nextHours,policyVersion:changed.version,enteredAt:null,dueAt:null});
    expect(nextPlan.configuration_id).not.toBe(frozenPlan.configuration_id);
    expect(nextPlan.parameters_json.development_tail_check.value).toEqual({kind:'duration',minutes:nextHours*60});
    expect(await developmentSlaPlan(database,legacySourceId)).toBeNull();
    expect(await developmentSlaPlan(database,enrolledId)).toEqual(frozenPlan);
    expect((await database.query('SELECT * FROM digital_sla_configurations WHERE configuration_id=$1',[frozenPlan.configuration_id])).rows).toEqual([frozenConfig]);
    expect((await database.query("SELECT * FROM digital_production_deadline_policies WHERE node_key='development_tail_check' ORDER BY version")).rows.slice(0,oldPolicies.length)).toEqual(oldPolicies);
    expect((await history(legacyTaskId)).map(row=>row.policy_version)).toEqual([1]);
    if(earlierHistory)expect(await history(legacyTaskId)).toEqual(earlierHistory);
    expect((await database.query(`SELECT s.created_at<c.created_at AS historical,
      t.created_at>c.created_at AS delayed FROM digital_production_sources s
      CROSS JOIN digital_sla_configurations c CROSS JOIN digital_production_tasks t
      WHERE s.source_id=$1 AND c.version=$2 AND t.task_id=$3`,[legacySourceId,changed.configurationVersion,enrolledTaskId])).rows).toEqual([{historical:true,delayed:true}]);
    await expect(tasks.read(actor(other),legacyTaskId)).rejects.toMatchObject({statusCode:404});
  });
});
