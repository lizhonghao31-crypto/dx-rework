import Fastify from "fastify";
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
import {ownedPostgresSchema} from "../helpers/owned-postgres-schema.js";
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
 const ids={designer:randomUUID(),clerk:randomUUID(),worker:randomUUID(),other:randomUUID(),root:randomUUID()};
 const actor=(who:keyof typeof ids,roles?:string[]):TrustedActorContext=>({actorId:ids[who],actorRoles:roles??[who==="root"?"root_superuser":who==="clerk"?"development_clerk":who==="worker"?"pattern_room_worker":"sample_designer"],authorizationCapability:"digital_production:view",authorizationCapabilities:["digital_production:view","pattern_room:orders:create","todo:view"],requestId:"TEST-P02"});
 const employees=new EmployeeAccessService(db,"TEST",new AccessMasterDataService(db,"TEST"),undefined as never,undefined as never,{enabled:false,dingtalkUserId:undefined,secret:undefined},`TEST-${ids.root}`);
 const forms=new DigitalDevelopmentService(db,true),execution=new DevelopmentExecutionService(db,true),amendments=new DevelopmentAmendmentService(db,true),identity=new DigitalProductionIdentityService(db,true),tasks=new DigitalProductionTaskService(db),notices=new DigitalProductionNotificationService(db);
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);await db.query("CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)");
  const manifest=JSON.parse(await readFile(new URL("../../apps/api/src/platform/migration-manifest.json",import.meta.url),"utf8"));
  for(const row of manifest.migrations){await db.query(await readFile(new URL(`../../apps/api/migrations/${row.version}.sql`,import.meta.url),"utf8"));await db.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)",[row.version,row.checksum]);}
  // Test-only identity bootstrap, before organization policy. All tested commands use actual service authorization.
  for(const who of Object.keys(ids) as Array<keyof typeof ids>){const id=ids[who];await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[id,`TEST ${who}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','TEST',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,`TEST-${id}`]);if(who!=="root")await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'P02 test bootstrap')",[randomUUID(),id,actor(who).actorRoles[0]]);}
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'TEST')",[ids.root,`TEST-${ids.root}`]);
  await new AccessMasterDataService(db,"TEST").ensureOrganizationPolicy();
 },60000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 const prepare=async(field:DevelopmentReturnIssue["field"]="specification",missing=false)=>{
  const source=await identity.createSource(actor("designer"),{designStyleNo:`TEST-P02-${randomUUID()}`,temporaryStyleNo:null,customerCode:null,developmentType:"头版"},randomUUID()),sourceId=source.sourceId,materialId=randomUUID(),attachmentId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[attachmentId,`TEST/${attachmentId}`,"a".repeat(64),ids.designer]);
  const document={...initialDevelopmentDocument(),quantity:1,sampleSize:"M",orderDate:"2026-10-20",materials:[{materialId,category:"主布" as const,label:"TEST主布",name:"TEST棉布",specification:"40支",quantity:"1",color:"黑",width:"",weight:"",composition:"",supplier:"",consumption:"",requiredThisRound:false,available:!missing,expectedDate:null}],files:[{attachmentId,kind:"款图" as const}]};
  const saved=await forms.save(actor("designer"),sourceId,{expectedVersion:0,document},randomUUID()),sheet=await forms.publish(actor("designer"),sourceId,saved.version,randomUUID()),checkTask=sheet.taskId!;
  const issues:DevelopmentReturnIssue[]=[{materialId,field,reason:`TEST ${field}需核实`}];if(missing&&field!=="physical")issues.push({materialId,field:"physical",reason:"TEST实物未到"});
  const entry={materialId,usage:"use" as const,physical:!missing,quantity:true,color:true,specification:field!=="specification",note:"",confirmedWith:""};
  const verification=await execution.saveMaterials(actor("clerk"),sourceId,{taskId:checkTask,expectedVersion:0,expectedDocumentVersion:sheet.version,entries:[entry],result:"缺项退回",returnIssues:issues},randomUUID()) as {version:number};
  await execution.check(actor("clerk"),sourceId,{taskId:checkTask,expectedVerificationVersion:verification.version,result:"缺项退回",note:"TEST具体退回",returnIssues:issues,items:[{materialId,physical:entry.physical,quantity:true,color:true,specification:entry.specification}]},randomUUID());
  const supply=(await execution.read(actor("designer"),sourceId)).tasks.find(t=>t.taskKind==="development_material_supply"&&t.state==="ready")!;
  return {sourceId,materialId,supply,document,sheet};
 };
 const save=async(f:Awaited<ReturnType<typeof prepare>>,patch:Record<string,unknown>={specification:"42支"})=>{
  const context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId),document=structuredClone(context.document);Object.assign(document.materials[0]!,patch);
  const input={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:context.draft?.version??0,document,reason:"TEST按原退回字段补正"};return {input,saved:await amendments.save(actor("designer"),f.sourceId,input,randomUUID())};
 };
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
 it("refuses unauthorized, stale, inactive, wrong-round and conflicting drafts without writes",async()=>{
  const f=await prepare(),{input}=await save(f),count=async()=>Number((await db.query("SELECT count(*) n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n);
  await expect(amendments.save(actor("worker"),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:404});await expect(amendments.save(actor("other"),f.sourceId,input,randomUUID())).rejects.toMatchObject({statusCode:404});
  await expect(amendments.save(actor("designer"),f.sourceId,input,randomUUID())).rejects.toThrow("另一窗口");
  await expect(amendments.save(actor("designer"),f.sourceId,{...input,roundNumber:2},randomUUID())).rejects.toThrow("当前制作轮次");
  await employees.disableAccess(actor("root"),ids.designer,"TEST失效身份拒绝");try{await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toMatchObject({statusCode:403});}finally{await employees.restoreAccess(actor("root"),ids.designer,"TEST恢复身份供其他用例");}
  expect(await count()).toBe(0);expect((await tasks.read(actor("designer"),f.supply.taskId)).state).toBe("ready");
  await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"pause","TEST暂停保护",randomUUID());await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toThrow("暂停或取消");await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"resume","TEST恢复",randomUUID());await tasks.controlResource(actor("designer"),{kind:"source",id:f.sourceId},"cancel","TEST取消保护",randomUUID());await expect(amendments.save(actor("designer"),f.sourceId,{...input,expectedDraftVersion:1},randomUUID())).rejects.toThrow("暂停或取消");expect(await count()).toBe(0);
 });
 it("does not confuse a material arrival with correcting data and atomically retains the draft on a mixed rejection",async()=>{
  const f=await prepare("specification",true),{saved}=await save(f),body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion};
  await expect(amendments.submit(actor("designer"),f.sourceId,body,randomUUID())).rejects.toThrow("实物尚未补齐");expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(saved.draftVersion);
  await forms.materialEvent(actor("designer"),f.sourceId,f.materialId,{expectedVersion:f.sheet.version,expectedMaterialRevision:0,action:"到货",expectedDate:null,note:"TEST实物到货"},randomUUID());
  const response=await amendments.submit(actor("designer"),f.sourceId,body,randomUUID());expect(response.documentVersion).toBe(f.sheet.version+1);expect((await execution.read(actor("clerk"),f.sourceId)).tasks.filter(t=>t.taskKind==="development_material_recheck")).toHaveLength(1);
 });
 it("submits a physical-only replenishment without inventing another document revision and exposes the original command receipt",async()=>{
  const f=await prepare("physical",true);await forms.materialEvent(actor("designer"),f.sourceId,f.materialId,{expectedVersion:f.sheet.version,expectedMaterialRevision:0,action:"到货",expectedDate:null,note:"TEST实物到货"},randomUUID());
  const body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:0},key="x".repeat(128);
  const result=await amendments.submit(actor("designer"),f.sourceId,body,key);expect(result).toMatchObject({documentVersion:f.sheet.version,amendmentId:null});expect((await amendments.receipt(actor("designer"),f.sourceId,f.supply.taskId,"submit",key)).receipt).toEqual(result);expect((await amendments.receipt(actor("designer"),f.sourceId,f.supply.taskId,"submit",randomUUID())).receipt).toBeNull();
  expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);expect((await db.query("SELECT count(*)::int n FROM digital_development_amendments WHERE source_id=$1",[f.sourceId])).rows[0].n).toBe(0);
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
 it("uses independent real test sessions at the HTTP boundary and refuses unauthorized writes without business mutations",async()=>{
  const f=await prepare(),context=await amendments.read(actor("designer"),f.sourceId,f.supply.taskId),codes=new Map<string,keyof typeof ids>(),provider:DingTalkProvider={
   exchangeMobileCode:async code=>{const who=codes.get(code);if(!who)throw Error("Unknown TEST code");return {userId:`TEST-${ids[who]}`,unionId:`TEST-${ids[who]}`,corpId:"TEST"};},
   exchangeQrCode:async()=>{throw Error("QR not tested");},buildQrAuthorizationUrl:()=>{throw Error("QR not tested");},
   getOrganizationMember:async identity=>{const found=(Object.keys(ids) as Array<keyof typeof ids>).find(who=>`TEST-${ids[who]}`===identity.userId);return found?{corpId:"TEST",userId:identity.userId,unionId:identity.unionId,active:true,employed:true,displayName:`TEST ${found}`}:null;}
  };
  // Only the external identity provider is local. AuthService, persisted sessions,
  // current role/capability loading, businessActor and business APIs are real.
  const auth=new AuthService(provider,new PostgresAuthStore(db,"TEST",`TEST-${ids.root}`),"TEST",3600000,randomUUID()),app=Fastify(),sessions=new Map<string,string>();
  for(const who of ["designer","clerk","worker"] as const){const code=`TEST-P02-${who}-${randomUUID()}`;codes.set(code,who);sessions.set(who,(await auth.loginMobile(code)).token);}
  registerDevelopmentRoutes(app,{authenticate:token=>auth.authenticate(token),root:new RootAuthority(db,"TEST",`TEST-${ids.root}`)},forms,undefined as never);
  const body={taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:context.documentVersion,expectedDraftVersion:0,document:{...context.document,materials:context.document.materials.map(m=>({...m,specification:"42支"}))},reason:"TEST经真实会话补正"},endpoint=`/digital-production/sources/${f.sourceId}/development/amendment`,count=async()=>Number((await db.query("SELECT count(*) n FROM digital_production_commands WHERE command LIKE $1",[`%${f.sourceId}%`])).rows[0].n);
  try{const before=await count();for(const [who,status]of [["worker",404],["clerk",403]] as const){const denied=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get(who)}`,"idempotency-key":randomUUID()},payload:body});expect(denied.statusCode).toBe(status);expect(await count()).toBe(before);}
   const key=randomUUID(),allowed=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":key},payload:body});expect(allowed.statusCode,allowed.body).toBe(200);expect(allowed.json().draftVersion).toBe(1);expect(await count()).toBe(before+1);expect((await forms.read(actor("designer"),f.sourceId)).version).toBe(f.sheet.version);
   const receipt=await app.inject({url:`${endpoint}/receipt?taskId=${f.supply.taskId}&operation=save&key=${key}`,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`}});expect(receipt.statusCode).toBe(200);expect(receipt.json().receipt.draftVersion).toBe(1);
   const removed=await app.inject({method:"PUT",url:endpoint,headers:{cookie:`dx_rework_session=${sessions.get("designer")}`,"idempotency-key":randomUUID()},payload:{...body,expectedDraftVersion:1,document:{...body.document,materials:[]}}});expect(removed.statusCode).toBe(409);expect(await count()).toBe(before+1);expect((await amendments.read(actor("designer"),f.sourceId,f.supply.taskId)).draft?.version).toBe(1);
  }finally{await app.close();}
 });
 it("protects frozen publication with database immutability rather than overwriting the old row",async()=>{
  const f=await prepare("name"),{saved}=await save(f,{name:"TEST更正品名"});await amendments.submit(actor("designer"),f.sourceId,{taskId:f.supply.taskId,roundNumber:1,expectedDocumentVersion:f.sheet.version,expectedDraftVersion:saved.draftVersion},randomUUID());
  const verification=(await execution.read(actor("clerk"),f.sourceId)).materialVerification!;expect(verification.entries[0]).toMatchObject({usage:"pending",physical:false,quantity:false,color:false,specification:false});
  await expect(db.query("UPDATE digital_development_amendments SET reason='overwrite' WHERE source_id=$1",[f.sourceId])).rejects.toThrow();await expect(db.query("UPDATE digital_development_documents SET document='{}' WHERE source_id=$1",[f.sourceId])).rejects.toThrow();

 });
});
