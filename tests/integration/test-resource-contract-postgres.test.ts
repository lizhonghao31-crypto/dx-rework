import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawn} from 'node:child_process';
import pg from 'pg';
import {describe,it,expect} from 'vitest';
import {resourceContext,resourceEnvironment,cleanupResources,resourceSmoke} from '../../scripts/test-resource-lifecycle.mjs';
import {ownedPostgresSchema,createOwnedPostgresSchema,readOwnedResources,dropOwnedPostgresSchema,releaseOwnedPostgresSchema} from '../../scripts/test-resource-contract.mjs';

async function finishContext(context:Parameters<typeof cleanupResources>[0],pools:pg.Pool[]){
 let cleaned=false;
 try{await cleanupResources(context);cleaned=true;}
 finally{await Promise.all(pools.map(pool=>pool.end()));if(cleaned)await rm(context.dir,{recursive:true,force:true});else process.stderr.write('TEST_RESOURCE_CLEANUP_EVIDENCE_RETAINED: '+context.dir+'\n');}
}

const url=process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('test resource ownership against actual PostgreSQL',()=>{
 it('cleans a real failing child before expensive suites',async()=>{await resourceSmoke(url!);},15000);
 it('rejects wrong run, identity and an unlabelled database before DROP, retaining the owned schema',async()=>{
  const context=await resourceContext({default:url!}),env=resourceEnvironment(context),schema=ownedPostgresSchema('resource_smoke','default',env),pool=new pg.Pool({connectionString:url});
  try{
   await createOwnedPostgresSchema(pool,schema);
   expect(()=>readOwnedResources(context.dir,'ffffffff',context.identities)).toThrow();
   await expect(cleanupResources({...context,identities:{default:{...context.identities.default,databaseOid:'0'}}})).rejects.toThrow();
   const unlabelled=new URL(url!);unlabelled.pathname='/postgres';
   await expect(cleanupResources({...context,urls:{default:unlabelled.toString()}})).rejects.toThrow('TEST_DATABASE_REJECTED');
   expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(1);
  }finally{await finishContext(context,[pool]);}
 });
 it('binds Acceptance-clock resources to that actual database and refuses a different labelled test target',async()=>{
  const clock=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL;
  if(!clock)throw Error('ACCEPTANCE_CLOCK_TEST_DATABASE_URL is required for the two-target contract');
  const context=await resourceContext({default:url!,'acceptance-clock':clock}),env={...resourceEnvironment(context),TEST_DATABASE_URL:url!,ACCEPTANCE_CLOCK_TEST_DATABASE_URL:clock};
  const schema=ownedPostgresSchema('business_anchors','acceptance-clock',env),pool=new pg.Pool({connectionString:clock});
  try{
   await createOwnedPostgresSchema(pool,schema);
   await expect(cleanupResources({...context,urls:{default:url!,'acceptance-clock':url!}})).rejects.toThrow('TEST_RESOURCE_LIVE_IDENTITY_CHANGED');
   expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(1);
  }finally{await finishContext(context,[pool]);}
 });
 it('preserves a borrowed client for the caller after serialized teardown',async()=>{
  const context=await resourceContext({default:url!}),env={...resourceEnvironment(context),TEST_DATABASE_URL:url!},schema=ownedPostgresSchema('resource_smoke','default',env),pool=new pg.Pool({connectionString:url}),client=await pool.connect();
  try{await createOwnedPostgresSchema(client,schema);await dropOwnedPostgresSchema(client,schema);expect((await client.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);expect((await client.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);}
  finally{client.release();await finishContext(context,[pool]);}
 });
 it.each(['same-db','cross-db','failed-worker'])('retains exact resources until both workers exit (%s), then actually cleans all declared targets',async mode=>{
  const clock=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL;if(!clock)throw Error('Clock test database is required');
  const context=await resourceContext({default:url!,'acceptance-clock':clock}),pools={default:new pg.Pool({connectionString:url}),'acceptance-clock':new pg.Pool({connectionString:clock})};
  const code=`import pg from 'pg';import {ownedPostgresSchema,createOwnedPostgresSchema,releaseOwnedPostgresSchema} from './scripts/test-resource-contract.mjs';
   const target=process.argv[1],url=target==='default'?process.env.TEST_DATABASE_URL:process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL;
   const pool=new pg.Pool({connectionString:url}),schema=ownedPostgresSchema(target==='default'?'resource_smoke':'business_anchors',target);
   try{await createOwnedPostgresSchema(pool,schema);await pool.query('CREATE TABLE "'+schema+'".fixture(id integer)');
    if(process.argv[2]==='fail')throw Error('EXPECTED_FIXTURE_FAILURE');
    const result=await releaseOwnedPostgresSchema(pool,schema);if(result.state!=='retained_for_runner'||!(await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount)throw Error('HANDOFF_IS_NOT_DELETION');
   }finally{await pool.end();}`;
  const worker=(target:string,fail=false)=>new Promise<{code:number|null;stderr:string}>((resolve,reject)=>{
   const child=spawn(process.execPath,['--input-type=module','-e',code,target,fail?'fail':'ok'],{env:{...process.env,...resourceEnvironment(context),NODE_ENV:'test',DATABASE_URL:'',TEST_DATABASE_URL:url!,ACCEPTANCE_CLOCK_TEST_DATABASE_URL:clock},stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',part=>stderr+=part);child.once('error',reject);child.once('exit',code=>resolve({code,stderr}));
  });
  try{
   const failed=mode==='failed-worker',results=await Promise.all([worker('default',failed),worker(mode==='same-db'?'default':'acceptance-clock')]);expect(results[0]!.code).toBe(failed?1:0);if(failed)expect(results[0]!.stderr).toContain('EXPECTED_FIXTURE_FAILURE');expect(results[1]!.code).toBe(0);
   const resources=readOwnedResources(context.dir,context.runId,context.identities);expect(resources).toHaveLength(2);
   for(const r of resources)expect((await pools[r.databaseTarget as keyof typeof pools].query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[r.schema])).rowCount).toBe(1);
   await cleanupResources(context);
   for(const r of resources)expect((await pools[r.databaseTarget as keyof typeof pools].query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[r.schema])).rowCount).toBe(0);
  }finally{await finishContext(context,Object.values(pools));}
 },15000);
 it('immediately deletes outside managed runner mode and refuses a different handoff owner',async()=>{
  const context=await resourceContext({default:url!}),env={...resourceEnvironment(context),TEST_DATABASE_URL:url!},schema=ownedPostgresSchema('resource_smoke','default',env),pool=new pg.Pool({connectionString:url});
  try{
   await createOwnedPostgresSchema(pool,schema);
   await expect(releaseOwnedPostgresSchema(pool,schema,{...env,DX_REWORK_TEST_SCHEMA_CLEANUP:'unknown'})).rejects.toThrow('TEST_RESOURCE_CLEANUP_MODE_REJECTED');
   await expect(releaseOwnedPostgresSchema(pool,schema,{...env,DX_REWORK_TEST_RUN_ID:'ffffffff'})).rejects.toThrow('TEST_RESOURCE_CLEANUP_OWNER_REQUIRED');
   expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(1);
   expect(await releaseOwnedPostgresSchema(pool,schema,{...env,DX_REWORK_TEST_SCHEMA_CLEANUP:''})).toMatchObject({state:'deleted',schema});
   expect((await pool.query('SELECT 1 FROM pg_namespace WHERE nspname=$1',[schema])).rowCount).toBe(0);
  }finally{await finishContext(context,[pool]);}
 });
 it('refuses unregistered resources before creating anything',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dx-unregistered-'));
  const unknownPrefix=['new','forgotten','prefix'].join('_');
  try{expect(()=>ownedPostgresSchema(unknownPrefix,'default',{DX_REWORK_TEST_RUN_ID:'1234abcd',DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:dir})).toThrow('TEST_RESOURCE_UNREGISTERED');}finally{await rm(dir,{recursive:true,force:true});}
 });
});
