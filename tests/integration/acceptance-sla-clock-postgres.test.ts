import {digitalTaskTiming} from '@dx-rework/domain/digital-task-deadline';
import {DigitalCockpitQuery} from '../../apps/api/src/production-platform/cockpit-query.js';
import {PatternRoomOrderService} from '../../apps/api/src/pattern-room/order-service.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {loadConfig} from '@dx-rework/config';
import {buildApp} from '../../apps/api/src/app.js';
import {AttachmentService} from '../../apps/api/src/tools/attachments.js';
import {DisabledObjectStorage} from '../../apps/api/src/tools/storage.js';
import {DigitalProductionAccessService} from '../../apps/api/src/production-platform/access-service.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {DigitalOrderCreateSchema,beijingCalendarDate} from '@dx-rework/contracts/digital-production';
import {SlaOrderService} from '../../apps/api/src/production-platform/sla-order-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {WorkerAwareAccessMasterDataService} from '../../apps/api/src/access/worker-aware-access-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import Fastify from 'fastify';
import {AuthService} from '../../apps/api/src/auth/service.js';
import {PostgresAuthStore} from '../../apps/api/src/auth/postgres-store.js';
import {AcceptanceDingTalkProvider} from '../../apps/api/src/auth/acceptance-provider.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {registerAcceptanceClockRoutes} from '../../apps/api/src/acceptance-clock/routes.js';
import {registerDigitalIdentityRoutes} from '../../apps/api/src/production-platform/identity-routes.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {AcceptanceClockControlService} from '../../apps/api/src/acceptance-clock/control-service.js';
import {clockRoots} from '../../apps/api/src/acceptance-clock/scope.js';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {migrationExecutionSql} from '../../scripts/deploy/migration-execution-compatibility.mjs';
import {assertTestDatabaseTarget} from '../../scripts/test-database-safety.mjs';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {verifyAcceptanceClockServer} from '../../apps/api/src/acceptance-clock/guard.js';
import {AcceptanceClockRuntime} from '../../apps/api/src/acceptance-clock/runtime.js';
import {businessNow,ContextBusinessClock,registerAcceptanceCreated} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {SlaConfigurationRepository} from '../../apps/api/src/production-platform/sla-configuration-repository.js';
import {mintAcceptanceControlCode,AcceptanceControlAuthority} from '../../apps/api/src/auth/acceptance-control.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';

