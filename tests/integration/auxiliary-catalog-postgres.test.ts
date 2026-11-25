import {vi as correctnessBudget} from 'vitest';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
// Scoped to this heavy PG correctness file; global ordinary/performance defaults stay strict.
correctnessBudget.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
import {createHash,randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import Fastify from 'fastify';
import {createWebUrls,rewriteApiProxyPath} from '../../apps/web/url-contract.js';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {AuxiliaryCatalogService,validateAuxiliaryReferences} from '../../apps/api/src/access/auxiliary-catalog-service.js';
import {registerAuxiliaryCatalogRoutes} from '../../apps/api/src/access/auxiliary-catalog-routes.js';
import {RootAuthority} from '../../apps/api/src/access/root-authority.js';
import {AccessMasterDataService} from '../../apps/api/src/access/service.js';
import {EmployeeAccessService} from '../../apps/api/src/access/employee-access-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import type {TrustedActorContext} from '../../apps/api/src/tools/repositories.js';
import type {AuthUser} from '../../apps/api/src/auth/service.js';
import {AuxiliaryQuerySchema,AUXILIARY_CATALOG_ROLES,type AuxiliaryItem} from '@dx-rework/contracts/auxiliary-catalog';
const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('P06 shared auxiliary catalog with current PostgreSQL schema',()=>{
 const schema=ownedPostgresSchema('auxiliary_catalog'),admin=new pg.Pool({connectionString:url!}),db=new pg.Pool({connectionString:url!,options:`-c search_path=${schema}`});
 const roles=[...AUXILIARY_CATALOG_ROLES,'root_superuser','development_clerk','pattern_room_worker'],ids=new Map(roles.map(role=>[role,randomUUID()]));
 const capabilities=new Map<string,string[]>();
 const rootAuthority=new RootAuthority(db,'TEST',`TEST-${ids.get('root_superuser')}`),service=new AuxiliaryCatalogService(db,rootAuthority),forms=new DigitalDevelopmentService(db,true),identity=new DigitalProductionIdentityService(db,true);
 const actor=(role='sample_designer'):TrustedActorContext=>({actorId:ids.get(role)!,actorRoles:[role],authorizationCapability:'auxiliary_catalog:write',authorizationCapabilities:capabilities.get(role)??[],requestId:'TEST-P06'});
 const value=(name='TEST-'+randomUUID(),specification='TEST规格')=>({name,specification,auxiliaryKind:'扁机' as const});
 const list=(q='',includeInactive=false,page=1,who=actor())=>service.list(who,AuxiliaryQuerySchema.parse({q,includeInactive:String(includeInactive),page}));
 beforeAll(async()=>{
  await createOwnedPostgresSchema(admin,schema);await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8'));
  for(const row of manifest.migrations){await db.query(await readFile(new URL(`../../apps/api/migrations/${row.version}.sql`,import.meta.url),'utf8'));await db.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[row.version,row.checksum]);}
  // Synthetic identity/role bootstrap only. Business commands below use persisted roles and RootAuthority.
  for(const role of roles){const id=ids.get(role)!;await db.query('INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)',[id,`TEST ${role}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk','TEST',$3,$3,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,`TEST-${id}`]);if(role!=='root_superuser')await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'P06 TEST identity bootstrap')",[randomUUID(),id,role]);}
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,$2,'TEST')",[ids.get('root_superuser'),`TEST-${ids.get('root_superuser')}`]);await new AccessMasterDataService(db,'TEST').ensureOrganizationPolicy();
  for(const role of roles)capabilities.set(role,(await db.query<{capability:string}>('SELECT capability FROM role_capabilities WHERE role_code=$1',[role])).rows.map(row=>row.capability));
 },testExecutionConfig.correctnessTimeoutMs);
 afterAll(async()=>{await db.end();await releaseOwnedPostgresSchema(admin,schema);await admin.end();});
 it('allows exactly the five authorized identities to perform all four operations, without approval or extra capabilities',async()=>{
  for(const role of [...AUXILIARY_CATALOG_ROLES,'root_superuser']){const who=actor(role),first=await service.create(who,value(),randomUUID()),other=await service.create(who,value(),randomUUID());
   const renamed=await service.rename(who,first.id,{expectedVersion:first.version,name:first.name+'改名',reason:'TEST改名'},randomUUID());expect(renamed.version).toBe(2);
   const merged=await service.merge(who,other.id,{expectedVersion:other.version,targetId:first.id,expectedTargetVersion:renamed.version,reason:'TEST已确认同规格同供应方重复名称'},randomUUID());expect(merged).toMatchObject({active:false,mergedInto:first.id});
   expect(await service.disable(who,first.id,{expectedVersion:renamed.version,reason:'TEST停用'},randomUUID())).toMatchObject({active:false,version:3});
   expect((await list(first.name,true,1,who)).items.find(row=>row.id===first.id)?.active).toBe(false);
   expect(await service.rename(who,first.id,{expectedVersion:3,name:first.name+'停用后改名',reason:'TEST仅改名不恢复'},randomUUID())).toMatchObject({active:false,version:4});
  }
  expect((await db.query("SELECT count(*)::int n FROM role_capabilities WHERE capability LIKE 'auxiliary_catalog:%'")).rows[0].n).toBe(8);
  for(const role of ['development_clerk','pattern_room_worker']){const count=Number((await db.query('SELECT count(*) n FROM auxiliary_catalog_versions')).rows[0].n);await expect(service.create(actor(role),value(),randomUUID())).rejects.toMatchObject({statusCode:403});await expect(list('',false,1,actor(role))).rejects.toMatchObject({statusCode:403});expect(Number((await db.query('SELECT count(*) n FROM auxiliary_catalog_versions')).rows[0].n)).toBe(count);}
  await expect(service.create({...actor('development_clerk'),actorRoles:['root_superuser']},value(),randomUUID())).rejects.toMatchObject({statusCode:403});
  const protectedItem=await service.create(actor(),value(),randomUUID());
  await expect(service.rename(actor('development_clerk'),protectedItem.id,{expectedVersion:1,name:'TEST越权',reason:'TEST'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(service.disable(actor('development_clerk'),protectedItem.id,{expectedVersion:1,reason:'TEST'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(service.merge(actor('development_clerk'),protectedItem.id,{expectedVersion:1,targetId:randomUUID(),expectedTargetVersion:1,reason:'TEST'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(db.query("INSERT INTO capability_catalog(capability,display_name,description) VALUES('test:forbidden','TEST','TEST')")).rejects.toThrow();
 });
 it('deduplicates concurrent same combinations and same keys, retaining separate specifications without a supplier',async()=>{
  const input=value(),results=await Promise.allSettled([service.create(actor(),input,randomUUID()),service.create(actor('order_merchandiser'),input,randomUUID())]);expect(results.filter(row=>row.status==='fulfilled')).toHaveLength(1);expect(results.filter(row=>row.status==='rejected')).toHaveLength(1);
  await service.create(actor(),{...input,specification:'另一规格'},randomUUID());
  await expect(service.create(actor(),{...input,supplier:'另一供应方'},randomUUID())).rejects.toMatchObject({statusCode:400});
  expect((await list(input.name)).total).toBe(2);
  const key=randomUUID(),next=value(),[a,b]=await Promise.all([service.create(actor(),next,key),service.create(actor(),next,key)]);expect(a).toEqual(b);expect((await list(next.name)).total).toBe(1);
  await expect(service.create(actor(),{...next,name:next.name+'不同载荷'},key)).rejects.toMatchObject({statusCode:409});expect((await service.receipt(actor(),'create',key)).receipt).toMatchObject({id:a.id});expect((await service.receipt(actor('order_merchandiser'),'create',key)).receipt).toBeNull();
 });
 it('preserves but does not project or search old supplier data in the directory, including original receipts',async()=>{
  const oldSupplier='TEST旧辅料供应方'+randomUUID(),input=value(),key=randomUUID();
  const entry=await service.create(actor(),input,key);
  const legacyInput={name:input.name,specification:input.specification,supplier:oldSupplier,auxiliaryKind:input.auxiliaryKind};
  const legacyHash=createHash('sha256').update(JSON.stringify(legacyInput)).digest('hex');
  // Simulate a pre-change head and original response without modifying immutable version history.
  await db.query('UPDATE auxiliary_catalog_items SET supplier=$2 WHERE auxiliary_id=$1',[entry.id,oldSupplier]);
  await db.query("UPDATE idempotency_records SET request_hash=$3,response=response||jsonb_build_object('supplier',$2::text) WHERE scope='auxiliary-catalog:create' AND idempotency_key=$1",[key,oldSupplier,legacyHash]);
  const renamed=await service.rename(actor(),entry.id,{expectedVersion:1,name:entry.name+'原记录',reason:'TEST 照常改名'},randomUUID());
  expect(renamed).not.toHaveProperty('supplier');
  expect((await list(oldSupplier,true)).total).toBe(0);
  expect((await list(entry.name)).items).toEqual([renamed]);
  expect((await service.history(actor(),entry.id,1)).items.every(row=>!Object.hasOwn(row,'supplier'))).toBe(true);
  expect((await service.receipt(actor(),'create',key)).receipt).toEqual(entry);
  expect(await service.create(actor(),legacyInput,key)).toEqual(entry);
  await expect(service.create(actor(),{...input,name:renamed.name},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await db.query('SELECT supplier FROM auxiliary_catalog_versions WHERE auxiliary_id=$1 AND version=2',[entry.id])).rows[0].supplier).toBe(oldSupplier);
 });
 it('stores reference pricing by exact version and keeps catalog access separate from cost visibility',async()=>{
  const original=await service.create(actor(),{...value(),referencePricing:{amount:'0',unit:'套'}},randomUUID());
  expect((await db.query('SELECT supplier FROM auxiliary_catalog_items WHERE auxiliary_id=$1',[original.id])).rows).toEqual([{supplier:''}]);
  expect((await db.query('SELECT supplier FROM auxiliary_catalog_versions WHERE auxiliary_id=$1 AND version=1',[original.id])).rows).toEqual([{supplier:''}]);
  const key=randomUUID(),next={expectedVersion:1,referencePricing:{amount:'2.350001',unit:'枚'},reason:'TEST 目录参考价改版'};
  const changed=await service.changeReferencePricing(actor(),original.id,next,key);
  expect(changed).toMatchObject({version:2,referencePricing:next.referencePricing});
  expect(await service.changeReferencePricing(actor(),original.id,next,key)).toEqual(changed);
  await expect(service.changeReferencePricing(actor(),original.id,next,randomUUID())).rejects.toMatchObject({statusCode:409});
  const history=await service.history(actor(),original.id,1);
  expect(history.items.map(row=>row.referencePricing)).toEqual([next.referencePricing,{amount:'0',unit:'套'}]);
  const own=actor(),withoutCost={...own,authorizationCapabilities:own.authorizationCapabilities?.filter(value=>value!=='pattern_room:orders:create')??[]};
  expect((await list(original.name,false,1,withoutCost)).items[0]!.referencePricing).toBeUndefined();
  expect((await service.history(withoutCost,original.id,1)).items.every(row=>row.referencePricing===undefined)).toBe(true);
  expect((await service.receipt(withoutCost,'reference-pricing',key)).receipt?.referencePricing).toBeUndefined();
  await expect(service.changeReferencePricing(withoutCost,original.id,{...next,expectedVersion:2},randomUUID())).rejects.toMatchObject({statusCode:403});
  const cleared=await service.changeReferencePricing(actor(),original.id,{expectedVersion:2,referencePricing:null,reason:'TEST 参考价待定'},randomUUID());
  expect(cleared).toMatchObject({version:3,referencePricing:null});
  expect((await service.history(actor(),original.id,1)).items.map(row=>row.referencePricing)).toEqual([null,next.referencePricing,{amount:'0',unit:'套'}]);
 });
 it('rejects stale versions, foreign combinations, self/cyclic merges and preserves every old-name chain',async()=>{
  const a=await service.create(actor(),value(),randomUUID()),b=await service.create(actor(),value(),randomUUID()),c=await service.create(actor(),value(),randomUUID());
  const merge=(source:AuxiliaryItem,target:AuxiliaryItem)=>service.merge(actor(),source.id,{expectedVersion:source.version,targetId:target.id,expectedTargetVersion:target.version,reason:'TEST核实重复'},randomUUID());
  await expect(merge(a,a)).rejects.toMatchObject({statusCode:409});await expect(merge(a,{...b,version:2})).rejects.toMatchObject({statusCode:409});
  const foreign=await service.create(actor(),value(undefined,'不同规格'),randomUUID());await expect(merge(a,foreign)).rejects.toMatchObject({statusCode:409});
  const mergedA=await merge(a,b);await merge(b,c);expect((await list(a.name)).items.map(row=>row.id)).toEqual([c.id]);expect((await list(a.name,true)).items.some(row=>row.id===a.id)).toBe(true);
  await expect(merge(c,mergedA)).rejects.toMatchObject({statusCode:409});await expect(service.rename(actor(),c.id,{expectedVersion:2,name:'TEST过期',reason:'TEST'},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(db.query('UPDATE auxiliary_catalog_versions SET name=$1 WHERE auxiliary_id=$2',['TEST篡改',a.id])).rejects.toThrow();
 });
 it('rolls back both directory head and version when audit insertion fails',async()=>{
  const input=value();await db.query("CREATE FUNCTION test_auxiliary_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'TEST-P06 audit failure'; END $$");await db.query("CREATE TRIGGER test_auxiliary_failure BEFORE INSERT ON operation_events FOR EACH ROW WHEN (NEW.action='auxiliary_catalog.create') EXECUTE FUNCTION test_auxiliary_failure()");
  try{await expect(service.create(actor(),input,randomUUID())).rejects.toThrow('TEST-P06 audit failure');}finally{await db.query('DROP TRIGGER test_auxiliary_failure ON operation_events');await db.query('DROP FUNCTION test_auxiliary_failure()');}
  expect((await list(input.name,true)).total).toBe(0);
 });
 it('preserves real order snapshots after rename/merge/disable and refuses new stale or invented references',async()=>{
  const entry=await service.create(actor(),value(),randomUUID()),source=await identity.createSource(actor(),{designStyleNo:'TEST-P06-'+randomUUID(),temporaryStyleNo:null,customerCode:null,developmentType:'头版'},randomUUID()),file=randomUUID();
  await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST.png','image/png',1,$3,$4,'ready',CURRENT_TIMESTAMP)",[file,`TEST-P06/${file}`,'a'.repeat(64),actor().actorId]);
  const document={...initialDevelopmentDocument(),quantity:1,sizes:['M','L'],sampleSize:'M',sizeQuantities:[1,0],measurements:initialDevelopmentDocument().measurements.map(row=>({...row,values:['50','50']})),materials:[{materialId:randomUUID(),category:'辅料' as const,label:'TEST辅料',auxiliaryKind:entry.auxiliaryKind,auxiliaryCatalog:{id:entry.id,version:entry.version},name:entry.name,supplier:'TEST 原订单供应商',specification:entry.specification,width:'',weight:'',composition:'',consumption:'',color:'',quantity:'1',requiredThisRound:true,available:false,expectedDate:'2026-12-01'}],files:[{attachmentId:file,kind:'款图' as const}]};
  const saved=await forms.save(actor(),source.sourceId,{expectedVersion:0,document},randomUUID()),published=await forms.publish(actor(),source.sourceId,saved.version,randomUUID());
  const draftSource=await identity.createSource(actor(),{designStyleNo:'TEST-P06-'+randomUUID(),temporaryStyleNo:null,customerCode:null,developmentType:'头版'},randomUUID());
  const draft=await forms.save(actor(),draftSource.sourceId,{expectedVersion:0,document:{...document,files:[]}},randomUUID());
  const renamed=await service.rename(actor(),entry.id,{expectedVersion:1,name:entry.name+'新名',reason:'TEST改名不改单'},randomUUID()),target=await service.create(actor(),value(),randomUUID());await service.merge(actor(),entry.id,{expectedVersion:renamed.version,targetId:target.id,expectedTargetVersion:target.version,reason:'TEST同规格同供应方重复'},randomUUID());await service.disable(actor(),target.id,{expectedVersion:target.version,reason:'TEST停用'},randomUUID());
  expect((await forms.read(actor(),source.sourceId)).document).toEqual(published.document);
  expect((await forms.save(actor(),draftSource.sourceId,{expectedVersion:draft.version,document:{...draft.document!,instructions:'TEST停用后继续旧草稿'}},randomUUID())).document!.materials).toEqual(draft.document!.materials);
  await expect(forms.save(actor('order_merchandiser'),draftSource.sourceId,{expectedVersion:draft.version+1,document:draft.document!},randomUUID())).rejects.toMatchObject({statusCode:403});
  const next=await identity.createSource(actor(),{designStyleNo:'TEST-P06-'+randomUUID(),temporaryStyleNo:null,customerCode:null,developmentType:'头版'},randomUUID());
  await expect(forms.save(actor(),next.sourceId,{expectedVersion:0,document:{...document,files:[]}},randomUUID())).rejects.toMatchObject({statusCode:409});expect((await forms.read(actor(),next.sourceId)).document).toBeNull();
  const client=await db.connect();try{await client.query('BEGIN');await validateAuxiliaryReferences(client,published.document!,published.document!);await expect(validateAuxiliaryReferences(client,{...document,materials:document.materials.map(m=>({...m,auxiliaryCatalog:{id:randomUUID(),version:1}}))})).rejects.toMatchObject({statusCode:409});await client.query('ROLLBACK');}finally{client.release();}
 });
 it('reads the same immutable version history under every original catalog role, with bounded pages and denied unrelated readers',async()=>{
  const original=await service.create(actor(),value(),randomUUID());
  let current=original;
  for(let version=2;version<=17;version++)current=await service.rename(actor(),original.id,{expectedVersion:current.version,name:original.name+'-'+version,reason:'TEST version '+version},randomUUID());
  for(const role of [...AUXILIARY_CATALOG_ROLES,'root_superuser']){
   const first=await service.history(actor(role),original.id,1),second=await service.history(actor(role),original.id,2);
   expect(first).toMatchObject({total:17,page:1,pageSize:15});expect(first.items.map(row=>row.version)).toEqual(Array.from({length:15},(_,index)=>17-index));
   expect(second.items.map(row=>row.version)).toEqual([2,1]);
   expect(second.items[1]).toMatchObject({...original,reason:'业务页直接新增共享辅料',changedBy:'TEST sample_designer',action:'auxiliary_catalog.create'});
  }
  expect((await list(original.name)).items).toEqual([current]);
  expect(await service.history(actor(),original.id,1,original.version)).toMatchObject({total:1,items:[{id:original.id,version:original.version,name:original.name}]});
  expect(await service.history(actor(),original.id,1,current.version+1)).toMatchObject({total:0,items:[]});
  await expect(service.history(actor('development_clerk'),original.id,1,original.version)).rejects.toMatchObject({statusCode:403});
  for(const role of ['development_clerk','pattern_room_worker'])await expect(service.history(actor(role),original.id,1)).rejects.toMatchObject({statusCode:403});
  await expect(service.history(actor(),randomUUID(),1)).rejects.toMatchObject({statusCode:404});
  await expect(service.history(actor(),original.id,0)).rejects.toThrow();
 });
 it('searches across all pages and rejects stopped identities with their old role snapshot',async()=>{
  const prefix='TEST-PAGE-'+randomUUID();for(let i=0;i<17;i++)await service.create(actor(),value(`${prefix}-${i}`),randomUUID());expect((await list(prefix)).items).toHaveLength(15);expect((await list(prefix,false,2)).items).toHaveLength(2);expect((await list(prefix+'-16')).total).toBe(1);
  const employees=new EmployeeAccessService(db,'TEST',new AccessMasterDataService(db,'TEST'),undefined as never,undefined as never,{enabled:false,dingtalkUserId:undefined,secret:undefined},`TEST-${ids.get('root_superuser')}`);
  await employees.disableAccess(actor('root_superuser'),ids.get('sample_designer')!,'TEST停用后拒绝');try{await expect(service.create(actor(),value(),randomUUID())).rejects.toMatchObject({statusCode:403});}finally{await employees.restoreAccess(actor('root_superuser'),ids.get('sample_designer')!,'TEST恢复测试夹具');}
 });
 it('serializes Root catalog commands with actual employment deactivation in the command transaction',async()=>{
  const root=actor('root_superuser'),rootId=root.actorId;
  const blocked=async(pid:number,waiter?:number)=>{for(let i=0;i<100;i++){const found=await db.query(waiter?'SELECT cardinality(pg_blocking_pids($1))>0 AS blocked':"SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND pid<>pg_backend_pid()) AS blocked",[waiter??pid]);if(found.rows[0].blocked)return;await new Promise(resolve=>setTimeout(resolve,20));}throw Error('TEST expected actual PostgreSQL lock wait');};
  for(const field of ['active','employed'] as const){
   const table='identity_mappings',key='user_id';
   const change=(client:pg.PoolClient,enabled:boolean)=>client.query(`UPDATE ${table} SET ${field}=$2 WHERE ${key}=$1`,[rootId,enabled]);
   const before=Number((await db.query('SELECT count(*) n FROM auxiliary_catalog_versions')).rows[0].n),revoker=await db.connect();
   let pending:Promise<{value?:AuxiliaryItem;error?:unknown}>|undefined;
   try{
    await revoker.query('BEGIN');const pid=Number((await revoker.query('SELECT pg_backend_pid() pid')).rows[0].pid);await change(revoker,false);
    pending=service.create(root,value(),randomUUID()).then(value=>({value}),error=>({error}));await blocked(pid);await revoker.query('COMMIT');expect((await pending).error).toMatchObject({statusCode:403});expect(Number((await db.query('SELECT count(*) n FROM auxiliary_catalog_versions')).rows[0].n)).toBe(before);
   }finally{await revoker.query('ROLLBACK');await change(revoker,true);revoker.release();await pending;}
   // A command that already holds eligibility may finish first; directory
   // synchronization must wait until that same command transaction commits.
   const gate=await db.connect(),sync=await db.connect();let writing:Promise<AuxiliaryItem>|undefined,stopping:Promise<unknown>|undefined;
   try{
    await gate.query('BEGIN');const gatePid=Number((await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid);await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-auxiliary-catalog-v1',0))");
    writing=service.create(root,value(),randomUUID());await blocked(gatePid);await sync.query('BEGIN');const syncPid=Number((await sync.query('SELECT pg_backend_pid() pid')).rows[0].pid);stopping=change(sync,false);await blocked(0,syncPid);await gate.query('COMMIT');const written=await writing;await stopping;await sync.query('COMMIT');expect(written.active).toBe(true);
    await expect(service.create(root,value(),randomUUID())).rejects.toMatchObject({statusCode:403});expect(Number((await db.query('SELECT count(*) n FROM auxiliary_catalog_versions')).rows[0].n)).toBe(before+1);
   }finally{await gate.query('ROLLBACK');await sync.query('ROLLBACK');await writing?.catch(()=>undefined);await stopping?.catch(()=>undefined);await change(sync,true);gate.release();sync.release();}
  }
  // Root's protected enabled state must not be falsified to build a fixture.
  await expect(db.query('UPDATE app_users SET enabled=false WHERE id=$1',[rootId])).rejects.toThrow();
  expect((await db.query('SELECT enabled FROM app_users WHERE id=$1',[rootId])).rows[0].enabled).toBe(true);
  const gate=await db.connect(),sync=await db.connect();let writing:Promise<AuxiliaryItem>|undefined,changing:Promise<unknown>|undefined;
  try{await gate.query('BEGIN');const gatePid=Number((await gate.query('SELECT pg_backend_pid() pid')).rows[0].pid);await gate.query("SELECT pg_advisory_xact_lock(hashtextextended('shared-auxiliary-catalog-v1',0))");writing=service.create(root,value(),randomUUID());await blocked(gatePid);await sync.query('BEGIN');const pid=Number((await sync.query('SELECT pg_backend_pid() pid')).rows[0].pid);changing=sync.query('UPDATE app_users SET display_name=display_name WHERE id=$1',[rootId]);await blocked(0,pid);await gate.query('COMMIT');await writing;await changing;await sync.query('COMMIT');expect(await rootAuthority.isRootUser(rootId)).toBe(true);
  }finally{await gate.query('ROLLBACK');await sync.query('ROLLBACK');await writing?.catch(()=>undefined);await changing?.catch(()=>undefined);gate.release();sync.release();}
 },testExecutionConfig.correctnessTimeoutMs);
 it('exposes the same schemas and persisted authorization through real Fastify routes; no restore command',async()=>{
  const app=Fastify();app.setErrorHandler((error,_request,reply)=>{const e=error as Error&{statusCode?:number};void reply.status(e.statusCode??500).send({error:{message:e.message}});});
  registerAuxiliaryCatalogRoutes(app,{root:rootAuthority,service,authenticate:async token=>{const who=token==='clerk'?actor('development_clerk'):actor();return {id:who.actorId,businessRoles:who.actorRoles,capabilities:who.authorizationCapabilities} as AuthUser;}});
  try{for(const base of ['/','/acceptance/']){const urls=createWebUrls(base);expect((await app.inject({method:'GET',url:rewriteApiProxyPath(urls.apiUrl('master-data/auxiliaries'),urls.apiProxyPrefix)})).statusCode).toBe(200);}
   const created=await app.inject({method:'POST',url:rewriteApiProxyPath(createWebUrls('/acceptance/').apiUrl('master-data/auxiliaries'),'/acceptance/api'),headers:{'idempotency-key':randomUUID()},payload:value()});expect(created.statusCode).toBe(200);const current=created.json();
   const denied=await app.inject({method:'POST',url:rewriteApiProxyPath(createWebUrls('/acceptance/').apiUrl('master-data/auxiliaries'),'/acceptance/api'),headers:{cookie:'dx_rework_session=clerk','idempotency-key':randomUUID()},payload:value()});expect(denied.statusCode).toBe(403);
   const invalid=await app.inject({method:'POST',url:`/master-data/auxiliaries/${current.id}/disable`,headers:{'idempotency-key':randomUUID()},payload:{expectedVersion:1,reason:'TEST不授权恢复',enabled:true}});expect(invalid.statusCode).toBe(400);
   const history=await app.inject({method:'GET',url:`/master-data/auxiliaries/${current.id}/versions`});expect(history.statusCode).toBe(200);expect(history.json()).toMatchObject({total:1,items:[{id:current.id,version:1}]});
   expect((await app.inject({method:'GET',url:`/master-data/auxiliaries/${current.id}/versions`,headers:{cookie:'dx_rework_session=clerk'}})).statusCode).toBe(403);
   expect((await app.inject({method:'GET',url:`/master-data/auxiliaries/${current.id}/versions?page=0`})).statusCode).toBe(400);
   expect((await app.inject({method:'POST',url:`/master-data/auxiliaries/${current.id}/enable`,payload:{}})).statusCode).toBe(404);
   expect((await list(current.name)).items[0]).toMatchObject({active:true,version:1});
  }finally{await app.close();}
 });
});
