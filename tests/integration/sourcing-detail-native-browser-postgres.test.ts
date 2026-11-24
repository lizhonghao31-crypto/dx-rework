import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {join,resolve,extname} from "node:path";
import {tmpdir} from "node:os";
import {build} from "vite";
import type {Browser,Page,chromium as Chromium} from "playwright-core";
import {loadConfig} from "@dx-rework/config";
import {buildApp} from "../../apps/api/src/app.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import {ExportJobService} from "../../apps/api/src/tools/exports.js";
import {SourcingProductionService} from "../../apps/api/src/sourcing/sourcing-production-service.js";
import {SourcingContractReturnService} from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import {ManagementReportingService} from "../../apps/api/src/reporting/management-reporting-service.js";
import {ReportExportService} from "../../apps/api/src/reporting/report-export-service.js";
import {ProcessConfigurationService} from "../../apps/api/src/rework/process-configuration-service.js";
import {ProcessWorkerPlanService} from "../../apps/api/src/rework/process-worker-plan-service.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("architecture C sourcing through production App and native signed TEST identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string,token:string,ieToken:string;
 const ids:string[]=[],styles:string[]=[],evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"sourcing-detail");
 const open=async(index:number,width=1165)=>{
  const context=await browser.newContext({viewport:{width,height:1003}});await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);
  const page=await context.newPage(),errors:string[]=[];page.on("pageerror",error=>errors.push(String(error)));page.setDefaultTimeout(12000);
  page.on("response",response=>{if(response.url().includes("/api/")&&response.status()>=400)errors.push(response.status()+" "+new URL(response.url()).pathname);});
  try{await page.goto(base+"/ui/sourcing/orders/"+ids[index]);await page.locator(".sourcing-workflow-rail").waitFor();await page.locator("fieldset.sourcing-submission-fields:enabled").waitFor();return {context,page};}
  catch(error){const body=await page.locator("body").innerText();await writeFile(join(evidence,"open-failure-"+index+".json"),JSON.stringify({errors,body}));await page.screenshot({path:join(evidence,"open-failure-"+index+".png"),fullPage:true});await context.close();throw Error(String(error)+"\n"+JSON.stringify({errors,body:body.slice(0,1800)}));}
 };
 const dismiss=async(page:Page)=>{await page.getByRole("dialog").getByRole("button",{name:"知道了",exact:true}).click();};
 beforeAll(async()=>{
  f=await businessAnchorFixture(url!);const secret="TEST architecture sourcing native browser ".repeat(3),root=new RootAuthority(f.db,"anchor-test","uat-root");
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
  const config=loadConfig({NODE_ENV:"test",DATABASE_URL:url!,DINGTALK_CORP_ID:"anchor-test",DINGTALK_H5_APP_KEY:"TEST",DINGTALK_H5_APP_SECRET:secret,DINGTALK_WEB_CLIENT_ID:"TEST",DINGTALK_WEB_CLIENT_SECRET:secret,DINGTALK_QR_REDIRECT_URI:"https://architecture.invalid/auth/qr/callback",APP_BASE_PATH:"/",SESSION_SECRET:secret});
  const authenticate:typeof auth.authenticate=(token,context)=>auth.authenticate(token,context);
  const photoGrants=new Map<string,{key:string;expiresAt:string}>();
  const grant=f.storage.createDownloadGrant.bind(f.storage);
  f.storage.createDownloadGrant=async(key,options)=>{
   const original=await grant(key,options),id=randomUUID();
   photoGrants.set(id,{key,expiresAt:original.expiresAt});
   return {...original,downloadUrl:base+"/api/__sourcing-photo-test-storage/"+id};
  };
  const reporting=new ManagementReportingService(f.db);
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},
   sourcing:{authenticate,root,service:f.sourcing,contracts:f.contracts,production:new SourcingProductionService(f.db),contractReturns:new SourcingContractReturnService(f.db)},
   reporting:{authenticate,root,service:reporting,exportService:new ReportExportService(reporting,f.db,"TEST-ie-center")},
   processConfiguration:{authenticate,root,service:new ProcessConfigurationService(f.db),workerPlan:new ProcessWorkerPlanService(f.db)},
   tools:{authenticate,isRootUser:id=>root.isRootUser(id),attachments:f.attachments,exports:new ExportJobService(f.db),
    canDownloadBoundAttachment:(actor,binding)=>Promise.resolve(f.sourcing.canDownloadBoundAttachment({
     actorId:actor.actorId,actorRoles:actor.actorRoles,authorizationCapability:"sourcing:view",
     authorizationCapabilities:actor.capabilities,requestId:"TEST-sourcing-attachment-download",
    },binding)),
   },
  });
  await app.ready();token=(await auth.loginMobile(mintAcceptanceLoginCode("root",secret))).token;
  const ieIdentity=(await f.db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[f.people.ie!.actorId])).rows[0]?.provider_user_id;
  expect(ieIdentity).toMatch(/^uat-/);
  ieToken=(await auth.loginMobile(mintAcceptanceLoginCode(ieIdentity.slice(4),secret))).token;
  for(let index=0;index<3;index++){
   const style="TEST-ARCH-C-"+index+"-"+randomUUID();styles.push(style);
   const created=await f.sourcing.createCase(f.people.merchandiser!,{gender:"男装",styleName:"TEST详情隔离",deliveryDate:"2026-12-20",estimatedCutPieceSendDate:"2026-11-10",daxingUnitPrice:"5",attachmentIds:[await f.image(f.people.merchandiser!)],lineItems:[{styleNo:style,color:"黑",quantity:10}]},randomUUID());
   ids.push(created.value.sourcingCaseId);
   if(index===0)await f.sourcing.quoteIePrice(f.people.ie!,ids[index]!,{linePrices:[{position:1,unitPrice:"5"}]},randomUUID());
  }
  output=await mkdtemp(join(tmpdir(),"dx-sourcing-detail-native-"));const previous=process.env.NODE_ENV;
  try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
  const html=await readFile(join(output,"index.html"));
  server=createServer(async(request,response)=>{try{
   const path=request.url??"/";
   const photoPath="/api/__sourcing-photo-test-storage/";
   if(path.startsWith(photoPath)){
    const grant=photoGrants.get(path.slice(photoPath.length));
    if(!grant||Date.parse(grant.expiresAt)<=Date.now()){response.writeHead(403);response.end();return;}
    const metadata=await f.storage.head(grant.key),bytes=await f.storage.readBytes(grant.key,1000000);
    response.writeHead(200,{"content-type":metadata.mimeType,"cache-control":"no-store"});
    response.end(Buffer.from(bytes));return;
   }
   if(path.startsWith("/api/")){
    const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));const payload=Buffer.concat(chunks);
    const headers={...request.headers,host:"architecture.invalid",origin:"https://architecture.invalid"};delete headers["content-length"];
    const reply=await app.inject({method:request.method as "GET"|"POST"|"PUT"|"DELETE",url:path.slice(4),headers,...(payload.length?{payload}: {})});response.writeHead(reply.statusCode,reply.headers);response.end(reply.rawPayload);return;
   }
   if(path.startsWith("/assets/")){const asset=new URL(path,"http://TEST.invalid").pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset)){response.writeHead(400);response.end();return;}response.writeHead(200,{"content-type":extname(asset)===".css"?"text/css":"text/javascript"});response.end(await readFile(join(output,asset.slice(1))));return;}
   response.writeHead(200,{"content-type":"text/html;charset=utf-8"});response.end(html);
  }catch{response.writeHead(500);response.end();}});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();if(!address||typeof address==="string")throw Error("Native test loopback required");base="http://127.0.0.1:"+address.port;
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??"playwright-core");browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:["--no-sandbox"]});await mkdir(evidence,{recursive:true});
 });
 afterAll(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await app?.close();await f?.dispose();if(output)await rm(output,{recursive:true,force:true});});
 it("shows authorized sourcing facts while records are pending or failed, then recovers without writes",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const casePath="/api/sourcing/cases/"+ids[1];
  const reads:string[]=[],writes:string[]=[];
  page.on("request",request=>{
   const path=new URL(request.url()).pathname;
   if(path!==casePath&&!path.startsWith(casePath+"/"))return;
   if(request.method()==="GET")reads.push(path.slice(casePath.length));else writes.push(request.method());
  });
  let release!:()=>void;
  const delay=new Promise<void>(done=>{release=done;});
  await page.route("**"+casePath+"/detail-sections",async route=>{
   await delay;
   await route.fulfill({status:503,contentType:"application/json",
    body:JSON.stringify({error:{message:"TEST 附属记录暂不可用"}})});
  });
  try{
   await page.goto(base+"/ui/sourcing/orders/"+ids[1]);
   const facts=page.getByLabel("外发定价选厂订单核心信息");
   await facts.waitFor();
   expect(await facts.textContent()).toContain("10 件");
   expect(await facts.textContent()).toContain("2026-12-20");
   expect(await page.getByRole("link",{name:"返回订单列表",exact:true}).isVisible()).toBe(true);
   expect(await page.getByRole("button",{name:"提交 IE 逐款价格",exact:true}).count()).toBe(0);
   release();
   await page.getByRole("alert").filter({hasText:"TEST 附属记录暂不可用"}).waitFor();
   expect(await facts.isVisible()).toBe(true);
   expect(await page.getByRole("button",{name:"提交 IE 逐款价格",exact:true}).count()).toBe(0);
   await page.getByRole("button",{name:"重新读取图片、时间线和转厂记录",exact:true}).click();
   await page.locator("fieldset.sourcing-submission-fields:enabled").waitFor();
   expect(await facts.isVisible()).toBe(true);
   expect(reads.filter(path=>path==="")).toHaveLength(3);
   for(const endpoint of ["/contract","/dispatch","/contract-return"]){
    expect(reads.filter(path=>path===endpoint)).toHaveLength(2);
   }
   for(const endpoint of ["/detail-sections","/attachments","/timeline","/factory-changes/current"]){
    expect(reads.filter(path=>path===endpoint)).toHaveLength(1);
   }
   expect(writes).toEqual([]);
  }finally{release();await context.close();}
 });
 it("shows only the current order photo before dispatch finishes and keeps actions unavailable",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);
  const page=await context.newPage();
  page.setDefaultTimeout(12000);
  const casePath="/api/sourcing/cases/"+ids[1];
  const otherCase=ids[2]!;
  const photos=await f.db.query<{attachment_id:string;entity_id:string}>(
   "SELECT attachment_id,entity_id FROM attachments WHERE entity_type='sourcing_case' AND entity_id=ANY($1::text[])",
   [[ids[1],otherCase]],
  );
  const currentPhoto=photos.rows.find(row=>row.entity_id===ids[1])!;
  const otherPhoto=photos.rows.find(row=>row.entity_id===otherCase)!;
  expect(currentPhoto.attachment_id).not.toBe(otherPhoto.attachment_id);
  let release!:()=>void;
  const delayed=new Promise<void>(done=>{release=done;});
  const writes:string[]=[];
  page.on("request",request=>{
   if(new URL(request.url()).pathname.startsWith(casePath)&&request.method()!=="GET")writes.push(request.method());
  });
  await page.route("**"+casePath+"/dispatch",async route=>{await delayed;await route.continue();});
  try{
   await page.goto(base+"/ui/sourcing/orders/"+ids[1]);
   const gallery=page.getByLabel("订单图片",{exact:true});
   await gallery.waitFor();
   const image=gallery.getByRole("img");
   expect(await image.getAttribute("src")).toContain(currentPhoto.attachment_id);
   expect(await image.getAttribute("src")).not.toContain(otherPhoto.attachment_id);
   await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
   await gallery.getByRole("button",{name:/放大查看/}).click();
   const dialog=page.getByRole("dialog").filter({has:page.getByRole("link",{name:"下载原图",exact:true})});
   await dialog.waitFor();
   expect(await dialog.getByRole("img").getAttribute("src")).toContain(currentPhoto.attachment_id);
   expect(await page.locator("fieldset.sourcing-submission-fields:enabled").count()).toBe(0);
   release();
   await page.locator("fieldset.sourcing-submission-fields:enabled").waitFor();
   expect(writes).toEqual([]);
  }finally{release();await context.close();}
 });
 it("preserves manual prices on the natural current to history to current path with no writable history forms",async()=>{
  const {context,page}=await open(0,1440);try{
   const input=page.locator('[aria-label="供应链总监逐款价格"] input').first();await input.focus();await input.fill("");expect(await input.inputValue()).toBe("");const timeOrigin=await page.evaluate(()=>performance.timeOrigin);await page.getByLabel("选厂/调价说明",{exact:false}).fill("TEST保留人工意见");
   await page.locator("a.sourcing-workflow-step").filter({hasText:"跟单创建订单"}).click();await page.locator(".sourcing-node-history").waitFor();
   expect(await page.locator(".sourcing-node-history input:not([readonly]),.sourcing-node-history form,.sourcing-node-history input[type=file]").count()).toBe(0);
   await page.getByRole("link",{name:"返回当前节点",exact:true}).click();await page.locator('[aria-label="供应链总监逐款价格"] input').first().waitFor();await page.locator("fieldset.sourcing-submission-fields:enabled").waitFor();
   expect(await page.evaluate(()=>performance.timeOrigin)).toBe(timeOrigin);expect(await page.getByLabel("选厂/调价说明",{exact:false}).inputValue()).toBe("TEST保留人工意见");expect(await input.inputValue()).toBe("");
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,"native-current-history-current-1440.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("recovers a genuinely committed quote after a controlled lost receipt using the original body and idempotency key",async()=>{
  const {context,page}=await open(1);try{
   const posts:{body:string|null;key:string|null}[]=[];
   await page.route("**/api/sourcing/cases/"+ids[1]+"/ie-quotes",async route=>{
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null});const response=await route.fetch();
    if(posts.length===1){expect(response.status()).toBe(201);await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"TEST_RECEIPT_LOST",message:"TEST提交后回执丢失"}})});}else await route.fulfill({response});
   });
   await page.locator('[aria-label="IE逐款价格"] input').first().fill("5");await page.getByRole("button",{name:"提交 IE 逐款价格",exact:true}).click();await dismiss(page);
   expect(await page.getByRole("button",{name:"核对上次提交结果",exact:true}).count()).toBe(1);
   await page.getByRole("link",{name:"返回订单列表",exact:true}).click();await page.getByRole("dialog",{name:"提交结果待确认"}).waitFor();await dismiss(page);expect(page.url()).toContain(ids[1]);
   await page.getByRole("button",{name:"核对上次提交结果",exact:true}).click();await page.getByRole("dialog",{name:"提交成功"}).waitFor();await dismiss(page);
   expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect((await f.db.query("SELECT count(*)::int n FROM sourcing_ie_quotes WHERE sourcing_case_id=$1",[ids[1]])).rows[0].n).toBe(1);
   await page.screenshot({path:join(evidence,"native-original-request-recovered-1165.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("opens the authorized original outside processing quote in the IE center and returns to the same search after saving",async()=>{
  const style="TEST-IE-CENTER-"+randomUUID();
  const merch=f.people.merchandiser!;
  const {value:record}=await f.sourcing.createCase(merch,{gender:"男装",styleName:"TEST核价中心",deliveryDate:"2026-12-20",
    estimatedCutPieceSendDate:"2026-11-10",daxingUnitPrice:"5",attachmentIds:[await f.image(merch)],
    lineItems:[{styleNo:style,color:"黑",quantity:10}]},randomUUID());
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  try{
   await context.addCookies([{name:"dx_rework_session",value:ieToken,url:base}]);
   const page=await context.newPage();page.setDefaultTimeout(12000);
   await page.goto(base+"/ui/sourcing/pending");
   await page.getByRole("link",{name:"IE 报价与核价中心",exact:true}).click();
   await page.getByRole("link",{name:"外发加工核价",exact:true}).click();
   await page.getByRole("textbox",{name:"搜索外发款号或单号",exact:true}).fill(style);
   await page.getByRole("button",{name:"搜索",exact:true}).click();
   await page.getByRole("link",{name:record.erpOrderNo,exact:true}).click();
   expect(new URL(page.url()).searchParams.get("caseId")).toBe(record.sourcingCaseId);
   const editor=page.locator('[aria-label="IE逐款价格"] input').first();
   await editor.fill("6.25");
   const submit=page.waitForResponse(response=>response.url().endsWith(`/sourcing/cases/${record.sourcingCaseId}/ie-quotes`)
     &&response.request().method()==="POST");
   await page.getByRole("button",{name:"提交 IE 逐款价格",exact:true}).click();
   expect((await submit).status()).toBe(201);
   await dismiss(page);
   const stored=await f.db.query("SELECT count(*)::int AS total FROM sourcing_ie_quotes WHERE sourcing_case_id=$1 AND quoted_by=$2",
    [record.sourcingCaseId,f.people.ie!.actorId]);
   expect(stored.rows[0].total).toBe(1);
   await page.getByRole("link",{name:"返回 IE 报价与核价中心",exact:true}).click();
   expect(new URL(page.url()).searchParams.get("search")).toBe(style);
   await page.getByText("暂无该条件下待核价的外发单。",{exact:true}).waitFor();
   await expect.poll(()=>page.getByRole("textbox",{name:"搜索外发款号或单号",exact:true})
    .evaluate(node=>node===document.activeElement)).toBe(true);
   const historyResponse=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname.endsWith('/sourcing/cases')&&url.searchParams.get('stage')==='ie_history';
   });
   await page.getByRole('combobox',{name:'外发核价范围'}).click();
   await page.getByRole('option',{name:'已办理记录',exact:true}).click();
   const listed=await historyResponse;
   expect(listed.status()).toBe(200);
   expect(await listed.json()).toMatchObject({totalCount:1,items:[{sourcingCaseId:record.sourcingCaseId,
    status:'pending_management_decision',ieQuote:{quotedBy:f.people.ie!.actorId}}]});
   await page.getByRole('link',{name:record.erpOrderNo,exact:true}).click();
   await page.getByRole('group',{name:'款式明细横向滚动'}).waitFor();
   expect(await page.getByRole('group',{name:'款式明细横向滚动'}).innerText()).toContain('6.25');
   expect(await page.getByRole('button',{name:'提交 IE 逐款价格',exact:true}).count()).toBe(0);
   await page.getByRole('link',{name:'返回 IE 报价与核价中心',exact:true}).click();
   await expect.poll(()=>page.getByRole('link',{name:record.erpOrderNo,exact:true}).evaluate(node=>node===document.activeElement)).toBe(true);
   expect(new URL(page.url()).searchParams.get('view')).toBe('history');
  }finally{await context.close();}
 });
 it("reaches the exact original rework queue row as the signed IE and returns to the same filtered queue",async()=>{
  await f.reworkReady(1,async id=>{
   const row=(await f.db.query("SELECT rework_no FROM rework_orders WHERE rework_order_id=$1",[id])).rows[0];
   expect(row.rework_no).toBeTruthy();
   const context=await browser.newContext({viewport:{width:1165,height:1003}});
   try{
    await context.addCookies([{name:"dx_rework_session",value:ieToken,url:base}]);
    const page=await context.newPage();page.setDefaultTimeout(12000);
    await page.goto(base+"/ui/ie-processing");
    await page.getByRole("link",{name:"返工核价与复核",exact:true}).click();
    await page.getByRole("textbox",{name:"搜索款号或原业务单号",exact:true}).fill(row.rework_no);
    await page.getByRole("button",{name:"搜索",exact:true}).click();
    const original=page.getByRole("link",{name:row.rework_no,exact:true});
    const [response]=await Promise.all([
     page.waitForResponse(value=>value.request().method()==="GET"&&new URL(value.url()).pathname.endsWith(`/rework-orders/${id}/process-configuration`)),
     original.click(),
    ]);
    const detail=new URL(page.url());
    expect(detail.pathname).toBe("/ui/process-configuration");
    expect(detail.searchParams.get("rework")).toBe(id);
    expect(response.status()).toBe(200);
    await page.getByRole("link",{name:"返回 IE 报价与核价中心",exact:true}).click();
    await original.waitFor();
    await expect.poll(()=>original.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(new URL(page.url()).searchParams.get("search")).toBe(row.rework_no);
    expect(new URL(page.url()).searchParams.get("queue")).toBe("pending_ie_review");
   }finally{await context.close();}
  });
 });
 it("does not carry a price proposal to another order along the original list and detail navigation",async()=>{
  const {context,page}=await open(2);try{
   await page.locator('[aria-label="IE逐款价格"] input').first().fill("7.25");await page.getByRole("link",{name:"返回订单列表",exact:true}).click();
   const dialog=page.getByRole("dialog");await dialog.waitFor();await dialog.getByRole("button",{name:"取消",exact:true}).click();expect(page.url()).toContain(ids[2]);
   await page.getByRole("link",{name:"返回订单列表",exact:true}).click();await dialog.getByRole("button",{name:"确认",exact:true}).click();
   await page.locator(`a[href*="/ui/sourcing/orders/${ids[0]}"]`).first().click();await page.locator('[aria-label="供应链总监逐款价格"] input').first().waitFor();await page.locator("fieldset.sourcing-submission-fields:enabled").waitFor();
   expect(await page.locator('[aria-label="供应链总监逐款价格"] input').first().inputValue()).toBe("5");expect((await page.request.get(base+"/api/auth/me")).status()).toBe(200);
  }finally{await context.close();}
 });
 it("recovers the native return modal internally after a committed response is lost, with exactly one transition",async()=>{
  const {context,page}=await open(0);try{
   const posts:{body:string|null;key:string|null}[]=[];
   await page.route("**/api/sourcing/cases/"+ids[0]+"/return-to-merchandiser",async route=>{
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null});const response=await route.fetch();
    if(posts.length===1){expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"TEST_RETURN_RECEIPT_LOST",message:"TEST退回回执丢失"}})});}else await route.fulfill({response});
   });
   await page.getByRole("button",{name:"退回跟单修改",exact:true}).click();const modal=page.getByRole("dialog",{name:"退回跟单修改",exact:true});
   await modal.getByLabel("退回原因 *",{exact:true}).fill("TEST原退回请求");await modal.getByRole("button",{name:"确认退回",exact:true}).click();await dismiss(page);
   const recovery=modal.getByRole("button",{name:"核对上次提交结果",exact:true});await recovery.waitFor();expect(await recovery.isEnabled()).toBe(true);expect(await modal.locator("textarea").isDisabled()).toBe(true);
   await page.screenshot({path:join(evidence,"native-return-modal-recovery-1165.png"),fullPage:true});await recovery.click();await modal.waitFor({state:"hidden"});await page.getByText("退回原因：TEST原退回请求",{exact:false}).waitFor();
   expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect((await f.db.query("SELECT count(*)::int n FROM sourcing_case_transitions WHERE sourcing_case_id=$1 AND business_action='returned_to_merchandiser'",[ids[0]])).rows[0].n).toBe(1);
  }finally{await context.close();}
 });
 it("recovers the native budget-correction modal internally with the same request and one stored correction",async()=>{
  const {context,page}=await open(2);try{
   const posts:{body:string|null;key:string|null}[]=[];
   await page.route("**/api/sourcing/cases/"+ids[2]+"/budget-price-corrections",async route=>{
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null});const response=await route.fetch();
    if(posts.length===1){expect(response.status()).toBe(200);await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"TEST_BUDGET_RECEIPT_LOST",message:"TEST预算更正回执丢失"}})});}else await route.fulfill({response});
   });
   await page.getByText("查看订单款式、交期与预算",{exact:true}).click();await page.getByRole("button",{name:"更正",exact:true}).click();const modal=page.getByRole("dialog",{name:"更正预算价",exact:true});
   await modal.getByLabel("新预算价",{exact:true}).fill("10.8");await modal.getByLabel("更正原因",{exact:true}).fill("TEST原预算更正请求");await modal.getByRole("button",{name:"确认更正",exact:true}).click();await dismiss(page);
   const recovery=modal.getByRole("button",{name:"核对上次提交结果",exact:true});await recovery.waitFor();expect(await recovery.isEnabled()).toBe(true);expect(await modal.getByLabel("新预算价",{exact:true}).isDisabled()).toBe(true);
   await page.screenshot({path:join(evidence,"native-budget-modal-recovery-1165.png"),fullPage:true});await recovery.click();await modal.waitFor({state:"hidden"});
   expect(posts).toHaveLength(2);expect(posts[1]).toEqual(posts[0]);expect((await f.db.query("SELECT count(*)::int n FROM sourcing_budget_price_corrections WHERE sourcing_case_id=$1",[ids[2]])).rows[0].n).toBe(1);
   expect((await f.db.query("SELECT new_unit_price::text price FROM sourcing_budget_price_corrections WHERE sourcing_case_id=$1",[ids[2]])).rows[0].price).toBe("10.8000");
  }finally{await context.close();}
 });

});
