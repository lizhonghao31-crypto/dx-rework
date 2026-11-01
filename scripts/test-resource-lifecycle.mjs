import {spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {assertTestDatabaseTarget} from './test-database-safety.mjs';
import {readOwnedResources} from './test-resource-contract.mjs';

export async function resourceContext(urls) {
 const identities={};
 for(const [target,url]of Object.entries(urls))if(url)identities[target]=await assertTestDatabaseTarget(url);
 return {runId:randomUUID().replaceAll('-','').slice(0,8),dir:await mkdtemp(join(tmpdir(),'dx-test-resources-')),urls,identities};
}
export function resourceEnvironment(context) {
 return {DX_REWORK_TEST_RUN_ID:context.runId,DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:context.dir,DX_REWORK_TEST_RESOURCE_IDENTITIES:JSON.stringify(context.identities)};
}
export async function cleanupResources(context) {
 // Validate every receipt and every live target BEFORE the first DROP; never discover schemas to delete.
 const resources=readOwnedResources(context.dir,context.runId,context.identities);
 for(const target of new Set(resources.map(r=>r.databaseTarget))){
  const actual=await assertTestDatabaseTarget(context.urls[target]);
  if(JSON.stringify(actual)!==JSON.stringify(context.identities[target]))throw Error('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
 }
 for(const target of new Set(resources.map(r=>r.databaseTarget))){
  const pool=new pg.Pool({connectionString:context.urls[target],max:1});
  try{for(const r of resources.filter(r=>r.databaseTarget===target)){
   const client=await pool.connect();
   try{await client.query('BEGIN');await client.query("SELECT pg_advisory_xact_lock(hashtextextended('test-owned-schema-teardown-v1',0))");await client.query(`DROP SCHEMA IF EXISTS "${r.schema}" CASCADE`);await client.query('COMMIT');}
   catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   await assertAbsent(pool,r.schema);
  }}finally{await pool.end();}
 }
 process.stdout.write(`TEST_RESOURCE_CLEANUP_PASSED run=${context.runId} resources=${resources.length}\n`);
}
async function assertAbsent(pool,schema){if((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount)throw Error('TEST_RESOURCE_CLEANUP_RESIDUE');}
export async function resourceSmoke(url) {
 const context=await resourceContext({default:url}),env=resourceEnvironment(context);
 const pool=new pg.Pool({connectionString:url,max:1});let schema,cleaned=false;
 try{
  const child=spawnSync(process.execPath,['--input-type=module','-e',`
   import pg from 'pg';
   import {ownedPostgresSchema} from './scripts/test-resource-contract.mjs';
   if(process.env.DATABASE_URL!=='')throw Error('GENERIC_DATABASE_INHERITED');
   const schema=ownedPostgresSchema('resource_smoke');const pool=new pg.Pool({connectionString:process.env.TEST_DATABASE_URL});
   try{await pool.query('CREATE SCHEMA "'+schema+'"');await pool.query('CREATE TABLE "'+schema+'".smoke(id integer)');console.log(schema);}finally{await pool.end();}
   throw Error('EXPECTED_FIXTURE_FAILURE');
  `],{encoding:'utf8',env:{...process.env,...env,NODE_ENV:'test',DATABASE_URL:'',TEST_DATABASE_URL:url}});
  if(child.status!==1||!child.stderr.includes('EXPECTED_FIXTURE_FAILURE'))throw Error('TEST_RESOURCE_FAILURE_CHILD_DID_NOT_EXECUTE');
  schema=child.stdout.trim();
  if(!(await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount)throw Error('TEST_RESOURCE_SMOKE_NOT_CREATED');
 }finally{
  try{await cleanupResources(context);cleaned=true;if(schema)await assertAbsent(pool,schema);}
  finally{await pool.end();if(cleaned)await rm(context.dir,{recursive:true,force:true});else console.error('TEST_RESOURCE_CLEANUP_EVIDENCE_RETAINED: '+context.dir);}
 }
 process.stdout.write('TEST_RESOURCE_CREATE_REGISTER_FAILURE_CLEANUP_SMOKE_PASSED\n');
}
