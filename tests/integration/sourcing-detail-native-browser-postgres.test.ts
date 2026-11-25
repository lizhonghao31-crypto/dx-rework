import {afterAll,beforeAll,describe,expect,it,vi} from "vitest";
import {createHash,randomUUID} from "node:crypto";
import {createServer,type Server} from "node:http";
import {mkdtemp,mkdir,readFile,writeFile,rm} from "node:fs/promises";
import {join,resolve,extname} from "node:path";
import {tmpdir} from "node:os";
import {build} from "vite";
import sharp from "sharp";
import type {Browser,Page,chromium as Chromium} from "playwright-core";
import {loadConfig} from "@dx-rework/config";
import {buildApp} from "../../apps/api/src/app.js";
import {AuthService} from "../../apps/api/src/auth/service.js";
import {PostgresAuthStore} from "../../apps/api/src/auth/postgres-store.js";
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.js";
import {RootAuthority} from "../../apps/api/src/access/root-authority.js";
import {ExportJobService} from "../../apps/api/src/tools/exports.js";
import {SourcingProductionService} from "../../apps/api/src/sourcing/sourcing-production-service.js";
import {SourcingService} from "../../apps/api/src/sourcing/sourcing-service.js";
import {SourcingContractReturnService} from "../../apps/api/src/sourcing/sourcing-contract-return-service.js";
import {ManagementReportingService} from "../../apps/api/src/reporting/management-reporting-service.js";
import {ReportExportService} from "../../apps/api/src/reporting/report-export-service.js";
import {ProcessConfigurationService} from "../../apps/api/src/rework/process-configuration-service.js";
import {ProcessWorkerPlanService} from "../../apps/api/src/rework/process-worker-plan-service.js";
import {TodoService} from "../../apps/api/src/todos/service.js";
import {TodoProjectionService} from "../../apps/api/src/todos/projection-service.js";
import {businessAnchorFixture} from "../helpers/business-anchor-fixture.js";
import {decideSeenSourcingOwner} from "../helpers/sourcing-owner-approval-fixture.js";
import {testExecutionConfig} from "../../scripts/test-execution-config.mjs";
vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)("architecture C sourcing through production App and native signed TEST identity",()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,app:ReturnType<typeof buildApp>,browser:Browser,server:Server,output:string,base:string,token:string,ieToken:string,ownerToken:string,merchToken:string,approvalService:SourcingService;
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
  const todos=new TodoService(f.db);
  approvalService=new SourcingService(f.db,undefined,undefined,new TodoProjectionService(todos),f.contracts,undefined,root);
  app=buildApp({config,auth,checkDatabase:async()=>undefined,getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:f.access},
   sourcing:{authenticate,root,service:f.sourcing,contracts:f.contracts,production:new SourcingProductionService(f.db),contractReturns:new SourcingContractReturnService(f.db)},
   todos:{authenticate,root,service:todos,merchandiserWorkbench:true},
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
  const ownerIdentity=(await f.db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[f.people.owner!.actorId])).rows[0]?.provider_user_id;
  expect(ownerIdentity).toMatch(/^uat-/);
  ownerToken=(await auth.loginMobile(mintAcceptanceLoginCode(ownerIdentity.slice(4),secret))).token;
  const merchIdentity=(await f.db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[f.people.merchandiser!.actorId])).rows[0]?.provider_user_id;
  expect(merchIdentity).toMatch(/^uat-/);
  merchToken=(await auth.loginMobile(mintAcceptanceLoginCode(merchIdentity.slice(4),secret))).token;
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
 it("uses the original versioned contract receipt from the signed merchandiser workbench and retries the same write",async()=>{
  const previous=process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;
  process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT='2020-01-01T00:00:00Z';
  const merch=f.people.merchandiser!,manager=f.people['production-management']!,owner=f.people.owner!,style=`TEST-X6-${randomUUID()}`;
  const context=await browser.newContext({viewport:{width:1165,height:747}});
  await context.addCookies([{name:'dx_rework_session',value:merchToken,url:base}]);
  try{
   const craft=(await f.access.ensureCrafts(manager,{craftNames:['TEST X6 industrial sewing']}))[0]!,prices=[{position:1,unitPrice:'5'}];
   const order=await approvalService.createCase(merch,{gender:'男装',styleName:'TEST X6 original contract',deliveryDate:'2026-12-20',
    estimatedCutPieceSendDate:'2026-11-10',daxingUnitPrice:'5',lineItems:[{styleNo:style,color:'黑',quantity:10}]},randomUUID());
   const id=order.value.sourcingCaseId;
   await approvalService.quoteIePrice(f.people.ie!,id,{linePrices:prices},randomUUID());
   await approvalService.recordManagementDecision(manager,id,{linePrices:prices,craftIds:[craft.craftId],supplierId:f.supplierId,cuttingProcess:'in_house'},randomUUID());
   await decideSeenSourcingOwner(approvalService,owner,id,{decision:'approved'},randomUUID());
   const path=`/api/sourcing/cases/${id}/contract-return`;
   const page=await context.newPage();page.setDefaultTimeout(12000);
   const state=await context.request.get(base+path);expect(state.status(),await state.text()).toBe(200);
   const before=await state.json();expect(before).toMatchObject({canUpload:true,currentContractReturned:false,currentContractDocumentId:expect.any(String)});
   const documentId=before.currentContractDocumentId;
   let transfers=0;
   await page.route('https://private.example.test/',async route=>{
    const body=route.request().postDataBuffer()!,type=route.request().headers()['content-type']!;
    const form=await new Response(new Uint8Array(body),{headers:{'content-type':type}}).formData(),file=form.get('file'),key=form.get('key');
    if(!(file instanceof Blob)||typeof key!=='string')throw Error('Expected the real signed attachment form');
    const bytes=new Uint8Array(await file.arrayBuffer()),sha256=createHash('sha256').update(bytes).digest('hex');
    expect(sha256).toBe(form.get('x-oss-meta-sha256'));
    await f.storage.writeImmutable(key,bytes,{mimeType:file.type,sha256});transfers++;
    await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
   });
   const attempts:Array<{body:unknown;key:string|undefined}>=[];
   await page.route('**'+path,async route=>{
    if(route.request().method()!=='POST')return route.continue();
    attempts.push({body:route.request().postDataJSON(),key:route.request().headers()['idempotency-key']});
    if(attempts.length!==1)return route.continue();
    const accepted=await route.fetch();expect(accepted.status(),await accepted.text()).toBe(200);await route.abort('failed');
   });
   const home=`${base}/ui/digital-production?workspace=merchandiser&kind=sourcing&search=${encodeURIComponent(style)}`;
   await page.goto(home);const list=page.getByRole('region',{name:'待我办理',exact:true});
   await list.getByRole('button',{name:'办理本单回签',exact:true}).click();
   const summary=page.getByRole('region',{name:'本单摘要',exact:true});
   await summary.getByText(/工厂 TEST anchor factory/).waitFor();
   const panel=page.getByRole('region',{name:'本单合同回传',exact:true});
   await panel.getByRole('link',{name:'下载本版合同',exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('search')).toBe(style);
   const image=await sharp({create:{width:2,height:2,channels:3,background:'#164e63'}}).png().toBuffer();
   await panel.locator('input[type=file]').setInputFiles({name:'TEST original X6 signing.png',mimeType:'image/png',buffer:image});
   await panel.getByRole('alert').waitFor();
   expect(attempts,`transfers=${transfers}; ${await panel.getByRole('alert').innerText()}`).toHaveLength(1);
   await panel.getByRole('button',{name:'核对同一次回签',exact:true}).click();
   await panel.getByRole('status').filter({hasText:'本版回签已保存。'}).waitFor();
   expect(attempts).toHaveLength(2);expect(attempts[0]).toEqual(attempts[1]);expect(transfers).toBe(1);
   expect(attempts[0]?.body).toMatchObject({expectedContractDocumentId:documentId,attachmentIds:[expect.any(String)]});
   const stored=await (await context.request.get(base+path)).json();
   expect(stored).toMatchObject({currentContractDocumentId:documentId,currentContractReturned:true,uploadedFileCount:1,
    versions:[{revision:1,signedContractDocumentId:documentId,attachments:[{filename:'TEST original X6 signing.png'}]}]});
   await panel.getByRole('button',{name:'返回跟单列表',exact:true}).click();
   await list.getByText('没有符合当前授权及筛选的原跟单事项。',{exact:true}).waitFor();
   await expect.poll(()=>page.evaluate(()=>document.activeElement?.textContent)).toBe('待我办理');
   expect(new URL(page.url()).searchParams.get('search')).toBe(style);
   await page.goto(base+`/ui/sourcing/orders/${id}?section=contract-return`);
   await page.getByRole('link',{name:'查看 V1 回签合同',exact:true}).waitFor();
   expect((await (await context.request.get(base+path)).json()).contractReturnedAt).toBe(stored.contractReturnedAt);
  }finally{await context.close();if(previous===undefined)delete process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT;else process.env.CONTRACT_RETURN_MONITOR_ENABLED_AT=previous;}
 });
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
  await page.route("**"+casePath+"/detail-sections*",async route=>{
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
   const desktop=page.getByLabel('桌面端主导航',{exact:true});
   const group=desktop.locator('details').filter({has:page.getByText('产品开发打板',{exact:true})});
   if(await group.getAttribute('open')===null)await group.locator('summary').click();
   const center=group.locator('a[href="/ui/ie-processing?directory=unified"]').filter({hasText:"IE 报价与核价中心"});
   await center.click();
   await page.waitForURL(url=>url.pathname.endsWith('/ui/ie-processing')&&url.searchParams.get('directory')==='unified');
   await page.getByRole('region',{name:'IE 报价与核价目录',exact:true}).waitFor();
   // The sidebar now opens the unified directory, while the former sourcing
   // tab remains an independently supported legacy bookmark.
   await page.goto(base+'/ui/ie-processing?channel=sourcing&search=&page=1');
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
    await page.setViewportSize({width:390,height:844});
    expect(await page.locator(".mobile-primary-navigation").count()).toBe(0);
    await page.getByRole("link",{name:"返回 IE 报价与核价中心",exact:true}).click();
    await original.waitFor();
    await expect.poll(()=>original.evaluate(node=>node===document.activeElement)).toBe(true);
    expect(new URL(page.url()).searchParams.get("search")).toBe(row.rework_no);
    expect(new URL(page.url()).searchParams.get("queue")).toBe("pending_ie_review");
    detail.searchParams.delete("ieReturn");
    const originalRead=page.waitForResponse(value=>value.request().method()==="GET"
      &&new URL(value.url()).pathname.endsWith(`/rework-orders/${id}/process-configuration`));
    await page.goto(detail.href);
    expect((await originalRead).status()).toBe(200);
    expect(await page.getByRole("link",{name:"返回 IE 报价与核价中心",exact:true}).count()).toBe(0);
    expect(await page.locator(".mobile-primary-navigation").count()).toBe(0);
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

 it("freezes the actual pending owner view and restores the exact committed approval before recovering a failed read",async()=>{
  const merch=f.people.merchandiser!,manager=f.people["production-management"]!,owner=f.people.owner!,prices=[{position:1,unitPrice:"5"}];
  const craft=(await f.access.ensureCrafts(manager,{craftNames:["TEST车缝"]}))[0]!;
  const pending=async()=>{
   const created=await approvalService.createCase(merch,{gender:"男装",styleName:"TEST同版老板审批",deliveryDate:"2026-12-20",
    estimatedCutPieceSendDate:"2026-11-10",daxingUnitPrice:"5",attachmentIds:[await f.image(merch)],
    lineItems:[{styleNo:"TEST-SEEN-OWNER-"+randomUUID(),color:"黑",quantity:10}]},randomUUID());
   const id=created.value.sourcingCaseId;
   await approvalService.quoteIePrice(f.people.ie!,id,{linePrices:prices},randomUUID());
   await approvalService.recordManagementDecision(manager,id,{linePrices:prices,craftIds:[craft.craftId],supplierId:f.supplierId,cuttingProcess:"in_house"},randomUUID());
   return id;
  };
  const context=await browser.newContext({viewport:{width:1165,height:1003}});
  await context.addCookies([{name:"dx_rework_session",value:ownerToken,url:base}]);
  const page=await context.newPage();page.setDefaultTimeout(12000);
  const approve=page.getByRole("button",{name:"批准方案",exact:true});
  const waitApproval=async(id:string)=>{
   await page.goto(base+"/ui/sourcing/orders/"+id+"?node=owner");
   await expect.poll(()=>approve.isEnabled()).toBe(true);
  };
  try{
   const id=await pending();
   const openCaseFrom=async(path:string)=>{
    await page.goto(base+path);
    await page.locator(`a[href*="/ui/sourcing/orders/${id}"]`).first().click();
    await page.waitForURL(url=>url.pathname===`/ui/sourcing/orders/${id}`);
    await expect.poll(()=>approve.isEnabled()).toBe(true);
   };
   await openCaseFrom("/ui/sourcing/pending");
   await openCaseFrom("/ui/my-tasks?module=sourcing");
   await waitApproval(id);
   const budget=page.locator(".sourcing-budget-price-value").first();
   expect(Number((await budget.textContent())?.replace(/[^\d.]/g,""))).toBe(5);
   const returnButton=page.getByRole("button",{name:"退回跟单修改",exact:true});
   await returnButton.click();
   const reason="TEST 保留这条人工意见";
   const dialog=page.getByRole("dialog",{name:"退回跟单修改",exact:true});
   await dialog.getByRole("textbox").fill(reason);
   await f.sourcing.correctBudgetPrice({...f.root,authorizationCapability:"sourcing:inquiry:create"},id,{daxingUnitPrice:"6",reason:"TEST 合法更正"},randomUUID());
   const stale=page.waitForResponse(response=>response.request().method()==="POST"&&new URL(response.url()).pathname===`/api/sourcing/cases/${id}/return-to-merchandiser`);
   await dialog.getByRole("button",{name:"确认退回",exact:true}).click();
   expect((await stale).status()).toBe(409);
   await page.getByText("审批内容已更新，请刷新后重新核对",{exact:true}).waitFor();
   expect(await approve.isDisabled()).toBe(true);
   expect((await f.sourcing.getCase({...owner,authorizationCapability:"sourcing:view"},id)).status).toBe("pending_owner_approval");
   await page.getByRole("button",{name:"重新读取订单",exact:true}).click();
   await expect.poll(()=>approve.isEnabled()).toBe(true);
   expect(Number((await budget.textContent())?.replace(/[^\d.]/g,""))).toBe(6);
   await returnButton.click();
   expect(await dialog.getByRole("textbox").inputValue()).toBe(reason);
   await dialog.getByRole("button",{name:"取消",exact:true}).click();

   const next=await pending();
   const posts:{body:string|null;key:string|null;status:number;replayed:string|undefined}[]=[];
   let failRead=false;
   await page.route(url=>url.pathname===`/api/sourcing/cases/${next}/detail-sections`&&url.searchParams.get("ownerReview")==="1",async route=>{
    if(!failRead)return route.continue();
    failRead=false;
    await route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"TEST_READ_FAILED",message:"TEST 提交成功后读取暂不可用"}})});
   });
   await page.route("**/api/sourcing/cases/"+next+"/owner-decisions",async route=>{
    const response=await route.fetch();
    posts.push({body:route.request().postData(),key:route.request().headers()["idempotency-key"]??null,status:response.status(),replayed:response.headers()["idempotency-replayed"]});
    if(posts.length===1){
     return route.fulfill({status:503,contentType:"application/json",body:JSON.stringify({error:{code:"TEST_RECEIPT_LOST",message:"TEST 原批准已提交但回执丢失"}})});
    }
    failRead=true;
    return route.fulfill({response});
   });
   await waitApproval(next);
   await approve.click();await dismiss(page);
   expect(await approve.isDisabled()).toBe(true);
   const pendingReadFailure=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/sourcing/cases/${next}/detail-sections`&&response.status()===503);
   await page.getByRole("button",{name:"核对上次提交结果",exact:true}).click();
   expect((await pendingReadFailure).status()).toBe(503);
   const confirmedReadWarning=page.getByText("已提交成功，刷新失败，请重新读取",{exact:true});
   await confirmedReadWarning.waitFor();
   const successfulRead=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/sourcing/cases/${next}/detail-sections`&&response.status()===200);
   await page.getByRole("button",{name:"重新读取订单",exact:true}).click();
   await successfulRead;
   await confirmedReadWarning.waitFor({state:"hidden"});
   expect(posts).toHaveLength(2);
   expect(posts[0]).toMatchObject({status:201});
   expect(posts[1]).toMatchObject({body:posts[0]!.body,key:posts[0]!.key,status:201,replayed:"true"});
   expect(JSON.parse(posts[0]!.body!)).toMatchObject({decision:"approved",expectedApprovalBasis:expect.stringMatching(/^[a-f0-9]{64}$/)});
   expect((await f.db.query("SELECT decision FROM sourcing_owner_decisions WHERE sourcing_case_id=$1",[next])).rows).toEqual([{decision:"approved"}]);
   expect(await page.getByRole("button",{name:"核对上次提交结果",exact:true}).count()).toBe(0);
  }finally{await context.close();}
 });
});
