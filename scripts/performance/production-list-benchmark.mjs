import {createHash,randomUUID} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import pg from 'pg';
import Fastify from 'fastify';
import {assertTestDatabaseTarget} from '../test-database-safety.mjs';
import {migrationExecutionSql} from '../deploy/migration-execution-compatibility.mjs';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.ts';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.ts';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.ts';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.ts';
import {RootAuthority} from '../../apps/api/src/access/root-authority.ts';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.ts';
import {registerDigitalAccessRoutes} from '../../apps/api/src/production-platform/access-routes.ts';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.ts';
import {registerDevelopmentRoutes} from '../../apps/api/src/production-platform/development-routes.ts';
import {ApplicationError} from '../../apps/api/src/platform/errors.ts';
// Explicit isolated TEST DB only. The fixture is retained for identical before/after samples.
await assertTestDatabaseTarget();
const evidence=process.env.DX_PERF_OUTPUT_DIR;if(!evidence)throw Error('DX_PERF_OUTPUT_DIR required');
await mkdir(evidence,{recursive:true});const manifestPath=`${evidence}/seed.json`,label=process.env.DX_PERF_LABEL??'baseline';
let manifest;try{manifest=JSON.parse(await readFile(manifestPath,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;}
const admin=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
if(!manifest)manifest={schema:`dx_pr12_perf_${randomUUID().replaceAll('-','').slice(0,8)}`,root:randomUUID(),designer:randomUUID(),stranger:randomUUID(),worker:randomUUID(),sourceIds:[],taskIds:[],createdBy:'dx-pr12-synthetic-only'};
if(!/^dx_pr12_perf_[0-9a-f]{8}$/.test(manifest.schema)||manifest.createdBy!=='dx-pr12-synthetic-only')throw Error('Unowned benchmark schema rejected');
const db=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL,options:`-c search_path=${manifest.schema}`,max:10});
let metric={queries:[],started:0};
db.on('connect',client=>{const original=client.query.bind(client);client.query=(...args)=>{const started=performance.now(),sql=typeof args[0]==='string'?args[0]:args[0]?.text??'';const pending=original(...args);if(!pending?.then)return pending;return pending.then(result=>{metric.queries.push({sql,ms:performance.now()-started,rows:result.rowCount});return result;});};});
const actor=(id,roles)=>({actorId:id,actorRoles:roles,authorizationCapability:'pattern_room:orders:create',authorizationCapabilities:['pattern_room:orders:create'],requestId:'TEST-PR12-benchmark'});
const identity=new DigitalProductionIdentityService(db,true),tasks=new DigitalProductionTaskService(db);
if(!manifest.sourceIds.length){
 await admin.query(`CREATE SCHEMA ${manifest.schema}`);
 const migrations=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')).migrations;
 await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
 const serverVersion=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
 for(const migration of migrations){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8');await db.query(migrationExecutionSql({...migration,sql},serverVersion));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
 for(const [id,role]of [[manifest.root,'owner_group'],[manifest.designer,'sample_designer'],[manifest.stranger,'sample_designer'],[manifest.worker,'pattern_room_worker']]){
  await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,`TEST-PR12 ${role}`]);
  await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);
  await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST benchmark')",[randomUUID(),id,role,manifest.root]);
 }
 await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1::uuid,$1::uuid::text,'TEST')",[manifest.root]);
 for(let i=0;i<60;i++){
  const source=await identity.createSource(actor(manifest.designer,['sample_designer']),{developmentType:'头版',designStyleNo:`TEST-P12-${i<20?'SMALL':'LARGE'}-${String(i).padStart(3,'0')}`,temporaryStyleNo:null,customerCode:null},randomUUID());manifest.sourceIds.push(source.sourceId);
  const routeId=randomUUID(),client=await db.connect();try{await client.query('BEGIN');for(const kind of ['development_materials','development_pattern','development_cutting','development_sewing','development_tail_check','development_confirmation']){const task=await tasks.createWithClient(client,actor(manifest.root,['root_superuser']),{resource:{kind:'source',id:source.sourceId},kind,routeId,routeVersion:1,occurrence:1,assigneeId:kind==='development_pattern'?manifest.worker:null});manifest.taskIds.push(task.taskId);}await client.query('COMMIT');}catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
 }
 manifest.seededAt=new Date().toISOString();await writeFile(manifestPath,JSON.stringify(manifest,null,2));
}
const app=Fastify();app.setErrorHandler((error,_request,reply)=>reply.code(error.statusCode??500).send({error:{message:error.message,code:error.code}}));
app.addHook('onRequest',async()=>{metric={queries:[],started:performance.now()};});
app.addHook('onSend',async(_request,reply)=>{reply.header('x-bench-sql-count',metric.queries.length).header('x-bench-sql-ms',metric.queries.reduce((sum,q)=>sum+q.ms,0).toFixed(3));});
await app.register(async routes=>{const dependencies={service:identity,journeys:new DigitalJourneyQuery(db),root:new RootAuthority(db,'TEST',undefined),creationEnabled:true,authenticate:async token=>{if(![manifest.root,manifest.designer,manifest.stranger,manifest.worker].includes(token))throw new ApplicationError('UNAUTHORIZED','TEST login required',401);const roles=(await db.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[token])).rows.map(r=>r.role_code),capabilities=(await db.query('SELECT DISTINCT capability FROM role_capabilities WHERE role_code=ANY($1::text[])',[roles])).rows.map(r=>r.capability);return {id:token,displayName:'TEST',businessRoles:roles,capabilities};}};registerDigitalIdentityRoutes(routes,dependencies);registerDigitalAccessRoutes(routes,dependencies,new DigitalProductionAccessService(db));registerDevelopmentRoutes(routes,dependencies,new DigitalDevelopmentService(db,true),undefined);},{prefix:'/api'});
app.get('/api/auth/me',async()=>({status:'authorized',user:{id:manifest.root,displayName:'TEST Root',businessRoles:['root_superuser'],capabilities:[],isRoot:true}}));
await app.listen({host:'127.0.0.1',port:4192});
const base='http://127.0.0.1:4192/api/digital-production',normalize=value=>JSON.parse(JSON.stringify(value,(key,item)=>key==='asOf'?undefined:item));
async function sample(path,id=manifest.root,cold=false){const start=performance.now(),response=await fetch(base+path,{headers:{cookie:`dx_rework_session=${id}`,...(cold?{connection:'close'}:{})}}),body=await response.json();if(!response.ok&&response.status!==403)throw Error(`HTTP ${response.status} ${JSON.stringify(body)}`);return {status:response.status,path,cold,wallMs:performance.now()-start,sqlCount:Number(response.headers.get('x-bench-sql-count')),sqlMs:Number(response.headers.get('x-bench-sql-ms')),jsonCodeUnits:JSON.stringify(body).length,body:normalize(body),queries:metric.queries};}
if(process.env.DX_PERF_SERVE==='1'){console.log(JSON.stringify({ready:true,pid:process.pid,base,seed:manifestPath,role:'TEST Root cookie from seed.json',label}));await new Promise(resolve=>process.once('SIGTERM',resolve));}
else{
 const scenarios=[['cockpit_page1','/journeys?page=1'],['cockpit_page3','/journeys?page=3'],['search_20','/journeys?search=SMALL'],['selected_source',`/journeys/${manifest.sourceIds[0]}`],['designer_page1','/workspaces/designer?page=1'],['pattern_page1','/workspaces/pattern?scope=all&state=all&page=1']];
 const samples=[];for(const [name,path]of scenarios){console.log(JSON.stringify({stage:'sampling',name,label}));await sample(path);for(const cold of [true,false])for(let i=0;i<12;i++){const result=await sample(path,manifest.root,cold);samples.push({name,iteration:i,...result});}}
 const oracle=[];for(const role of ['root','designer','stranger','worker'])for(const path of ['/journeys?page=1','/journeys?page=3','/journeys?search=SMALL','/journeys?state=active','/journeys?risk=unknown','/journeys?kpi=blocked','/workspaces/designer?page=1','/workspaces/designer?page=3','/workspaces/pattern?scope=mine&state=all'])oracle.push({role,path,...await sample(path,manifest[role])});
 const grouped={};for(const item of samples){const key=item.name+(item.cold?':fresh_http':':warm_http');(grouped[key]??=[]).push(item);}
 const percentile=(rows,p)=>[...rows].sort((a,b)=>a-b)[Math.ceil(rows.length*p)-1];
 const summary=Object.fromEntries(Object.entries(grouped).map(([key,rows])=>[key,{n:rows.length,p50Ms:percentile(rows.map(r=>r.wallMs),.5),p95Ms:percentile(rows.map(r=>r.wallMs),.95),sqlCount:rows[0].sqlCount,sqlMsP50:percentile(rows.map(r=>r.sqlMs),.5)}]));
 const sqlGroups={};for(const q of samples[0].queries){const group=sqlGroups[q.sql]??={count:0,totalMs:0};group.count++;group.totalMs+=q.ms;}
 const sourceFiles=['apps/api/src/production-platform/journey-query.ts','apps/api/src/production-platform/journey-task-summary.ts','apps/api/src/production-platform/development-workspace-query.ts','apps/web/src/digital-designer-workspace.tsx','packages/contracts/src/digital-production-journey.ts'];
 const sourceFileSha256=Object.fromEntries(await Promise.all(sourceFiles.map(async path=>{try{return [path,createHash('sha256').update(await readFile(new URL('../../'+path,import.meta.url))).digest('hex')];}catch(error){if(error.code!=='ENOENT')throw error;return [path,null];}})));
 const result={label,sourceFileSha256,sourceSha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),localOnly:true,acceptanceOrEcsSla:false,seed:manifest,conditions:'same owned schema, actual PostgreSQL16/Fastify production routes; serial requests; fresh HTTP connections versus warmed HTTP; DB buffer cache not flushed; 12 samples per mode; no performance SLA assertion',summary,sqlGroups:Object.entries(sqlGroups).sort((a,b)=>b[1].totalMs-a[1].totalMs),samples,oracle};await writeFile(`${evidence}/${label}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify({label,summary,topSql:result.sqlGroups.slice(0,4)},null,2));
}
await app.close();await db.end();await admin.end();
