import {taskResult} from "../helpers/development-task-result-fixture.js";
import * as snapshotReads from "../../apps/api/src/production-platform/journey-snapshot-reads.js";
import {minimumInitialCustomerDate} from "@dx-rework/contracts/digital-production";
import { applyDigitalPoDateFixture } from "../helpers/digital-po-date-fixture.js";
import { DigitalCockpitQuery } from "../../apps/api/src/production-platform/cockpit-query.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it,vi } from "vitest";
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
    await database.query(await readFile(new URL("../../apps/api/migrations/0221_digital_production_notifications.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0222_digital_development_documents.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0223_digital_development_execution.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0224_digital_development_route.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0244_development_sewing_result_attachments.sql", import.meta.url), "utf8"));
    await database.query(await readFile(new URL("../../apps/api/migrations/0245_development_pattern_result_attachments.sql", import.meta.url), "utf8"));
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
  const prepare=async(missing=false,craft:"无"|"印花"="无",preassign=true,additionalMaterials:DevelopmentDocument["materials"]=[])=>{
    const id=await source(),document=await ready(),materialId=randomUUID();document.craft=craft;
    document.materials=[{materialId,category:"主布",label:"主布A",supplier:"",name:"棉布",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"",quantity:"1",requiredThisRound:true,available:!missing,expectedDate:null},...additionalMaterials];
    const draft=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    const sheet=await development.publish(actor(),id,draft.version,randomUUID());
    if(preassign)await execution.dispatch(clerk(),id,{expectedVersion:0,patternWorkerId:other,cuttingWorkerId:other,sewingWorkerId:other},randomUUID());
    return {id,materialId,taskId:sheet.taskId!,version:sheet.version};
  };
  const checks=(materialId:string,physical=true)=>[{materialId,physical,quantity:true,color:true,specification:true}];
  it("R2 requires exact-task paper results even without craft and preserves the task on rejection",async()=>{
    const {id,taskId,materialId}=await prepare();await execution.check(clerk(),id,{taskId,result:'通过',note:'',items:checks(materialId)},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==='development_pattern')!;
    await expect(execution.complete(worker(),id,{taskId:paper.taskId,note:'',attachmentIds:[]},randomUUID())).rejects.toThrow('本任务成果');
    const file=await taskResult(database,execution,worker(),id,paper.taskId,'纸样成果');
    const another=await prepare();await execution.check(clerk(),another.id,{taskId:another.taskId,result:'通过',note:'',items:checks(another.materialId)},randomUUID());
    const otherPaper=(await execution.read(worker(),another.id)).tasks.find(t=>t.taskKind==='development_pattern')!;
    await expect(execution.complete(worker(),another.id,{taskId:otherPaper.taskId,note:'旧文件不可代替',attachmentIds:[file]},randomUUID())).rejects.toThrow('本轮纸样任务');
    expect((await tasks.read(worker(),otherPaper.taskId)).state).toBe('ready');
    const key=randomUUID(),input={taskId:paper.taskId,note:'合法本任务成果',attachmentIds:[file]};
    await execution.complete(worker(),id,input,key);await execution.complete(worker(),id,input,key);
    expect((await execution.read(worker(),id)).facts.filter(f=>f.kind==='纸样完成'&&f.taskId===paper.taskId)).toHaveLength(1);
  });
  it("keeps invalid saved workers pending instead of choosing another person",async()=>{
    const {id,taskId,materialId}=await prepare();
    await database.query('UPDATE app_users SET enabled=false WHERE id=$1',[other]);
    try {
      await execution.check(clerk(),id,{taskId,result:'通过',note:'失效人选应待安排',items:checks(materialId)},randomUUID());
      const state=await execution.read(boss(),id);
      for(const kind of ['development_pattern','development_cutting'])expect(state.tasks.find(t=>t.taskKind===kind)).toMatchObject({state:'pending',assigneeId:null,enteredAt:null});
    } finally {await database.query('UPDATE app_users SET enabled=true WHERE id=$1',[other]);}
  });
  it("accepts materials without preassignment and starts successor clocks only on authorized assignment",async()=>{
    const {id,taskId,materialId}=await prepare(false,"无",false);
    const input={taskId,result:"通过" as const,note:"TEST 无预派核料",items:checks(materialId)},key=randomUUID();
    const results=await Promise.all([execution.check(clerk(),id,input,key),execution.check(clerk(),id,input,key)]);
    expect(results[0]).toEqual(results[1]);
    const state=await execution.read(boss(),id),paper=state.tasks.find(t=>t.taskKind==="development_pattern")!,cut=state.tasks.find(t=>t.taskKind==="development_cutting")!;
    expect(state.tasks.find(t=>t.taskId===taskId)?.state).toBe("completed");
    expect(state.tasks.filter(t=>["development_pattern","development_cutting"].includes(t.taskKind))).toHaveLength(2);
    for(const task of [paper,cut])expect(task).toMatchObject({state:"pending",assigneeId:null,enteredAt:null,dueAt:null});
    expect(state.facts.filter(f=>f.kind==="核配通过")).toHaveLength(1);
    await expect(execution.check(clerk(),id,input,randomUUID())).rejects.toMatchObject({statusCode:409});
    await expect(tasks.read(worker(),paper.taskId)).rejects.toMatchObject({statusCode:404});
    await expect(tasks.reassign(worker(),paper.taskId,other,randomUUID())).rejects.toMatchObject({statusCode:403});
    const assignedAfter=Date.now();
    await tasks.reassign(boss(),paper.taskId,other,randomUUID());
    const assigned=await tasks.read(worker(),paper.taskId);
    expect(assigned).toMatchObject({state:"ready",assigneeId:other,slaHours:48});
    expect(new Date(assigned.enteredAt!).getTime()).toBeGreaterThanOrEqual(assignedAfter);
    await tasks.reassign(clerk(),paper.taskId,other,randomUUID());
    expect(await tasks.read(worker(),paper.taskId)).toMatchObject({enteredAt:assigned.enteredAt,dueAt:assigned.dueAt});
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"TEST 纸样完成",attachmentIds:[await taskResult(database,execution,worker(),id,paper.taskId,"纸样成果")]},randomUUID());
    expect(await tasks.read(boss(),cut.taskId)).toMatchObject({state:"pending",assigneeId:null,enteredAt:null});
    await tasks.reassign(boss(),cut.taskId,other,randomUUID());
    expect(await tasks.read(worker(),cut.taskId)).toMatchObject({state:"ready",slaHours:4});
    expect((await execution.read(boss(),id)).dispatch).toBeNull();
  });
  it("preassigns without starting clocks, rejects main-material bypass, then activates only paper before cutting",async()=>{
    const {id,taskId,materialId}=await prepare();
    expect((await execution.read(clerk(),id)).tasks).toHaveLength(1);
    await expect(execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId,false)},randomUUID())).rejects.toMatchObject({statusCode:409});
    await execution.check(clerk(),id,{taskId,result:"通过",note:"核配并交纸样",items:checks(materialId)},randomUUID());
    const state=await execution.read(worker(),id),paper=state.tasks.find(t=>t.taskKind==="development_pattern")!,cut=state.tasks.find(t=>t.taskKind==="development_cutting")!;
    expect(paper).toMatchObject({state:"ready",slaHours:48});expect(cut).toMatchObject({state:"pending",enteredAt:null});
    await expect(execution.complete(worker(),id,{taskId:cut.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:409});
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"纸样完成并交出",attachmentIds:[await taskResult(database,execution,worker(),id,paper.taskId,"纸样成果")]},randomUUID());
    expect(await tasks.read(worker(),cut.taskId)).toMatchObject({state:"ready",slaHours:4});
    await execution.complete(worker(),id,{taskId:cut.taskId,note:"裁板交出",attachmentIds:[]},randomUUID());
    expect((await execution.read(worker(),id)).facts.map(f=>f.kind)).toEqual(["核配通过","纸样完成","裁板完成"]);
  });
  it("assigns already-created waiting tasks through the existing authorized dispatch entry",async()=>{
    const {id,taskId,materialId}=await prepare(false,"无",false);
    await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
    await execution.dispatch(clerk(),id,{expectedVersion:0,patternWorkerId:other,cuttingWorkerId:other,sewingWorkerId:other},randomUUID());
    const state=await execution.read(boss(),id),paper=state.tasks.find(t=>t.taskKind==="development_pattern")!,cut=state.tasks.find(t=>t.taskKind==="development_cutting")!;
    expect(paper).toMatchObject({state:"ready",assigneeId:other});
    expect(cut).toMatchObject({state:"pending",assigneeId:other,enteredAt:null});
    expect(state.tasks.filter(t=>["development_pattern","development_cutting"].includes(t.taskKind))).toHaveLength(2);
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[await taskResult(database,execution,worker(),id,paper.taskId,"纸样成果")]},randomUUID());
    expect(await tasks.read(worker(),cut.taskId)).toMatchObject({state:"ready",assigneeId:other});
  });
  it("does not overwrite an existing task owner through first-time preassignment",async()=>{
    const {id,taskId,materialId}=await prepare(false,"无",false),replacement=randomUUID();
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'TEST replacement',true)",[replacement]);
    await database.query("INSERT INTO user_role_assignments(user_id,role_code) VALUES($1,'pattern_room_worker')",[replacement]);
    await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(boss(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    await tasks.reassign(boss(),paper.taskId,other,randomUUID());
    await expect(execution.dispatch(clerk(),id,{expectedVersion:0,patternWorkerId:replacement,cuttingWorkerId:other,sewingWorkerId:other},randomUUID())).rejects.toThrow("明确执行岗位改派");
    expect((await tasks.read(boss(),paper.taskId)).assigneeId).toBe(other);
    expect((await execution.read(boss(),id)).dispatch).toBeNull();
    const before=await tasks.read(boss(),paper.taskId);
    await execution.dispatch(clerk(),id,{expectedVersion:0,reassignExisting:true,patternWorkerId:replacement,cuttingWorkerId:other,sewingWorkerId:other},randomUUID());
    expect(await tasks.read(boss(),paper.taskId)).toMatchObject({assigneeId:replacement,enteredAt:before.enteredAt,dueAt:before.dueAt});

  });
  it.each([true,false])("keeps failed feedback out of production progress and gives recheck no extra 4h (preassigned=%s)",async(preassigned)=>{
    const {id,taskId,materialId,version}=await prepare(true,"无",preassigned);
    await execution.check(clerk(),id,{taskId,result:"缺项退回",note:"主布实物未到",items:checks(materialId,false)},randomUUID());
    const supply=(await execution.read(actor(),id)).tasks.find(t=>t.taskKind==="development_material_supply")!;
    expect(supply.routeProgress.completed).toBe(0);
    const cockpit=new DigitalCockpitQuery(database),input={page:1,search:'',stage:'development' as const};
    const returned=(await cockpit.list(boss(),input)).items.find(row=>row.sourceId===id)!;
    expect(returned.flow?.find(node=>node.key==='development_materials')).toMatchObject({state:'uncreated',taskId:null});

    await expect(execution.resubmit(actor(),id,supply.taskId,randomUUID())).rejects.toMatchObject({statusCode:409});
    await development.materialEvent(actor(),id,materialId,{expectedMaterialRevision:0,expectedVersion:version,action:"到货",expectedDate:null,note:"主料实物已到"},randomUUID());
    await execution.resubmit(actor(),id,supply.taskId,randomUUID());
    const recheck=(await execution.read(clerk(),id)).tasks.find(t=>t.taskKind==="development_material_recheck")!;
    expect(recheck).toMatchObject({state:"ready",slaHours:null,dueAt:null});
    const row=(await cockpit.list(boss(),input)).items.find(item=>item.sourceId===id)!;
    expect(row.flow?.find(node=>node.key==='development_materials')).toMatchObject({state:'ready',taskId:recheck.taskId});
    expect(row.tasks.find(task=>task.taskId===taskId)?.state).toBe('completed');

    expect((await tasks.read(clerk(),taskId)).slaHours).toBe(4);
    await execution.check(clerk(),id,{taskId:recheck.taskId,result:"通过",note:"缺项已补",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(boss(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    expect(paper.state).toBe(preassigned?"ready":"pending");
    if(!preassigned)expect(paper).toMatchObject({assigneeId:null,enteredAt:null,dueAt:null});
  });
  it("requires ordinary auxiliary checks even when its free name says zipper",async()=>{
    const id=await source(),document=await ready(),main=randomUUID(),secondary=randomUUID(),accessory=randomUUID();
    const material=(materialId:string,category:"主布"|"配布"|"辅料",label:string)=>({materialId,category,label,supplier:"",name:"测试材料",width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"",quantity:"1",requiredThisRound:true,available:true,expectedDate:null});
    document.materials=[material(main,"主布","自定义面料"),material(secondary,"配布","罗纹"),material(accessory,"辅料","拉链")];
    const saved=await development.save(actor(),id,{expectedVersion:0,document},randomUUID());
    const sheet=await development.publish(actor(),id,saved.version,randomUUID());
    const input={taskId:sheet.taskId!,result:"通过" as const,note:"",items:checks(main)};
    await expect(execution.check(clerk(),id,input,randomUUID())).rejects.toThrow("罗纹");
    await expect(execution.check(clerk(),id,{...input,items:[...checks(main),...checks(secondary)]},randomUUID())).rejects.toThrow("拉链");
    await execution.check(clerk(),id,{...input,items:[...checks(main),...checks(secondary),...checks(accessory)]},randomUUID());
    expect((await execution.read(boss(),id)).facts.filter(f=>f.kind==="核配通过")).toHaveLength(1);
  });
  const auxiliary=(auxiliaryKind:"普通辅料"|"拉链"|"扁机"="普通辅料")=>({materialId:randomUUID(),category:"辅料" as const,auxiliaryKind,label:auxiliaryKind,supplier:"",name:auxiliaryKind,width:"",weight:"",composition:"",consumption:"",color:"黑",specification:"规格A",quantity:"1",requiredThisRound:true,available:false,expectedDate:"2026-10-20"});
  it.each(["拉链","扁机"] as const)("keeps %s waiting at sewing and wakes only its material condition after arrival",async kind=>{
    const extra=auxiliary(kind),{id,taskId,materialId,version}=await prepare(true,"无",true,[extra]);
    await expect(execution.check(worker(),id,{taskId,result:"通过",note:"越权",items:[...checks(materialId),...checks(extra.materialId,false)]},randomUUID())).rejects.toMatchObject({statusCode:404});
    await expect(execution.check(clerk(),id,{taskId,result:"通过",note:"",items:[...checks(materialId),...checks(extra.materialId,false)]},randomUUID())).rejects.toThrow("缺项说明");
    await execution.check(clerk(),id,{taskId,result:"通过",note:"由设计师跟进缺料",items:[...checks(materialId),...checks(extra.materialId,false)]},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    await execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[await taskResult(database,execution,worker(),id,paper.taskId,"纸样成果")]},randomUUID());
    const cutting=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_cutting")!;
    await execution.complete(worker(),id,{taskId:cutting.taskId,note:"",attachmentIds:[]},randomUUID());
    const sewing=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_sewing")!;
    expect(sewing.state).toBe("pending");
    expect(sewing.unmetConditions.map(item=>item.name)).toEqual(expect.arrayContaining([kind,"车板执行衔接"]));
    const key=randomUUID(),input={expectedMaterialRevision:0,expectedVersion:version,action:"到货" as const,expectedDate:null,note:"TEST 实物到料"};
    await development.materialEvent(actor(),id,extra.materialId,input,key);
    await development.materialEvent(actor(),id,extra.materialId,input,key);
    const state=await execution.read(worker(),id);
    expect(state.tasks.filter(t=>t.taskKind==="development_sewing")).toHaveLength(1);
    expect(state.tasks.find(t=>t.taskId===sewing.taskId)!.unmetConditions.map(item=>item.name)).not.toContain(kind);
    expect(state.materialReadiness.filter(row=>row.required).every(row=>row.available)).toBe(true);
    expect((await database.query("SELECT satisfied FROM digital_production_task_conditions WHERE task_id=$1 AND condition_key='materials_ready'",[sewing.taskId])).rows[0].satisfied).toBe(true);
  });
  it("revokes material readiness on a stop report and restores the original clock after director approval",async()=>{
    const {id,taskId,materialId}=await prepare(true);
    await execution.check(clerk(),id,{taskId,result:"通过",note:"实物已核实",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'检测.pdf','application/pdf',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"b".repeat(64),other]);
    await execution.recordUploadPurpose(worker(),id,file,"面料报告");
    const report=await execution.report(worker(),id,{recommendation:"建议停用",note:"规格异常",attachmentIds:[file]},randomUUID()) as {reportId:string};
    const blocked=await tasks.read(worker(),paper.taskId);expect(blocked.state).toBe("blocked");expect(blocked.unmetConditions.some(row=>row.condition==="fabric_quality")).toBe(true);
    await expect(execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toThrow("完工条件");
    await expect(execution.decideFabric(clerk(),id,{reportId:report.reportId,decision:"允许使用",note:"越权"},randomUUID())).rejects.toMatchObject({statusCode:403});
    await execution.decideFabric(boss(),id,{reportId:report.reportId,decision:"允许使用",note:"TEST 已复核"},randomUUID());
    expect(await tasks.read(worker(),paper.taskId)).toMatchObject({state:"ready",enteredAt:paper.enteredAt,dueAt:paper.dueAt});
  });
  it("supplements an omitted legacy ordinary accessory without rewriting the old task or duplicating successors",async()=>{
    const extra=auxiliary(),{id,taskId,materialId}=await prepare(false,"无",true,[extra]);
    // Construct the old immutable fact in the isolated fixture; never update audit history.
    const db=await database.connect();try{
      await db.query("BEGIN");
      const origin=(await db.query("SELECT route_instance_id FROM digital_production_tasks WHERE task_id=$1",[taskId])).rows[0];
      await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'核配通过',$4,$5)",[randomUUID(),id,taskId,JSON.stringify({taskId,result:"通过",note:"旧版仅主配料",items:checks(materialId)}),root]);
      const paper=await tasks.createWithClient(db,clerk(),{resource:{kind:"source",id},authorizingTaskId:taskId,kind:"development_pattern",routeId:origin.route_instance_id,routeVersion:1,occurrence:1,assigneeId:other});
      await tasks.createWithClient(db,clerk(),{resource:{kind:"source",id},authorizingTaskId:taskId,kind:"development_cutting",routeId:origin.route_instance_id,routeVersion:1,occurrence:1,assigneeId:other,predecessors:[paper.taskId]});
      await tasks.setConditionWithClient(db,clerk(),paper.taskId,"materials_ready",true);
      await tasks.setConditionWithClient(db,clerk(),paper.taskId,"handover_received",true);
      await tasks.setConditionWithClient(db,clerk(),taskId,"business_recorded",true);
      await tasks.completeWithClient(db,clerk(),taskId,{note:"旧核验"},randomUUID());
      await db.query("COMMIT");
    }catch(error){await db.query("ROLLBACK");throw error;}finally{db.release();}
    const original=await tasks.read(clerk(),taskId),key=randomUUID();
    await expect(execution.supplementCheck(worker(),id,taskId,key)).rejects.toMatchObject({statusCode:404});
    const next=await execution.supplementCheck(clerk(),id,taskId,key) as {taskId:string};
    expect(await execution.supplementCheck(clerk(),id,taskId,key)).toEqual(next);
    await execution.check(clerk(),id,{taskId:next.taskId,result:"通过",note:"实际补核",items:[...checks(materialId),...checks(extra.materialId)]},randomUUID());
    const state=await execution.read(boss(),id);
    expect(state.tasks.filter(t=>t.taskKind==="development_pattern")).toHaveLength(1);
    expect(state.tasks.filter(t=>t.taskKind==="development_cutting")).toHaveLength(1);
    expect(await tasks.read(clerk(),taskId)).toMatchObject({completedAt:original.completedAt,enteredAt:original.enteredAt});
    expect(state.materialReadiness.every(row=>row.available)).toBe(true);
  });
  it("requires craft sample before paper completion and rejects unrelated operators",async()=>{
    const {id,taskId,materialId}=await prepare(false,"印花");await execution.check(clerk(),id,{taskId,result:"通过",note:"",items:checks(materialId)},randomUUID());
    const paper=(await execution.read(worker(),id)).tasks.find(t=>t.taskKind==="development_pattern")!;
    await expect(execution.complete(worker(),id,{taskId:paper.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toThrow("工艺开发板");
    await expect(execution.complete(actor(),id,{taskId:paper.taskId,note:"",attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:404});
    const file=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'工艺.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`test/${file}`,"a".repeat(64),other]);
    await execution.recordUploadPurpose(worker(),id,file,"纸样成果",paper.taskId);
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
    await service.createOrder(boss(),{customerCode:"PD",productGroup:"男装",designStyleNo:sheet.designStyleNo,temporaryStyleNo:null,orderDate:"2026-09-30",contractDeliveryDate:null,primaryMerchandiserId:primary,lines:[{poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:"黑",colorForeign:null,deliveryDate:minimumInitialCustomerDate(),sizes:[{size:"M",quantity:1}]}]},randomUUID(),id);
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

  it("R2 reuses material and policy reads only inside one actor's read-only snapshot",async()=>{
    const {id,taskId,materialId}=await prepare();
    await execution.check(clerk(),id,{taskId,result:"通过",note:"TEST snapshot",items:checks(materialId)},randomUUID());
    const statements:string[]=[];
    const measured={connect:async()=>{
      const client=await database.connect();
      return new Proxy(client,{get(target,key){
        if(key==='query')return (...args:unknown[])=>{if(typeof args[0]==='string')statements.push(args[0]);return Reflect.apply(target.query,target,args);};
        const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;
      }});
    }} as unknown as pg.Pool;
    const measuredExecution=new DevelopmentExecutionService(measured,true);
    const disabled=vi.spyOn(snapshotReads,'reuseJourneySnapshotReads').mockImplementation(client=>client);
    let baseline:Awaited<ReturnType<DevelopmentExecutionService['read']>>;
    try{baseline=await measuredExecution.read(boss(),id);}finally{disabled.mockRestore();}
    const baselineCount=statements.length;statements.length=0;
    const result=await measuredExecution.read(boss(),id);
    expect(result).toEqual(baseline!);expect(statements.length).toBeLessThan(baselineCount);
    expect(statements[0]).toBe('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');expect(statements.at(-1)).toBe('COMMIT');
    const optimizedCount=statements.length;
    const workerResult=await measuredExecution.read(worker(),id);
    expect(workerResult.tasks.some(task=>task.taskKind==='development_materials')).toBe(false);
    console.info(JSON.stringify({evidence:'R2 execution SQL count',baseline:baselineCount,optimized:optimizedCount}));
  });

});
