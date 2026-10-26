import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import pg from "pg";
import {describe,it,expect} from "vitest";
import {ownedPostgresSchema} from "../helpers/owned-postgres-schema.js";
import {migrationExecutionSql} from "../../scripts/deploy/migration-execution-compatibility.mjs";
import {assertTestDatabaseTarget} from "../../scripts/test-database-safety.mjs";
import {EmployeeAccessService} from "../../apps/api/src/access/employee-access-service.js";
import {AccessMasterDataService} from "../../apps/api/src/access/service.js";
import {maintainAcceptanceCuttingWorker} from "../../scripts/acceptance/cutting-worker-maintenance.js";
import type {TrustedActorContext} from "../../apps/api/src/tools/repositories.js";
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const tables=['app_users','identity_mappings','user_role_assignments','user_capabilities','delegated_authorizations','business_people','access_security_policy','owner_bootstrap_consumptions','business_roles','role_capabilities','auth_sessions','employee_directory_profiles','business_person_aliases','operation_events'];
async function fixture(run:(f:{db:pg.Pool;env:NodeJS.ProcessEnv;id:string;root:TrustedActorContext;old:string;access:AccessMasterDataService;employees:EmployeeAccessService;args:string[];snapshot:(omitTarget?:boolean)=>Promise<unknown>;target:(options?:{corpId?:string;unionId?:string;providerId?:string})=>Promise<void>})=>Promise<void>, options:{rootUnionId?:string}={}){
 await assertTestDatabaseTarget(url);
 const schema=ownedPostgresSchema('acceptance_cutting'),admin=new pg.Pool({connectionString:url}),db=new pg.Pool({connectionString:url,options:`-c search_path=${schema}`});
 try{
  await admin.query(`CREATE SCHEMA ${schema}`);
  const manifest=JSON.parse(await readFile(new URL('../../apps/api/src/platform/migration-manifest.json',import.meta.url),'utf8')) as {migrations:Array<{version:string;checksum:string}>};
  const version=Number((await db.query('SHOW server_version_num')).rows[0].server_version_num);
  await db.query('CREATE TABLE schema_migrations(version text PRIMARY KEY,checksum char(64) NOT NULL,applied_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for(const m of manifest.migrations){await db.query(migrationExecutionSql({...m,sql:await readFile(new URL(`../../apps/api/migrations/${m.version}.sql`,import.meta.url),'utf8')},version));await db.query('INSERT INTO schema_migrations VALUES($1,$2,CURRENT_TIMESTAMP)',[m.version,m.checksum]);}
  const rootId=randomUUID(),old=randomUUID(),disabled=randomUUID(),id=randomUUID(),corp='TEST-cutting-fixture';
  for(const [user,alias,role] of [[rootId,'root','owner_group'],[old,'pattern-room-worker','pattern_room_worker'],[disabled,'sample-designer','sample_designer']]){
   await db.query('INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,$2,true,false)',[user,`[UAT] ${alias}`]);
   await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)",[randomUUID(),user,corp,`uat-${alias}`,alias==='root'?(options.rootUnionId??'uat-union-root'):`uat-union-${alias}`]);
   // Initial isolated bootstrap occurs before organization policy; normal tested writes keep every guard enabled.
   await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST isolated fixture')",[randomUUID(),user,role,rootId]);
  }
  await db.query("INSERT INTO owner_bootstrap_consumptions(singleton,user_id,provider_user_id,corp_id) VALUES(true,$1,'uat-root',$2)",[rootId,corp]);
  const access=new AccessMasterDataService(db,corp);await access.ensureOrganizationPolicy();
  const root:TrustedActorContext={actorId:rootId,actorRoles:['root_superuser','owner_group'],authorizationCapability:'access:admin',authorizationCapabilities:['access:admin'],requestId:randomUUID()};
  await access.createPerson({...root,authorizationCapability:'master_data:manage'},{personType:'internal',appUserId:old,displayName:'TEST existing worker',aliases:['TEST existing alias'],reason:'TEST preserve existing person'});
  const employees=new EmployeeAccessService(db,corp,access,undefined as never,undefined as never,{enabled:false,dingtalkUserId:undefined,secret:undefined},'uat-root');
  await employees.disableAccess(root,disabled,'TEST preserve existing manual disable');
  const env={NODE_ENV:'test',ACCEPTANCE_LAB_ENABLED:'true',ROOT_DINGTALK_USER_ID:'uat-root',DINGTALK_CORP_ID:corp,ACCEPTANCE_DATABASE_URL:url!};
  const snapshot=async(omitTarget=false)=>Promise.all(tables.map(async table=>({table,rows:(await db.query<{value:Record<string,unknown>}>(`SELECT to_jsonb(t) AS value FROM ${table} t ORDER BY to_jsonb(t)::text`)).rows.map(r=>r.value).filter(v=>{
   if(!omitTarget)return true;
   if(table==='app_users')return v.id!==id;
   if(['identity_mappings','user_role_assignments','user_capabilities','auth_sessions'].includes(table))return v.user_id!==id;
   if(table==='operation_events')return !(v.entity_type==='app_user'&&v.entity_id===id||(v.after_state as {userId?:string}|null)?.userId===id);
   return true;
  })})));
  const target=async(mapping:{corpId?:string;unionId?:string;providerId?:string}={})=>{
   await db.query("INSERT INTO app_users(id,display_name,enabled,manual_access_disabled) VALUES($1,'[UAT] 裁床师傅',true,false)",[id]);
   await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2,'dingtalk',$3,$4,$5,true,true,CURRENT_TIMESTAMP)",[randomUUID(),id,mapping.corpId??corp,mapping.providerId??'uat-cutting-worker',mapping.unionId??'uat-union-cutting-worker']);
  };
  await run({db,env,id,root,old,access,employees,args:['--apply',`--expected-user-id=${id}`],snapshot,target});
 }finally{await db.end();await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);await admin.end();}
}
(url?describe:describe.skip)('single fixed Acceptance cutting-worker fixture with original PostgreSQL guards',()=>{
 it('checks without writes; creates only one pinned identity and role, serializes repeats, leaves every old field and person unchanged',async()=>fixture(async f=>{
  const before=await f.snapshot();expect(await maintainAcceptanceCuttingWorker(f.db,f.env,['--check',`--expected-user-id=${f.id}`])).toMatchObject({status:'missing',applied:false});expect(await f.snapshot()).toEqual(before);
  const results=await Promise.all([1,2,3].map(()=>maintainAcceptanceCuttingWorker(f.db,f.env,f.args)));
  expect(results.filter(r=>r.created)).toHaveLength(1);expect(results.filter(r=>r.grantedRole)).toHaveLength(1);expect(results.every(r=>r.userId===f.id&&r.status==='ready')).toBe(true);
  expect(await f.snapshot(true)).toEqual(before);
  expect((await f.db.query('SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL',[f.id])).rows).toEqual([{role_code:'cutting_worker'}]);
  expect((await f.db.query('SELECT provider_user_id,union_id,corp_id FROM identity_mappings WHERE user_id=$1',[f.id])).rows).toEqual([{provider_user_id:'uat-cutting-worker',union_id:'uat-union-cutting-worker',corp_id:f.env.DINGTALK_CORP_ID}]);
  expect((await f.db.query("SELECT action FROM operation_events WHERE after_state->>'userId'=$1 OR entity_type='app_user' AND entity_id=$1 ORDER BY action",[f.id])).rows.map(r=>r.action)).toEqual(['acceptance.cutting_worker.created','access.role.assign']);
  const stable=await f.snapshot();expect(await maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).toMatchObject({created:false,grantedRole:false});expect(await f.snapshot()).toEqual(stable);
 }),60000);
 it('adds only the missing original role to the pinned clean identity without refreshing its user or identity fields',async()=>fixture(async f=>{
  await f.target();const before=await f.db.query('SELECT to_jsonb(u) AS u,to_jsonb(i) AS i FROM app_users u JOIN identity_mappings i ON i.user_id=u.id WHERE u.id=$1',[f.id]);
  expect(await maintainAcceptanceCuttingWorker(f.db,f.env,[])).toMatchObject({status:'missing_role',applied:false});
  expect(await maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).toMatchObject({created:false,grantedRole:true,status:'ready'});
  expect((await f.db.query('SELECT to_jsonb(u) AS u,to_jsonb(i) AS i FROM app_users u JOIN identity_mappings i ON i.user_id=u.id WHERE u.id=$1',[f.id])).rows).toEqual(before.rows);
 }),60000);
 it.each(['disabled','wrong-union','wrong-corp','wrong-alias','direct-capability','extra-role','person'] as const)('refuses abnormal existing target %s without repairing or writing any data',async kind=>fixture(async f=>{
  await f.target(kind==='wrong-union'?{unionId:'wrong'}:kind==='wrong-corp'?{corpId:'wrong'}:kind==='wrong-alias'?{providerId:'uat-other'}:{});
  if(kind==='disabled')await f.employees.disableAccess(f.root,f.id,'TEST target disabled before fixture');
  if(kind==='direct-capability')await f.db.query("INSERT INTO user_capabilities(user_id,capability) VALUES($1,'access:admin')",[f.id]);
  if(kind==='extra-role')await f.access.assignRole(f.root,{userId:f.id,roleCode:'quality_control',reason:'TEST dirty target'});
  if(kind==='person')await f.access.createPerson({...f.root,authorizationCapability:'master_data:manage'},{personType:'internal',appUserId:f.id,displayName:'TEST unexpected person',aliases:[],reason:'TEST existing person conflict'});
  const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);
 }),60000);
 it('refuses expected-ID collisions, corporation/Root conflicts and production configuration before any data writes',async()=>fixture(async f=>{
  for(const env of [{...f.env,NODE_ENV:'production'},{...f.env,DINGTALK_CORP_ID:'wrong'},{...f.env,ACCEPTANCE_DATABASE_URL:'postgresql://localhost/production'}]){const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,env,f.args)).rejects.toThrow();expect(await f.snapshot()).toEqual(before);}
  const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,['--apply',`--expected-user-id=${f.old}`])).rejects.toThrow('existing account');expect(await f.snapshot()).toEqual(before);
  await f.target();const pinned=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,['--apply',`--expected-user-id=${randomUUID()}`])).rejects.toThrow('expected distinct user ID');expect(await f.snapshot()).toEqual(pinned);
 }),60000);
 it('rejects an existing Root with a wrong UAT union marker without attempting to repair it',async()=>fixture(async f=>{
  const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).rejects.toThrow('UAT identity');expect(await f.snapshot()).toEqual(before);
 },{rootUnionId:'broken-root'}),60000);
 it('preserves the original dirty-old-standard-identity rejection before target creation',async()=>fixture(async f=>{
  await f.access.assignRole(f.root,{userId:f.old,roleCode:'quality_control',reason:'TEST dirty old standard identity'});const before=await f.snapshot();
  await expect(maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).rejects.toThrow('non-standard authorization');expect(await f.snapshot()).toEqual(before);
 }),60000);
 it('rejects an unrevoked future delegation on the target with all original data untouched',async()=>fixture(async f=>{
  await f.target();await f.access.assignRole(f.root,{userId:f.id,roleCode:'cutting_worker',reason:'TEST target standard role'});
  await f.access.createDelegation({...f.root,authorizationCapability:'delegation:manage'},{grantorUserId:f.old,granteeUserId:f.id,capability:'pattern_room:orders:view',scopeType:'global',validFrom:new Date(Date.now()+86400000).toISOString(),validUntil:new Date(Date.now()+2*86400000).toISOString(),reason:'TEST future delegation must block'});
  const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).rejects.toThrow('unrevoked delegations');expect(await f.snapshot()).toEqual(before);
 }),60000);
 it('rejects a real non-Acceptance connected database before any business or identity queries can write',async()=>fixture(async f=>{
  const other=new URL(url!);other.pathname='/dx_rework_ci';const nonAcceptance=new pg.Pool({connectionString:other.toString()});
  const before=await f.snapshot();try{await expect(maintainAcceptanceCuttingWorker(nonAcceptance,f.env,f.args)).rejects.toThrow('refused connected database');}finally{await nonAcceptance.end();}expect(await f.snapshot()).toEqual(before);
 }),60000);
 it('rolls back new user, mapping and audit if the guarded role writer fails; retry remains one audited grant',async()=>fixture(async f=>{
  await f.db.query("CREATE FUNCTION fixture_reject_cutting_grant() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role_code='cutting_worker' THEN RAISE EXCEPTION 'TEST guarded role failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER zz_fixture_reject_cutting_grant BEFORE INSERT ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION fixture_reject_cutting_grant()");
  const before=await f.snapshot();await expect(maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).rejects.toThrow('TEST guarded role failure');expect(await f.snapshot()).toEqual(before);
  await f.db.query('DROP TRIGGER zz_fixture_reject_cutting_grant ON user_role_assignments; DROP FUNCTION fixture_reject_cutting_grant()');
  expect(await maintainAcceptanceCuttingWorker(f.db,f.env,f.args)).toMatchObject({created:true,grantedRole:true,status:'ready'});
 }),60000);
});
