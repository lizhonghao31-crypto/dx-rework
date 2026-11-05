import assert from 'node:assert/strict';
import {test} from 'node:test';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {offlineDeploymentPlan,parseChangedPaths,nonDatabaseArguments,OFFLINE_DEPLOYMENT_SUITE} from './offline-deployment-plan.mjs';
import {classifyFullGatePaths} from './full-gate-risk-map.mjs';
const modified=paths=>paths.map(path=>({status:'M',path}));

test('only existing application source/prose changes can omit the offline fixture; all other non-DB tests remain selected',()=>{
 for(const paths of [['apps/api/src/sourcing/sourcing-service.ts'],['apps/web/src/app.tsx','packages/ui/src/table.tsx'],['docs/requirements/example.md'],['README.md']]){
  const plan=offlineDeploymentPlan(modified(paths));assert.equal(plan.required,false);
  assert.deepEqual(nonDatabaseArguments(plan,'/tmp/results.json').slice(-2),['--exclude',OFFLINE_DEPLOYMENT_SUITE]);
 }
 const all=offlineDeploymentPlan([]);assert.equal(all.required,true);assert.ok(!nonDatabaseArguments(all,'report.json').includes('--exclude'));
});
test('direct fixture inputs, execution/selection controls, lockfiles and unknown paths preserve all 22 offline cases',()=>{
 const paths=['scripts/dx-update.sh','scripts/dx-acceptance.sh','scripts/deploy/unknown-new-executor.sh','scripts/migrate.mjs','scripts/migration-branches.json','scripts/test-suite-plan.mjs','scripts/ci/offline-deployment-plan.mjs','scripts/ci/full-gate-lanes.mjs','vitest.config.ts','package.json','package-lock.json','apps/api/package.json','apps/api/src/platform/migration-manifest.json','apps/api/migrations/0001_example.sql','infra/pm2/ecosystem.acceptance.config.cjs','.github/workflows/full-gate.yml',OFFLINE_DEPLOYMENT_SUITE,'tests/integration/acceptance-active-slot-chain.test.py','tests/fixtures/main-tools/scripts/deploy/activate-release.sh','tests/helpers/new-helper.ts','docs/operations/g1-acceptance-compat-update.sh','unknown/config.json'];
 for(const path of paths){const plan=offlineDeploymentPlan(modified(['apps/web/src/app.tsx',path]));assert.equal(plan.required,true,path);assert.ok(!nonDatabaseArguments(plan,'report.json').includes('--exclude'));}
 const risk=classifyFullGatePaths(['scripts/ci/offline-deployment-plan.mjs']);assert.ok(risk.deploymentSensitive&&risk.maintenanceSensitive&&risk.activationSensitive&&risk.transferSensitive);
});
test('new, removed, renamed, malformed or empty paths fall back; no candidate can self-exempt by moving a test',()=>{
 for(const changes of [[],null,[null],...[undefined,'A','D','R100','T','?'].map(status=>[{status,path:'apps/api/src/known.ts'}]),...['../apps/api/src/x.ts','apps/api/src/../x.ts','apps\\api\\src\\x.ts',''].map(path=>[{status:'M',path}])])assert.equal(offlineDeploymentPlan(changes).required,true);
 assert.deepEqual(parseChangedPaths('M\0apps/web/src/app.tsx\0'),modified(['apps/web/src/app.tsx']));
 for(const raw of ['',null,'M\tx\n','R100\0old\0new\0','M\0'])assert.equal(offlineDeploymentPlan(parseChangedPaths(raw)).required,true);
});
test('real Git NUL diff keeps both sides of rename/deletion and whitespace names conservative',()=>{
 const dir=mkdtempSync(join(tmpdir(),'dx-offline-plan-')),git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',stdio:'pipe'});
 try{
  git('init','-q');git('config','user.name','fixture');git('config','user.email','fixture@example.invalid');mkdirSync(join(dir,'apps/web/src'),{recursive:true});
  writeFileSync(join(dir,'apps/web/src/app.ts'),'old\n');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD').trim();
  writeFileSync(join(dir,'apps/web/src/app.ts'),'changed\n');git('add','.');git('commit','-qm','modified');
  assert.equal(offlineDeploymentPlan(parseChangedPaths(git('diff','--name-status','--no-renames','-z',base,'HEAD'))).required,false);
  git('mv','apps/web/src/app.ts','apps/web/src/moved file.ts');git('commit','-qm','rename');
  assert.equal(offlineDeploymentPlan(parseChangedPaths(git('diff','--name-status','--no-renames','-z',base,'HEAD'))).required,true);
 }finally{rmSync(dir,{recursive:true,force:true});}
});
test('the offline test copies deployment/fixture inputs, and retains its exact 22-case execution checks',()=>{
 const wrapper=readFileSync(OFFLINE_DEPLOYMENT_SUITE,'utf8'),python=readFileSync('tests/integration/acceptance-active-slot-chain.test.py','utf8');
 const cases=[...python.matchAll(/^ {4}def (test_\w+)\(/gm)].map(m=>m[1]);assert.equal(cases.length,22);assert.equal(new Set(cases).size,22);
 assert.match(wrapper,/runCases\(originalCases, 14\)/);assert.match(wrapper,/runCases\(activationCases, 8\)/);
 assert.match(python,/required = \[/);assert.match(python,/write\(self.repo \/ "package-lock.json"/);
 // A new copied application input must not silently inherit the independence
 // exception. Check the fixture's declared copies and direct repository reads.
 const declared=python.match(/required = \[([\s\S]*?)\]/)?.[1];assert.ok(declared);
 const copied=[...declared.matchAll(/["']([^"']+)["']/g)].map(m=>m[1]);
 const direct=[...python.matchAll(/REPOSITORY\s*\/\s*["']([^"']+)["']/g)].map(m=>m[1]);
 assert.ok(copied.length>15&&direct.length>=3);
 for(const path of [...copied,...direct])assert.equal(offlineDeploymentPlan(modified([path])).required,true,'offline fixture input: '+path);
 const workflow=readFileSync('.github/workflows/full-gate.yml','utf8');assert.match(workflow,/node scripts\/ci\/full-gate-lanes.mjs test-non-db/);
 const transport=readFileSync('scripts/ci/full-gate-lanes.mjs','utf8');assert.match(transport,/validateBundle\(parsed,\{id,inputs/);assert.match(transport,/validateNonDatabase\(json\(report\),inputs.nonDatabase\)/);
});
