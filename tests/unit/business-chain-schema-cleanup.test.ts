import assert from 'node:assert/strict';
import {spawnSync,execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,readdirSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {SCHEMA_PREFIXES,claimMainMaintenancePublic,readOwnedResources} from '../../scripts/test-resource-contract.mjs';
import {postgresPlan,fullGatePostgresPlan} from '../../scripts/test-suite-plan.mjs';
import {classifyFullGatePaths} from '../../scripts/ci/full-gate-risk-map.mjs';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

describe('shared PostgreSQL resource contract',()=>{
 it('rejects unknown resources before creation, even outside a managed run',()=>{
  expect(()=>ownedPostgresSchema('unknown_schema')).toThrow('TEST_RESOURCE_UNREGISTERED');
  expect(SCHEMA_PREFIXES).toContain('pmc_role');expect(SCHEMA_PREFIXES).toContain('release_lock');expect(SCHEMA_PREFIXES).toContain('business_anchors');
 });
 it('does not sign a Full PG pass with missing classification or an empty plan',()=>{
  const dir=mkdtempSync(join(tmpdir(),'dx-no-empty-pass-')),receipt=join(dir,'receipt.json');
  const env={...process.env,NODE_ENV:'test',TEST_DATABASE_URL:'postgresql://never-connect.invalid/test',DX_REWORK_POSTGRES_RECEIPT:receipt,DX_REWORK_TEST_EXECUTION_ID:'negative-contract',BASE_SHA:'b'.repeat(40)};
  const invoke=(extra:Record<string,string>)=>spawnSync(process.execPath,['scripts/run-business-chain-gate.mjs','--full-gate'],{encoding:'utf8',env:{...env,DB_REQUIRED:'',BUSINESS_CHAIN_SENSITIVE:'',MIGRATION_SENSITIVE:'',DEPLOYMENT_SENSITIVE:'',MAPPED_POSTGRES_TESTS:'',...extra},timeout:10000});
  try{
   expect(invoke({}).status).not.toBe(0);
   const empty={DB_REQUIRED:'true',BUSINESS_CHAIN_SENSITIVE:'false',MIGRATION_SENSITIVE:'false',DEPLOYMENT_SENSITIVE:'false',MAPPED_POSTGRES_TESTS:''};
   const rejected=invoke(empty);expect(rejected.status).not.toBe(0);expect(rejected.stderr).toContain('POSTGRES_EMPTY_PLAN_REJECTED');
   const na=invoke({...empty,DB_REQUIRED:'false',TEST_DATABASE_URL:'',DX_REWORK_TEST_EXECUTION_ID:''});
   expect(na.status,na.stderr).toBe(0);expect(na.stdout).toContain('POSTGRES_NOT_APPLICABLE');expect(JSON.parse(readFileSync(receipt,'utf8')).status).toBe('not-applicable');expect(na.stdout).not.toContain('GATE_PASSED');
  }finally{rmSync(dir,{recursive:true,force:true});}
 });
 it('uses exactly one contract for creation, manifest validation and cleanup',async()=>{
  const helper=await readFile(new URL('../helpers/owned-postgres-schema.ts',import.meta.url),'utf8');
  const cleanup=await readFile(new URL('../../scripts/test-resource-lifecycle.mjs',import.meta.url),'utf8');
  expect(helper).toContain('test-resource-contract.mjs');expect(cleanup).toContain('readOwnedResources');
  expect(cleanup).toContain('assertTestDatabaseTarget(context.urls[target])');expect(cleanup).toContain('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
  expect(cleanup).not.toMatch(/WHERE nspname (?:LIKE|~)/);
  expect(cleanup).toContain('EXPECTED_FIXTURE_FAILURE');expect(cleanup).toContain('child.status!==1');
 });
 it('clears generic database URL at both Vitest and subprocess boundaries',async()=>{
  const [config,chain,runner]=await Promise.all(['vitest.config.ts','vitest.business-chain.config.ts','scripts/run-business-chain-gate.mjs'].map(path=>readFile(path,'utf8')));
  expect(config).toContain('env: { DATABASE_URL: "" }');expect(chain).toContain('env: { DATABASE_URL: "" }');
  expect(runner).toContain("DATABASE_URL:''");expect(runner).not.toContain('?? process.env.DATABASE_URL');
 });
});

// These behavioral checks import installed pg/Vitest modules and therefore run
// in the unit phase, after npm ci; native preinstall protocol checks stay dependency-free.
const identity={database:'dx_rework_ci',username:'dx_rework_test',databaseOid:'42',serverVersion:'160015',marker:'dx-rework-isolated-test-v1'};
const maintenanceIdentity={database:'dx_rework_main_0232_test',username:'dx_rework_test',marker:'dx-rework-isolated-test-v1',databaseOid:'43',serverVersion:'160015',port:'5432',address:'127.0.0.1',allowConnections:true,isTemplate:false,isSuperuser:false,canCreateDatabase:false,canCreateRole:false,canReplicate:false,canBypassRls:false};
const maintenanceUrl='postgresql://dx_rework_test@127.0.0.1:5432/dx_rework_main_0232_test',maintenanceAdminUrl='postgresql://postgres@127.0.0.1:5432/dx_rework_main_0232_test';
const maintenanceIdentities={default:{...identity,port:'5432',address:'127.0.0.1'},'main-maintenance':maintenanceIdentity};
const maintenanceEnvironment=(dir:string)=>({DX_REWORK_TEST_RUN_ID:'1234abcd',DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:dir,DX_REWORK_TEST_RESOURCE_IDENTITIES:JSON.stringify(maintenanceIdentities),DX_REWORK_TEST_SCHEMA_CLEANUP:'after-workers',MAIN_0232_TEST_DATABASE_URL:maintenanceUrl,MAIN_0232_TEST_ADMIN_DATABASE_URL:maintenanceAdminUrl});
function maintenanceQueryable(live=maintenanceIdentity,state={present:true,occupied:false}){
 const queries:string[]=[];
 return {queries,async query(sql:string){
  queries.push(sql);
  if(sql.includes('FROM pg_database database'))return {rows:[{database:live.database,username:live.username,marker:live.marker,database_oid:live.databaseOid,server_version:live.serverVersion,port:live.port,address:live.address,allow_connections:live.allowConnections,is_template:live.isTemplate,is_superuser:live.isSuperuser,can_create_database:live.canCreateDatabase,can_create_role:live.canCreateRole,can_replicate:live.canReplicate,can_bypass_rls:live.canBypassRls}]};
  if(sql.includes("to_regnamespace('public')"))return {rows:[state]};
  throw Error('UNEXPECTED_MAINTENANCE_QUERY');
 }};
}
async function withMaintenanceFixture(check:(dir:string,environment:NodeJS.ProcessEnv)=>void|Promise<void>){
 const dir=mkdtempSync(join(tmpdir(),'dx-maintenance-contract-')),previousNodeEnv=process.env.NODE_ENV;
 process.env.NODE_ENV='test';
 try{await check(dir,maintenanceEnvironment(dir));}
 finally{if(previousNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=previousNodeEnv;rmSync(dir,{recursive:true,force:true});}
}

it('maintenance fixture cannot start an unowned migration through a direct CLI entry',()=>{
 const output=execFileSync(process.execPath,['tests/fixtures/main-0232-maintenance.mjs'],{encoding:'utf8',env:{...process.env,NODE_ENV:'test',DATABASE_URL:'',TEST_DATABASE_URL:'postgresql://unused@never-connect.invalid/test',TEST_ADMIN_DATABASE_URL:'postgresql://unused@never-connect.invalid/test',MAIN_0232_EXPECTED_PG_MAJOR:'13'}});
 assert.equal(output,'');
});
it('main maintenance public claim records one exclusive receipt after read-only identity and emptiness checks',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  const pool=maintenanceQueryable();await claimMainMaintenancePublic(pool,environment);
  const resources=readOwnedResources(dir,environment.DX_REWORK_TEST_RUN_ID,maintenanceIdentities);
  assert.deepEqual(resources,[{version:1,kind:'main-maintenance-public',runId:'1234abcd',schema:'public',databaseTarget:'main-maintenance',identity:maintenanceIdentity}]);
  assert.equal(pool.queries.length,2);assert.ok(pool.queries.every(sql=>/^\s*SELECT\b/.test(sql)));
  const receipt=readFileSync(join(dir,'main-maintenance-1234abcd.json'),'utf8');
  await assert.rejects(()=>claimMainMaintenancePublic(pool,environment),{code:'EEXIST'});
  assert.equal(readFileSync(join(dir,'main-maintenance-1234abcd.json'),'utf8'),receipt);
 });
});
it('main maintenance claim rejects absent cleanup ownership and changed live identity before writing a receipt',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  const neverQuery={query(){throw Error('MUST_NOT_QUERY');}};
  for(const change of [{DX_REWORK_TEST_RUN_ID:undefined},{DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:undefined},{DX_REWORK_TEST_SCHEMA_CLEANUP:'immediate'}])await assert.rejects(()=>claimMainMaintenancePublic(neverQuery,{...environment,...change}),/TEST_RESOURCE_CLEANUP_OWNER_REQUIRED/);
  await assert.rejects(()=>claimMainMaintenancePublic(neverQuery,{...environment,MAIN_0232_TEST_DATABASE_URL:maintenanceUrl.replace('127.0.0.1','192.0.2.1')}),/TEST_MAINTENANCE_TARGET_REJECTED/);
  const changed=maintenanceQueryable({...maintenanceIdentity,databaseOid:'99'});
  await assert.rejects(()=>claimMainMaintenancePublic(changed,environment),/TEST_RESOURCE_LIVE_IDENTITY_CHANGED/);
  assert.equal(changed.queries.length,1);assert.deepEqual(readdirSync(dir),[]);
 });
});
it('main maintenance public claim rejects a missing or occupied public schema',async()=>{
 await withMaintenanceFixture(async(dir,environment)=>{
  for(const state of [{present:false,occupied:false},{present:true,occupied:true}]){
   const pool=maintenanceQueryable(maintenanceIdentity,state);
   await assert.rejects(()=>claimMainMaintenancePublic(pool,environment),/TEST_MAINTENANCE_FRESH_PUBLIC_REQUIRED/);
   assert.equal(pool.queries.length,2);assert.deepEqual(readdirSync(dir),[]);
  }
 });
});
it('0232 maintenance actually enters the canonical Full plan once and uses the isolated single-worker configuration',async()=>{
 const file='tests/integration/main-0232-maintenance-postgres.test.ts',risk=classifyFullGatePaths(['scripts/deploy/main-maintenance-plans.json']);
 const full=fullGatePostgresPlan({DB_REQUIRED:String(risk.dbRequired),BUSINESS_CHAIN_SENSITIVE:String(risk.businessChainSensitive),MIGRATION_SENSITIVE:String(risk.migrationSensitive),DEPLOYMENT_SENSITIVE:String(risk.deploymentSensitive),MAPPED_POSTGRES_TESTS:[...risk.mappedPostgresTests,file,file].join(','),BASE_SHA:'b'.repeat(40)});
 const selected=full.plan.filter(row=>row.path===file);
 assert.equal(selected.length,1);assert.deepEqual(selected[0].memberships,['mapped','chain']);
 assert.equal(selected[0].config,'vitest.postgres-immediate.config.ts');
 assert.equal(postgresPlan({chain:true}).filter(row=>row.path===file).length,1);
 const {default:configuration}=await import('../../vitest.postgres-immediate.config.ts');
 assert.equal(configuration.test.maxWorkers,testExecutionConfig.workers.postgres);assert.equal(configuration.test.maxWorkers,1);
});
