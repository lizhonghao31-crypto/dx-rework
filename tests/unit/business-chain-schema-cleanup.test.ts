import {readFile} from 'node:fs/promises';
import {describe,expect,it} from 'vitest';
import {ownedPostgresSchema} from '../helpers/owned-postgres-schema.js';
import {SCHEMA_PREFIXES} from '../../scripts/test-resource-contract.mjs';

describe('shared PostgreSQL resource contract',()=>{
 it('rejects unknown resources before creation, even outside a managed run',()=>{
  expect(()=>ownedPostgresSchema('unknown_schema')).toThrow('TEST_RESOURCE_UNREGISTERED');
  expect(SCHEMA_PREFIXES).toContain('customer_quote');expect(SCHEMA_PREFIXES).toContain('acceptance_people');expect(SCHEMA_PREFIXES).toContain('business_anchors');
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
