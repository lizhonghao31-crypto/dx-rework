import {randomUUID} from 'node:crypto';
import {mkdirSync,writeFileSync,readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join} from 'node:path';

// Creation and cleanup consume this one registry. Unknown prefixes fail before CREATE.
export const SCHEMA_PREFIXES = Object.freeze(["access", "employee_access", "finance_access", "tools", "acceptance_roles", "business_anchors", "full_chain", "own_tail", "pattern_backfill", "pmc_role", "quality_basic", "receiving", "release_lock", "resource_smoke", "rework", "rework_v2", "root_http_1", "root_http_2", "root_self_admin", "sample", "sourcing", "supplier", "temporary_proxy", "wage_marker"]);
const suffix=/^[0-9a-f]{32}$/;
const generated=new Map();
// The maintenance checker deliberately targets public. It must never borrow a
// business fixture database; this one provisioned, marked target starts empty.
export function assertMainMaintenanceTarget(databaseUrl,adminUrl,identities) {
 const low=new URL(databaseUrl),admin=new URL(adminUrl),identity=identities['main-maintenance'];
 if(!['postgres:','postgresql:'].includes(low.protocol)||!['postgres:','postgresql:'].includes(admin.protocol)
  ||!['127.0.0.1','localhost'].includes(low.hostname)||admin.hostname!==low.hostname||admin.port!==low.port||admin.pathname!==low.pathname
  ||decodeURIComponent(low.pathname.slice(1))!=='dx_rework_main_0232_test'||identity?.database!=='dx_rework_main_0232_test'
  ||identity.username!==decodeURIComponent(low.username)||!identity.databaseOid||identity.marker!=='dx-rework-isolated-test-v1'
  ||Object.entries(identities).some(([target,other])=>target!=='main-maintenance'&&other.databaseOid===identity.databaseOid&&other.port===identity.port&&other.address===identity.address))throw Error('TEST_MAINTENANCE_TARGET_REJECTED');
}
export async function claimMainMaintenancePublic(pool,environment=process.env) {
 const runId=environment.DX_REWORK_TEST_RUN_ID,dir=environment.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR;
 if(!/^[0-9a-f]{8}$/.test(runId??'')||!dir||environment.DX_REWORK_TEST_SCHEMA_CLEANUP!=='after-workers')throw Error('TEST_RESOURCE_CLEANUP_OWNER_REQUIRED');
 const identities=JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES??'{}');
 assertMainMaintenanceTarget(environment.MAIN_0232_TEST_DATABASE_URL,environment.MAIN_0232_TEST_ADMIN_DATABASE_URL,identities);
 const {assertTestDatabaseTarget}=await import('./test-database-safety.mjs');
 const actual=await assertTestDatabaseTarget(environment.MAIN_0232_TEST_DATABASE_URL,pool);
 if(JSON.stringify(actual)!==JSON.stringify(identities['main-maintenance']))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 const {rows:[state]}=await pool.query(`SELECT to_regnamespace('public') IS NOT NULL AS present,
  EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=to_regnamespace('public'))
  OR EXISTS(SELECT 1 FROM pg_proc WHERE pronamespace=to_regnamespace('public'))
  OR EXISTS(SELECT 1 FROM pg_type WHERE typnamespace=to_regnamespace('public')) AS occupied`);
 if(!state.present||state.occupied)throw Error('TEST_MAINTENANCE_FRESH_PUBLIC_REQUIRED');
 mkdirSync(dir,{recursive:true});
 writeFileSync(join(dir,'main-maintenance-'+runId+'.json'),JSON.stringify({version:1,kind:'main-maintenance-public',runId,schema:'public',databaseTarget:'main-maintenance',identity:actual})+'\n',{flag:'wx',mode:0o600});
}
export function assertRegisteredSchema(schema) {
 const prefix=schema.slice(0,-33),token=schema.slice(-32);
 if(!SCHEMA_PREFIXES.includes(prefix)||schema[prefix.length]!=='_'||!suffix.test(token))throw Error('TEST_RESOURCE_UNREGISTERED: '+schema);
 return prefix;
}
export function ownedPostgresSchema(prefix,databaseTarget='default',environment=process.env) {
 if(!SCHEMA_PREFIXES.includes(prefix))throw Error('TEST_RESOURCE_UNREGISTERED: '+prefix);
 if(!['default','acceptance-clock'].includes(databaseTarget)||databaseTarget==='acceptance-clock'&&prefix!=='business_anchors')throw Error('TEST_RESOURCE_TARGET_REJECTED');
 const runId=environment.DX_REWORK_TEST_RUN_ID,dir=environment.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR;
 if(Boolean(runId)!==Boolean(dir)||runId&&!/^[0-9a-f]{8}$/.test(runId))throw Error('TEST_RESOURCE_RUN_REJECTED');
 const schema=prefix+'_'+(runId?runId+randomUUID().replaceAll('-','').slice(8):randomUUID().replaceAll('-',''));
 if(runId){
  const identity=JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES??'{}')[databaseTarget];
  if(!identity?.databaseOid||!identity?.database||!identity?.username||identity.marker!=='dx-rework-isolated-test-v1')throw Error('TEST_RESOURCE_IDENTITY_REQUIRED');
  mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,schema+'.json'),JSON.stringify({version:1,kind:'postgres-schema',runId,schema,databaseTarget,identity})+'\n',{flag:'wx',mode:0o600});
 }
 generated.set(schema,{databaseTarget,url:databaseTarget==='acceptance-clock'?environment.ACCEPTANCE_CLOCK_TEST_DATABASE_URL:environment.TEST_DATABASE_URL,identity:runId?JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES)[databaseTarget]:null,runId:runId??null,manifestDir:dir??null});return schema;
}
export function readOwnedResource(dir,name,runId,identities) {
 if(!/^[0-9a-f]{8}$/.test(runId))throw Error('TEST_RESOURCE_RUN_REJECTED');
 if(name.includes('/')||name.includes('\\')||!name.endsWith('.json'))throw Error('TEST_RESOURCE_MANIFEST_REJECTED');
  const path=join(dir,name);
  if(!name.endsWith('.json')||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())throw Error('TEST_RESOURCE_MANIFEST_REJECTED');
  const r=JSON.parse(readFileSync(path,'utf8'));
  if(r.kind==='main-maintenance-public'){
   if(r.version!==1||r.runId!==runId||r.schema!=='public'||r.databaseTarget!=='main-maintenance'||name!=='main-maintenance-'+runId+'.json'
    ||r.identity?.database!=='dx_rework_main_0232_test'||!identities['main-maintenance']||JSON.stringify(r.identity)!==JSON.stringify(identities['main-maintenance']))throw Error('TEST_RESOURCE_MANIFEST_REJECTED: '+name);
   return r;
  }
  assertRegisteredSchema(r.schema??'');
  if(r.version!==1||r.kind!=='postgres-schema'||!['default','acceptance-clock'].includes(r.databaseTarget)||r.runId!==runId||!r.schema.slice(-32).startsWith(runId)||name!==r.schema+'.json'||!identities[r.databaseTarget]||JSON.stringify(r.identity)!==JSON.stringify(identities[r.databaseTarget]))throw Error('TEST_RESOURCE_MANIFEST_REJECTED: '+name);
  if(r.databaseTarget==='acceptance-clock'&&!r.schema.startsWith('business_anchors_'))throw Error('TEST_RESOURCE_TARGET_REJECTED');
  return r;
}
export function readOwnedResources(dir,runId,identities) {
 if(!/^[0-9a-f]{8}$/.test(runId))throw Error('TEST_RESOURCE_RUN_REJECTED');
 return readdirSync(dir).map(name=>readOwnedResource(dir,name,runId,identities));
}
export async function createOwnedPostgresSchema(pool,schema) {
 if(!generated.has(schema))throw Error('TEST_RESOURCE_NOT_CREATED_BY_THIS_PROCESS');
 assertRegisteredSchema(schema);
 const {assertTestDatabaseTarget}=await import('./test-database-safety.mjs');
 const actual=await assertTestDatabaseTarget(generated.get(schema).url,pool),expected=generated.get(schema).identity;
 if(expected&&JSON.stringify(actual)!==JSON.stringify(expected))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 await pool.query(`CREATE SCHEMA "${schema}"`);
}
export async function dropOwnedPostgresSchema(pool,schema) {
 if(!generated.has(schema))throw Error('TEST_RESOURCE_NOT_CREATED_BY_THIS_PROCESS');
 assertRegisteredSchema(schema);
 const {assertTestDatabaseTarget}=await import('./test-database-safety.mjs');
 const actual=await assertTestDatabaseTarget(generated.get(schema).url,pool);
 const expected=generated.get(schema).identity;
 if(expected&&JSON.stringify(actual)!==JSON.stringify(expected))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 const acquired=typeof pool.totalCount==='number';
 const client=acquired?await pool.connect():pool;
 try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('test-owned-schema-teardown-v1',0))");await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);await client.query('COMMIT');}
 catch(error){await client.query('ROLLBACK');throw error;}finally{if(acquired)client.release();}
}
// Fixture teardown is a handoff, never a claim that the schema was deleted.
// The managed runner already waits for Vitest's workers and then consumes the
// exact manifest serially across both databases. Standalone runs still delete.
export async function releaseOwnedPostgresSchema(pool,schema,environment=process.env) {
 if(!generated.has(schema))throw Error('TEST_RESOURCE_NOT_CREATED_BY_THIS_PROCESS');
 if(environment.DX_REWORK_TEST_SCHEMA_CLEANUP&&environment.DX_REWORK_TEST_SCHEMA_CLEANUP!=='after-workers')throw Error('TEST_RESOURCE_CLEANUP_MODE_REJECTED');
 if(environment.DX_REWORK_TEST_SCHEMA_CLEANUP!=='after-workers'){
  await dropOwnedPostgresSchema(pool,schema);return {state:'deleted',schema};
 }
 const owner=generated.get(schema);
 if(!owner.runId||owner.runId!==environment.DX_REWORK_TEST_RUN_ID||owner.manifestDir!==environment.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR)throw Error('TEST_RESOURCE_CLEANUP_OWNER_REQUIRED');
 const identities=JSON.parse(environment.DX_REWORK_TEST_RESOURCE_IDENTITIES??'{}');
 // Another worker may still be writing its own receipt. Only this process's
 // already completed receipt is read here; the parent validates ALL after exit.
 const resource=readOwnedResource(owner.manifestDir,schema+'.json',owner.runId,identities);
 if(!resource||JSON.stringify(resource.identity)!==JSON.stringify(owner.identity))throw Error('TEST_RESOURCE_CLEANUP_OWNER_REQUIRED');
 const {assertTestDatabaseTarget}=await import('./test-database-safety.mjs');
 if(JSON.stringify(await assertTestDatabaseTarget(owner.url,pool))!==JSON.stringify(owner.identity))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 return {state:'retained_for_runner',schema,runId:owner.runId};
}
