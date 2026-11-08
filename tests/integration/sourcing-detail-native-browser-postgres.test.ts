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
import {SourcingProductionService} from "../../apps/api/src/sourcing/sourcing-production-service.js";
import {SourcingContractReturnService} from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("architecture C sourcing through production App and native signed TEST identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string,token:string;
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
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},sourcing:{authenticate,root,service:f.sourcing,contracts:f.contracts,production:new SourcingProductionService(f.db),contractReturns:new SourcingContractReturnService(f.db)}});
  await app.ready();token=(await auth.loginMobile(mintAcceptanceLoginCode("root",secret))).token;
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
