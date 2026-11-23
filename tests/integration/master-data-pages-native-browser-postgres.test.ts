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
import {registerAccessRoutes} from "../../apps/api/src/access/routes.js";
import {masterDataPageFixture} from "../helpers/master-data-page-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("PERF12 full production App directories with original signed identity and native TEST records",()=>{
 let f:Awaited<ReturnType<typeof masterDataPageFixture>>,browser:Browser,server:Server,base:string,output:string,token:string;
 const app=Fastify(),evidence=join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),"master-data-pages"),requests:string[]=[];
 beforeAll(async()=>{
  f=await masterDataPageFixture(url!);output=await mkdtemp(join(tmpdir(),"dx-queue-pages-"));
  const secret="TEST wage pages native signed identity ".repeat(3),root=new RootAuthority(f.db,"anchor-test","uat-root");
  const auth=new AuthService(new AcceptanceDingTalkProvider(f.db,"anchor-test",secret),new PostgresAuthStore(f.db,"anchor-test","uat-root"),"anchor-test",3600000,secret);
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:"/",corpId:"anchor-test",mobileClientId:"TEST",webClientId:"TEST",qrRedirectUri:"https://acceptance.invalid/auth/qr/callback",isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const value=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:value.statusCode??500).send({error:{code:value.code,message:value.message}});});
  const authenticate=(value:string|undefined)=>auth.authenticate(value);
  registerAccessRoutes(app,{service:f.access,root,authenticate});
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
 it("shows current15 people and searches active aliases beyond the first page through the actual app",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  try{
   await page.goto(base+"/ui/people");await page.getByRole("searchbox",{name:"搜索人员"}).fill("TEST 目录人员");
   await page.waitForResponse(async r=>r.url().includes("/people-page?")&&new URL(r.url()).searchParams.get("q")==="TEST 目录人员"&&r.status()===200);
   await page.getByRole("navigation",{name:"临时工分页",exact:true}).getByRole("button",{name:"2",exact:true}).click();
   await page.getByText("TEST 目录人员 16",{exact:true}).waitFor();expect(await page.locator(".workforce-list article").count()).toBe(15);
   await page.getByRole("searchbox",{name:"搜索人员"}).fill("TEST目录别名31");await page.getByText("TEST 目录人员 31",{exact:true}).waitFor();expect(await page.locator(".workforce-list article").count()).toBe(1);
   expect(requests.some(path=>path.startsWith("/master-data/people?"))).toBe(false);await page.screenshot({path:join(evidence,"people-alias-1165.png"),fullPage:true});
  }finally{await context.close();}
 });
 it("retries page2 without stale rows and keeps original draft guards plus an independently selected off-page supplier",async()=>{
  const context=await browser.newContext({viewport:{width:1165,height:1003}});await context.addCookies([{name:"dx_rework_session",value:token,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);
  let abortedPage2Reads=0;
  try{
   await page.goto(base+"/ui/suppliers/manage?q="+encodeURIComponent("TEST 目录供应商")+"&status=all");await page.getByText("共 31 家",{exact:true}).waitFor();let fail=true;
   await page.route("**/master-data/supplier-page?**",async route=>{if(fail&&new URL(route.request().url()).searchParams.get("page")==="2"){abortedPage2Reads++;await route.abort();return;}await route.continue();});
   await page.getByRole("navigation",{name:"资料维护分页",exact:true}).getByRole("button",{name:"2",exact:true}).click();await page.getByRole("button",{name:"重新读取目录",exact:true}).waitFor();expect(abortedPage2Reads).toBe(1);expect(await page.locator(".supplier-records--manage tbody tr").count()).toBe(0);
   const retry=page.waitForResponse(response=>new URL(response.url()).pathname==='/api/master-data/supplier-page'&&new URL(response.url()).searchParams.get('page')==='2'&&response.request().method()==='GET');
   fail=false;await page.getByRole("button",{name:"重新读取目录",exact:true}).click();const retried=await retry;expect(retried.status(),await retried.text()).toBe(200);
   await page.getByRole('button',{name:'维护 TEST 目录供应商 16',exact:true}).waitFor();await page.getByText("共 31 家",{exact:true}).waitFor();expect(await page.locator(".supplier-records--manage tbody tr").count()).toBe(15);expect(await page.locator(".supplier-center-error").count()).toBe(0);expect(await page.getByRole("navigation",{name:"资料维护分页",exact:true}).getByRole("button",{name:"2",exact:true}).getAttribute("aria-current")).toBe("page");
   await page.getByRole("button",{name:"维护 TEST 目录供应商 16",exact:true}).click();const name=page.getByRole("textbox",{name:"供应商名称",exact:false});await name.waitFor();await name.fill("TEST 未保存编辑");await page.getByRole("button",{name:"返回目录",exact:true}).click();await page.getByRole("button",{name:"继续编辑",exact:true}).click();expect(await name.inputValue()).toBe("TEST 未保存编辑");
   const read=page.waitForResponse(r=>r.url().includes("/supplier-page?")&&new URL(r.url()).searchParams.get("q")==="TEST最后页工艺");await page.goto(base+"/ui/suppliers/manage?q="+encodeURIComponent("TEST最后页工艺")+"&status=all&supplierId="+f.supplierIds[0]);const one=await(await read).json();expect(one.items.map((x:{supplierId:string})=>x.supplierId)).toEqual([f.supplierIds[30]]);
   await name.waitFor();expect(await name.inputValue()).toBe("TEST 目录供应商 01");expect(new URL(page.url()).searchParams.get("supplierId")).toBe(f.supplierIds[0]);
   const unauth=await app.inject({method:"GET",url:"/master-data/supplier-page?page=1"});expect(unauth.statusCode).toBe(401);await page.screenshot({path:join(evidence,"supplier-selected-off-page-1165.png"),fullPage:true});
  }catch(error){
   console.error('PERF12_PAGE_RETRY_DIAGNOSTIC',JSON.stringify({abortedPage2Reads,requestPaths:requests.filter(path=>path.includes('/supplier-page?')).slice(-8),rows:await page.locator('.supplier-records--manage tbody tr').allTextContents(),errors:await page.locator('.supplier-center-error').allTextContents(),pagination:await page.getByRole('navigation',{name:'资料维护分页',exact:true}).innerText(),retryButtons:await page.getByRole('button',{name:'重新读取目录',exact:true}).count()}));
   await page.screenshot({path:join(evidence,'supplier-retry-failed-state.png'),fullPage:true});throw error;
  }finally{await context.close();}
 });
});
