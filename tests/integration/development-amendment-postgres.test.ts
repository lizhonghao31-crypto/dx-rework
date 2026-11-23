import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {TodoProjectionService} from "../../apps/api/src/todos/projection-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {PatternRoomOrderService} from "../../apps/api/src/pattern-room/order-service.js";
import {DevelopmentDocumentSchema,developmentMakingSizes} from "@dx-rework/contracts/digital-development";
import Fastify from "fastify";
import {registerDevelopmentExecutionRoutes} from "../../apps/api/src/production-platform/development-execution-routes.js";
import {registerDevelopmentRoutes} from "../../apps/api/src/production-platform/development-routes.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import type {DingTalkProvider} from "../../apps/api/src/auth/provider.js";
import {EmployeeAccessService} from "../../apps/api/src/access/employee-access-service.js";
import {AccessMasterDataService} from "../../apps/api/src/access/service.js";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {beforeAll,afterAll,describe,it,expect} from "vitest";
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from "../helpers/owned-postgres-schema.js";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {DigitalProductionIdentityService} from "../../apps/api/src/production-platform/identity-service.js";
import {DigitalDevelopmentService} from "../../apps/api/src/production-platform/development-service.js";
import {DevelopmentExecutionService} from "../../apps/api/src/production-platform/development-execution-service.js";
import {DevelopmentAmendmentService} from "../../apps/api/src/production-platform/development-amendment-service.js";
import {DigitalProductionTaskService} from "../../apps/api/src/production-platform/task-service.js";
import {DigitalProductionNotificationService} from "../../apps/api/src/production-platform/notification-service.js";
import {materialReadiness} from "../../apps/api/src/production-platform/development-material-readiness.js";
import type {DevelopmentReturnIssue} from "@dx-rework/contracts/digital-development-amendments";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)("P02 same-round correction with real current schema",()=>{
 const schema=ownedPostgresSchema("development_amendment"),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const ids={designer:randomUUID(),clerk:randomUUID(),worker:randomUUID(),other:randomUUID(),supervisor:randomUUID(),director:randomUUID(),root:randomUUID()};
 const actor=(who:keyof typeof ids,roles?:string[]):TrustedActorContext=>({actorId:ids[who],actorRoles:roles??[who==="root"?"root_superuser":who==="clerk"?"development_clerk":who==="supervisor"?"pattern_room_supervisor":who==="director"?"production_management":who==="worker"?"pattern_room_worker":"sample_designer"],authorizationCapability:"digital_production:view",authorizationCapabilities:["digital_production:view","pattern_room:orders:create","todo:view"],requestId:"TEST-P02"});
 const employees=new EmployeeAccessService(db,"TEST",new AccessMasterDataService(db,"TEST"),undefined as never,undefined as never,{enabled:false,dingtalkUserId:undefined,secret:undefined},`TEST-${ids.root}`);
 const forms=new DigitalDevelopmentService(db,true),execution=new DevelopmentExecutionService(db,true),amendments=new DevelopmentAmendmentService(db,true),identity=new DigitalProductionIdentityService(db,true),tasks=new DigitalProductionTaskService(db),notices=new DigitalProductionNotificationService(db);
 beforeAll(async()=>{
  await createOwnedPostgresSchema(admin,schema);await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8"));
  const amendmentIndex=manifest.migrations.findIndex((row:{version:string})=>row.version==="0248_development_document_amendments");
  if(amendmentIndex<0)throw new Error("Missing development amendment migration");
  const migrate=async(rows:Array<{version:string;checksum:string}>)=>{for(const row of rows){await db.query(await readFile(new URL(`../../apps/api/migrations/${row.version}.sql`,import.meta.url),"utf8"));await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[row.version,row.checksum]);}};
  // Create the historical return before 0248, then upgrade in the real order.
  // Later migrations can depend on the amendment tables and must not run first.
  await migrate(manifest.migrations.slice(0,amendmentIndex));
  // Test-only identity bootstrap, before organization policy. All tested commands use actual service authorization.
  for(const who of Object.keys(ids) as Array<keyof typeof ids>){const id=ids[who];await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,`TEST ${who}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','TEST',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,`TEST-${id}`]);if(who!=="root")await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'P02 test bootstrap')",[randomUUID(),id,actor(who).actorRoles[0]]);}
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'TEST')",[ids.root,`TEST-${ids.root}`]);
  await new AccessMasterDataService(db,"TEST").ensureOrganizationPolicy();
  legacyReturns=[await prepareLegacyReturn(),await prepareLegacyReturn(),await prepareLegacyReturn()];
  await migrate(manifest.migrations.slice(amendmentIndex));
 },testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{try{await db.end();await releaseOwnedPostgresSchema(admin,schema);}finally{await admin.end();}});
 let legacyReturns:Array<Awaited<ReturnType<typeof prepareLegacyReturn>>>=[];
 const prepareLegacyReturn=async()=>{
  const source=await identity.createSource(actor("designer"),{designStyleNo:`TEST-LEGACY-${randomUUID()}`,temporaryStyleNo:null,customerCode:null,developmentType:"头版"},randomUUID()),sourceId=source.sourceId,materialId=randomUUID(),attachmentId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`TEST/${attachmentId}`,"a".repeat(64),ids.designer]);
  const document={...initialDevelopmentDocument(),quantity:1,sampleSize:"历史M",orderDate:"2026-09-01",materials:[{materialId,category:"主布" as const,label:"TEST旧主布",name:"TEST棉布",specification:"",quantity:"1",color:"黑",width:"",weight:"",composition:"",supplier:"",consumption:"",requiredThisRound:true,available:false,expectedDate:null}],files:[{attachmentId,kind:"款图" as const}]};
  delete document.documentFormatVersion;delete document.sizeQuantities;delete document.quotationMode;
  // Pre-0248 sources predate automatic quotations; do not inherit modern UI opt-in.
  expect(document.quotationMode).toBeUndefined();
  expect((await db.query("SELECT to_regclass('digital_quotation_documents') AS relation")).rows[0].relation).toBeNull();
  // Historical frozen-document fixture only; no schema/immutable guard is disabled. The return is made through the actual pre-0248 command below.
  const client=await db.connect();let taskId:string;try{await client.query("BEGIN");taskId=(await tasks.createWithClient(client,actor("root"),{resource:{kind:"source",id:sourceId},kind:"development_materials",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:ids.clerk})).taskId;await forms.bindFiles(client,actor("designer"),sourceId,document);await client.query("INSERT INTO digital_development_documents(source_id,version,status,document,published_at,task_id,updated_by) VALUES($1,2,'published',$2,CURRENT_TIMESTAMP,$3,$4)",[sourceId,JSON.stringify(document),taskId,ids.designer]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const entry={materialId,usage:"use" as const,physical:false,quantity:true,color:true,specification:true,note:"",confirmedWith:""},draft=await execution.saveMaterials(actor("clerk"),sourceId,{taskId:taskId!,expectedVersion:0,expectedDocumentVersion:2,entries:[entry],result:"缺项退回"},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),sourceId,{taskId:taskId!,expectedVerificationVersion:draft.version,result:"缺项退回",note:"TEST旧版实物未到，补齐后文员复核",items:[entry]},randomUUID());
  const supply=(await execution.read(actor("designer"),sourceId)).tasks.find(task=>task.taskKind==="development_material_supply"&&task.state==="ready")!;
  return {sourceId,materialId,document,supply};
 };
 const prepare=async(field:DevelopmentReturnIssue["field"]="specification",missing=false,withAux=false,need?:DevelopmentReturnIssue["need"],withOrder?:boolean,workbench=false)=>{
  const source=await identity.createSource(actor("designer"),{designStyleNo:`TEST-P02-${randomUUID()}`,temporaryStyleNo:null,customerCode:null,developmentType:"头版"},randomUUID()),sourceId=source.sourceId,materialId=randomUUID(),attachmentId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`TEST/${attachmentId}`,"a".repeat(64),ids.designer]);
  const order={customerCode:withOrder?"TEST":"",productGroup:"男装" as const,designStyleNo:(await forms.read(actor("designer"),sourceId)).designStyleNo,temporaryStyleNo:null,primaryMerchandiserId:null,orderDate:new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).format(new Date()),contractDeliveryDate:null,lines:[{formalPoNo:withOrder?"TEST-G1-PO":null,customerWarehouseArrivalDate:withOrder?"2099-12-31":null,poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:withOrder?"TEST黑":"",colorForeign:null,deliveryDate:null,sizes:[{size:withOrder?"M":"",quantity:withOrder?"100":""}]}]};
  const initial=initialDevelopmentDocument(),sizes=["M","L"];
  const document={...initial,...(withOrder===undefined?{}:{customerOrderDraft:{withOrder,order}}),sizes,measurements:initial.measurements.map(row=>({...row,values:sizes.map(()=>"")})),quantity:withOrder===undefined?1:2,sizeQuantities:withOrder===undefined?[1,0]:[1,1],sampleSize:"M",orderDate:null,materials:[...(withAux?[{materialId:randomUUID(),category:"主布" as const,label:"TEST主布",name:"TEST棉布",specification:"40支",quantity:"1",color:"黑",width:"",weight:"",composition:"",supplier:"",consumption:"",requiredThisRound:true,available:true,expectedDate:null}]:[]),{materialId,category:withAux?"辅料" as const:"主布" as const,...(withAux?{auxiliaryKind:"普通辅料" as const}:{}),label:withAux?"TEST辅料":"TEST主布",name:"TEST棉布",specification:"40支",quantity:"1",color:"黑",width:"",weight:"",composition:"",supplier:"",consumption:"",requiredThisRound:false,available:!missing,expectedDate:withAux&&missing?"2026-11-01":null}],files:[{attachmentId,kind:"款图" as const}]};
  const createDocument=workbench?await (async()=>{
   const attachments=await Promise.all(Array.from({length:5},async()=>{
    const id=randomUUID();
    await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[id,`TEST/${id}`,"b".repeat(64),ids.designer]);
    return {attachmentId:id,kind:"局部图" as const};
   }));
   const fabric={...document.materials[0]!,available:false,composition:"棉",width:"150 cm",supplier:"原布行",sampleAttachmentId:attachments[0]!.attachmentId};
   const materials=[fabric,...Array.from({length:19},(_,index)=>({...fabric,materialId:randomUUID(),name:`TEST 材料 ${index+2}`,category:index<7?"主布":"辅料",sampleAttachmentId:null}))];
   return DevelopmentDocumentSchema.parse({...document,materials,files:[...document.files,...attachments],stitchDensity:"原针距",
    workbenchSheet:{version:1,styleName:"长表",brand:"原品牌",gender:"男装",boardType:"头版",processingSelected:true,referenceNote:"原说明",sewingRows:[]}});
  })():document;
  expect(DevelopmentDocumentSchema.safeParse(createDocument).success).toBe(true);
  const saved=await forms.save(actor("designer"),sourceId,{expectedVersion:0,document:createDocument},randomUUID()),sheet=await forms.publish(actor("designer"),sourceId,saved.version,randomUUID()),checkTask=sheet.taskId!;
  const issues:DevelopmentReturnIssue[]=[{materialId,field,...(need?{need}:{}),reason:`TEST ${field}需核实`}];if(workbench)issues.push({materialId:null,field:"files",reason:"TEST 附件应改为有效的材料局部图"});if(missing&&field!=="physical")issues.push({materialId,field:"physical",reason:"TEST实物未到"});
  const entry={materialId,usage:"use" as const,physical:!missing,quantity:field!=="quantity",color:field!=="color",specification:field!=="specification",note:"",confirmedWith:""};
  const verification=await execution.saveMaterials(actor("clerk"),sourceId,{taskId:checkTask,expectedVersion:0,expectedDocumentVersion:sheet.version,entries:createDocument.materials.map(m=>m.materialId===materialId?entry:{...entry,materialId:m.materialId,physical:true,quantity:true,color:true,specification:true}),result:"缺项退回",returnIssues:issues},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),sourceId,{taskId:checkTask,expectedVerificationVersion:verification.version,result:"缺项退回",note:"TEST具体退回",returnIssues:issues,items:createDocument.materials.map(m=>({materialId:m.materialId,physical:m.materialId===materialId?entry.physical:true,quantity:m.materialId===materialId?entry.quantity:true,color:m.materialId===materialId?entry.color:true,specification:m.materialId===materialId?entry.specification:true}))},randomUUID());
  const supply=(await execution.read(actor("designer"),sourceId)).tasks.find(t=>t.taskKind==="development_material_supply"&&t.state==="ready")!;
  return {sourceId,materialId,supply,document,sheet};
 };
 const save=async(f:Awaited<ReturnType<typeof prepare>>,patch:Record<string,unknown>={specification:"42支"})=>{
  const context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId),document=structuredClone(context.document);Object.assign(document.materials[0]!,patch);
  const input={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:context.draft?.version??0,document,reason:"TEST按原退回字段补正"};return {input,saved:await amendments.save(actor("designer"),f.sourceId,input,randomUUID())};
 };

 const reopenInput=async(f:Awaited<ReturnType<typeof prepare>>)=>{
  const state=await execution.read(actor("clerk"),f.sourceId);return {taskId:f.sheet.taskId!,supplyTaskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:state.sheet.version,expectedVerificationVersion:state.materialVerification!.version,note:"TEST与设计师沟通后由文员重新确认用途"};
 };
 it("D08 B clerk retakes a returned task exactly once; old supply cannot override new use, and only recheck submits facts",async()=>{
  const f=await prepare("physical",true,true),input=await reopenInput(f),key=randomUUID();
  const before=await forms.read(actor("clerk"),f.sourceId),factsBefore=(await db.query("SELECT count(*)::int n FROM digital_development_execution_facts WHERE source_id=$1 AND kind='核配通过'",[f.sourceId])).rows[0].n;
  for(const who of ["designer","worker","supervisor"] as const)await expect(execution.reopenMaterials(actor(who),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:who==="worker"?404:403});
  await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,{...input,roundNumber:2},randomUUID())).rejects.toThrow("制作轮次");
  const other=await prepare("physical",true);await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,{...input,supplyTaskId:other.supply.taskId},randomUUID())).rejects.toThrow("不属于本轮");
  const [a,b]=await Promise.all([execution.reopenMaterials(actor("clerk"),f.sourceId,input,key),execution.reopenMaterials(actor("clerk"),f.sourceId,input,randomUUID())]) as Array<{taskId:string}>;expect(a).toEqual(b);expect(await execution.reopenMaterials(actor("clerk"),f.sourceId,input,key)).toEqual(a);
  expect((await tasks.read(actor("designer"),f.supply.taskId)).state).toBe("cancelled");
  expect((await db.query("SELECT count(*)::int n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind IN ('development_material_supply','development_material_recheck') AND t.state IN ('ready','pending','blocked')",[f.sourceId])).rows[0].n).toBe(1);
  expect((await notices.todos(actor("clerk"))).filter(t=>t.todoId===a!.taskId)).toHaveLength(1);expect((await notices.todos(actor("designer"))).some(t=>t.todoId===f.supply.taskId)).toBe(false);
  expect((await forms.read(actor("designer"),f.sourceId)).document).toEqual(before.document);expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(false);
  await expect(amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:before.version,expectedDraftVersion:0},randomUUID())).rejects.toThrow("已结束");
  await expect(execution.resubmit(actor("designer"),f.sourceId,f.supply.taskId,randomUUID())).rejects.toThrow("旧任务不能重复提交");
  const state=await execution.read(actor("clerk"),f.sourceId),entries=state.materialVerification!.entries.map(r=>({materialId:r.materialId,usage:r.materialId===f.materialId?"unused" as const:"use" as const,physical:r.materialId!==f.materialId,quantity:true,color:true,specification:true,note:r.materialId===f.materialId?"TEST确认本轮不用":"",confirmedWith:r.materialId===f.materialId?"TEST设计师":""}));
  const saved=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:a!.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries,returnIssues:[]},randomUUID()) as {version:number};
  expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(false);expect((await db.query("SELECT count(*)::int n FROM digital_development_execution_facts WHERE source_id=$1 AND kind='核配通过'",[f.sourceId])).rows[0].n).toBe(factsBefore);
  await execution.check(actor("clerk"),f.sourceId,{taskId:a!.taskId,expectedVerificationVersion:saved.version,result:"通过",note:"TEST文员提交重新核料",items:entries.filter(r=>r.usage==='use').map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
  expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(true);expect((await forms.read(actor("designer"),f.sourceId)).document).toEqual(before.document);
  expect((await db.query("SELECT count(*)::int n FROM digital_development_execution_facts WHERE source_id=$1 AND kind='缺项退回'",[f.sourceId])).rows[0].n).toBe(1);expect((await db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='development_material_reopen'",[f.sourceId])).rows[0].n).toBe(1);
 });
 it("D08 retains independent document issues on a mixed return even when the clerk now chooses unused",async()=>{
  const f=await prepare("specification",true,true),input=await reopenInput(f),next=await execution.reopenMaterials(actor("clerk"),f.sourceId,input,randomUUID()) as {taskId:string},state=await execution.read(actor("clerk"),f.sourceId);
  const entries=state.materialVerification!.entries.map(r=>({materialId:r.materialId,usage:r.materialId===f.materialId?"unused" as const:"use" as const,physical:r.materialId!==f.materialId,quantity:true,color:true,specification:r.materialId!==f.materialId,note:"TEST重新确认不用",confirmedWith:"TEST设计师"}));
  const saved=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries},randomUUID()) as {version:number},items=entries.filter(r=>r.usage==='use').map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}));
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"通过",note:"TEST不应绕过资料",items},randomUUID())).rejects.toThrow("资料缺错");
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"缺项退回",note:"TEST不应丢掉原缺错",returnIssues:[{materialId:null,field:"instructions",reason:"TEST另有问题"}],items},randomUUID())).rejects.toThrow("资料缺错");
  await execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"缺项退回",note:"TEST保留原规格问题",returnIssues:[{materialId:f.materialId,field:"specification",reason:"TEST仍待补正规格"}],items},randomUUID());
  expect((await execution.read(actor("designer"),f.sourceId)).tasks.filter(t=>t.taskKind==='development_material_supply'&&t.state==='ready')).toHaveLength(1);expect((await forms.read(actor("clerk"),f.sourceId)).version).toBe(f.sheet.version);
 });
 it("D08 known material mismatch cannot be waived by choosing unused or relabelled as a mere physical shortage",async()=>{
  const f=await prepare("color",true,true,"supply"),next=await execution.reopenMaterials(actor("clerk"),f.sourceId,await reopenInput(f),randomUUID()) as {taskId:string},state=await execution.read(actor("clerk"),f.sourceId),entries=state.materialVerification!.entries.map(r=>({materialId:r.materialId,usage:r.materialId===f.materialId?"unused" as const:"use" as const,physical:r.materialId!==f.materialId,quantity:true,color:r.materialId!==f.materialId,specification:true,note:"TEST用途变更",confirmedWith:"TEST设计师"}));
  const saved=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries},randomUUID()) as {version:number},items=entries.filter(r=>r.usage==='use').map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}));
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"通过",note:"TEST不应绕过已知不符",items},randomUUID())).rejects.toThrow("不符");
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"缺项退回",note:"TEST不能替换问题性质",returnIssues:[{materialId:f.materialId,field:"physical",reason:"TEST实物未到"}],items},randomUUID())).rejects.toThrow("不符");
  await execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"缺项退回",note:"TEST不用但保留原颜色不符",returnIssues:[{materialId:f.materialId,field:"color",need:"supply",reason:"TEST原颜色不符仍须更换"}],items},randomUUID());expect((await execution.read(actor("designer"),f.sourceId)).tasks.filter(t=>t.taskKind==='development_material_supply'&&t.state==='ready')).toHaveLength(1);
 });
 it("D08 quality stop is not waived by reopening, a draft use change or removing that material",async()=>{
  const f=await prepare("physical",true,true),file=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-quality.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST/${file}`,"b".repeat(64),ids.supervisor]);await execution.recordUploadPurpose(actor("supervisor"),f.sourceId,file,"面料报告");await execution.report(actor("supervisor"),f.sourceId,{materialIds:[f.materialId],recommendation:"建议停用",note:"TEST不能靠改用途绕过质量",attachmentIds:[file]},randomUUID());
  const next=await execution.reopenMaterials(actor("clerk"),f.sourceId,await reopenInput(f),randomUUID()) as {taskId:string},state=await execution.read(actor("clerk"),f.sourceId),entries=state.materialVerification!.entries.map(r=>({materialId:r.materialId,usage:r.materialId===f.materialId?"unused" as const:"use" as const,physical:r.materialId!==f.materialId,quantity:true,color:true,specification:true,note:"TEST用途变更",confirmedWith:"TEST设计师"}));
  const saved=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries},randomUUID()) as {version:number};
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:next.taskId,expectedVerificationVersion:saved.version,result:"通过",note:"TEST仍须质量决定",items:entries.filter(r=>r.usage==='use').map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID())).rejects.toThrow("问题面料");expect((await tasks.read(actor("clerk"),next.taskId)).state).toBe('ready');expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(false);
 });
 it("D08 races legitimate supply completion without creating duplicate active tasks and rolls back a failed retake",async()=>{
  const f=await prepare("physical",true,true),input=await reopenInput(f),key=randomUUID(),before=Number((await db.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1",[f.sourceId])).rows[0].n);
  await db.query(`CREATE FUNCTION d08_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST D08 transaction interruption'; END $$; CREATE TRIGGER d08_injected_failure BEFORE INSERT ON audit_events FOR EACH ROW WHEN (NEW.entity_id='${f.sourceId}' AND NEW.action='development_material_reopen') EXECUTE FUNCTION d08_injected_failure()`);
  try{await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,input,key)).rejects.toThrow("TEST D08 transaction interruption");}finally{await db.query("DROP TRIGGER d08_injected_failure ON audit_events; DROP FUNCTION d08_injected_failure()");}
  expect((await tasks.read(actor("designer"),f.supply.taskId)).state).toBe('ready');expect(Number((await db.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1",[f.sourceId])).rows[0].n)).toBe(before);
  const material={expectedMaterialRevision:0,expectedVersion:f.sheet.version,action:"到货" as const,expectedDate:null,note:"TEST与文员接回同时提交的真实到货"};
  await expect(forms.materialEvent(actor("designer"),f.sourceId,f.materialId,material,randomUUID())).rejects.toMatchObject({statusCode:403});
  const results=await Promise.allSettled([execution.reopenMaterials(actor("clerk"),f.sourceId,input,key),execution.resubmit(actor("designer"),f.sourceId,f.supply.taskId,randomUUID())]);expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);
  expect((await db.query("SELECT count(*)::int n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind IN ('development_materials','development_material_supply','development_material_recheck') AND t.state IN ('pending','ready','blocked')",[f.sourceId])).rows[0].n).toBe(1);expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(false);
 });
 it("D08 cannot retake a paused/cancelled source or an obsolete document snapshot",async()=>{
  const f=await prepare("physical",true,true),input=await reopenInput(f);
  await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,{...input,expectedDocumentVersion:input.expectedDocumentVersion+1},randomUUID())).rejects.toThrow("正式资料");
  await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,{...input,expectedVerificationVersion:input.expectedVerificationVersion+1},randomUUID())).rejects.toThrow("文员确认");
  await tasks.controlResource(actor("root"),{kind:"source",id:f.sourceId},"pause","TEST暂停仍不可重核",randomUUID());await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,input,randomUUID())).rejects.toThrow("暂停或取消");
  await tasks.controlResource(actor("root"),{kind:"source",id:f.sourceId},"resume","TEST恢复正常待办",randomUUID());await tasks.controlResource(actor("root"),{kind:"source",id:f.sourceId},"cancel","TEST取消轮不能重开",randomUUID());await expect(execution.reopenMaterials(actor("clerk"),f.sourceId,input,randomUUID())).rejects.toThrow("暂停或取消");
  expect((await db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='development_material_reopen'",[f.sourceId])).rows[0].n).toBe(0);
 });
 it("P07 preserves derived arrangement reads across unrelated task changes and resets only changed remaining work",async()=>{
  const f=await prepare(),{saved}=await save(f);await amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},randomUUID());
  let state=await execution.read(actor("clerk"),f.sourceId);const task=state.tasks.find(t=>t.taskKind==="development_material_recheck")!,entries=state.materialVerification!.entries.map(row=>({materialId:row.materialId,usage:"use" as const,physical:true,quantity:true,color:true,specification:true,note:"",confirmedWith:""}));
  const draft=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:task.taskId,expectedDocumentVersion:state.sheet.version,expectedVersion:state.materialVerification!.version,entries},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),f.sourceId,{taskId:task.taskId,expectedVerificationVersion:draft.version,result:"通过",note:"TEST复核通过",items:entries},randomUUID());
  const todos=new TodoService(db,undefined,undefined,undefined,notices),clerk={...actor("clerk"),authorizationCapability:"todo:view"};
  const find=async()=> (await todos.listForActor(clerk,{module:"digital_production"})).todos.find(t=>t.category==="digital_assignment"&&t.entityId===f.sourceId)!;
  const old=await find();expect(old.unread).toBe(true);expect(old.route.developmentRound).toBe(1);
  await todos.markReadForActor(clerk,old.todoId,{contentToken:old.contentToken!,route:old.route});expect((await find()).unread).toBe(false);
  state=await execution.read(actor("clerk"),f.sourceId);const plan=state.arrangement!;
  await execution.arrange(actor("clerk"),f.sourceId,{roundNumber:plan.roundNumber,expectedDocumentVersion:plan.documentVersion,expectedVersion:plan.version,management:"keep",managementReason:"",entries:plan.rows.map(row=>({kind:row.kind,assigneeId:row.kind==="development_pattern"?ids.worker:row.assigneeId,reason:"",expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null}))},randomUUID());
  const changed=await find();expect(changed.unread).toBe(true);expect(changed.contentToken).not.toBe(old.contentToken);
  await expect(todos.markReadForActor(clerk,old.todoId,{contentToken:old.contentToken!,route:old.route})).rejects.toMatchObject({statusCode:409});
  await todos.markReadForActor(clerk,changed.todoId,{contentToken:changed.contentToken!,route:changed.route});
  const paper=(await execution.read(actor("worker"),f.sourceId)).tasks.find(t=>t.taskKind==="development_pattern")!;await tasks.prioritize(actor("root"),paper.taskId,"urgent",randomUUID());
  expect(await find()).toMatchObject({contentToken:changed.contentToken,unread:false});
 });
 it("P07 records a director's actual fabric report read independently and preserves immutable business facts",async()=>{
  const f=await prepare(),file=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-report.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST/${file}`,"b".repeat(64),ids.supervisor]);
  await execution.recordUploadPurpose(actor("supervisor"),f.sourceId,file,"面料报告");const report=await execution.report(actor("supervisor"),f.sourceId,{materialIds:[f.materialId],recommendation:"建议停用",note:"TEST需总监明确决定",attachmentIds:[file]},randomUUID()) as {reportId:string};
  const todos=new TodoService(db,undefined,undefined,undefined,notices),director={...actor("director"),authorizationCapability:"todo:view"};
  const find=async()=> (await todos.listForActor(director,{module:"digital_production"})).todos.find(t=>t.todoId===report.reportId);
  const item=(await find())!,before=(await db.query("SELECT * FROM digital_development_execution_facts WHERE fact_id=$1",[report.reportId])).rows[0];expect(item).toMatchObject({unread:true,category:"digital_fabric_decision"});
  await todos.markReadForActor(director,item.todoId,{contentToken:item.contentToken!,route:item.route});expect(await find()).toMatchObject({unread:false});
  await tasks.prioritize(actor("root"),f.supply.taskId,"urgent",randomUUID());expect(await find()).toMatchObject({contentToken:item.contentToken,unread:false});
  const root={...actor("root"),authorizationCapability:"todo:view"};expect((await todos.listForActor(root,{module:"digital_production"})).todos.find(t=>t.todoId===report.reportId)).toBeUndefined();await expect(todos.markReadForActor(root,item.todoId,{contentToken:item.contentToken!,route:item.route})).rejects.toMatchObject({statusCode:404});
  expect((await db.query("SELECT * FROM digital_development_execution_facts WHERE fact_id=$1",[report.reportId])).rows[0]).toEqual(before);
  await execution.decideFabric(actor("director"),f.sourceId,{reportId:report.reportId,decision:"允许使用",note:"TEST按原权限明确决定",expectedDecisionId:null},randomUUID());
  expect(await find()).toBeUndefined();expect((await db.query("SELECT count(*)::int n FROM todo_content_reads WHERE todo_id=$1",[item.todoId])).rows[0].n).toBe(1);
 });
 it("preserves pre-0248 pure replenishment, including an unchanged saved draft, without publication checks or no-op revisions",async()=>{
  for(const [index,f] of legacyReturns.slice(0,2).entries()){
   const context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId);expect(context).toMatchObject({directSupplyMode:"legacy",issues:[]});expect(context.document.materials[0]!.specification).toBe("");
   const base={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:2,expectedDraftVersion:0};
   await expect(amendments.submit(actor("worker"),f.sourceId,base,randomUUID())).rejects.toMatchObject({statusCode:404});
   await expect(amendments.submit(actor("designer"),f.sourceId,base,randomUUID())).rejects.toThrow("实物尚未补齐");
   await forms.materialEvent(actor("designer"),f.sourceId,f.materialId,{expectedMaterialRevision:0,expectedVersion:2,action:"到货",expectedDate:null,note:"TEST旧补料到货"},randomUUID());
   let expectedDraftVersion=0;if(index===1)expectedDraftVersion=(await amendments.save(actor("designer"),f.sourceId,{...base,document:context.document,reason:""},randomUUID())).draftVersion;
   const key=randomUUID(),input={...base,expectedDraftVersion},first=await amendments.submit(actor("designer"),f.sourceId,input,key);expect(await amendments.submit(actor("designer"),f.sourceId,input,key)).toEqual(first);expect(first.amendmentId).toBeNull();
   const current=await forms.read(actor("designer"),f.sourceId);expect(current.version).toBe(2);expect(current.document).toEqual(f.document);
   expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);expect((await db.query("SELECT count(*)::int n FROM digital_development_amendment_drafts WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);
   const rechecks=(await execution.read(actor("clerk"),f.sourceId)).tasks.filter(task=>task.taskKind==="development_material_recheck");expect(rechecks).toHaveLength(1);expect(rechecks[0]).toMatchObject({state:"ready",assigneeId:ids.clerk});expect((await notices.todos(actor("clerk"))).filter(todo=>todo.todoId===rechecks[0]!.taskId)).toHaveLength(1);
  }
 });
 it("D08 keeps a verified pre-0248 returned task accessible to the original clerk without revising its frozen document",async()=>{
  const f=legacyReturns[2]!,state=await execution.read(actor("clerk"),f.sourceId);expect(state.reopenMaterialCheck).not.toBeNull();
  const next=await execution.reopenMaterials(actor("clerk"),f.sourceId,{...state.reopenMaterialCheck!,note:"TEST文员接回旧补料核实用途"},randomUUID()) as {taskId:string};
  expect((await tasks.read(actor("clerk"),next.taskId)).state).toBe('ready');expect((await forms.read(actor("designer"),f.sourceId)).document).toEqual(f.document);expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);
 });
 it("does not treat empty structured issues or document corrections as legacy replenishment",async()=>{
  const f=await prepare();expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).directSupplyMode).toBeNull();
  const input={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:0};
  await expect(amendments.submit(actor("designer"),f.sourceId,input,randomUUID())).rejects.toThrow("请先保存");await expect(execution.resubmit(actor("designer"),f.sourceId,f.supply.taskId,randomUUID())).rejects.toThrow("资料补正");
  // Malformed structured fixture remains distinct from an absent old record; no history is overwritten.
  await db.query("INSERT INTO digital_development_execution_facts(fact_id,source_id,task_id,kind,payload,actor_id) VALUES($1,$2,$3,'补料复核',$4,$5)",[randomUUID(),f.sourceId,f.supply.taskId,JSON.stringify({returnRequirements:{checkTaskId:f.sheet.taskId,documentVersion:f.sheet.version,issues:[],note:"TEST缺问题的结构化记录"}}),ids.clerk]);
  expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).directSupplyMode).toBeNull();await expect(amendments.submit(actor("designer"),f.sourceId,input,randomUUID())).rejects.toThrow("请先保存");await expect(execution.resubmit(actor("designer"),f.sourceId,f.supply.taskId,randomUUID())).rejects.toThrow("缺少具体问题");
  expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);expect((await execution.read(actor("designer"),f.sourceId)).tasks.filter(task=>task.taskKind==="development_material_recheck")).toHaveLength(0);
  const client=await db.connect();let unlinkedTask:string;try{await client.query("BEGIN");unlinkedTask=(await tasks.createWithClient(client,actor("root"),{resource:{kind:"source",id:f.sourceId},kind:"development_material_supply",routeId:randomUUID(),routeVersion:1,occurrence:2,assigneeId:ids.designer})).taskId;await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  const unknown=await amendments.read(actor("designer"),f.sourceId,unlinkedTask!);expect(unknown).toMatchObject({issues:[],directSupplyMode:null});
  await expect(amendments.submit(actor("designer"),f.sourceId,{...input,taskId:unlinkedTask!},randomUUID())).rejects.toThrow("请先保存");await expect(execution.resubmit(actor("designer"),f.sourceId,unlinkedTask!,randomUUID())).rejects.toThrow("未取得本任务的原退回依据");
  expect((await execution.read(actor("designer"),f.sourceId)).tasks.filter(task=>task.taskKind==="development_material_recheck")).toHaveLength(0);
 });
 it("P03 creates native execution from all 20 positive making sizes without truncating names or changing price rules",async()=>{
  const designerActor={...actor("designer"),authorizationCapabilities:[...actor("designer").authorizationCapabilities??[],"pattern_room:orders:view","pattern_room:orders:edit"]};
  const source=await identity.createSource(designerActor,{designStyleNo:`TEST-P03-${randomUUID()}`,temporaryStyleNo:null,customerCode:null,developmentType:"头版"},randomUUID()),attachmentId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`TEST/${attachmentId}`,"a".repeat(64),ids.designer]);
  const native=new PatternRoomOrderService(db,new TodoProjectionService(new TodoService(db)),{ordersEnabled:true}),linkedForms=new DigitalDevelopmentService(db,true,native);
  const document={...initialDevelopmentDocument(),quantity:20,sizes:Array.from({length:20},(_,index)=>`TEST长尺码${index+1}-${"码".repeat(20)}`),sizeQuantities:Array.from({length:20},()=>1),measurements:[],materials:[],files:[{attachmentId,kind:"款图" as const}]};
  const saved=await linkedForms.save(designerActor,source.sourceId,{expectedVersion:0,document},randomUUID());
  const price=(await db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const published=await linkedForms.publish(designerActor,source.sourceId,saved.version,randomUUID(),{categoryId:price.price_id,priceVersion:price.version});
  const link=(await db.query("SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1",[source.sourceId])).rows[0];
  const order=await native.get(designerActor,link.order_id);expect(order.sizeColor).toBe(developmentMakingSizes(published.document));expect(order.sizeColor!.length).toBeGreaterThan(200);expect(order.rounds[0]!.quantity).toBe(20);
  const extra=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-extra.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[extra,`TEST/${extra}`,"b".repeat(64),ids.designer]);
  const change={version:order.version,roundId:order.currentRoundId,styleNo:order.styleNo,requiredDate:'2026-12-01',customer:order.customer,sizeColor:order.sizeColor,referenceStyleNo:order.referenceStyleNo,variant:order.variant,note:'TEST只更新附件日期备注',attachmentIds:[attachmentId,extra],reason:'TEST保留长系统摘要'},key=randomUUID();
  await expect(native.updateMaterials({...actor('worker'),authorizationCapabilities:['pattern_room:orders:view','pattern_room:orders:edit']},order.orderId,change,randomUUID())).rejects.toMatchObject({statusCode:403});
  const changed=await native.updateMaterials(designerActor,order.orderId,change,key);await native.updateMaterials(designerActor,order.orderId,change,key);
  expect(changed).toMatchObject({sizeColor:order.sizeColor,requiredDate:'2026-12-01',note:change.note,version:order.version+1});expect(changed.attachments.filter(file=>file.active)).toHaveLength(2);
  for(const sizeColor of [order.sizeColor+'TEST伪造','TEST短文本',null])await expect(native.updateMaterials(designerActor,order.orderId,{...change,version:changed.version,sizeColor},randomUUID())).rejects.toMatchObject({statusCode:400});
  expect((await native.get(designerActor,order.orderId)).version).toBe(changed.version);
  expect((await linkedForms.read(designerActor,source.sourceId)).document).toEqual(published.document);

 });

 it("P03 reads and corrects a pre-upgrade frozen legacy snapshot without inventing counts or its missing date",async()=>{
  const source=await identity.createSource(actor("designer"),{designStyleNo:`TEST-LEGACY-${randomUUID()}`,temporaryStyleNo:null,customerCode:null,developmentType:"头版"},randomUUID()),sourceId=source.sourceId,materialId=randomUUID(),attachmentId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`TEST/${attachmentId}`,"a".repeat(64),ids.designer]);
  const legacy=initialDevelopmentDocument();delete legacy.documentFormatVersion;delete legacy.sizeQuantities;Object.assign(legacy,{quantity:1,sampleSize:"历史码42",orderDate:null,materials:[],files:[{attachmentId,kind:"款图"}]});
  legacy.materials=[{materialId,category:"主布",label:"TEST历史主布",name:"TEST棉",specification:"40支",quantity:"1",color:"黑",width:"",weight:"",composition:"",supplier:"",consumption:"",requiredThisRound:true,available:true,expectedDate:null}];
  // Pre-upgrade fixture bootstrap only: seed the original frozen publication; every operation below is the real business command.
  const client=await db.connect();let taskId:string;try{await client.query("BEGIN");taskId=(await tasks.createWithClient(client,actor("root"),{resource:{kind:"source",id:sourceId},kind:"development_materials",routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:ids.clerk})).taskId;await forms.bindFiles(client,actor("designer"),sourceId,legacy);await client.query("INSERT INTO digital_development_documents(source_id,version,status,document,published_at,task_id,updated_by) VALUES($1,2,'published',$2,CURRENT_TIMESTAMP,$3,$4)",[sourceId,JSON.stringify(legacy),taskId,ids.designer]);await client.query("COMMIT");}catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  expect((await forms.read(actor("designer"),sourceId)).document).toEqual(legacy);
  const entry={materialId,usage:"use" as const,physical:true,quantity:true,color:true,specification:false,note:"",confirmedWith:""},issues=[{materialId,field:"specification" as const,reason:"TEST历史规格需澄清"}];
  const draft=await execution.saveMaterials(actor("clerk"),sourceId,{taskId:taskId!,expectedVersion:0,expectedDocumentVersion:2,entries:[entry],result:"缺项退回",returnIssues:issues},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),sourceId,{taskId:taskId!,expectedVerificationVersion:draft.version,result:"缺项退回",note:"TEST规格澄清",returnIssues:issues,items:[entry]},randomUUID());
  const supply=(await execution.read(actor("designer"),sourceId)).tasks.find(task=>task.taskKind==="development_material_supply"&&task.state==="ready")!,context=await amendments.read(actor("designer"),sourceId,supply.taskId),corrected=structuredClone(context.document);corrected.materials[0]!.specification="42支";
  const input={taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:2,expectedDraftVersion:0,document:corrected,reason:"TEST澄清历史规格"};
  await expect(amendments.save(actor("designer"),sourceId,{...input,document:{...corrected,quantity:2}},randomUUID())).rejects.toThrow("复版");
  const saved=await amendments.save(actor("designer"),sourceId,input,randomUUID());await amendments.submit(actor("designer"),sourceId,{taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:2,expectedDraftVersion:saved.draftVersion},randomUUID());
  const current=(await forms.read(actor("clerk"),sourceId)).document!;expect(current.sampleSize).toBe("历史码42");expect(current.documentFormatVersion).toBeUndefined();expect(current.sizeQuantities).toBeUndefined();expect(current.orderDate).toBeNull();expect(current.materials[0]!.specification).toBe("42支");expect((await db.query("SELECT document FROM digital_development_documents WHERE source_id=$1",[sourceId])).rows[0].document).toEqual(legacy);
 });
 it("saves without changing official data, then appends one revision and one clerk recheck with identical-command retry",async()=>{
  const f=await prepare(),frozen=(await db.query("SELECT document FROM digital_development_documents WHERE source_id=$1",[f.sourceId])).rows[0].document;
  const {input,saved}=await save(f);expect((await forms.read(actor("clerk"),f.sourceId)).document?.materials[0]?.specification).toBe("40支");
  const body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},key=randomUUID();
  const results=await Promise.all([amendments.submit(actor("designer"),f.sourceId,body,key),amendments.submit(actor("designer"),f.sourceId,body,key)]);expect(results[0]).toEqual(results[1]);
  const current=await forms.read(actor("clerk"),f.sourceId);expect(current).toMatchObject({roundNumber:1,version:f.sheet.version+1,document:{materials:[{specification:"42支"}]}});
  expect((await db.query("SELECT document FROM digital_development_documents WHERE source_id=$1",[f.sourceId])).rows[0].document).toEqual(frozen);
  expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(1);
  const state=await execution.read(actor("clerk"),f.sourceId),rechecks=state.tasks.filter(t=>t.taskKind==="development_material_recheck");expect(rechecks).toHaveLength(1);expect(rechecks[0]).toMatchObject({assigneeId:ids.clerk,state:"ready",routeVersion:1});expect(state.materialVerification?.entries[0]).toMatchObject({usage:"use",specification:false});expect(state.materialVerification?.entries[0]?.invalidated.join()).toContain("规格");
  await expect(amendments.submit(actor("designer"),f.sourceId,body,randomUUID())).rejects.toMatchObject({statusCode:409});
  const history=await amendments.history(actor("clerk"),f.sourceId,1);expect(history.original.document).toEqual(frozen);expect(history.revisions).toHaveLength(1);expect(input.document.materials[0]?.specification).toBe("42支");
  expect((await materialReadiness(db,f.sourceId,1)).earlyReady).toBe(false);
  const clerkTodos=(await notices.todos(actor("clerk"))).filter(todo=>todo.todoId===rechecks[0]!.taskId);expect(clerkTodos).toHaveLength(1);expect(clerkTodos[0]!.recipientUserId).toBe(ids.clerk);expect((await notices.todos(actor("designer"))).some(todo=>todo.todoId===f.supply.taskId)).toBe(false);expect((await notices.todos(actor("worker"))).some(todo=>todo.todoId===rechecks[0]!.taskId)).toBe(false);
 });
 it("corrects only the returned supplier and sample of a full workbench sheet, and rejects an obsolete correction",async()=>{
  const f=await prepare("supplier",false,false,"document",undefined,true);
  const context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId);
  const current=context.document,corrected=structuredClone(current),replaced=corrected.files[1]!,replacement=corrected.files[2]!;
  expect(current.materials).toHaveLength(20);
  expect(current.files).toHaveLength(6);
  expect(context.issues).toEqual([
   expect.objectContaining({materialId:f.materialId,field:"supplier"}),
   expect.objectContaining({materialId:null,field:"files"}),
  ]);
  Object.assign(corrected.materials[0]!,{supplier:"更新布行",sampleAttachmentId:replacement.attachmentId});
  corrected.files=corrected.files.filter(file=>file.attachmentId!==replaced.attachmentId);
  const version={taskId:f.supply.taskId,roundNumber:context.roundNumber,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:0};
  const input={...version,document:corrected,reason:"TEST 只补供应商与材料局部图"};
  const saved=await amendments.save(actor("designer"),f.sourceId,input,randomUUID());
  await expect(amendments.save(actor("designer"),f.sourceId,{...input,reason:"旧窗口"},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.document).toEqual(corrected);
  expect((await forms.read(actor("designer"),f.sourceId)).document).toEqual(current);
  await amendments.submit(actor("designer"),f.sourceId,{...version,expectedDraftVersion:saved.draftVersion},randomUUID());
  expect((await forms.read(actor("designer"),f.sourceId)).document).toEqual(corrected);
  const history=await amendments.history(actor("clerk"),f.sourceId,context.roundNumber);
  expect(history.original.document).toEqual(current);
  expect(history.revisions).toHaveLength(1);
 });
 it("refuses unauthorized, stale, inactive, wrong-round and conflicting drafts without writes",async()=>{
  const f=await prepare(),{input}=await save(f),count=async()=>Number((await db.query("SELECT count(*) n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n);
  await expect(amendments.save(actor("worker"),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:404});await expect(amendments.save(actor("other"),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:404});
  await expect(amendments.save(actor("designer"),f.sourceId,input,randomUUID())).rejects.toThrow("另一窗口");
  await expect(amendments.save(actor("designer"),f.sourceId,{...input,roundNumber:2},randomUUID())).rejects.toThrow("当前制作轮次");
  await employees.disableAccess(actor("root"),ids.designer,"TEST失效身份拒绝");try{await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});}finally{await employees.restoreAccess(actor("root"),ids.designer,"TEST恢复身份供其他用例");}
  expect(await count()).toBe(0);expect((await tasks.read(actor("designer"),f.supply.taskId)).state).toBe("ready");
  await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"pause","TEST暂停保护",randomUUID());await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toThrow("暂停或取消");await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"resume","TEST恢复",randomUUID());await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"cancel","TEST取消保护",randomUUID());await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toThrow("暂停或取消");expect(await count()).toBe(0);
 });
 it("keeps data correction and clerk receipt separate on a mixed material return",async()=>{
  const f=await prepare("specification",true);
  const unchanged=await save(f,{});
  await expect(amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:unchanged.saved.draftVersion},randomUUID())).rejects.toThrow("资料尚未修改");
  const {saved}=await save(f),body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion};
  expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);
  expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(saved.draftVersion);
  await expect(amendments.submit(actor("clerk"),f.sourceId,body,randomUUID())).rejects.toMatchObject({statusCode:403});
  const response=await amendments.submit(actor("designer"),f.sourceId,body,randomUUID());
  expect(response.documentVersion).toBe(f.sheet.version+1);
  const read=await execution.read(actor("clerk"),f.sourceId);
  const recheck=read.tasks.filter(task=>task.taskKind==="development_material_recheck");
  expect(recheck).toEqual([expect.objectContaining({taskId:response.taskId,state:"ready",canExecute:true})]);
  expect(read.sheet.materialEvents).toEqual([]);
  expect((await materialReadiness(db,f.sourceId,1)).sewingReady).toBe(false);
 });
 it.each(["physical","color"] as const)("hands off a %s supply return without inventing a document revision or actual arrival",async(issue)=>{
  const f=await prepare(issue,issue==="physical",false,"supply");
  await expect(forms.materialEvent(actor("designer"),f.sourceId,f.materialId,{expectedVersion:f.sheet.version,expectedRound:1,expectedMaterialRevision:0,action:"到货",expectedDate:null,note:"TEST设计师不能登记实到"},randomUUID())).rejects.toMatchObject({statusCode:403});
  const body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:0},key="x".repeat(128);
  const result=await amendments.submit(actor("designer"),f.sourceId,body,key);expect(result).toMatchObject({documentVersion:f.sheet.version,amendmentId:null});expect((await amendments.receipt(actor("designer"),f.sourceId,f.supply.taskId,"submit",key)).receipt).toEqual(result);expect((await amendments.receipt(actor("designer"),f.sourceId,f.supply.taskId,"submit",randomUUID())).receipt).toBeNull();
  expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);
  const current=await execution.read(actor("clerk"),f.sourceId);
  const recheck=current.tasks.find(task=>task.taskId===result.taskId);
  expect(recheck).toMatchObject({state:"ready",canExecute:true,routeVersion:1});
  expect(current.sheet.materialEvents).toEqual([]);
  expect((await materialReadiness(db,f.sourceId,1)).sewingReady).toBe(false);
  const entries=current.materialVerification!.entries.map(row=>({materialId:row.materialId,usage:"use" as const,physical:true,quantity:true,color:true,specification:true,note:"TEST文员核实实际到料",confirmedWith:""}));
  const input={taskId:result.taskId,expectedDocumentVersion:current.sheet.version,expectedVersion:current.materialVerification!.version,entries};
  await expect(execution.saveMaterials(actor("designer"),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:404});
  await expect(execution.saveMaterials(actor("clerk"),f.sourceId,{...input,bulkChecks:[{materialId:f.materialId,field:issue}]},randomUUID())).rejects.toThrow("逐项");
  const missing=entries.map(row=>({...row,[issue]:false}));
  const draft=await execution.saveMaterials(actor("clerk"),f.sourceId,{...input,entries:missing},randomUUID());
  await expect(execution.check(actor("clerk"),f.sourceId,{taskId:result.taskId,expectedVerificationVersion:draft.version,result:"通过",note:"TEST不能缺料通过",items:missing},randomUUID())).rejects.toThrow("逐项核实实到");
  const saved=await execution.saveMaterials(actor("clerk"),f.sourceId,{...input,expectedVersion:draft.version},randomUUID());
  expect((await materialReadiness(db,f.sourceId,1)).sewingReady).toBe(false);
  await execution.check(actor("clerk"),f.sourceId,{taskId:result.taskId,expectedVerificationVersion:saved.version,result:"通过",note:"TEST文员已逐项核配",items:entries},randomUUID());
  expect((await materialReadiness(db,f.sourceId,1)).sewingReady).toBe(true);
  expect((await execution.read(actor("clerk"),f.sourceId)).sheet.materialEvents).toEqual([]);
 });
 it("rolls back a failed transaction and safely retries the same command after the fixture failure is removed",async()=>{
  const f=await prepare(),{saved}=await save(f),body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},key=randomUUID();
  await db.query(`CREATE FUNCTION p02_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST transaction interruption'; END $$; CREATE TRIGGER p02_injected_failure BEFORE INSERT ON digital_development_amendments FOR EACH ROW WHEN (NEW.source_id='${f.sourceId}'::uuid) EXECUTE FUNCTION p02_injected_failure()`);
  try{await expect(amendments.submit(actor("designer"),f.sourceId,body,key)).rejects.toThrow("TEST transaction interruption");}finally{await db.query("DROP TRIGGER p02_injected_failure ON digital_development_amendments; DROP FUNCTION p02_injected_failure()");}
  expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);expect((await tasks.read(actor("designer"),f.supply.taskId)).state).toBe("ready");expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(saved.draftVersion);expect((await amendments.receipt(actor("designer"),f.sourceId,f.supply.taskId,"submit",key)).receipt).toBeNull();
  expect((await amendments.submit(actor("designer"),f.sourceId,body,key)).documentVersion).toBe(f.sheet.version+1);
 });
 it("preserves Root's existing ability when the original designer is disabled, without changing source ownership",async()=>{
  const f=await prepare(),{input}=await save(f);await employees.disableAccess(actor("root"),ids.designer,"TEST Root处理失效设计师");
  try{const saved=await amendments.save(actor("root"),f.sourceId,{...input,expectedDraftVersion:1,reason:"TEST Root按既有权限补正"},randomUUID());await amendments.submit(actor("root"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},randomUUID());}
  finally{await employees.restoreAccess(actor("root"),ids.designer,"TEST恢复夹具账号");}
  expect((await db.query("SELECT created_by FROM digital_production_sources WHERE source_id=$1",[f.sourceId])).rows[0].created_by).toBe(ids.designer);expect((await db.query("SELECT published_by FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].published_by).toBe(ids.root);
 });
 it('allows a returned correction while shipping is only automatically ready, preserving original clocks and frozen standards',async()=>{
  const f=await prepare();
  const shipping=(await execution.read(actor('designer'),f.sourceId)).tasks.find(t=>t.taskKind==='development_shipping')!;
  expect(shipping.state).toBe('ready');expect((await db.query('SELECT entered_at FROM digital_production_tasks WHERE task_id=$1',[shipping.taskId])).rows[0].entered_at).not.toBeNull();
  const snapshot=async()=>({
   tasks:(await db.query(`SELECT t.task_id,t.entered_at,t.completed_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 AND a.task_kind NOT IN ('development_material_supply','development_material_recheck') ORDER BY t.task_id`,[f.sourceId])).rows,
   deadlines:(await db.query(`SELECT d.* FROM digital_production_deadline_revisions d JOIN digital_production_task_access a USING(task_id)
    WHERE a.source_id=$1 ORDER BY d.revision_id`,[f.sourceId])).rows,
   frozen:(await db.query('SELECT * FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision',[f.sourceId])).rows
  });
  const before=await snapshot(),{saved}=await save(f),key=randomUUID();
  const input={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion};
  const result=await amendments.submit(actor('designer'),f.sourceId,input,key);
  expect(await amendments.submit(actor('designer'),f.sourceId,input,key)).toEqual(result);
  const after=await snapshot();expect(after.tasks).toEqual(before.tasks);expect(after.frozen).toEqual(before.frozen);
  // The new recheck may get its own deadline revision; all original revisions stay intact.
  expect(after.deadlines.filter(d=>before.deadlines.some(b=>b.revision_id===d.revision_id))).toEqual(before.deadlines);
  expect((await forms.read(actor('designer'),f.sourceId)).document!.materials[0]!.specification).toBe('42支');
  const recheck=(await execution.read(actor('clerk'),f.sourceId)).tasks.find(t=>t.taskKind==='development_material_recheck')!;
  expect(recheck.enteredAt).toBe(f.sheet.publishedAt);
 });
 it('still refuses a correction after actual shipping and preserves its draft and published basis',async()=>{
  const f=await prepare(),{saved}=await save(f);
  const shipping=(await execution.read(actor('designer'),f.sourceId)).tasks.find(t=>t.taskKind==='development_shipping')!;
  await execution.route(actor('designer'),f.sourceId,{taskId:shipping.taskId,result:'通过',note:'TEST实际寄出',craftExecution:null,nextAssigneeId:null,sentDate:new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()),trackingNo:'TEST-SHIPPED'},randomUUID());
  const before=await forms.read(actor('designer'),f.sourceId);
  await expect(amendments.submit(actor('designer'),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},randomUUID())).rejects.toThrow('实际修改 / 复版');
  expect(await forms.read(actor('designer'),f.sourceId)).toEqual(before);
  expect((await amendments.read(actor('designer'),f.sourceId,f.supply.taskId)).draft?.version).toBe(saved.draftVersion);
 });
 it("refuses an amendment after paper work has really activated and preserves its clock and published basis",async()=>{
  const f=await prepare(),first=await save(f);await amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:first.saved.draftVersion},randomUUID());
  let state=await execution.read(actor("clerk"),f.sourceId);const recheck=state.tasks.find(t=>t.taskKind==="development_material_recheck")!,entries=state.materialVerification!.entries.map(row=>({materialId:row.materialId,usage:"use" as const,physical:true,quantity:true,color:true,specification:true,note:"",confirmedWith:""}));
  const confirmed=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:recheck.taskId,expectedDocumentVersion:state.sheet.version,expectedVersion:state.materialVerification!.version,entries},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),f.sourceId,{taskId:recheck.taskId,expectedVerificationVersion:confirmed.version,result:"通过",note:"TEST文员复核新资料",items:entries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
  state=await execution.read(actor("clerk"),f.sourceId);const plan=state.arrangement!;
  await execution.arrange(actor("clerk"),f.sourceId,{roundNumber:plan.roundNumber,expectedDocumentVersion:plan.documentVersion,expectedVersion:plan.version,management:"keep",managementReason:"",entries:plan.rows.map(row=>({kind:row.kind,assigneeId:row.kind==="development_pattern"?ids.worker:row.assigneeId,reason:"",expectedTask:row.taskId?{taskId:row.taskId,state:row.state!,assigneeId:row.assigneeId}:null}))},randomUUID());
  const paper=(await execution.read(actor("worker"),f.sourceId)).tasks.find(t=>t.taskKind==="development_pattern")!;expect(paper.state).toBe("ready");expect(paper.enteredAt).not.toBeNull();
  const file=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-report.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST/${file}`,"b".repeat(64),ids.worker]);await execution.recordUploadPurpose(actor("worker"),f.sourceId,file,"面料报告");
  await execution.report(actor("worker"),f.sourceId,{materialIds:[f.materialId],recommendation:"建议停用",note:"TEST已在办后发现需要核实",attachmentIds:[file]},randomUUID());
  const supplemental=await execution.supplementCheck(actor("clerk"),f.sourceId,recheck.taskId,randomUUID()) as {taskId:string};
  state=await execution.read(actor("clerk"),f.sourceId);const latest=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:supplemental.taskId,expectedDocumentVersion:state.sheet.version,expectedVersion:state.materialVerification!.version,entries},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),f.sourceId,{taskId:supplemental.taskId,expectedVerificationVersion:latest.version,result:"缺项退回",note:"TEST另有制作说明问题",returnIssues:[{materialId:null,field:"instructions",reason:"TEST制作说明待实质修改"}],items:entries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());
  const supply=(await execution.read(actor("designer"),f.sourceId)).tasks.find(t=>t.taskKind==="development_material_supply"&&t.state==="ready")!,context=await amendments.read(actor("designer"),f.sourceId,supply.taskId),before=(await db.query("SELECT entered_at,state FROM digital_production_tasks WHERE task_id=$1",[paper.taskId])).rows[0];
  const draft=await amendments.save(actor("designer"),f.sourceId,{taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:0,document:{...context.document,instructions:"TEST实质修改制作说明"},reason:"TEST不能覆盖已在办制作依据"},randomUUID());
  await expect(amendments.submit(actor("designer"),f.sourceId,{taskId:supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:draft.draftVersion},randomUUID())).rejects.toThrow("实际修改 / 复版");
  expect((await db.query("SELECT entered_at,state FROM digital_production_tasks WHERE task_id=$1",[paper.taskId])).rows[0]).toEqual(before);expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(context.documentVersion);
 });
 it.each([false,true])("uses the real HTTP correction flow with UI customer-order shape (withOrder=%s) and rejects unauthorized writes",async(withOrder)=>{
  const f=await prepare("specification",false,false,undefined,withOrder),context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId),codes=new Map<string,keyof typeof ids>(),provider:DingTalkProvider={
   exchangeMobileCode:async code=>{const who=codes.get(code);if(!who)throw Error("Unknown TEST code");return {userId:`TEST-${ids[who]}`,unionId:`TEST-${ids[who]}`,corpId:"TEST"};},
   exchangeQrCode:async()=>{throw Error("QR not tested");},buildQrAuthorizationUrl:()=>{throw Error("QR not tested");},
   getOrganizationMember:async identity=>{const found=(Object.keys(ids) as Array<keyof typeof ids>).find(who=>`TEST-${ids[who]}`===identity.userId);return found?{corpId:"TEST",userId:identity.userId,unionId:identity.unionId,active:true,employed:true,displayName:`TEST ${found}`}:null;}
  };
  // Only the external identity provider is local. AuthService, persisted sessions,
  // current role/capability loading, businessActor and business APIs are real.
  const auth=new AuthService(provider,new PostgresAuthStore(db,"TEST",`TEST-${ids.root}`),"TEST",3600000,randomUUID()),app=Fastify(),sessions=new Map<string,string>();
  for(const who of ["designer","clerk","worker"] as const){const code=`TEST-P02-${who}-${randomUUID()}`;codes.set(code,who);sessions.set(who,(await auth.loginMobile(code)).token);}
  registerDevelopmentRoutes(app,{authenticate:token=>auth.authenticate(token),root:new RootAuthority(db,"TEST",`TEST-${ids.root}`)},forms,undefined as never);
  registerDevelopmentExecutionRoutes(app,{authenticate:token=>auth.authenticate(token),root:new RootAuthority(db,"TEST",`TEST-${ids.root}`)},execution,undefined as never);
  const body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:0,document:{...context.document,materials:context.document.materials.map(m=>({...m,specification:"42支"}))},reason:"TEST经真实会话补正"},endpoint=`/digital-production/sources/${f.sourceId}/development/amendment`,count=async()=>Number((await db.query("SELECT count(*) n FROM digital_production_commands WHERE command LIKE $1",[`%${f.sourceId}%`])).rows[0].n);
  // JSONB object order differs from the HTTP schema reconstruction, even when the order is untouched.
  const parsed=DevelopmentDocumentSchema.parse(body.document);
  expect(JSON.stringify(context.document.customerOrderDraft)).not.toBe(JSON.stringify(parsed.customerOrderDraft));
  expect(parsed.customerOrderDraft).toEqual(context.document.customerOrderDraft);
  try{const before=await count();for(const [who,status]of [["worker",404],["clerk",403]] as const){const denied=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get(who)}`,"idempotency-key":randomUUID()},payload:body});expect(denied.statusCode).toBe(status);expect(await count()).toBe(before);}
   const key=randomUUID(),allowed=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":key},payload:body});expect(allowed.statusCode,allowed.body).toBe(200);expect(allowed.json().draftVersion).toBe(1);expect(await count()).toBe(before+1);expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);
   const receipt=await app.inject({url:`${endpoint}/receipt?taskId=${f.supply.taskId}&operation=save&key=${key}`,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`}});expect(receipt.statusCode).toBe(200);expect(receipt.json().receipt.draftVersion).toBe(1);
   const g=await prepare("physical",true,true),reopen=await reopenInput(g),reopenUrl=`/digital-production/sources/${g.sourceId}/execution/reopen-materials`,taskCount=async()=>Number((await db.query("SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1",[g.sourceId])).rows[0].n),beforeReopen=await taskCount();
   const refused=await app.inject({method:"POST",url:reopenUrl,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":randomUUID()},payload:reopen});expect(refused.statusCode,refused.body).toBe(403);expect(await taskCount()).toBe(beforeReopen);expect((await tasks.read(actor("designer"),g.supply.taskId)).state).toBe('ready');
   const retaken=await app.inject({method:"POST",url:reopenUrl,headers:{cookie:`dx_rework_session=${sessions.get("clerk")}`,"idempotency-key":randomUUID()},payload:reopen});expect(retaken.statusCode,retaken.body).toBe(200);expect(await taskCount()).toBe(beforeReopen+1);expect((await notices.todos(actor("clerk"))).some(todo=>todo.todoId===retaken.json().taskId)).toBe(true);
   const removed=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":randomUUID()},payload:{...body,expectedDraftVersion:1,document:{...body.document,materials:[]}}});expect(removed.statusCode).toBe(409);expect(await count()).toBe(before+1);expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(1);
   for(const patch of [{quantity:3},{sizeQuantities:[2,0]},{craft:"印花"},{customerOrderDraft:{...body.document.customerOrderDraft!,withOrder:!withOrder}},{customerOrderDraft:{...body.document.customerOrderDraft!,order:{...body.document.customerOrderDraft!.order,lines:[{...body.document.customerOrderDraft!.order.lines[0]!,sizes:[{size:"M",quantity:"101"}]}]}}}]){
    const refused=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":randomUUID()},payload:{...body,expectedDraftVersion:1,document:{...body.document,...patch}}});expect(refused.statusCode,refused.body).toBe(409);expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(1);
   }
   const submitKey=randomUUID(),submitted=await app.inject({method:"POST",url:`${endpoint}/submit`,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":submitKey},payload:{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:1}});expect(submitted.statusCode,submitted.body).toBe(200);
   expect((await app.inject({method:"POST",url:`${endpoint}/submit`,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":submitKey},payload:{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:1}})).json()).toEqual(submitted.json());
   const formal=await forms.read(actor("designer"),f.sourceId);expect(formal.document!.customerOrderDraft).toEqual(context.document.customerOrderDraft);expect(formal.document!.quantity).toBe(2);expect(formal.document!.sizeQuantities).toEqual([1,1]);expect(formal.document!.materials[0]!.specification).toBe("42支");
   const state=await execution.read(actor("clerk"),f.sourceId),recheck=state.tasks.find(t=>t.taskKind==='development_material_recheck'&&t.state==='ready')!;expect(recheck.assigneeId).toBe(ids.clerk);expect((await notices.todos(actor("clerk"))).filter(t=>t.todoId===recheck.taskId)).toHaveLength(1);
   const entries=state.materialVerification!.entries.map(row=>({...row,usage:"use" as const,physical:true,quantity:true,color:true,specification:true})),verified=await execution.saveMaterials(actor("clerk"),f.sourceId,{taskId:recheck.taskId,expectedDocumentVersion:state.sheet.version,expectedVersion:state.materialVerification!.version,entries},randomUUID()) as {version:number};
   await execution.check(actor("clerk"),f.sourceId,{taskId:recheck.taskId,expectedVerificationVersion:verified.version,result:"通过",note:"TEST补正规格后原文员真实复核",items:entries.map(({materialId,physical,quantity,color,specification})=>({materialId,physical,quantity,color,specification}))},randomUUID());expect((await tasks.read(actor("clerk"),recheck.taskId)).state).toBe('completed');
  }finally{await app.close();}
 });
 it("protects frozen publication with database immutability rather than overwriting the old row",async()=>{
  const f=await prepare("name"),{saved}=await save(f,{name:"TEST更正品名"});await amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},randomUUID());
  const verification=(await execution.read(actor("clerk"),f.sourceId)).materialVerification!;expect(verification.entries[0]).toMatchObject({usage:"pending",physical:false,quantity:false,color:false,specification:false});
  await expect(db.query("UPDATE digital_development_amendments SET reason='overwrite' WHERE source_id=$1",[f.sourceId])).rejects.toThrow();await expect(db.query("UPDATE digital_development_documents SET document='{}' WHERE source_id=$1",[f.sourceId])).rejects.toThrow();

 });
});
