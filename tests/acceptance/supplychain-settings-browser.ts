import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer,type Server} from 'node:http';
import type {Browser,chromium as Chromium} from 'playwright-core';
import Fastify from 'fastify';
import {build} from 'vite';
import {AuthService,AuthDeniedError} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider,mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.js';
import {registerAuthRoutes} from '../../apps/api/src/auth/routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import type {ApplicationError} from '../../apps/api/src/platform/errors.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {ShortLeadService} from '../../apps/api/src/production-platform/short-lead-service.js';
export type SettingsBrowserFault={losePath?:string;lost?:boolean;failRead?:boolean;afterPublishRead?:boolean};
/** Original full App, original auth routes/store/membership and actual native
 * services. Only DingTalk and named transport faults are TEST adapters. */
export async function supplychainSettingsBrowser(url:string,evidence:string){
 const out=await mkdtemp(join(tmpdir(),'dx-settings-set-')),app=Fastify(),f=await businessAnchorFixture(url),db=f.db,secret='TEST paired settings native auth only '.repeat(4),root=new RootAuthority(db,'anchor-test','uat-root');
 const auth=new AuthService(new AcceptanceDingTalkProvider(db,'anchor-test',secret),new PostgresAuthStore(db,'anchor-test','uat-root'),'anchor-test',3600000,secret),errors:string[]=[],faults=new Map<string,SettingsBrowserFault>();
 const requests:Array<{session:string;path:string;method:string;key:string|null;bodyHash:string|null;status:number}>=[];
 let browser:Browser|undefined,server:Server|undefined,loginIndex=0;
 const dispose=async()=>{await browser?.close();if(server)await new Promise<void>(r=>server!.close(()=>r()));await app.close();await f.dispose();await rm(out,{recursive:true,force:true});};
 try{
  registerAuthRoutes(app,auth,{secureCookie:false,ttlSeconds:3600,appBasePath:'/',corpId:'anchor-test',mobileClientId:'TEST',webClientId:'TEST',qrRedirectUri:'https://acceptance.invalid/auth/qr/callback',isRootUser:id=>root.isRootUser(id)});
  app.setErrorHandler((error,_request,reply)=>{const e=error as ApplicationError;void reply.code(error instanceof AuthDeniedError?401:e.statusCode??500).send({error:{code:e.code,message:e.message}});});
  registerDigitalIdentityRoutes(app,{service:new DigitalProductionIdentityService(db,true),creationEnabled:true,root,authenticate:token=>auth.authenticate(token),accessService:new DigitalProductionAccessService(db),taskService:new DigitalProductionTaskService(db,secret),developmentService:new DigitalDevelopmentService(db,true),developmentExecution:new DevelopmentExecutionService(db,true),developmentAttachments:f.attachments,journeys:new DigitalJourneyQuery(db),seriesPlans:new SeriesPlanService(db,secret),shortLead:new ShortLeadService(db)});
  // Unrelated navigation indicator is a clearly labelled TEST response.
  app.get('/todos/mine/indicator',async(request,reply)=>{const user=await auth.authenticate(request.headers.cookie?.split(';').map(v=>v.trim()).find(v=>v.startsWith('dx_rework_session='))?.slice(18));reply.header('x-dx-rework-actor-id',user.id);return {pendingCount:0,unreadCount:0};});
  await app.ready();
  await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/m01-settings-native-ui.tsx'),name:'NativeSettingsUi',formats:['iife']}}});
  const files=await readdir(out),js=await readFile(join(out,files.find(p=>p.endsWith('.js'))!),'utf8'),css=await readFile(join(out,files.find(p=>p.endsWith('.css'))!),'utf8');
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  server=createServer(async(req,res)=>{try{
   const path=req.url??'/',session=(req.headers.cookie??'').split(';').map(v=>v.trim()).find(v=>v.startsWith('settings_fixture_session='))?.split('=')[1]??'unowned';
   if(!path.startsWith('/api/')){res.setHeader('content-type','text/html;charset=utf-8');res.end(html);return;}
   const chunks:Buffer[]=[];for await(const chunk of req)chunks.push(Buffer.from(chunk));const body=Buffer.concat(chunks).toString(),method=req.method??'GET',key=typeof req.headers['idempotency-key']==='string'?req.headers['idempotency-key']:null,fault=faults.get(session);
   if(fault?.failRead&&path==='/api/digital-production/sla-settings/sets'&&method==='GET'){fault.failRead=false;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_READ_FAILURE',message:'TEST 设置读取暂时失败'}}));return;}
   const result=await app.inject({method:method as 'GET'|'POST'|'PUT',url:path.slice(4),headers:{cookie:req.headers.cookie??'','content-type':'application/json',...(key?{'idempotency-key':key}:{})},...(body?{payload:body}:{})});
   requests.push({session,path,method,key,bodyHash:body?createHash('sha256').update(body).digest('hex'):null,status:result.statusCode});
   if(fault?.afterPublishRead&&path.endsWith('/sets/publish')&&result.statusCode===200)fault.failRead=true;
   if(fault?.losePath===path&&!fault.lost&&method==='POST'&&result.statusCode===200){fault.lost=true;res.writeHead(503,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_COMMITTED_RECEIPT_LOST',message:'TEST 已提交，回执暂时不可用'}}));return;}
   res.writeHead(result.statusCode,{'content-type':'application/json','cache-control':'no-store',...(result.headers['x-dx-rework-actor-id']?{'x-dx-rework-actor-id':result.headers['x-dx-rework-actor-id']}:{})});res.end(result.body);
  }catch(e){res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:{code:'TEST_NATIVE_HTTP',message:(e as Error).message}}));}});
  await new Promise<void>(r=>server!.listen(0,'127.0.0.1',r));const address=server.address();if(!address||typeof address==='string')throw Error('Owned loopback port missing');const base='http://127.0.0.1:'+address.port;
  const {chromium}:{chromium:typeof Chromium}=await import(process.env.PLAYWRIGHT_IMPORT??'playwright-core');browser=await chromium.launch({headless:true,...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{}),args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
  const admin={...f.root,authorizationCapability:'access:admin',authorizationCapabilities:['access:admin','master_data:manage']};
  const dedicated=async(role:string)=>{const id=randomUUID();await db.query('INSERT INTO app_users(id,display_name,enabled)VALUES($1,$2,true)',[id,'TEST settings set '+role]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at)VALUES($1,$2,'dingtalk','anchor-test',$3,$4,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,'uat-pair-'+id,'uat-union-pair-'+id]);const assignment=await f.access.assignRole(admin,{userId:id,roleCode:role,reason:'TEST isolated settings native identity'});return {id,assignmentId:assignment.assignmentId};};
  const login=async(id:string)=>{const mapping=(await db.query("SELECT provider_user_id FROM identity_mappings WHERE user_id=$1 AND corp_id='anchor-test' AND active AND employed",[id])).rows[0];assert(mapping?.provider_user_id.startsWith('uat-'));const response=await app.inject({method:'POST',url:'/auth/mobile',remoteAddress:'127.0.0.'+(++loginIndex),payload:{code:mintAcceptanceLoginCode(mapping.provider_user_id.slice(4),secret)}});assert.equal(response.statusCode,200,response.statusCode===200?undefined:response.body);const cookie=response.headers['set-cookie'],header=Array.isArray(cookie)?cookie[0]:cookie;assert.equal(typeof header,'string');const token=header!.split(';',1)[0]!.slice('dx_rework_session='.length);assert.equal((await auth.authenticate(token)).id,id);return token;};
  const open=async(id=f.root.actorId,width=1440,fault:SettingsBrowserFault={})=>{const context=await browser!.newContext({viewport:{width,height:960}}),session=randomUUID();faults.set(session,fault);await context.addCookies([{name:'dx_rework_session',value:await login(id),url:base},{name:'settings_fixture_session',value:session,url:base}]);const page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));await page.goto(base+'/ui/digital-cockpit?workspace=settings&fullApp=1');return {context,page,session};};
  const writeEvidence=()=>writeFile(join(evidence,'requests.json'),JSON.stringify({source:'Original App/AuthService/native services, isolated lowpriv TEST PG, only labelled external provider/transport adapters',requests,errors},null,2));
  return {f,db,auth,base,browser,open,dedicated,admin,requests,faults,errors,evidence,writeEvidence,dispose};
 }catch(e){await dispose();throw e;}
}
