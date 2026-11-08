import {beforeAll,afterAll,describe,it,expect,vi} from "vitest";
import {mkdtemp,readFile,rm,mkdir} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve,extname} from "node:path";
import {createServer,type Server} from "node:http";
import assert from "node:assert/strict";
import Fastify from "fastify";
import {build} from "vite";
import type {Browser,chromium as Chromium} from "playwright-core";
import {AuthService,AuthDeniedError} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import {registerAuthRoutes} from "../../apps/api/src/auth/routes.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import type {ApplicationError} from "../../apps/api/src/platform/errors.js";
import {registerResponsibilityDeterminationRoutes} from "../../apps/api/src/rework/responsibility-determination-routes.js";
import {registerOwnFactoryApprovalRoutes} from "../../apps/api/src/rework/own-factory-approval-routes.js";
import {registerExternalResponsibilityRoutes} from "../../apps/api/src/rework/external-responsibility-routes.js";
import {ResponsibilityDeterminationApplicationService} from "../../apps/api/src/rework/responsibility-determination-application-service.js";
import {OwnFactoryApprovalApplicationService} from "../../apps/api/src/rework/own-factory-approval-application-service.js";
import {ExternalResponsibilityApplicationService} from "../../apps/api/src/rework/external-responsibility-application-service.js";
import {responsibilityQueueFixture} from "../helpers/responsibility-queue-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("PERF10 full production App queue pages with signed native identity and synthetic historical rows",()=>{
 let f:Awaited<ReturnType<typeof responsibilityQueueFixture>>,browser:Browser,server:Server,base:string,output:string,token:string;
 const app=Fastify(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"responsibility-queues"),requests:string[]=[];
 beforeAll(async()=>{
  f=await responsibilityQueueFixture(url!);await f.initialize();output=await mkdtemp(join(tmpdir(),"dx-queue-pages-"));
  const secret="TEST queue pages native signed identity ".repeat(3),root=new RootAuthority(f.database,"anchor-test","uat-root");
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.database,"anchor-test",secret),new PostgresAuthStore(f.database,"anchor-test","uat-root"),"anchor-test",3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:"/",corpId:"anchor-test",mobileClientId:"TEST",webClientId:"TEST",qrRedirectUri:"https://acceptance.invalid/auth/qr/callback",isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  const authenticate=(value:string|undefined)=>auth.authenticate(value);
  registerResponsibilityDeterminationRoutes(app,{service:new ResponsibilityDeterminationApplicationService(f.database),root,authenticate});
  registerOwnFactoryApprovalRoutes(app,{service:new OwnFactoryApprovalApplicationService(f.database),root,authenticate});
  registerExternalResponsibilityRoutes(app,{service:new ExternalResponsibilityApplicationService(f.database),root,authenticate});
  const provider=(await f.database.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND active AND employed",[f.root.actorId])).rows[0]!;
  const login=await app.inject({method:"POST",url:"/auth/mobile",payload:{code:mintAcceptanceLoginCode(provider.provider_user_id.slice(4),secret)}});
  assert.equal(login.statusCode,200,login.body);const cookies=login.headers["set-cookie"];token=(Array.isArray(cookies)?cookies[0]:cookies)!.split(";",1)[0]!.slice("dx_rework_session=".length);
  assert.equal((await auth.authenticate(token)).id,f.root.actorId);
  const previous=process.env.NODE_ENV;try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{process.env.NODE_ENV=previous;}
  const html=await readFile(join(output,"index.html"));
  server=createServer(async(request,response)=>{try{
   const path=request.url??"/";
   if(path.startsWith("/api/")){requests.push(path);const reply=await app.inject({method:"GET",url:path.slice(4),headers:{cookie:request.headers.cookie??""}});response.writeHead(reply.statusCode,{"content-type":"application/json"});response.end(reply.rawPayload);return;}
   if(path.startsWith("/assets/")){const asset=new URL(path,"http://TEST.invalid").pathname;if(!/^\/assets\/[A-Za-z0-9_.-]+$/.test(asset)){response.writeHead(400);response.end();return;}const bytes=await readFile(join(output,asset.slice(1)));response.writeHead(200,{"content-type":extname(asset)===".css"?"text/css":"text/javascript"});response.end(bytes);return;}
   response.writeHead(200,{"content-type":"text/html;charset=utf-8"});response.end(html);
  }catch{response.writeHead(500);response.end();}});
  await new Promise<void>(done=>server.listen(0,"127.0.0.1",done));const address=server.address();assert(address&&typeof address!=="string");base="http://127.0.0.1:"+address.port;
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??"playwright-core");browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:["--no-sandbox"]});await mkdir(evidence,{recursive:true});
 });
 afterAll(async()=>{await browser?.close();if(server){server.closeAllConnections();await new Promise<void>(done=>server.close(()=>done()));}await app.close();await f?.dispose();if(output)await rm(output,{recursive:true,force:true});});
 it("keeps full201 counts and real15-row pages, searches beyond the former window and preserves handling links in all three routes",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   for(const [path,queue,label]of [["/ui/responsibility","responsibility-determinations","待责任判定分页"],["/ui/own-factory-approvals","own-factory-approvals","本厂承担审批分页"],["/ui/external-responsibilities","external-responsibilities","供应商扣款分页"]]){
    await page.goto(base+path);await page.getByText("201 条当前结果",{exact:true}).waitFor();expect(await page.locator(".responsibility-task-link").count()).toBe(15);
    const first=await page.locator(".responsibility-task-link").first().getAttribute("href"),nextReply=page.waitForResponse(r=>r.url().includes(queue!+"/queue?")&&new URL(r.url()).searchParams.get("page")==="2");await page.getByRole("navigation",{name:label!,exact:true}).getByRole("button",{name:"2",exact:true}).click();const reply=await nextReply;expect(reply.status(),await reply.text()).toBe(200);
    await expect.poll(()=>page.locator(".responsibility-task-link").count(),{timeout:12000}).toBe(15);await expect.poll(()=>requests.filter(p=>p.includes(queue!+"/queue?")&&p.includes("page=2")).length).toBeGreaterThan(0);await expect.poll(()=>page.locator(".responsibility-task-link").first().getAttribute("href")).not.toBe(first);
    const input=page.getByRole("searchbox");await input.fill("ONLY%_201");await page.getByText("1 条当前结果",{exact:true}).waitFor();expect(await page.locator(".responsibility-task-link").count()).toBe(1);
    expect(requests.some(p=>p.includes(queue!+"/queue?")&&p.includes("page=1")&&p.includes("search=ONLY%25_201"))).toBe(true);
    expect(await page.locator(".responsibility-task-link").getAttribute("href")).toMatch(/\/ui\/tasks\/[0-9a-f-]{36}$/);expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    await page.screenshot({path:join(evidence,queue+"-search.png"),fullPage:true});
   }
  }finally{await context.close();}
 });
 it("offers a page-specific retry after a real transport failure and ignores an obsolete search reply",async()=>{
  const context=await browser.newContext();await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   let fail=true;await page.route("**/responsibility-determinations/queue?**",async route=>{if(fail){await route.abort();return;}await route.continue();});
   await page.goto(base+"/ui/responsibility");await page.getByText("待判责队列加载失败",{exact:false}).waitFor();expect(await page.locator(".responsibility-task-link").count()).toBe(0);
   fail=false;await page.getByRole("button",{name:"重试读取本页",exact:true}).click();await page.getByText("201 条当前结果",{exact:true}).waitFor();
   await page.unroute("**/responsibility-determinations/queue?**");let release=()=>{};const delayed=new Promise<void>(done=>{release=done;});
   await page.route("**/responsibility-determinations/queue?**",async route=>{if(new URL(route.request().url()).searchParams.get("search")==="NO_MATCH"){await delayed;try{await route.continue();}catch{/* The obsolete browser request may already be aborted. */}return;}await route.continue();});
   const stale=page.waitForRequest(r=>r.url().includes("search=NO_MATCH"));await page.getByRole("searchbox").fill("NO_MATCH");await stale;await page.getByRole("searchbox").fill("ONLY%_201");await page.getByText("1 条当前结果",{exact:true}).waitFor();release();await page.waitForLoadState("networkidle");expect(await page.locator(".responsibility-task-link").count()).toBe(1);
  }finally{await context.close();}
 });
});

