import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DevelopmentDocumentSchema, type DevelopmentDocument } from "@dx-rework/contracts/digital-development";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("P06 development execution PostgreSQL", () => {
  const schema = ownedPostgresSchema("development_execution");
  const admin = new pg.Pool({connectionString:databaseUrl!});
  const database = new pg.Pool({connectionString:databaseUrl!,options:`-c search_path=${schema}`});
  const designer=randomUUID(), other=randomUUID(), root=randomUUID();
  const actor=(id=designer,roles=["sample_designer"]):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:"pattern_room:orders:create",authorizationCapabilities:["pattern_room:orders:create","todo:view"],requestId:"P05"});
  const execution=new DevelopmentExecutionService(database,true), tasks=new DigitalProductionTaskService(database);
  const service=new DigitalProductionIdentityService(database,true), development=new DigitalDevelopmentService(database,true);
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
    await database.query(await readFile(new URL("../../apps/api/migrations/0222_digital_development_documents.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0223_digital_development_execution.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0224_digital_development_route.sql", import.meta.url), "utf8"));
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'development_clerk'),($2,'pattern_room_worker')",[root,other]);
  });

  afterAll(async()=>{await database.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
  const source=async()=> (await service.createSource(actor(),{developmentType:"头版",designStyleNo:`TEST-P05-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
  const draft=():DevelopmentDocument=>DevelopmentDocumentSchema.parse({template:"上衣",quantity:null,sampleSize:"",orderDate:null,returnDate:null,unit:"cm",sizes:["M"],measurements:[{name:"胸围",values:[""]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"免洗",materials:[],files:[]});
  const ready=async()=>{
    const doc=draft(),id=randomUUID();
    await database.query(`INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$4,'test.png','image/png',100,$2,$3,'ready',CURRENT_TIMESTAMP)`,[id,"a".repeat(64),designer,`test/${id}`]);
    return {...doc,quantity:1,sampleSize:"M",orderDate:"2026-09-30",files:[{attachmentId:id,kind:"款图" as const}]};
  };

  const clerk=()=>actor(root,["development_clerk"]),worker=()=>actor(other,["pattern_room_worker"]),boss=()=>actor(root,["root_superuser"]);
  const prepare=async(missing=false,craft:"无"|"印花"="无")=>{
    const id=await source(),document=await ready(),materialId=randomUUID();document.craft=craft;
    document.materials=[{materialId,category:"主布",label:"主布A",supplier:"",name:"棉布",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"",quantity:"1",requiredThisRound:true,available:!missing,expectedDate:null}];
    const draft=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    const sheet=await development.publish(actor(),id,draft.version,randomUUID());
    await execution.dispatch(clerk(),id,{expectedVersion:0,patternWorkerId:other,cuttingWorkerId:other,sewingWorkerId:other},randomUUID());
    return {id,materialId,taskId:sheet.taskId!,version:sheet.version};
  };
  const checks=(materialId:string,physical=true)=>[{materialId,physical,quantity:true,color:true,specification:true}];
  it("preassigns without starting clocks, rejects main-material bypass, then activates only paper before cutting",async()=>{
    const {id,taskId,materialId}=await prepare();
    expect((await execution.read(clerk(),id)).tasks).toHaveLength(1);
    await expect(execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId,false)},randomUUID())).rejects.toMatchObject({statusCode:409});
    await execution.check(clerk(),id,{taskId,result:"通过",note:"核配并交纸样",items:checks(materialId)},randomUUID());
    const state=await execution.read(worker(),id),paper=state.tasks.find(t=>t.taskKind==="development_pattern")!,cut=state.tasks.find(t=>t.taskKind==="development_cutting")!;
    expect(paper).toMatchObject({state:"ready",slaHours:48});expect(cut).toMatchObject({state:"pending",enteredAt:null});
    await expect(execution.complete(worker(),id,{taskId:cut.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:409});
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"纸样完成并交出",attachmentIds:[]},randomUUID());
    expect(await tasks.read(worker(),cut.taskId)).toMatchObject({state:"ready",slaHours:4});
    await execution.complete(worker(),id,{taskId:cut.taskId,note:"裁板交出",attachmentIds:[]},randomUUID());
    expect((await execution.read(worker(),id)).facts.map(f=>f.kind)).toEqual(["核配通过","纸样完成","裁板完成"]);
  });
  it("keeps failed feedback out of production progress and gives recheck no extra 4h",async()=>{
    const {id,taskId,materialId,version}=await prepare(true);
    await execution.check(clerk(),id,{taskId,result:"缺项退回",note:"主布实物未到",items:checks(materialId,false)},randomUUID());
    const supply=(await execution.read(actor(),id)).tasks.find(t=>t.taskKind==="development_material_supply")!;
    expect(supply.routeProgress.completed).toBe(0);
    await expect(execution.resubmit(actor(),id,supply.taskId,randomUUID())).rejects.toMatchObject({statusCode:409});
    await development.materialEvent(actor(),id,materialId,{expectedMaterialRevision:0,expectedVersion:version,action:"到货",expectedDate:null,note:"主料实物已到"},randomUUID());
    await execution.resubmit(actor(),id,supply.taskId,randomUUID());
    const recheck=(await execution.read(clerk(),id)).tasks.find(t=>t.taskKind==="development_material_recheck")!;
    expect(recheck).toMatchObject({state:"ready",slaHours:null,dueAt:null});
    expect((await tasks.read(clerk(),taskId)).slaHours).toBe(4);
    await execution.check(clerk(),id,{taskId:recheck.taskId,result:"通过",note:"缺项已补",items:checks(materialId)},randomUUID());
  });
  it("requires craft sample before paper completion and rejects unrelated operators",async()=>{
    const {id,taskId,materialId}=await prepare(false,"印花");await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    await expect(execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toThrow("工艺开发板");
    await expect(execution.complete(actor(),id,{taskId:paper.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:404});
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'工艺.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"a".repeat(64),other]);
    await execution.recordUploadPurpose(worker(),id,file,"工艺开发板");
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[file]},randomUUID());
    expect(await development.canDownload(actor(),id,file)).toBe(true);
  });
  it("requires director decision for unsafe fabric, even if a later report says normal",async()=>{
    const {id,taskId,materialId}=await prepare();const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'检测.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"a".repeat(64),root]);
    await execution.recordUploadPurpose(boss(),id,file,"面料报告");
    const report=await execution.report(boss(),id,{recommendation:"建议停用",note:"缩水异常",attachmentIds:[file]},randomUUID()) as {reportId:string};
    await execution.report(boss(),id,{recommendation:"正常",note:"另一样品正常",attachmentIds:[file]},randomUUID());
    await expect(execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID())).rejects.toThrow("供应链总监");
    await expect(execution.decideFabric(clerk(),id,{reportId:report.reportId,decision:"允许使用",note:"不能自行决定"},randomUUID())).rejects.toMatchObject({statusCode:403});
    await execution.decideFabric(boss(),id,{reportId:report.reportId,decision:"允许使用",note:"已确认可用范围"},randomUUID());
    await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
  });
  it("never accepts a fabric report as the paper craft-board attachment",async()=>{
    const {id,taskId,materialId}=await prepare(false,"印花");
    await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(task=>task.taskKind==="development_pattern")!;
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'报告.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"a".repeat(64),other]);
    await execution.recordUploadPurpose(worker(),id,file,"面料报告");
    await expect(execution.complete(worker(),id,{taskId:paper.taskId,note:"误用报告",attachmentIds:[file]},randomUUID())).rejects.toThrow("附件用途不符");
    expect((await tasks.read(worker(),paper.taskId)).state).toBe("ready");
    await execution.report(worker(),id,{recommendation:"正常",note:"正确提交报告",attachmentIds:[file]},randomUUID());
    await expect(execution.recordUploadPurpose(worker(),id,file,"工艺开发板")).rejects.toMatchObject({statusCode:409});
  });
  it("lets only the linked active primary merchandiser follow up fabric reports",async()=>{
    const {id}=await prepare(),primary=randomUUID(),unrelated=randomUUID();
    for(const person of [primary,unrelated]){
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'跟单验收',true)",[person]);
      await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'order_merchandiser')",[person]);
    }
    const sheet=await development.read(boss(),id);
    await service.createOrder(boss(),{customerCode:"PD",productGroup:"男装",designStyleNo:sheet.designStyleNo,temporaryStyleNo:null,orderDate:"2026-09-30",contractDeliveryDate:null,primaryMerchandiserId:primary,lines:[{poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:"黑",colorForeign:null,deliveryDate:null,sizes:[{size:"M",quantity:1}]}]},randomUUID(),id);
    const merchant=actor(primary,["order_merchandiser"]),outsider=actor(unrelated,["order_merchandiser"]);
    expect((await execution.read(merchant,id)).canReportFabric).toBe(true);
    expect((await development.read(merchant,id)).canEdit).toBe(false);
    await execution.authorizeUpload(merchant,id);
    await expect(execution.read(outsider,id)).rejects.toMatchObject({statusCode:404});
    await expect(execution.authorizeUpload(outsider,id)).rejects.toMatchObject({statusCode:404});
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'跟单报告.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"a".repeat(64),primary]);
    await execution.recordUploadPurpose(merchant,id,file,"面料报告");
    await execution.report(merchant,id,{recommendation:"正常",note:"主跟单跟进",attachmentIds:[file]},randomUUID());
    await database.query("UPDATE user_role_assignments SET revoked_at=CURRENT_TIMESTAMP WHERE user_id=$1",[primary]);
    await expect(execution.authorizeUpload(merchant,id)).rejects.toMatchObject({statusCode:404});
  });

});
