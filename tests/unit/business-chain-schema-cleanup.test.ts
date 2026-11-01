import {spawnSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {SCHEMA_PREFIXES} from '../../scripts/test-resource-contract.mjs';

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
