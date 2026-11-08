import {randomUUID} from "node:crypto";
import {afterAll,afterEach,beforeAll,describe,expect,it,vi} from "vitest";
import {loadConfig} from "@dx-rework/config";
import type {FastifyInstance} from "fastify";
import {buildApp} from "../../apps/api/src/app.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import type {DingTalkProvider} from "../../apps/api/src/auth/provider.js";
import {OfficialDingTalkProvider} from "../../apps/api/src/auth/provider.js";
import {EmployeeAccessService} from "../../apps/api/src/access/employee-access-service.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("request identity pilot through original App, AuthService and PostgreSQL",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:FastifyInstance,auth:AuthService,root:RootAuthority,store:PostgresAuthStore,employeeAccess:EmployeeAccessService;
 let directoryCalls=0,directoryError:Error|null=null,beforeHandler:(()=>Promise<void>)|undefined;
 const secret="TEST architecture native identity proof ".repeat(3),origin="https://architecture.invalid";
 const supplier=()=>({supplierCode:"TEST_ARCH_"+randomUUID().replaceAll("-","").slice(0,12).toUpperCase(),supplierType:"factory",supplierName:"TEST architecture "+randomUUID(),changeReason:"TEST request-owned identity"});
 const login=async(alias:string)=>{const result=await auth.loginMobile(mintAcceptanceLoginCode(alias,secret));directoryCalls=0;return result;};
 const headers=(token:string)=>({cookie:"dx_rework_session="+token,origin,"x-request-id":"TEST-same-client-id"});
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);root=new RootAuthority(f.db,"anchor-test","uat-root");store=new PostgresAuthStore(f.db,"anchor-test","uat-root");
  const delegate:DingTalkProvider=new AcceptanceDingTalkProvider(f.db,"anchor-test",secret);
  // Controlled directory dependency over isolated native TEST identities. This
  // is a provider fault injection, not a real DingTalk/network outage.
  const provider:DingTalkProvider={
   exchangeMobileCode:code=>delegate.exchangeMobileCode(code),exchangeQrCode:code=>delegate.exchangeQrCode(code),buildQrAuthorizationUrl:state=>delegate.buildQrAuthorizationUrl(state),
   getOrganizationMember:async(...args)=>{directoryCalls++;if(directoryError)throw directoryError;return delegate.getOrganizationMember(...args);},
  };
  auth=new AuthService(provider,store,"anchor-test",3600000,secret);
  const config=loadConfig({NODE_ENV:"test",DATABASE_URL:url!,DINGTALK_CORP_ID:"anchor-test",DINGTALK_H5_APP_KEY:"TEST",DINGTALK_H5_APP_SECRET:secret,DINGTALK_WEB_CLIENT_ID:"TEST",DINGTALK_WEB_CLIENT_SECRET:secret,DINGTALK_QR_REDIRECT_URI:origin+"/auth/qr/callback",APP_BASE_PATH:"/",SESSION_SECRET:secret});
  // These existing admin commands do not call the provider. They set the real
  // transaction/audit context required by account-disable database guards.
  employeeAccess=new EmployeeAccessService(f.db,"anchor-test",f.access,store,new OfficialDingTalkProvider(config.dingtalk),{enabled:false,dingtalkUserId:undefined,secret:undefined},"uat-root");
  const authenticate:typeof auth.authenticate=(token,context)=>auth.authenticate(token,context);
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},sourcing:{authenticate,root,service:f.sourcing,contracts:f.contracts}});
  app.addHook("preHandler",async()=>{const action=beforeHandler;beforeHandler=undefined;await action?.();});
  await app.ready();
 });
 afterEach(()=>{vi.restoreAllMocks();directoryCalls=0;directoryError=null;beforeHandler=undefined;});
 afterAll(async()=>{await app?.close();await f?.dispose();});

 it("returns the actual committed supplier when the directory fails after the command, then fails closed on a new request",async()=>{
  const session=await login("root"),input=supplier(),original=f.access.createSupplier.bind(f.access);
  vi.spyOn(f.access,"createSupplier").mockImplementation(async(...args)=>{const result=await original(...args);directoryError=Error("TEST directory unavailable after real COMMIT");return result;});
  const response=await app.inject({method:"POST",url:"/master-data/suppliers",headers:headers(session.token),payload:input});
  expect(response.statusCode,response.body).toBe(201);expect(directoryCalls).toBe(2); // admission + final write phase
  expect((await f.db.query("SELECT count(*)::int n FROM supplier_catalog_versions WHERE supplier_name=$1",[input.supplierName])).rows[0].n).toBe(1);
  expect(response.json()).toHaveProperty("supplierId");
  const next=await app.inject({method:"GET",url:"/master-data/suppliers",headers:headers(session.token)});
  expect(next.statusCode).toBe(500);expect(directoryCalls).toBe(3);
  expect(next.body).not.toContain(input.supplierName);
 });

 it("keeps native sourcing command idempotency when post-commit directory access fails",async()=>{
  const merch=f.people.merchandiser!,image=await f.image(merch);
  const created=await f.sourcing.createCase(merch,{gender:"男装",styleName:"TEST架构",deliveryDate:"2026-12-20",estimatedCutPieceSendDate:"2026-11-10",daxingUnitPrice:"5",attachmentIds:[image],lineItems:[{styleNo:"TEST-ARCH-"+randomUUID(),color:"黑",quantity:10}]},randomUUID());
  const session=await login("ie"),id=created.value.sourcingCaseId,key=randomUUID(),original=f.sourcing.quoteIePrice.bind(f.sourcing);
  vi.spyOn(f.sourcing,"quoteIePrice").mockImplementation(async(...args)=>{const result=await original(...args);directoryError=Error("TEST provider unavailable after native quote");return result;});
  const request={method:"POST" as const,url:`/sourcing/cases/${id}/ie-quotes`,headers:{...headers(session.token),"idempotency-key":key},payload:{linePrices:[{position:1,unitPrice:"5"}]}};
  const first=await app.inject(request);expect(first.statusCode,first.body).toBe(201);expect(directoryCalls).toBe(2);
  directoryError=null;directoryCalls=0;
  const retry=await app.inject(request);expect(retry.statusCode,retry.body).toBe(201);expect(retry.headers["idempotency-replayed"]).toBe("true");
  expect(retry.json()).toEqual(first.json());expect(directoryCalls).toBe(2);
  expect((await f.db.query("SELECT count(*)::int n FROM sourcing_ie_quotes WHERE sourcing_case_id=$1",[id])).rows[0].n).toBe(1);
 });

 it("reloads local disablement after a committed write without upserting old active identity or pretending rollback",async()=>{
  const session=await login("production-management"),input=supplier(),original=f.access.createSupplier.bind(f.access),upsert=vi.spyOn(store,"upsertIdentity");
  vi.spyOn(f.access,"createSupplier").mockImplementation(async(...args)=>{
   const result=await original(...args);await employeeAccess.disableAccess(f.root,session.user.id,"TEST local disable after committed supplier");return result;
  });
  try{
   const response=await app.inject({method:"POST",url:"/master-data/suppliers",headers:headers(session.token),payload:input});
   expect(response.statusCode,response.body).toBe(401);expect(directoryCalls).toBe(2);expect(upsert).toHaveBeenCalledTimes(2);
   expect((await f.db.query("SELECT enabled FROM app_users WHERE id=$1",[session.user.id])).rows[0].enabled).toBe(false);
   expect((await f.db.query("SELECT count(*)::int n FROM supplier_catalog_versions WHERE supplier_name=$1",[input.supplierName])).rows[0].n).toBe(1);
   expect(response.body).not.toContain(input.supplierName);
  }finally{await employeeAccess.restoreAccess(f.root,session.user.id,"TEST restore dedicated fixture identity");}
 });

 it("honors a role revocation between admission and write while the original signed session remains valid",async()=>{
  const manager=f.people['production-management']!,master={...f.root,authorizationCapability:"access:admin",authorizationCapabilities:["access:admin","master_data:manage"]};
  await f.access.assignRole(master,{userId:manager.actorId,roleCode:"warehouse_receiver",reason:"TEST retain independently authorized session"});
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0];
  const session=await login("production-management"),input=supplier();
  beforeHandler=()=>f.access.revokeRole(master,assignment.assignment_id,"TEST same-session revoke before write");
  const response=await app.inject({method:"POST",url:"/master-data/suppliers",headers:headers(session.token),payload:input});
  expect(response.statusCode,response.body).toBe(403);
  expect((await f.db.query("SELECT count(*)::int n FROM supplier_catalog_versions WHERE supplier_name=$1",[input.supplierName])).rows[0].n).toBe(0);
  const current=await auth.authenticate(session.token);expect(current.id).toBe(session.user.id);expect(current.businessRoles).toContain("warehouse_receiver");expect(current.businessRoles).not.toContain("production_management");
 });

 it("fails closed on a local session-read failure after actual commit without deleting or exposing the saved record",async()=>{
  const session=await login("root"),input=supplier(),create=f.access.createSupplier.bind(f.access),find=store.findSession.bind(store);let committed=false;
  vi.spyOn(f.access,"createSupplier").mockImplementation(async(...args)=>{const result=await create(...args);committed=true;return result;});
  vi.spyOn(store,"findSession").mockImplementation(async(...args)=>{if(committed)throw Error("TEST local session read unavailable after COMMIT");return find(...args);});
  const response=await app.inject({method:"POST",url:"/master-data/suppliers",headers:headers(session.token),payload:input});
  expect(response.statusCode,response.body).toBe(500);expect(directoryCalls).toBe(2);
  expect(response.body).not.toContain(input.supplierName);expect(response.body).toContain("原提交结果尚未确认");
  expect((await f.db.query("SELECT count(*)::int n FROM supplier_catalog_versions WHERE supplier_name=$1",[input.supplierName])).rows[0].n).toBe(1);
 });

 it("redacts supplier fields using post-read current roles instead of the earlier proof's authorization",async()=>{
  const merch=f.people.merchandiser!,master={...f.root,authorizationCapability:"access:admin",authorizationCapabilities:["access:admin","master_data:manage"]};
  await f.access.assignRole(master,{userId:merch.actorId,roleCode:"warehouse_receiver",reason:"TEST preserve independent current session"});
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='order_merchandiser' AND revoked_at IS NULL",[merch.actorId])).rows[0];
  const session=await login("merchandiser"),read=f.access.getSupplier.bind(f.access);
  vi.spyOn(f.access,"getSupplier").mockImplementation(async(...args)=>{
   const result=await read(...args);expect(result.bankAccount).toBe("TEST0001");
   await f.access.revokeRole(master,assignment.assignment_id,"TEST remove sensitive supplier fields after read");return result;
  });
  const response=await app.inject({method:"GET",url:"/master-data/suppliers/"+f.supplierId,headers:headers(session.token)});
  expect(response.statusCode,response.body).toBe(200);expect(directoryCalls).toBe(1);
  expect(response.json()).toHaveProperty("supplierId",f.supplierId);
  expect(response.body).not.toContain("TEST0001");expect(response.json().bankAccount).toBeUndefined();expect(response.json().address).toBeUndefined();
  const current=await auth.authenticate(session.token);expect(current.businessRoles).toContain("warehouse_receiver");expect(current.businessRoles).not.toContain("order_merchandiser");
 });

 it("retains native pure-PMC reads and rejects writes with the actual signed session and Root authority",async()=>{
  const alias="test-architecture-pmc",member={corpId:"anchor-test",userId:"uat-"+alias,unionId:"uat-union-test-architecture-pmc-"+randomUUID(),displayName:"TEST架构独立PMC",active:true,employed:true};
  // Normal directory onboarding persists identity but refuses login until a
  // native Root role grant enables it. Do not repurpose an existing role user.
  await expect(store.upsertIdentity(member)).rejects.toMatchObject({code:"ACCOUNT_DISABLED"});
  const userId=(await f.db.query("SELECT user_id FROM identity_mappings WHERE corp_id=$1 AND provider_user_id=$2",[member.corpId,member.userId])).rows[0].user_id;
  const master={...f.root,authorizationCapability:"access:admin",authorizationCapabilities:["access:admin","master_data:manage"]};
  await f.access.assignRole(master,{userId,roleCode:"pmc",reason:"TEST dedicated pure PMC, no existing account change"});
  const session=await login(alias);expect(session.user.businessRoles).toEqual(["pmc"]);expect(await root.isRootUser(session.user.id)).toBe(false);
  const read=await app.inject({method:"GET",url:"/master-data/suppliers/"+f.supplierId,headers:headers(session.token)});
  expect(read.statusCode,read.body).toBe(200);expect(read.json().bankAccount).toBe("TEST0001");expect(directoryCalls).toBe(1);
  const input=supplier();directoryCalls=0;
  const write=await app.inject({method:"POST",url:"/master-data/suppliers",headers:headers(session.token),payload:input});
  expect(write.statusCode,write.body).toBe(403);expect(directoryCalls).toBe(1);
  expect((await f.db.query("SELECT count(*)::int n FROM supplier_catalog_versions WHERE supplier_name=$1",[input.supplierName])).rows[0].n).toBe(0);
 });
});
