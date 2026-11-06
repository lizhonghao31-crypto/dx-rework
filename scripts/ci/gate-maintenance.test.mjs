import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {owner} from './full-gate-lanes.mjs';
import {classifyFullGatePaths} from './full-gate-risk-map.mjs';
import {scopeFor,scopeRequired} from './ci-gate-runtime.mjs';
import {fullGatePostgresPlan,POSTGRES_CHAIN_TESTS,ROOT_AUDIT_TESTS} from '../test-suite-plan.mjs';

const sources = Object.fromEntries(['quick','full'].map(mode => [mode, readFileSync(`.github/workflows/${mode === 'quick' ? 'ci' : 'full-gate'}.yml`, 'utf8')]));
const worker = (text, id) => text.split(`\n  ${id}:\n`)[1].split(/\n {2}[a-zA-Z][\w-]*:\n/)[0];
const workflow = {quick: worker(sources.quick,'validate'), full: worker(sources.full,'full-validate')};

const renderer = mode => workflow[mode].split("          node <<'GATE_SUMMARY_JS'\n")[1].split('          GATE_SUMMARY_JS')[0].split('\n').map(line=>line.slice(10)).join('\n');
const catalog = mode => JSON.parse(workflow[mode].match(/GATE_CHECKS_JSON: >-\n {12}([^\n]+)/)[1]);
const scope = mode => mode==='full'?{event:'pull_request',base:'release/digital-production-v1',db:'true',mapped:'test.ts',journey:'true',migration:'true',business_chain:'true',deployment:'true',maintenance:'true',activation:'true',transfer:'true'}:{event:'pull_request',base:'release/digital-production-v1',governance:'true',web:'false',maintenance:'true'};
const allSteps = mode => Object.fromEntries(catalog(mode).map(([id])=>[id,{outcome:'success',conclusion:'success'}]));
function summary(mode, steps, state='success', flags=scope(mode)) {
  const dir=mkdtempSync(join(tmpdir(),'ci-summary-fixture-')),file=join(dir,'summary.md');
  try {
    const result=spawnSync(process.execPath,[],{input:renderer(mode),encoding:'utf8',env:{...process.env,GATE_KIND:mode,GATE_HEAD:'fixture-fixed-sha',GATE_JOB_STATUS:state,GATE_STEPS_JSON:JSON.stringify(steps),GATE_SCOPE_JSON:JSON.stringify(flags),GATE_CHECKS_JSON:JSON.stringify(catalog(mode)),GITHUB_STEP_SUMMARY:file}});
    assert.equal(result.error,undefined);return {code:result.status,text:readFileSync(file,'utf8'),stderr:result.stderr};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('both workflows use the same actual-outcome renderer and every step is catalogued once',()=>{
  assert.equal(renderer('quick'),renderer('full'));
  for(const mode of ['quick','full']) {
    const source=mode==='full'?['prepare','non-db','postgres'].map(id=>worker(sources.full,id)).join('\n'):workflow[mode];
    const ids=[...source.matchAll(/^ {8}id: (\w+)$/gm)].map(match=>match[1]).filter(id=>!['summary','lane','bundle','bundle_upload'].includes(id));
    assert.deepEqual(catalog(mode).map(row=>row[0]).sort(),ids.sort());
    if(mode==='full')for(const [id]of catalog(mode))assert.match(worker(sources.full,owner(id)),new RegExp('id: '+id+'\\n'));
    assert.equal(new Set(ids).size,ids.length);
    for(const [id,label] of catalog(mode)) assert.ok(source.includes(`      - name: ${label}\n        id: ${id}`));
  }
});
for(const mode of ['quick','full']) {
  test(`${mode}: completed required checks report success`,()=>{
    const result=summary(mode,allSteps(mode));assert.equal(result.code,0);assert.match(result.text,/未完成必需检查（含范围未判定）：无/);
  });
  test(`${mode}: failure plus downstream skips never says completed`,()=>{
    const steps=allSteps(mode);steps.policy={outcome:'failure',conclusion:'success'};
    const stopped=catalog(mode).findIndex(([id])=>id==='policy');
    for(const [id]of catalog(mode).slice(stopped+1))steps[id]={outcome:'skipped'};
    steps[mode==='full'?'risk':'classify']={outcome:'skipped'};
    const result=summary(mode,steps,'failure');assert.match(result.text,/Verify Actions usage policy \| 失败/);assert.match(result.text,/范围未判定，未完成/);assert.doesNotMatch(result.text,/checks.*completed|checks.*passed/);
  });
  test(`${mode}: checkout failure is summarized without repository files`,()=>{
    const result=summary(mode,{title:{outcome:'success'},checkout:{outcome:'failure'}},'failure');
    assert.match(result.text,/Checkout exact PR Head \| 失败/);assert.match(result.text,/未完成必需检查.*Verify/);assert.match(result.text,/fixture-fixed-sha/);
  });
}
test('Full timeout keeps passed checks, cancelled stage and downstream omissions distinct',()=>{
  const steps=allSteps('full');steps.acceptance_recovery={outcome:'cancelled'};for(const id of ['release_history','release_acceptance','package'])steps[id]={outcome:'skipped'};
  const result=summary('full',steps,'cancelled');assert.match(result.text,/Lint \| 成功/);assert.match(result.text,/Acceptance low-privilege migration and backup recovery \| 取消/);assert.match(result.text,/PR-17 package, runtime and relocation-safe transfer \| 取消导致未执行/);assert.match(result.text,/未完成必需检查.*Acceptance low-privilege.*PR-17 package/);
});
test('unclassified risk is not silently declared inapplicable',()=>{
  const result=summary('full',{title:{outcome:'success'}},'cancelled',{event:'pull_request',base:'main'});
  assert.match(result.text,/Start isolated PostgreSQL only for DB-sensitive changes \| 范围未判定，未完成/);
});
test('known non-DB scope reports DB stages inapplicable',()=>{
  const flags={...scope('full'),base:'main',db:'false',mapped:'',journey:'false',migration:'false',business_chain:'false',deployment:'false',maintenance:'false',activation:'false',transfer:'false'},steps=allSteps('full');
  for(const [id,,kind]of catalog('full'))if(kind!=='always')steps[id]={outcome:'skipped'};
  const result=summary('full',steps,'success',flags);assert.equal(result.code,0);assert.match(result.text,/Start isolated PostgreSQL only for DB-sensitive changes \| 不适用/);
});
const ordinaryMigrationPaths=['apps/api/migrations/9999_business.sql','apps/api/src/platform/migration-manifest.json','scripts/deploy/acceptance-migration-requirements.json','scripts/migration-branches.json','scripts/migration-main-extensions.json'];
const sharedGatePaths=['.github/workflows/ci.yml','scripts/ci/full-gate-risk-map.mjs','scripts/ci/ci-gate-runtime.mjs','scripts/ci/full-gate-lanes.mjs','scripts/ci/impact-shadow.mjs','scripts/ci/impact-shadow-graph.mjs','scripts/ci/impact-shadow-binding.mjs','scripts/ci/impact-shadow-policy.json','scripts/ci/pr-gate-protocol.mjs','scripts/ci/pr-gate-controller.mjs','scripts/ci/verify-actions-policy.mjs','scripts/ci/light-reuse.mjs','scripts/ci/construction-evidence.mjs','scripts/test-suite-plan.mjs','scripts/test-execution-config.mjs','vitest.business-chain.config.ts'];
const drillIds=['backup','acceptance_recovery','release_history','release_acceptance','package'];
const finalPlan={phase:'final',kind:'full',baseRef:'release/digital-production-v1'};
test('ordinary business migrations plus inventories and test mappings do not re-enable simulated operations',()=>{
  for(const paths of [...ordinaryMigrationPaths.map(p=>[p]),...sharedGatePaths.map(p=>[p]),[...ordinaryMigrationPaths,...sharedGatePaths],[...sharedGatePaths,...ordinaryMigrationPaths,...ordinaryMigrationPaths].reverse()]){
    const risk=classifyFullGatePaths(paths),flags=scopeFor(finalPlan,paths);
    assert.equal(risk.highRisk,true);assert.equal(risk.dbRequired,true);
    for(const key of ['maintenance','activation','transfer'])assert.equal(flags[key],'false');
    for(const id of drillIds)assert.equal(scopeRequired(catalog('full').find(row=>row[0]===id)[2],flags),false,id);
    const plan=fullGatePostgresPlan({BASE_SHA:'0e2692e39f0d000a566ed025947528fba324e87e',DB_REQUIRED:flags.db,BUSINESS_CHAIN_SENSITIVE:flags.business_chain,MIGRATION_SENSITIVE:flags.migration,DEPLOYMENT_SENSITIVE:flags.deployment,MAPPED_POSTGRES_TESTS:flags.mapped});
    const files=plan.plan.map(row=>row.path);
    for(const file of POSTGRES_CHAIN_TESTS)assert.ok(files.includes(file),file);
    if(flags.migration==='true')for(const file of ROOT_AUDIT_TESTS)assert.ok(files.includes(file),file);
    for(const file of ['migration-compatibility','acceptance-maintenance'])assert.ok(!files.includes(`tests/integration/${file}-postgres.test.ts`));
  }
});
test('CLI flags, runtime scope and actual summary agree that business migration drills are inapplicable',()=>{
  const dir=mkdtempSync(join(tmpdir(),'ci-drill-scope-'));try{
    const paths=[...ordinaryMigrationPaths,...sharedGatePaths],changed=join(dir,'changed'),envFile=join(dir,'env');writeFileSync(changed,paths.join('\n'));
    const result=spawnSync(process.execPath,['scripts/ci/full-gate-risk-map.mjs','--github-env',envFile,changed],{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
    const env=Object.fromEntries(readFileSync(envFile,'utf8').trim().split('\n').map(line=>line.split('=')));
    for(const key of ['MAINTENANCE_SENSITIVE','ACTIVATION_SENSITIVE','TRANSFER_SENSITIVE'])assert.equal(env[key],'false');
    assert.equal(env.MIGRATION_SENSITIVE,'true');assert.equal(env.DB_REQUIRED,'true');
    const flags=scopeFor(finalPlan,paths),steps=allSteps('full');for(const id of drillIds)steps[id]={outcome:'skipped'};
    const rendered=summary('full',steps,'success',flags);assert.equal(rendered.code,0);
    for(const id of drillIds)assert.ok(rendered.text.includes(catalog('full').find(row=>row[0]===id)[1]+' | 不适用'));
    steps.db_migrate={outcome:'failure'};const failed=summary('full',steps,'failure',flags),label=catalog('full').find(row=>row[0]==='db_migrate')[1];assert.ok(failed.text.includes(label+' | 失败'));assert.ok(failed.text.split('\n').find(line=>line.startsWith('未完成必需检查')).includes(label));
  }finally{rmSync(dir,{recursive:true,force:true});}
});
test('migration and backup tools still require recovery; unknown deployment executors remain conservative',()=>{
  for(const path of ['scripts/migrate.mjs','scripts/migration-lib.mjs','scripts/migration-history-policy.mjs','scripts/check-migrations.mjs','scripts/seed-base-migrations.sh','scripts/migration-integration-check.mjs','scripts/check-migration-export.mjs','scripts/deploy/migration-execution-compatibility.mjs','scripts/backup-postgres.sh','scripts/restore-postgres.sh','scripts/ci/acceptance-maintenance-drill.mjs','scripts/ci/main-release-history-drill.mjs','.github/workflows/full-gate.yml','.github/workflows/future-deploy.yml','scripts/deploy/future-maintenance.sh','infra/future.tf']){
    const paths=[...ordinaryMigrationPaths,...sharedGatePaths,path],risk=classifyFullGatePaths(paths),flags=scopeFor(finalPlan,paths);
    assert.equal(risk.maintenanceSensitive,true,path);assert.ok(risk.mappedPostgresTests.includes('tests/integration/migration-compatibility-postgres.test.ts'),path);
    for(const id of ['backup','acceptance_recovery','release_history'])assert.equal(scopeRequired(catalog('full').find(row=>row[0]===id)[2],flags),true,path+':'+id);
    const steps=allSteps('full');steps.acceptance_recovery={outcome:'skipped'};assert.equal(summary('full',steps,'success',flags).code,1);
  }
});
test('activation and transfer keep their existing bounded applicability',()=>{
  const activation=scopeFor(finalPlan,['scripts/deploy/activate-release.sh']);assert.equal(activation.maintenance,'false');assert.equal(activation.activation,'true');assert.equal(activation.transfer,'false');
  const transfer=scopeFor(finalPlan,['scripts/deploy/package-release.sh']);assert.equal(transfer.maintenance,'false');assert.equal(transfer.activation,'false');assert.equal(transfer.transfer,'true');
});
test('unexpected skipped required check fails closed even if earlier job status is success',()=>{
  const steps=allSteps('full');steps.tests={outcome:'skipped'};const result=summary('full',steps);
  assert.equal(result.code,1);assert.match(result.text,/Full unit and integration suite without runtime DB escalation \| 上游中断或未执行/);
});
test('web scope with no changed tests reports not applicable rather than tests passed',()=>{
  const steps=allSteps('quick');steps.web_tests={outcome:'success',outputs:{has_tests:'false'}};
  const result=summary('quick',steps,'success',{...scope('quick'),governance:'false',web:'true',maintenance:'false'});
  assert.equal(result.code,0);assert.match(result.text,/Run changed web unit tests \| 不适用/);
});
test('CI runs the original full Vitest command without changing local npm pretest or coverage',()=>{
  const pkg=JSON.parse(readFileSync('package.json','utf8'));assert.equal(pkg.scripts.test,'vitest run');assert.equal(pkg.scripts.pretest,'npm run build:packages');
  assert.match(sources.full,/run: node node_modules\/vitest\/vitest.mjs run --reporter=default --reporter=json --outputFile=/);assert.doesNotMatch(workflow.full,/run: npm test/);
  assert.equal((sources.full.match(/run: node scripts\/ci\/light-reuse.mjs run build npm run build --workspaces --if-present/g)||[]).length,1);
});
const allowFiles=['.github/workflows/ci.yml','.github/workflows/full-gate.yml','scripts/ci/verify-actions-policy.mjs','scripts/ci/gate-maintenance.test.mjs','docs/governance/ci-event-cost-fix-20261023.md'];
const approvedEnv={GITHUB_REPOSITORY:'lizhonghao31-crypto/dx-rework',HEAD_REPO:'lizhonghao31-crypto/dx-rework',GITHUB_HEAD_REF:'fix/ci-event-cost-summary',BASE_SHA:'cab8412cbd4d0141044f05cd71f2102e874b518f'};
for(const [label,env,files,code] of [
  ['retired maintenance authorization cannot be reused',approvedEnv,allowFiles,1],
  ['another branch',{...approvedEnv,GITHUB_HEAD_REF:'feature/other'},allowFiles,1],
  ['fork',{...approvedEnv,HEAD_REPO:'other/fork'},allowFiles,1],
  ['different base',{...approvedEnv,BASE_SHA:'changed'},allowFiles,1],
  ['business change',approvedEnv,[...allowFiles,'apps/api/src/production-platform/task-service.ts'],1],
  ['risk-map change',approvedEnv,[...allowFiles,'scripts/ci/full-gate-risk-map.mjs'],1],
  ['migration',approvedEnv,[...allowFiles,'apps/api/migrations/0254.sql'],1],
  ['empty diff',approvedEnv,[],1],
])test(`Quick exception scope: ${label}`,()=>{
  const dir=mkdtempSync(join(tmpdir(),'ci-exception-'));try{
    const file=join(dir,'files');writeFileSync(file,files.join('\n'));
    const result=spawnSync(process.execPath,['scripts/ci/verify-actions-policy.mjs','--approved-quick-maintenance',file],{encoding:'utf8',env:{...process.env,...env}});
    assert.equal(result.status,code,result.stderr);assert.match(result.stderr,/RETIRED_SINGLE_PR_MAINTENANCE_AUTHORIZATION/);
  }finally{rmSync(dir,{recursive:true,force:true});}
});
