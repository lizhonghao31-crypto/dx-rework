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
import {registerWageRoutes} from "../../apps/api/src/wages/wage-routes.js";
import {WageService} from "../../apps/api/src/wages/wage-service.js";
import {WageExportService} from "../../apps/api/src/wages/wage-export-service.js";
import {wagePageFixture} from "../helpers/wage-page-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("PERF11 full production App wage period pages with original signed identity and synthetic historical rows",()=>{
 let f:Awaited<ReturnType<typeof wagePageFixture>>,browser:Browser,server:Server,base:string,output:string,token:string;
 const app=Fastify(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"wage-period-pages"),requests:string[]=[];
 beforeAll(async()=>{
  f=await wagePageFixture(url!);output=await mkdtemp(join(tmpdir(),"dx-queue-pages-"));
  const secret="TEST wage pages native signed identity ".repeat(3),root=new RootAuthority(f.db,"anchor-test","uat-root");
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:"/",corpId:"anchor-test",mobileClientId:"TEST",webClientId:"TEST",qrRedirectUri:"https://acceptance.invalid/auth/qr/callback",isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  const authenticate=(value:string|undefined)=>auth.authenticate(value);
  registerWageRoutes(app,{service:new WageService(f.db),exportService:new WageExportService(f.db),root,authenticate});
  const provider=(await f.db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND active AND employed",[f.root.actorId])).rows[0]!;
  const login=await app.inject({method:"POST",url:"/auth/mobile",payload:{code:mintAcceptanceLoginCode(provider.provider_user_id.slice(4),secret)}});
  assert.equal(login.statusCode,200,login.body);const cookies=login.headers["set-cookie"];token=(Array.isArray(cookies)?cookies[0]:cookies)!.split(";",1)[0]!.slice("dx_rework_session=".length);
  assert.equal((await auth.authenticate(token)).id,f.root.actorId);
  const previous=process.env.NODE_ENV;try{process.env.NODE_ENV="production";await build({root:resolve("apps/web"),configFile:resolve("apps/web/vite.config.ts"),mode:"production",base:"/",build:{outDir:output,emptyOutDir:true}});}finally{if(previous===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previous;}
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
 it("keeps full-period totals while paging15 original cards and searching all wages in the real application",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   const initial=page.waitForResponse(r=>r.url().includes("/wage-periods/"+f.periodId+"?"));await page.goto(base+"/ui/wages/"+f.periodId);const first=await (await initial).json();
   await page.getByText("33 条当前结果",{exact:true}).waitFor();expect(await page.locator(".wage-item-card").count()).toBe(15);const summary=await page.locator(".wage-summary").innerText();
   const next=page.waitForResponse(r=>r.url().includes("/wage-periods/"+f.periodId+"?")&&new URL(r.url()).searchParams.get("page")==="2");await page.getByRole("navigation",{name:"工资期间明细分页",exact:true}).getByRole("button",{name:"2",exact:true}).click();const secondReply=await next;expect(secondReply.status(),await secondReply.text()).toBe(200);const second=await secondReply.json();
   await page.getByText("33 条当前结果",{exact:true}).waitFor();expect(await page.locator(".wage-item-card").count()).toBe(15);expect(new Set([...first.items,...second.items].map((x:{wageItemId:string})=>x.wageItemId)).size).toBe(30);expect(await page.locator(".wage-summary").innerText()).toBe(summary);
   await page.getByRole("searchbox").fill("TEST 普通返工");await page.getByText("11 条当前结果",{exact:true}).waitFor();expect(await page.locator(".wage-item-card").count()).toBe(11);expect(await page.locator(".wage-summary").innerText()).toBe(summary);
   expect(await page.locator("a.wage-export-link").getAttribute("href")).toBe("/api/wage-periods/"+f.periodId+"/export.xlsx");expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);await page.screenshot({path:join(evidence,"wage-period-filtered-1165.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("keeps the selected page on failed reads and ignores an obsolete search without displaying stale monetary rows",async()=>{
  const context=await browser.newContext();await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   await page.goto(base+"/ui/wages/"+f.periodId);await page.getByText("33 条当前结果",{exact:true}).waitFor();let fail=true;
   await page.route("**/wage-periods/"+f.periodId+"?**",async route=>{if(fail&&new URL(route.request().url()).searchParams.get("page")==="2"){await route.abort();return;}await route.continue();});
   await page.getByRole("navigation",{name:"工资期间明细分页",exact:true}).getByRole("button",{name:"2",exact:true}).click();await page.getByRole("button",{name:"重新读取工资详情",exact:true}).waitFor();expect(await page.locator(".wage-item-card").count()).toBe(0);
   fail=false;const retry=page.waitForResponse(r=>r.url().includes("/wage-periods/"+f.periodId+"?")&&new URL(r.url()).searchParams.get("page")==="2");await page.getByRole("button",{name:"重新读取工资详情",exact:true}).click();expect((await retry).status()).toBe(200);await page.getByText("33 条当前结果",{exact:true}).waitFor();expect(await page.getByRole("navigation",{name:"工资期间明细分页",exact:true}).getByRole("button",{name:"2",exact:true}).getAttribute("aria-current")).toBe("page");
   await page.unroute("**/wage-periods/"+f.periodId+"?**");let release=()=>{};const delayed=new Promise<void>(done=>{release=done;});
   await page.route("**/wage-periods/"+f.periodId+"?**",async route=>{if(new URL(route.request().url()).searchParams.get("q")==="NO_MATCH"){await delayed;try{await route.continue();}catch{/* Browser already aborted the superseded read. */}return;}await route.continue();});
   const stale=page.waitForRequest(r=>r.url().includes("q=NO_MATCH"));await page.getByRole("searchbox").fill("NO_MATCH");await stale;await page.getByRole("searchbox").fill("TEST 普通返工");await page.getByText("11 条当前结果",{exact:true}).waitFor();release();await page.waitForLoadState("networkidle");expect(await page.locator(".wage-item-card").count()).toBe(11);
  }finally{await context.close();}
 });
});
