import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {describe,it,expect,beforeAll,afterAll,vi} from 'vitest';
import {DigitalAnalysisFilterSchema} from '@dx-rework/contracts/digital-production-analysis';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {DevelopmentRevisionSchema} from '@dx-rework/contracts/digital-development-rounds';
import {DigitalAnalysisQuery} from '../../apps/api/src/production-platform/reporting-query.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('PR06 analysis with original full PostgreSQL schema',()=>{
 const schema=ownedPostgresSchema('analysis_v2'),admin=new pg.Pool({connectionString:url}),db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 const root=randomUUID(),designer=randomUUID(),stranger=randomUUID(),analysis=new DigitalAnalysisQuery(db),identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true);let sourceId:string,taskId:string;
 const actor=(id=designer,roles=['sample_designer']):TrustedActorContext=>({actorId:id,actorRoles:roles,authorizationCapability:'pattern_room:orders:create',authorizationCapabilities:['pattern_room:orders:create'],requestId:'TEST-PR06'});
 const boss=actor(root,['root_superuser']);
 beforeAll(async()=>{
  await admin.query(`CREATE SCHEMA ${schema}`);const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8'));await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const migration of manifest.migrations){await db.query(await readFile(new URL(`../../apps/api/migrations/${migration.version}.sql`,import.meta.url),'utf8'));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[migration.version,migration.checksum]);}
  for(const [id,role] of [[root,'owner_group'],[designer,'sample_designer'],[stranger,'sample_designer']]){await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,'TEST '+role]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST PR06')",[randomUUID(),id,role,root]);}
  const source=await identity.createSource(actor(),{developmentType:'头版',designStyleNo:'TEST-PR06-DATES',temporaryStyleNo:null,customerCode:'PD'},randomUUID());sourceId=source.sourceId;const file=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST/${file}`,'a'.repeat(64),designer]);
  const document=DevelopmentDocumentSchema.parse({template:'上衣',quantity:1,sampleSize:'M',orderDate:'2026-10-01',returnDate:null,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:file,kind:'款图'}]});const saved=await forms.save(actor(),sourceId,{expectedVersion:0,document},randomUUID());taskId=(await forms.publish(actor(),sourceId,saved.version,randomUUID())).taskId!;
 },120000);
 afterAll(async()=>{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();});
 it('keeps backlog outside the selected created range, without broadening another designer access',async()=>{
  const future=DigitalAnalysisFilterSchema.parse({from:'2090-01-01',to:'2090-01-02',scope:'snapshot'});expect((await analysis.list(actor(),future)).rows.map(row=>row.taskId)).toContain(taskId);expect((await analysis.list(actor(),{...future,scope:'created'})).total).toBe(0);expect((await analysis.list(actor(stranger),future)).total).toBe(0);
  const period=await analysis.list(actor(),DigitalAnalysisFilterSchema.parse({from:'2020-01-01',to:'2080-01-01',scope:'published'}));expect(period.overview?.period.newStyles).toBe(1);expect(period.rows.every(row=>row.sourceId===sourceId)).toBe(true);expect(period.rows[0].sourcePublishedAt).not.toBeNull();
 });
 it('records exact filtered evidence, replays it, rejects foreign references and retains export authority',async()=>{
  const filters=DigitalAnalysisFilterSchema.parse({from:'2090-01-01',to:'2090-01-02',scope:'snapshot',metric:'unassigned'}),result=await analysis.list(boss,filters);expect(result.rows.map(row=>row.taskId)).toContain(taskId);const note={filters,taskIds:[taskId],conclusion:'TEST 日期外旧积压',action:'TEST 核对原交付',observeAt:'2090-01-03T00:00:00Z'},key=randomUUID(),saved=await analysis.record(boss,note,key);expect(await analysis.record(boss,note,key)).toEqual(saved);expect((await analysis.list(boss,filters)).notes.find(item=>item.id===saved.id)).toMatchObject({filters,taskIds:[taskId],ruleVersion:'digital-production-v2-analysis-1'});await expect(analysis.record(boss,{...note,taskIds:[randomUUID()]},randomUUID())).rejects.toMatchObject({statusCode:404});await expect(analysis.export(actor(),filters)).rejects.toMatchObject({statusCode:403});const workbook=await analysis.export(boss,filters);expect(workbook.subarray(0,2).toString()).toBe('PK');const audit=(await db.query("SELECT after_state FROM audit_events WHERE action='digital.analysis.exported' ORDER BY created_at DESC LIMIT 1")).rows[0].after_state;expect(audit).toMatchObject({filters,rowCount:result.total,ruleVersion:'digital-production-v2-analysis-1'});
 });
 it('counts published craft-only revisions and excludes saved drafts from quality facts',async()=>{
  const rounds=new DevelopmentRoundService(db,true),sheet=await forms.read(actor(),sourceId),filters=DigitalAnalysisFilterSchema.parse({from:'2020-01-01',to:'2080-01-01',scope:'revisions',origin:'客户新增要求'});
  const before=await analysis.list(boss,filters),revision=DevelopmentRevisionSchema.parse({basedOnRound:1,document:{...sheet.document!,craft:'印花'},origin:'客户新增要求',customerComment:'TEST 客户要求修改印花位置',internalProblem:'',explanation:'TEST 仅重做工艺布片',categories:['工艺'],affectedNodes:['工艺'],outputKind:'工艺布片'});
  const saved=await rounds.save(actor(),sourceId,{expectedDraftVersion:0,revision},randomUUID());expect((await analysis.list(boss,filters)).rounds).toEqual(before.rounds);
  await rounds.publish(actor(),sourceId,{expectedDraftVersion:saved.draftVersion,basedOnRound:1},randomUUID());const after=await analysis.list(boss,filters),fact=after.rounds.find(item=>item.sourceId===sourceId&&item.round===2);
  expect(fact).toMatchObject({origin:'客户新增要求',affectedNodes:['工艺'],categories:['工艺'],customerComment:revision.customerComment,explanation:revision.explanation});expect(after.rows.length).toBeGreaterThan(0);expect(after.rows.every(row=>row.sourceId===sourceId&&row.round===2)).toBe(true);expect(after.overview?.period.newStyles).toBe(1);
  expect((await analysis.list(boss,{...filters,origin:'内部发现'})).rows).toHaveLength(0);
 });
 it('preserves original task-derived source reads while denying an unassigned worker',async()=>{
  const worker=randomUUID(),other=randomUUID();
  for(const id of [worker,other]){await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,'TEST PR06 worker']);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','TEST',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id]);await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'pattern_room_worker',$3,'TEST PR06')",[randomUUID(),id,root]);}
  const client=await db.connect();let assigned:string;try{await client.query('BEGIN');assigned=(await new DigitalProductionTaskService(db).createWithClient(client,boss,{resource:{kind:'source',id:sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:2,occurrence:2,assigneeId:worker})).taskId;await client.query('COMMIT');}finally{client.release();}
  const owner=actor(worker,['pattern_room_worker']),foreign=actor(other,['pattern_room_worker']),filters=DigitalAnalysisFilterSchema.parse({from:'2020-01-01',to:'2080-01-01',scope:'revisions',origin:'客户新增要求'});
  expect(await new DigitalProductionAccessPolicy(db).allowed(owner,'source',sourceId,'technical')).toBe(false);expect((await forms.read(owner,sourceId,db,2)).roundNumber).toBe(2);
  const visible=await analysis.list(owner,filters);expect(visible.rows.map(row=>row.taskId)).toContain(assigned!);expect(visible.rounds).toContainEqual(expect.objectContaining({sourceId,round:2,origin:'客户新增要求'}));
  expect((await analysis.list(foreign,filters)).rounds).toHaveLength(0);await expect(forms.read(foreign,sourceId)).rejects.toMatchObject({statusCode:404});await expect(analysis.export(owner,filters)).rejects.toMatchObject({statusCode:403});
 });
 it('excludes unrelated archived tasks before per-task authorization while retaining old live backlog',async()=>{
  const old=await identity.createSource(actor(),{developmentType:'头版',designStyleNo:'TEST-PR06-ARCHIVE',temporaryStyleNo:null,customerCode:'PD'},randomUUID()),document=(await forms.read(actor(),sourceId)).document!;
  // An isolated imported-history fixture; attachment binding and publishing are not replayed.
  const client=await db.connect();let archived:string;try{await client.query('BEGIN');archived=(await new DigitalProductionTaskService(db).createWithClient(client,boss,{resource:{kind:'source',id:old.sourceId},kind:'development_pattern',routeId:randomUUID(),routeVersion:1,occurrence:1,assigneeId:null})).taskId;await client.query("INSERT INTO digital_development_documents(source_id,version,status,document,updated_by,published_at,task_id) VALUES($1,1,'published',$2,$3,'2000-01-01T00:00:00Z',$4)",[old.sourceId,JSON.stringify(document),designer,archived]);await client.query("UPDATE digital_production_tasks SET state='cancelled',created_at='2000-01-01T00:00:00Z' WHERE task_id=$1",[archived]);await client.query('COMMIT');}finally{client.release();}
  const allowed=vi.spyOn(DigitalProductionAccessPolicy.prototype,'allowed');try{const result=await analysis.list(boss,DigitalAnalysisFilterSchema.parse({from:'2090-01-01',to:'2090-01-02',scope:'snapshot'}));expect(result.rows.length).toBeGreaterThan(0);expect(result.rows.every(row=>row.createdAt<'2090-01-01')).toBe(true);expect(allowed.mock.calls.some(call=>call[1]==='task'&&call[2]===archived!)).toBe(false);expect(result.rows.some(row=>row.taskId===archived!)).toBe(false);}finally{allowed.mockRestore();}
 });
});
