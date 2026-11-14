import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtempSync,mkdirSync,copyFileSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {spawnSync} from 'node:child_process';

const files=['scripts/ci/verify-actions-policy.mjs','scripts/ci/full-gate-risk-map.mjs',...['ci','full-gate','governance','pr-preview','pr-17-release'].map(name=>`.github/workflows/${name}.yml`)];
function verify(mutate=source=>source){
 const directory=mkdtempSync(join(tmpdir(),'dx-actions-policy-'));
 try{
  for(const file of files){const target=join(directory,file);mkdirSync(dirname(target),{recursive:true});copyFileSync(file,target);}
  const path=join(directory,'.github/workflows/ci.yml');writeFileSync(path,mutate(readFileSync(path,'utf8')));
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