const databaseUrl=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(databaseUrl?describe:describe.skip)('isolated Acceptance SLA business clock',()=>{
 const schema=ownedPostgresSchema('acceptance_clock'),admin=new pg.Pool({connectionString:databaseUrl}),db=new pg.Pool({connectionString:databaseUrl,options:`-c search_path=${schema}`});
 const rootId=randomUUID(),designerId=randomUUID(),realId=randomUUID(),workerId=randomUUID(),clerkId=randomUUID(),corp='clock-test',secret='TEST-only-clock-secret-'.repeat(3);
 const actor=(id=rootId):TrustedActorContext=>({actorId:id,actorRoles:id===rootId?['root_superuser','owner_group']:['sample_designer'],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view','pattern_room:orders:create'],requestId:randomUUID()});
 const environment={NODE_ENV:'test',ACCEPTANCE_LAB_ENABLED:'true',DINGTALK_CORP_ID:corp,ROOT_DINGTALK_USER_ID:'uat-root'};
 let runtime:AcceptanceClockRuntime;
 beforeAll(async()=>{
  await assertTestDatabaseTarget(databaseUrl);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')) as {migrations:Array<{version:string;checksum:string}>};
  const serverVersion=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const migration of manifest.migrations){const sql=await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8');await db.query(migrationExecutionSql({...migration,sql},serverVersion));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
  for(const [id,name,role] of [[rootId,'root','owner_group'],[designerId,'designer','sample_designer'],[realId,'real-person','sample_designer'],[workerId,'worker','pattern_room_worker'],[clerkId,'clerk','development_clerk'],[randomUUID(),'supervisor','pattern_room_supervisor'],[randomUUID(),'tail','pattern_room_tail_inspector']]){
   await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,`TEST clock ${name}`]);
   await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,corp,id===realId?'real-person':`uat-${name}`,id===realId?'real-union':`uat-union-${name}`]);
   await db.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');
   try{await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST isolated clock identities')",[randomUUID(),id,role,rootId]);}finally{await db.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
  }
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root',$2)",[rootId,corp]);
  await new WorkerAwareAccessMasterDataService(db,corp).ensureOrganizationPolicy();
  runtime=new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,databaseUrl!,environment),secret,true);
 },120000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('refuses disabled/production runtime and forged runtime proofs without querying business data',async()=>{
  await expect(verifyAcceptanceClockServer(db,databaseUrl!,{...environment,NODE_ENV:'production'})).rejects.toThrow(/refuses/);
  expect(()=>new AcceptanceClockRuntime(db,{} as never,secret,true)).toThrow(/verified/);
  // Restore only through the same genuine database/uat-root startup guard.
  runtime=new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,databaseUrl!,environment),secret,true);
 });
 it('creates only a new UAT source, freezes its actual standard reference and retries creation idempotently',async()=>{
  const input={name:'TEST完整开发链',requestKey:randomUUID()};
  const scene=await runtime.create(actor(designerId),input),retry=await runtime.create(actor(designerId),input);
  expect(retry.scenarioId).toBe(scene.scenarioId);expect(retry.sourceIds).toEqual(scene.sourceIds);expect(scene.sourceIds).toHaveLength(1);expect(scene.orderIds).toEqual([]);
  const source=(await db.query('SELECT * FROM digital_production_sources WHERE source_id=$1',[scene.sourceIds[0]])).rows[0];
  expect(source.created_by).toBe(designerId);
  const initial=(await db.query('SELECT * FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision',[scene.sourceIds[0]])).rows;
  expect(initial).toHaveLength(1);expect(initial[0].configuration_id).toBe(scene.configurationId);expect(initial[0].business_time).toMatchObject({scenarioId:scene.scenarioId,revision:scene.version,now:scene.now});
  await expect(runtime.create(actor(realId),{name:'TEST拒绝真实身份',requestKey:randomUUID()})).rejects.toMatchObject({statusCode:403});
  await expect(runtime.create(actor(rootId),input)).rejects.toMatchObject({statusCode:409});
 });
 it('rejects existing or cross-scenario bindings and keeps ordinary source history intact',async()=>{
  const old=await new DigitalProductionIdentityService(db,true).createSource(actor(realId),{developmentType:'头版',designStyleNo:`TEST-old-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID());
  const a=await runtime.create(actor(),{name:'TEST-A',requestKey:randomUUID()}),b=await runtime.create(actor(),{name:'TEST-B',requestKey:randomUUID()});
  await expect(runtime.run(a.scenarioId,actor(),()=>new ContextBusinessClock().read({kind:'source',id:b.sourceIds[0]!}))).rejects.toMatchObject({statusCode:409});
  await expect(runtime.run(a.scenarioId,actor(),()=>runtime.repository.transaction(async client=>{
   const auditId=randomUUID();await client.query("INSERT INTO audit_events(id,request_id,actor_id,action,entity_type,entity_id) VALUES($1,'TEST-forged-bind',$2,'digital_source_created','digital_production',$3)",[auditId,rootId,old.sourceId]);
   await registerAcceptanceCreated(client,{kind:'source',id:old.sourceId},rootId,auditId);
  }))).rejects.toThrow(/newly created UAT/);
  expect((await db.query("SELECT count(*)::int n FROM acceptance_sla_clock_resources WHERE resource_kind='source' AND resource_id=$1",[old.sourceId])).rows[0].n).toBe(0);
  expect((await db.query('SELECT business_time FROM digital_development_sla_plans WHERE source_id=$1',[old.sourceId])).rows[0].business_time.scenarioId).toBeNull();
 });
 it('advances once, rejects backwards/concurrent commands and persists across runtime recreation',async()=>{
  const scene=await runtime.create(actor(),{name:'TEST-monotonic',requestKey:randomUUID()}),key=randomUUID(),at=new Date(Date.parse(scene.now)+201*3600000).toISOString();
  const input={expectedVersion:scene.version,requestKey:key,at};
  const first=await runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,input));
  const retry=await runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,input));
  expect(first.replayed).toBe(false);expect(retry.replayed).toBe(true);expect(retry.effect).toEqual(first.effect);
  await expect(runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,{expectedVersion:scene.version+1,requestKey:randomUUID(),at:scene.now}))).rejects.toMatchObject({statusCode:409});
  const concurrent=await Promise.allSettled([1,2].map(n=>runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,{expectedVersion:scene.version+1,requestKey:randomUUID(),at:new Date(Date.parse(at)+n*3600000).toISOString()}))));
  expect(concurrent.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(concurrent.filter(r=>r.status==='rejected')).toHaveLength(1);
  const restored=new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,databaseUrl!,environment),secret,true);
  runtime=restored;
  const after=await restored.repository.view(scene.scenarioId);expect(after.version).toBe(scene.version+2);expect(Date.parse(after.now)).toBeGreaterThan(Date.parse(at));
  expect((await db.query('SELECT count(*)::int n FROM acceptance_sla_clock_events WHERE scenario_id=$1',[scene.scenarioId])).rows[0].n).toBe(2);
 });
 it('keeps authentication and audit time real while business time is virtual, and isolates concurrent scenes',async()=>{
  const scenes=await Promise.all(['A','B'].map(name=>runtime.create(actor(),{name:`TEST-scope-${name}`,requestKey:randomUUID()})));
  for(const [n,scene] of scenes.entries())await runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,{expectedVersion:scene.version,requestKey:randomUUID(),at:new Date(Date.parse(scene.now)+(n+1)*86400000).toISOString()}));
  const realBefore=Date.now(),code=mintAcceptanceControlCode(secret),authority=new AcceptanceControlAuthority(db,corp,secret);
  const times=await Promise.all(scenes.map(scene=>runtime.run(scene.scenarioId,actor(),async()=>{
   const token=await authority.begin(mintAcceptanceControlCode(secret));expect(token.length).toBeGreaterThan(20);
   const business=await new ContextBusinessClock().read({kind:'source',id:scene.sourceIds[0]!});
   expect(businessNow().toISOString()).toBe(business.now);expect(Date.now()-realBefore).toBeLessThan(10000);return business;
  })));
  expect(times[0]!.scenarioId).not.toBe(times[1]!.scenarioId);expect(times[0]!.now).not.toBe(times[1]!.now);
  await expect(authority.begin(code)).resolves.toEqual(expect.any(String));
  const recorded=(await db.query('SELECT max(recorded_at) at FROM acceptance_sla_clock_events')).rows[0].at as Date;
  expect(recorded.getTime()).toBeLessThan(Date.parse(times[0]!.now));
 });
 it('selects only an existing published reference for new test inputs and never publishes a global default from the scene',async()=>{
  const scene=await runtime.create(actor(),{name:'TEST-standard',requestKey:randomUUID()}),original=(await db.query('SELECT configuration_id FROM digital_development_sla_plans WHERE source_id=$1',[scene.sourceIds[0]])).rows[0].configuration_id;
  const next=await runtime.repository.transaction(async client=>{
   const repo=new SlaConfigurationRepository(client),current=(await repo.current())!;
   return repo.publish({expectedVersion:current.version,values:{...current.values,development_sewing:{kind:'duration',minutes:1200}},actorId:rootId,reason:'TEST fixture independent prior publication',requestKey:randomUUID()});
  });
  await runtime.run(scene.scenarioId,actor(),()=>runtime.repository.change(scene.scenarioId,rootId,{expectedVersion:scene.version,requestKey:randomUUID(),configurationId:next.configurationId}));
  await expect(runtime.run(scene.scenarioId,actor(),()=>runtime.repository.transaction(async client=>new SlaConfigurationRepository(client).publish({expectedVersion:next.version,values:next.values,actorId:rootId,reason:'TEST refused global change',requestKey:randomUUID()})))).rejects.toThrow(/不能发布全局/);
  const source=await runtime.run(scene.scenarioId,actor(),()=>new DigitalProductionIdentityService(db,true).createSource(actor(),{developmentType:'头版',designStyleNo:`TEST-new-standard-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID()));
  expect((await db.query('SELECT configuration_id FROM digital_development_sla_plans WHERE source_id=$1',[scene.sourceIds[0]])).rows[0].configuration_id).toBe(original);
  expect((await db.query('SELECT configuration_id FROM digital_development_sla_plans WHERE source_id=$1',[source.sourceId])).rows[0].configuration_id).toBe(next.configurationId);
  expect((await db.query('SELECT max(version)::int n FROM digital_sla_configurations')).rows[0].n).toBe(next.version);
 });
 it('resolves native scope, uses persisted scene time outside a request and scans only test receipts idempotently',async()=>{
  const scene=await runtime.create(actor(),{name:'TEST-native-scan',requestKey:randomUUID()}),control=new AcceptanceClockControlService(runtime);
  expect(await clockRoots(db,scene.sourceIds[0]!)).toEqual([{kind:'source',id:scene.sourceIds[0],scenarioId:scene.scenarioId}]);
  const at=new Date(Date.parse(scene.now)+3600000).toISOString(),key=randomUUID();
  const result=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:key,at});
  expect(result.scan.status).toBe('completed');
  expect(await new ContextBusinessClock(db).read({kind:'source',id:scene.sourceIds[0]!})).toMatchObject({now:at,scenarioId:scene.scenarioId});
  const retry=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:key,at});
  expect(retry.effect.replayed).toBe(true);expect(retry.scan).toMatchObject({status:'completed'});
  expect((await db.query('SELECT count(*)::int n FROM acceptance_sla_clock_scans WHERE scenario_id=$1',[scene.scenarioId])).rows[0].n).toBe(1);
  expect((await runtime.repository.view(scene.scenarioId)).lastScan?.status).toBe('completed');
  const later=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version+1,requestKey:randomUUID(),at:new Date(Date.parse(at)+3600000).toISOString()});
  const delayedRetry=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:key,at});
  expect(delayedRetry.effect.replayed).toBe(true);expect(delayedRetry.effect.effect.now).toBe(at);expect(delayedRetry.scene.now).toBe(later.scene.now);

 });

 it('keeps the original 4h business window, jumps exact thresholds, invalidates stale previews and never auto-completes work',async()=>{
  const scene=await runtime.create(actor(),{name:'TEST-clerk-boundaries',requestKey:randomUUID()}),control=new AcceptanceClockControlService(runtime),sourceId=scene.sourceIds[0]!,fileId=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[fileId,`TEST-clock/${fileId}`,'a'.repeat(64),rootId]);
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:fileId,kind:'款图'}]});
  const forms=new DigitalDevelopmentService(db,true);
  const published=await runtime.run(scene.scenarioId,actor(),async()=>{const draft=await forms.save(actor(),sourceId,{expectedVersion:0,document},randomUUID());return forms.publish(actor(),sourceId,draft.version,randomUUID());});
  const target=(await control.targets(scene.scenarioId,actor())).find(t=>t.id===published.taskId)!;
  expect(Date.parse(target.dueAt)-Date.parse(published.publishedAt!)).toBe(4*3600000);
  const preview=await control.preview(scene.scenarioId,actor(),{nodeId:target.id,boundary:'warning_before'});
  const jumped=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:randomUUID(),at:preview.at,previewToken:preview.token});
  expect(jumped.scan.status).toBe('completed');
  const old=await control.preview(scene.scenarioId,actor(),{nodeId:target.id,boundary:'warning'});
  await runtime.run(scene.scenarioId,actor(),()=>new DigitalProductionTaskService(db).prioritize(actor(),target.id,'urgent',randomUUID()));
  await expect(control.advance(scene.scenarioId,actor(),{expectedVersion:jumped.scene.version,requestKey:randomUUID(),at:old.at,previewToken:old.token})).rejects.toMatchObject({statusCode:409});
  const warning=await control.preview(scene.scenarioId,actor(),{nodeId:target.id,boundary:'warning'});
  const warned=await control.advance(scene.scenarioId,actor(),{expectedVersion:jumped.scene.version,requestKey:randomUUID(),at:warning.at,previewToken:warning.token});
  expect((await db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='warning'",[target.id])).rows[0].n).toBe(1);
  const due=await control.preview(scene.scenarioId,actor(),{nodeId:target.id,boundary:'due'});
  const atDue=await control.advance(scene.scenarioId,actor(),{expectedVersion:warned.scene.version,requestKey:randomUUID(),at:due.at,previewToken:due.token});
  const dueTask=await new DigitalProductionTaskService(db).read(actor(),target.id);
  expect(digitalTaskTiming({...dueTask,terminal:false},new Date(dueTask.acceptanceBusinessNow!)).state).not.toBe('overdue');
  const dueSummary=await new DigitalCockpitQuery(db).list(actor(),{page:1,search:published.designStyleNo,stage:'development'});
  expect(dueSummary.summary.overdue).toBe(0);

  expect((await db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[target.id])).rows[0].n).toBe(0);
  const after=await control.preview(scene.scenarioId,actor(),{nodeId:target.id,boundary:'due_after'});
  await control.advance(scene.scenarioId,actor(),{expectedVersion:atDue.scene.version,requestKey:randomUUID(),at:after.at,previewToken:after.token});
  expect((await db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[target.id])).rows[0].n).toBe(1);
  expect((await db.query('SELECT state FROM digital_production_tasks WHERE task_id=$1',[target.id])).rows[0].state).not.toBe('completed');
  await control.scan(scene.scenarioId,actor(),randomUUID());
  expect((await db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE task_id=$1 AND event_kind='overdue'",[target.id])).rows[0].n).toBe(1);
  const receipts=(await db.query('SELECT * FROM acceptance_sla_clock_receipts WHERE scenario_id=$1',[scene.scenarioId])).rows;
  expect(receipts.length).toBeGreaterThan(0);expect(receipts.every(r=>r.recipient_id!==realId)).toBe(true);
  const cockpit=await new DigitalCockpitQuery(db).list(actor(),{page:1,search:'',stage:'development'});
  expect(cockpit.summary.overdue).toBeGreaterThanOrEqual(1);

 });

 it('uses original control/business authentication, propagates HTTP context, and rejects mixed/ordinary resources',async()=>{
  const auth=new AuthService(new AcceptanceDingTalkProvider(db,corp,secret),new PostgresAuthStore(db,corp,'uat-root'),corp,3600000,secret);
  const controlToken=await auth.beginAcceptanceControl(mintAcceptanceControlCode(secret)),login=await auth.switchAcceptanceIdentity(controlToken,'root');
  const app=Fastify({logger:false});
  app.setErrorHandler((error,_request,reply)=>reply.code((error as {statusCode?:number}).statusCode??401).send({error:{message:error.message}}));
  registerAcceptanceClockRoutes(app,runtime,auth,new RootAuthority(db,corp,'uat-root'));
  registerDigitalIdentityRoutes(app,{service:new DigitalProductionIdentityService(db,true),creationEnabled:true,authenticate:token=>auth.authenticate(token),root:new RootAuthority(db,corp,'uat-root')});
  const cookie=`dx_acceptance_control=${controlToken}; dx_rework_session=${login.token}`;
  try{
   expect((await app.inject({method:'GET',url:'/acceptance/clock/scenarios'})).statusCode).toBe(401);
   const created=await app.inject({method:'POST',url:'/acceptance/clock/scenarios',headers:{cookie},payload:{name:'TEST-HTTP',requestKey:randomUUID()}});
   expect(created.statusCode,created.body).toBe(200);const scene=created.json();
   const advanced=await app.inject({method:'POST',url:`/acceptance/clock/scenarios/${scene.scenarioId}/advance`,headers:{cookie},payload:{expectedVersion:scene.version,requestKey:randomUUID(),at:new Date(Date.parse(scene.now)+86400000).toISOString()}});
   expect(advanced.statusCode,advanced.body).toBe(200);
   const source=await app.inject({method:'POST',url:'/digital-production/sources',headers:{cookie,'x-acceptance-scenario':scene.scenarioId,'idempotency-key':randomUUID()},payload:{developmentType:'头版',designStyleNo:`TEST-HTTP-created-${randomUUID()}`,temporaryStyleNo:null,customerCode:null}});
   expect(source.statusCode,source.body).toBe(200);const sourceId=source.json().sourceId;
   expect((await db.query('SELECT business_time FROM digital_development_sla_plans WHERE source_id=$1',[sourceId])).rows[0].business_time).toMatchObject({scenarioId:scene.scenarioId,now:advanced.json().scene.now});
   const other=await runtime.create(actor(),{name:'TEST-HTTP-other',requestKey:randomUUID()});
   const cross=await app.inject({method:'POST',url:`/digital-production/sources/${sourceId}/confirm`,headers:{cookie,'x-acceptance-scenario':other.scenarioId},payload:{}});
   expect(cross.statusCode).toBe(409);
   const plain=await new DigitalProductionIdentityService(db,true).createSource(actor(),{developmentType:'头版',designStyleNo:`TEST-plain-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID());
   expect((await app.inject({method:'POST',url:`/digital-production/sources/${plain.sourceId}/confirm`,headers:{cookie,'x-acceptance-scenario':scene.scenarioId},payload:{}})).statusCode).toBe(409);
   const ordinary=await app.inject({method:'GET',url:'/digital-production/sources',headers:{cookie}});
   expect(ordinary.statusCode,ordinary.body).toBe(200);expect(ordinary.headers['x-acceptance-clock']).toBeUndefined();
  }finally{await app.close();}
 });

 it('executes all four original craft/washing native chains in a future scene without faking prerequisites or timestamps',async()=>{
  const access=new WorkerAwareAccessMasterDataService(db,corp);
  await access.createPerson({...actor(),authorizationCapability:'master_data:manage'},{personType:'internal',appUserId:workerId,displayName:'TEST时钟师傅',aliases:[],reason:'TEST isolated native execution'});
  const scene=await runtime.create(actor(),{name:'TEST-native-future',requestKey:randomUUID()}),control=new AcceptanceClockControlService(runtime);
  const first=(await db.query('SELECT configuration_id FROM digital_sla_configurations ORDER BY version LIMIT 1')).rows[0].configuration_id;
  await control.standard(scene.scenarioId,actor(),{expectedVersion:scene.version,configurationId:first,requestKey:randomUUID()});
  const current=await runtime.repository.view(scene.scenarioId);
  await control.advance(scene.scenarioId,actor(),{expectedVersion:current.version,requestKey:randomUUID(),at:new Date(Date.parse(scene.now)+201*3600000).toISOString()});
  await runtime.run(scene.scenarioId,actor(),()=>exerciseDevelopmentSlaNative(db,new TodoProjectionService(new TodoService(db)),actor(),workerId,new ContextBusinessClock(db)));
  const roots=await runtime.repository.view(scene.scenarioId);expect(roots.sourceIds).toHaveLength(5);
  const nodes=(await db.query('SELECT entered_at,exited_at FROM pattern_room_node_times')).rows;
  expect(nodes.length).toBeGreaterThan(0);expect(nodes.every(n=>!n.exited_at||n.exited_at>=n.entered_at)).toBe(true);
  expect((await db.query("SELECT count(*)::int n FROM message_outbox WHERE topic='todo.delivery'")).rows[0].n).toBe(0);
  const native=new PatternRoomOrderService(db,new TodoProjectionService(new TodoService(db)),{ordersEnabled:true});
  const linked=(await db.query('SELECT o.order_id,o.current_round_id FROM pattern_room_orders o ORDER BY o.submitted_at DESC LIMIT 1')).rows[0],lateFile=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at,entity_type,entity_id) VALUES($1::uuid,$2,'TEST-late.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP,'pattern_room_attachment',$1::text)",[lateFile,`TEST-clock-late/${lateFile}`,'b'.repeat(64),rootId]);
  await db.query("INSERT INTO pattern_room_attachment_bindings(order_id,round_id,attachment_id,bound_by,reason,bound_at) VALUES($1,$2,$3,$4,'TEST later audit binding',CURRENT_TIMESTAMP+interval '1 second')",[linked.order_id,linked.current_round_id,lateFile,rootId]);
  const worker={...actor(workerId),actorRoles:['pattern_room_worker'],authorizationCapability:'pattern_room:orders:view',authorizationCapabilities:['pattern_room:orders:view','pattern_room:orders:complete','digital_production:view']};
  const detail=await runtime.run(scene.scenarioId,actor(),()=>native.get(worker,linked.order_id));
  expect(detail.attachments.some(file=>file.attachmentId===lateFile)).toBe(false);
  expect((await runtime.run(scene.scenarioId,actor(),()=>native.get(actor(),linked.order_id))).attachments.some(file=>file.attachmentId===lateFile)).toBe(true);

 },30000);

 it('retains the original frozen source when confirming a mother and creates an independent same-scene revision',async()=>{
  const row=(await db.query("SELECT s.source_id,s.design_style_no,m.scenario_id FROM digital_production_sources s JOIN acceptance_sla_clock_resources m ON m.resource_kind='source' AND m.resource_id=s.source_id JOIN digital_development_documents d USING(source_id) WHERE d.status='published' ORDER BY s.created_at DESC LIMIT 1")).rows[0];
  const scene=await runtime.repository.view(row.scenario_id),service=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),rounds=new DevelopmentRoundService(db,true);
  const before=(await db.query('SELECT configuration_id,plan_json FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1',[row.source_id])).rows[0];
  const order=await runtime.run(scene.scenarioId,actor(),()=>service.createOrder(actor(),DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:row.design_style_no,temporaryStyleNo:null,orderDate:beijingCalendarDate(new Date(scene.now)),lines:[{color:'黑',sizes:[{size:'M',quantity:20}],deliveryDate:'2027-03-01'}]}),randomUUID(),row.source_id));
  expect((await runtime.repository.view(scene.scenarioId)).orderIds).toContain(order.productionOrderId);
  const read=await new SlaOrderService(db).read(actor(),order.productionOrderId);
  expect(read.status).toBe('planned');if(read.status!=='planned')throw new Error('missing original mother plan');
  expect(read.time).toMatchObject({scenarioId:scene.scenarioId,now:scene.now});
  expect((await db.query('SELECT configuration_id FROM digital_sla_order_snapshots WHERE production_order_id=$1',[order.productionOrderId])).rows[0].configuration_id).toBe(before.configuration_id);
  expect((await db.query('SELECT plan_json FROM digital_development_sla_plans WHERE source_id=$1 ORDER BY revision DESC LIMIT 1',[row.source_id])).rows[0].plan_json).toEqual(before.plan_json);
  const fresh=await runtime.run(scene.scenarioId,actor(),async()=>{
   const original=await forms.read(actor(),row.source_id);
   const draft=await rounds.save(actor(),row.source_id,{expectedDraftVersion:0,revision:{basedOnRound:1,document:original.document!,origin:'客户新增要求',customerComment:'TEST新场景复版',internalProblem:'',explanation:'TEST实际新轮次',categories:['尺寸'],affectedNodes:['纸样','裁板','车板'],outputKind:'整件样板'}},randomUUID());
   return rounds.publish(actor(),row.source_id,{expectedDraftVersion:draft.draftVersion,basedOnRound:1},randomUUID());
  });
  expect(fresh.sourceId).not.toBe(row.source_id);
  expect((await runtime.repository.view(scene.scenarioId)).sourceIds).toContain(fresh.sourceId);
  expect((await forms.read(actor(),fresh.sourceId)).publishedAt).toBeNull();
  expect((await db.query('SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1',[fresh.sourceId])).rows[0].n).toBe(0);
 });
 it('copies inputs to a fresh scene without old actual facts and avoids pool starvation under queued requests',async()=>{
  const original=(await db.query("SELECT m.scenario_id FROM acceptance_sla_clock_resources m JOIN digital_development_documents d ON d.source_id=m.resource_id WHERE m.resource_kind='source' AND d.status='published' GROUP BY m.scenario_id HAVING count(*)=1 LIMIT 1")).rows[0];
  const before=await runtime.repository.view(original.scenario_id);
  const copied=await runtime.create(actor(),{name:'TEST-copy-reset',requestKey:randomUUID(),copyScenarioId:before.scenarioId});
  expect(copied.scenarioId).not.toBe(before.scenarioId);expect(Date.parse(copied.now)).toBeLessThan(Date.parse(before.now));
  expect(copied.orderIds).toEqual([]);
  const document=await new DigitalDevelopmentService(db,true).read(actor(),copied.sourceIds[0]!);
  expect(document.status).toBe('draft');expect(document.document?.files).toEqual([]);expect(document.publishedAt).toBeNull();
  expect((await db.query('SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1',[copied.sourceIds[0]])).rows[0].n).toBe(0);
  const times=await Promise.all(Array.from({length:12},()=>runtime.run(copied.scenarioId,actor(),()=>new ContextBusinessClock(db).read({kind:'source',id:copied.sourceIds[0]!}))));
  expect(times.every(t=>t.now===copied.now&&t.scenarioId===copied.scenarioId)).toBe(true);
 },10000);

 it('resumes interrupted copied documents on the same request without duplicating or overwriting native inputs',async()=>{
  const forms=new DigitalDevelopmentService(db,true),original=await runtime.create(actor(),{name:'TEST-copy-recovery-original',requestKey:randomUUID()});
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST必须实际复制的输入',craft:'无',washing:'免洗',materials:[{materialId:randomUUID(),category:'主布',label:'TEST主布',supplier:'TEST供应商',name:'TEST棉布',width:'',weight:'',composition:'',consumption:'',color:'',specification:'',quantity:'1',requiredThisRound:true,available:true,expectedDate:'2027-01-01'}],files:[]});
  await runtime.run(original.scenarioId,actor(),()=>forms.save(actor(),original.sourceIds[0]!,{expectedVersion:0,document},randomUUID()));
  for(const failure of ['before','after'] as const){
   const input={name:`TEST-copy-${failure}-commit`,requestKey:randomUUID(),copyScenarioId:original.scenarioId},save=DigitalDevelopmentService.prototype.save;
   const interrupted=vi.spyOn(DigitalDevelopmentService.prototype,'save').mockImplementationOnce(async function(this:DigitalDevelopmentService,...args){
    if(failure==='after')await save.apply(this,args);
    throw new Error(`TEST interrupted ${failure} document commit`);
   });
   try{await expect(runtime.create(actor(),input)).rejects.toThrow(`TEST interrupted ${failure}`);}finally{interrupted.mockRestore();}
   const row=(await db.query('SELECT scenario_id FROM acceptance_sla_clock_scenarios WHERE request_key=$1',[input.requestKey])).rows[0];
   const pending=await runtime.repository.view(row.scenario_id);expect(pending.sourceIds).toHaveLength(1);
   const beforeRetry=await forms.read(actor(),pending.sourceIds[0]!);expect(Boolean(beforeRetry.document)).toBe(failure==='after');
   // Recreate the runtime to prove recovery does not depend on process memory.
   runtime=new AcceptanceClockRuntime(db,await verifyAcceptanceClockServer(db,databaseUrl!,environment),secret,true);
   const copies=await Promise.all([runtime.create(actor(),input),runtime.create(actor(),input)]);
   expect(copies.every(copy=>copy.scenarioId===pending.scenarioId&&copy.sourceIds[0]===pending.sourceIds[0])).toBe(true);
   const copied=await forms.read(actor(),pending.sourceIds[0]!);
   expect(copied.version).toBe(1);expect(copied.status).toBe('draft');expect(copied.publishedAt).toBeNull();
   expect(copied.document).toMatchObject({instructions:document.instructions,measurements:document.measurements,files:[],materials:[{name:'TEST棉布',available:false,expectedDate:null}]});
   expect(copied.document!.materials[0]!.materialId).not.toBe(document.materials[0]!.materialId);
   expect((await db.query('SELECT count(*)::int n FROM digital_development_sla_plans WHERE source_id=$1',[copied.sourceId])).rows[0].n).toBe(1);
   expect((await db.query('SELECT count(*)::int n FROM digital_production_task_access WHERE source_id=$1',[copied.sourceId])).rows[0].n).toBe(0);
   const edited=await runtime.run(pending.scenarioId,actor(),()=>forms.save(actor(),copied.sourceId,{expectedVersion:copied.version,document:{...copied.document!,instructions:'TEST后续编辑必须保留'}},randomUUID()));
   await runtime.create(actor(),input);
   expect(await forms.read(actor(),copied.sourceId)).toMatchObject({version:edited.version,document:{instructions:'TEST后续编辑必须保留'}});
  }
 },15000);

 it('persists scan failure without rolling back time and recovers interrupted scans without duplicate effects',async()=>{
  const scene=await runtime.create(actor(),{name:'TEST-failed-scan',requestKey:randomUUID()}),control=new AcceptanceClockControlService(runtime),at=new Date(Date.parse(scene.now)+1800000).toISOString(),key=randomUUID();
  const fault=vi.spyOn(DigitalProductionNotificationService.prototype,'runOnce').mockRejectedValueOnce(new Error('TEST deterministic interrupted scan'));
  try{await expect(control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:key,at})).rejects.toThrow('TEST deterministic interrupted scan');}finally{fault.mockRestore();}
  const failed=await runtime.repository.view(scene.scenarioId);expect(failed.now).toBe(at);expect(failed.lastScan?.status).toBe('failed');
  const replay=await control.advance(scene.scenarioId,actor(),{expectedVersion:scene.version,requestKey:key,at});expect(replay.effect.replayed).toBe(true);expect(replay.scan.status).toBe('failed');
  await db.query("INSERT INTO acceptance_sla_clock_scans(scan_id,scenario_id,request_key,clock_version,business_time,actor_id,status) VALUES($1,$2,$3,$4,$5,$6,'pending')",[randomUUID(),scene.scenarioId,randomUUID(),failed.version,failed.now,rootId]);
  expect((await control.scan(scene.scenarioId,actor(),randomUUID())).status).toBe('completed');
  expect((await db.query("SELECT count(*)::int n FROM acceptance_sla_clock_scans WHERE scenario_id=$1 AND status='pending'",[scene.scenarioId])).rows[0].n).toBe(0);
  await expect(control.standard(scene.scenarioId,actor(designerId),{expectedVersion:failed.version,configurationId:scene.configurationId,requestKey:randomUUID()})).rejects.toMatchObject({statusCode:403});
 });

 (process.env.ACCEPTANCE_CLOCK_BROWSER_URL?it:it.skip)('runs the original browser detail and persisted clock through real isolated HTTP services',async()=>{
  const auth=new AuthService(new AcceptanceDingTalkProvider(db,corp,secret),new PostgresAuthStore(db,corp,'uat-root'),corp,3600000,secret),root=new RootAuthority(db,corp,'uat-root');
  const control=await auth.beginAcceptanceControl(mintAcceptanceControlCode(secret)),login=await auth.switchAcceptanceIdentity(control,'root'),scene=await runtime.create(actor(),{name:'TEST真实页面时钟',requestKey:randomUUID()});
  const config=loadConfig({NODE_ENV:'test',DATABASE_URL:databaseUrl!,DINGTALK_CORP_ID:corp,DINGTALK_H5_APP_KEY:'acceptance-disabled',DINGTALK_H5_APP_SECRET:'acceptance-disabled',DINGTALK_WEB_CLIENT_ID:'acceptance-disabled',DINGTALK_WEB_CLIENT_SECRET:'acceptance-disabled',DINGTALK_QR_REDIRECT_URI:`${process.env.ACCEPTANCE_CLOCK_BROWSER_URL}/auth/qr/callback`,SESSION_SECRET:secret,ROOT_DINGTALK_USER_ID:'uat-root',ACCEPTANCE_LAB_ENABLED:'true',ACCEPTANCE_LAB_SECRET:secret,DIGITAL_PRODUCTION_ENABLED:'true',DIGITAL_PRODUCTION_CREATION_ENABLED:'true'});
  const authenticate=(token:string|undefined)=>auth.authenticate(token),access=new WorkerAwareAccessMasterDataService(db,corp),attachments=new AttachmentService(db,new DisabledObjectStorage(),{prefix:'TEST',ttlSeconds:60,maxUploadBytes:1024*1024});
  const app=buildApp({config,auth,acceptanceClock:runtime,checkDatabase:async()=>{},getAppliedSchemaHistory:async()=>null,access:{authenticate,root,service:access},digitalIdentity:{authenticate,root,creationEnabled:true,service:new DigitalProductionIdentityService(db,true),taskService:new DigitalProductionTaskService(db),accessService:new DigitalProductionAccessService(db),developmentService:new DigitalDevelopmentService(db,true),developmentExecution:new DevelopmentExecutionService(db,true),developmentRounds:new DevelopmentRoundService(db,true),developmentAttachments:attachments},patternRoomPrices:{authenticate,root,service:new PatternRoomPriceService(db)}});
  try{
   await app.listen({port:3201,host:'127.0.0.1'});
   const result=await promisify(execFile)(process.execPath,['tests/acceptance/acceptance-sla-clock-live-browser.mjs'],{cwd:process.cwd(),env:{...process.env,CLOCK_CONTROL_TOKEN:control,CLOCK_BUSINESS_TOKEN:login.token,CLOCK_SOURCE_ID:scene.sourceIds[0]!},timeout:30000});
   process.stdout.write(result.stdout);
  }finally{await app.close();}
 },45000);

});
