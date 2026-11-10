import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {mkdtemp,mkdir,readFile,rm} from "node:fs/promises";
import {join,resolve,extname} from "node:path";
import {tmpdir} from "node:os";
import {build} from "vite";
import type {Browser,chromium as Chromium} from "playwright-core";
import {loadConfig} from "@dx-rework/config";
import {buildApp} from "../../apps/api/src/app.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import {ReceivingService} from "../../apps/api/src/receiving/receiving-service.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("architecture F4 receiving through production App and native signed TEST identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string;
 const ids:string[]=[],tokens=new Map<string,string>(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"receiving-board");
 const open=async(index:number,role="root",width=1165)=>{
  const context=await browser.newContext({viewport:{width,height:1003}});await context.addCookies([{name:"dx_rework_session",value:tokens.get(role)!,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);await page.goto(base+"/ui/orders?receivingBatchId="+ids[index]+"&returnTo=/ui/receiving");await page.locator(".order-board-row").waitFor();return {context,page};
 };
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);const secret="TEST architecture receiving native browser ".repeat(3),root=new RootAuthority(f.db,"anchor-test","uat-root");
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
  const config=loadConfig({NODE_ENV:"test",DATABASE_URL:url!,DINGTALK_CORP_ID:"anchor-test",DINGTALK_H5_APP_KEY:"TEST",DINGTALK_H5_APP_SECRET:secret,DINGTALK_WEB_CLIENT_ID:"TEST",DINGTALK_WEB_CLIENT_SECRET:secret,DINGTALK_QR_REDIRECT_URI:"https://architecture.invalid/auth/qr/callback",APP_BASE_PATH:"/",SESSION_SECRET:secret});
  const authenticate:typeof auth.authenticate=(token,context)=>auth.authenticate(token,context);
  // Native command creates isolated historical style-only receipts; this TEST
  // service option does not change runtime production configuration or routes.
  const receiving=new ReceivingService(f.db,undefined,undefined,undefined,{allowLegacyStyleInput:true});
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},receiving:{authenticate,root,service:receiving}});await app.ready();
  for(const role of ["root","warehouse"])tokens.set(role,(await auth.loginMobile(mintAcceptanceLoginCode(role,secret))).token);
  const warehouse={...f.people.warehouse!,authorizationCapability:"receiving:create",authorizationCapabilities:["receiving:create"]};
  for(let index=0;index<2;index++){
   const receipt=await receiving.create(warehouse,{styleNo:"TEST-ARCH-F4-"+index+"-"+randomUUID(),documentQuantity:10,actualQuantity:9,attachmentIds:[await f.image(warehouse)]},randomUUID());ids.push(receipt.value.receivingBatchId);
  }
  output=await mkdtemp(join(tmpdir(),"dx-receiving-board-native-"));const previous=process.env.NODE_ENV;
  try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
  const html=await readFile(join(output,"index.html"));
  server=createServer(async(request,response)=>{try{
   const path=request.url??"/";
   if(path.startsWith("/api/")){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks),headers={...request.headers,host:"architecture.invalid",origin:"https://architecture.invalid"};delete headers["content-length"];
    const reply=await app.inject({method:request.method as "GET"|"POST"|"PATCH"|"DELETE",url:path.slice(4),headers,...(payload.length?{payload}:{})});response.writeHead(reply.statusCode,reply.headers);response.end(reply.rawPayload);return;
   }
   if(path.startsWith("/assets/")){const asset=new URL(path,"http://TEST.invalid").pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset)){response.writeHead(400);response.end();return;}response.writeHead(200,{"content-type":extname(asset)===".css"?"text/css":"text/javascript"});response.end(await readFile(join(output,asset.slice(1))));return;}
   response.writeHead(200,{"content-type":"text/html;charset=utf-8"});response.end(html);
  }catch{response.writeHead(500);response.end();}});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();if(!address||typeof address==="string")throw Error("Owned native loopback required");base="http://127.0.0.1:"+address.port;
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??"playwright-core");browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:["--no-sandbox"]});await mkdir(evidence,{recursive:true});
 });
 afterAll(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await app?.close();await f?.dispose();if(output)await rm(output,{recursive:true,force:true});});
 it("recovers one committed packing after closing its unknown dialog without permitting another command",async()=>{
  const {context,page}=await open(0);try{
   const posts:Array<{body:string|null;key:string|null}>=[];
   await page.route("**/api/receiving/batches/"+ids[0]+"/packing-revisions",async route=>{
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null});const response=await route.fetch();expect(response.status()).toBe(201);
    if(posts.length===1)await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{message:"TEST committed packing lost receipt"}})});else await route.fulfill({response});
   });
   expect(await page.locator(".order-board-row").count()).toBe(1);expect(await page.getByLabel("开始日期",{exact:true}).count()).toBe(0);expect(await page.getByRole("link",{name:"返回仓库收货",exact:true}).count()).toBe(1);
   await page.getByRole("button",{name:"录入",exact:true}).click();await page.getByLabel("当前累计已装箱数量",{exact:true}).fill("9");await page.getByRole("button",{name:"保存",exact:true}).click();await page.getByRole("button",{name:"使用原内容核对提交结果",exact:true}).waitFor();
   await page.getByRole("dialog").getByRole("button",{name:"取消",exact:true}).click();await page.locator(".order-board-root-actions--desktop").getByRole("button",{name:"修改",exact:true}).click();expect(await page.getByRole("dialog").count()).toBe(0);expect(posts).toHaveLength(1);
   await page.getByRole("button",{name:"使用原内容核对提交结果",exact:true}).click();await page.getByText("原提交已确认保存",{exact:false}).waitFor();expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);
   expect((await f.db.query("SELECT count(*)::int n FROM receiving_packing_revisions WHERE receiving_batch_id=$1",[ids[0]])).rows[0].n).toBe(1);await page.screenshot({path:join(evidence,"native-packing-recovered-1165.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("records date precision in the original packing dialog and keeps quantity corrections without an invented actual time",async()=>{
  const {context,page}=await open(0);try{
   await page.locator('.order-board-packing-button').filter({hasText:'修改'}).click();
   const dialog=page.getByRole('dialog');expect(await dialog.getByLabel('实际装箱时间',{exact:true}).inputValue()).toBe('unknown');
   await dialog.getByLabel('实际装箱时间',{exact:true}).selectOption('date');const date='2026-01-01';await dialog.getByLabel('实际装箱日期',{exact:true}).fill(date);
   await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
   let saved=(await f.db.query("SELECT event.after_state->'packingActualTime' actual FROM receiving_packing_revisions revision JOIN operation_events event ON event.event_id=revision.operation_event_id WHERE revision.receiving_batch_id=$1 ORDER BY revision.created_at DESC LIMIT 1",[ids[0]])).rows[0]!.actual;
   expect(saved).toEqual({precision:'date',date});await page.getByText('实际 '+date,{exact:true}).waitFor();
   await page.locator('.order-board-packing-button').filter({hasText:'修改'}).click();expect(await dialog.getByLabel('实际装箱时间',{exact:true}).inputValue()).toBe('unknown');
   await dialog.getByLabel('当前累计已装箱数量',{exact:true}).fill('8');await dialog.getByRole('button',{name:'保存',exact:true}).click();await dialog.waitFor({state:'hidden'});
   saved=(await f.db.query("SELECT event.after_state->'packingActualTime' actual FROM receiving_packing_revisions revision JOIN operation_events event ON event.event_id=revision.operation_event_id WHERE revision.receiving_batch_id=$1 ORDER BY revision.created_at DESC LIMIT 1",[ids[0]])).rows[0]!.actual;expect(saved).toEqual({precision:'unknown'});
  }finally{await context.close();}
 });
 it("keeps native difference recovery reachable inside the modal and does not treat a GET as its receipt",async()=>{
  const {context,page}=await open(1);try{
   const posts:Array<{body:string|null;key:string|null}>=[];
   await page.route("**/api/receiving/batches/"+ids[1]+"/difference-resolutions",async route=>{
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null});const response=await route.fetch();expect(response.status()).toBe(201);
    if(posts.length===1)await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{message:"TEST committed difference lost receipt"}})});else await route.fulfill({response});
   });
   await page.getByRole("button",{name:"去处理",exact:true}).click();await page.getByLabel("处理结果",{exact:true}).fill("TEST native difference result");await page.getByRole("button",{name:"提交处理",exact:true}).click();const dialog=page.getByRole("dialog");await dialog.getByRole("button",{name:"使用原内容核对提交结果",exact:true}).waitFor();
   const read=page.waitForResponse(response=>new URL(response.url()).pathname==="/api/receiving/board"&&response.status()===200);await dialog.getByRole("button",{name:"仅重新读取回货记录",exact:true}).click();await read;expect(posts).toHaveLength(1);expect(await dialog.count()).toBe(1);
   await dialog.getByRole("button",{name:"使用原内容核对提交结果",exact:true}).click();await page.getByText("原提交已确认保存",{exact:false}).waitFor();expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect(await page.getByRole("dialog").count()).toBe(0);
   expect((await f.db.query("SELECT count(*)::int n FROM receiving_difference_resolutions WHERE receiving_batch_id=$1",[ids[1]])).rows[0].n).toBe(1);await page.screenshot({path:join(evidence,"native-difference-recovered-1165.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("retains the real warehouse role and exact-batch return path without exposing Root or merchandiser actions",async()=>{
  const {context,page}=await open(0,"warehouse",1440);try{
   expect(await page.locator(".order-board-row").count()).toBe(1);expect(await page.locator(".order-board-root-actions").count()).toBe(0);expect(await page.getByRole("button",{name:"去处理",exact:true}).count()).toBe(0);expect(await page.getByRole("link",{name:"＋ 仓库收货",exact:true}).count()).toBe(1);
   expect((await page.request.get(base+"/api/auth/me")).status()).toBe(200);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,"native-warehouse-1440.png"),fullPage:true});
  }finally{await context.close();}
 });
});
