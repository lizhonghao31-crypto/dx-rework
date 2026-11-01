import assert from 'node:assert/strict';import{test}from'node:test';
import{fixtureRoles,validateFixtureRoles}from'../test-fixture-prerequisites.mjs';
import{classifyFullGatePaths}from'./full-gate-risk-map.mjs';
test('fixture prerequisites reject absent/misprivileged roles before a long migration suite',()=>{
 const roles=fixtureRoles([{path:'tests/integration/acceptance-maintenance-postgres.test.ts'}]);assert.equal(roles.length,2);assert.deepEqual(fixtureRoles([{path:'ordinary.test.ts'}]),[]);
 const rows=roles.map(name=>({name,member:true,superuser:false,createRole:false,createDatabase:false,login:false}));validateFixtureRoles(roles,rows);
 for(const key of ['member','superuser','createRole','createDatabase','login']){const changed=structuredClone(rows);changed[0][key]=!changed[0][key];assert.throws(()=>validateFixtureRoles(roles,changed),/PREREQUISITE_MISSING/);}
 assert.throws(()=>validateFixtureRoles(roles,rows.slice(1)),/PREREQUISITE_MISSING/);
});
test('new execution/evidence/artifact helpers cannot bypass the shared FULL risk classifier',()=>{
 for(const p of ['scripts/owned-command.mjs','scripts/test-execution-config.mjs','scripts/test-fixture-prerequisites.mjs','scripts/ci/test-runtime-metadata.mjs','scripts/ci/light-reuse.mjs','scripts/ci/construction-evidence.mjs'])assert.equal(classifyFullGatePaths([p]).highRisk,true,p);
 assert.equal(classifyFullGatePaths(['scripts/ci/fixture-prerequisites.test.mjs']).highRisk,false);
});
