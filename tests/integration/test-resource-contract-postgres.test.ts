import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import pg from 'pg';
import {describe,it,expect} from 'vitest';
import {resourceContext,resourceEnvironment,cleanupResources,resourceSmoke} from '../../scripts/test-resource-lifecycle.mjs';
import {ownedPostgresSchema,createOwnedPostgresSchema,readOwnedResources,dropOwnedPostgresSchema} from '../../scripts/test-resource-contract.mjs';

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
  }finally{try{await cleanupResources(context);}finally{await pool.end();await rm(context.dir,{recursive:true,force:true});}}
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
  }finally{try{await cleanupResources(context);}finally{await pool.end();await rm(context.dir,{recursive:true,force:true});}}
 });
 it('preserves a borrowed client for the caller after serialized teardown',async()=>{
  const context=await resourceContext({default:url!}),env={...resourceEnvironment(context),TEST_DATABASE_URL:url!},schema=ownedPostgresSchema('resource_smoke','default',env),pool=new pg.Pool({connectionString:url}),client=await pool.connect();
  try{await createOwnedPostgresSchema(client,schema);await dropOwnedPostgresSchema(client,schema);expect((await client.query('SELECT 1 AS alive')).rows[0].alive).toBe(1);}
  finally{client.release();try{await cleanupResources(context);}finally{await pool.end();await rm(context.dir,{recursive:true,force:true});}}
 });
 it('refuses unregistered resources before creating anything',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'dx-unregistered-'));
  const unknownPrefix=['new','forgotten','prefix'].join('_');
  try{expect(()=>ownedPostgresSchema(unknownPrefix,'default',{DX_REWORK_TEST_RUN_ID:'1234abcd',DX_REWORK_TEST_RESOURCE_MANIFEST_DIR:dir})).toThrow('TEST_RESOURCE_UNREGISTERED');}finally{await rm(dir,{recursive:true,force:true});}
 });
});
