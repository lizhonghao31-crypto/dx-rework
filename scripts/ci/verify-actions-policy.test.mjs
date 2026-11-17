import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

const files=['scripts/ci/verify-actions-policy.mjs','scripts/ci/full-gate-risk-map.mjs',...['ci','full-gate','governance','pr-preview','pr-17-release'].map(name=>`.github/workflows/${name}.yml`)];
function verify(mutate=source=>source,workflow='ci'){
 const directory=mkdtempSync(join(tmpdir(),'dx-actions-policy-'));
 try{
  for(const file of files){const target=join(directory,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);}
  const path=join(directory,`.github/workflows/${workflow}.yml`);writeFileSync(path,mutate(readFileSync(path,'utf8')));
  return spawnSync(process.execPath,[join(directory,'scripts/ci/verify-actions-policy.mjs')],{encoding:'utf8',timeout:10000});
 }finally{rmSync(directory,{recursive:true,force:true});}
}
test('the actual Actions validator accepts the once-only workflow used by Light and Full',()=>{
 const result=verify();assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/ACTIONS_USAGE_POLICY_OK/);
});
for(const event of ['synchronize','reopened','edited'])test(`the actual validator rejects restoring repeated Light on ${event}`,()=>{
 const result=verify(source=>source.replace('      - opened','      - opened\n      - '+event));assert.notEqual(result.status,0);assert.match(result.stderr,/Light must trigger only once/);
});
test('the actual validator rejects Light retry workers and cancelling queued final work',()=>{
 const retry=verify(source=>source.replaceAll(' && github.run_attempt == 1',''));assert.notEqual(retry.status,0);assert.match(retry.stderr,/reject later events and repeat attempts/);
 const cancellation=verify(source=>source.replace('cancel-in-progress: false','cancel-in-progress: true'));assert.notEqual(cancellation.status,0);assert.match(cancellation.stderr,/queue without cancelling/);
});

for(const workflow of ['ci','full-gate']){
 const label=workflow==='ci'?'Quick':'Full';
 for(const [fault,mutate]of [
  ['rename folding',source=>source.replace('git diff --no-renames --name-only','git diff --name-only')],
  ['explicit rename detection',source=>source.replace('git diff --no-renames --name-only','git diff --find-renames --name-only')],
  ['mutable base',source=>source.replace('git diff --no-renames --name-only "${BASE_SHA}"','git diff --no-renames --name-only "origin/main"')],
  ['unfrozen head',source=>source.replace('git diff --no-renames --name-only "${BASE_SHA}" "${HEAD_SHA}"','git diff --no-renames --name-only "${BASE_SHA}" "${GITHUB_SHA}"')],
  ['deleted paths filtered',source=>source.replace('git diff --no-renames --name-only','git diff --diff-filter=AM --no-renames --name-only')],
  ['wrong changed-file output',source=>source.replace(/(git diff --no-renames --name-only[^\n]+\/)(quick|full)(-gate-changed-files\.txt)/,(_match,before,kind,after)=>before+(kind==='quick'?'full':'quick')+after)],
  ['valid text only in a comment',source=>source.replace(/^(\s*)(git diff --no-renames --name-only[^\n]+)$/m,'$1# $2\n$1git diff --name-only "${BASE_SHA}" "${HEAD_SHA}" > "$RUNNER_TEMP/changed.txt"')],
 ])test(`the actual ${label} validator rejects ${fault}`,()=>{
  const result=verify(mutate,workflow);assert.notEqual(result.status,0);assert.match(result.stderr,new RegExp(`${label} Gate classifier must classify exact PR diff with rename paths preserved`));
 });
}
