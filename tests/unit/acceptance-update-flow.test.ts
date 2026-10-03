import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {mayRecoverOldRuntime} from '../../scripts/deploy/acceptance-update-policy.mjs';

function run(failure:string) {
 return spawnSync('bash',['-c',`
set -euo pipefail
source scripts/deploy/acceptance-update-flow.sh
worker() {
 echo "worker:$1"
 case "$SCENARIO:$1" in
  current:prepare) return 10;;
  build:prepare|backup:backup|stop:stop|startup:activate|public:activate) return 1;;
  partial:recover|stopped:recover) return 1;;
 esac
 return 0
}
maintenance() {
 echo "maintenance:$1"
 case "$SCENARIO:$1" in
  permissions:preflight|identity:preflight|first:apply|partial:apply|stopped:apply) return 1;;
 esac
 return 0
}
acceptance_update_flow
`],{env:{...process.env,SCENARIO:failure},encoding:'utf8'});
}
describe('Acceptance controller failure routing',()=>{
 it('completes preparation, owner checks and backup before stopping',()=>{
  const r=run('success');expect(r.status).toBe(0);
  expect(r.stdout.trim().split('\n')).toEqual(['worker:prepare','maintenance:preflight','worker:backup','worker:stop','maintenance:apply','worker:activate']);
 });
 it.each(['build','backup','permissions','identity'])('keeps runtime untouched on %s failure',failure=>{
  const r=run(failure);expect(r.status).not.toBe(0);expect(r.stdout).not.toContain('worker:stop');expect(r.stdout).not.toContain('maintenance:apply');
 });
 it('verifies an already-current candidate without stopping or backup',()=>{
  const r=run('current');expect(r.status).toBe(0);expect(r.stdout.trim()).toBe('worker:prepare');
 });
 it('does not migrate after stop failure',()=>{const r=run('stop');expect(r.status).not.toBe(0);expect(r.stdout).not.toContain('maintenance:apply');});
 it('requests verified recovery after a failed migration, retaining failed status',()=>{
  const r=run('first');expect(r.status).not.toBe(0);expect(r.stdout).toContain('worker:recover');expect(r.stdout).not.toContain('worker:activate');
 });
 it.each(['partial','stopped'])('keeps runtime stopped when %s recovery is refused',failure=>{
  const r=run(failure);expect(r.status).not.toBe(0);expect(r.stdout.trim().endsWith('worker:halt')).toBe(true);
 });
 it.each(['startup','public'])('halts candidate on %s failure without switching back old code',failure=>{
  const r=run(failure);expect(r.status).not.toBe(0);expect(r.stdout).toContain('worker:halt');expect(r.stdout).not.toContain('worker:recover');
 });
 it('requires the full unchanged history and a previously online runtime for recovery',()=>{
  const before={migrations:[{version:'one',checksum:'a'},{version:'two',checksum:'b'}]};
  expect(mayRecoverOldRuntime('online',before,structuredClone(before))).toBe(true);
  expect(mayRecoverOldRuntime('stopped',before,before)).toBe(false);
  expect(mayRecoverOldRuntime('online',before,{migrations:[...before.migrations,{version:'three',checksum:'c'}]})).toBe(false);
  expect(mayRecoverOldRuntime('online',before,{migrations:[{version:'one',checksum:'drift'},before.migrations[1]]})).toBe(false);
 });
});

describe('same candidate recovery after activation failure',()=>{
 it('uses the real planner to resume a halted current candidate without migrations, then becomes a healthy no-op',()=>{
  const result=spawnSync('bash',['-c',`
set -euo pipefail
source scripts/deploy/acceptance-update-flow.sh
status=online
active=old
schema_current=false
fail_activation=true
worker() {
 echo "worker:$1"
 case "$1" in
  prepare)
   action="$("$NODE_BIN" scripts/deploy/acceptance-update-policy.mjs next-action "$active" candidate "$schema_current" "$status")"
   case "$action" in verify) return 10;; activate) return 11;; esac;;
  stop|halt) status=stopped;;
  activate)
   active=candidate
   if [[ "$fail_activation" == true ]]; then return 1; fi
   status=online;;
 esac
 return 0
}
maintenance() { echo "maintenance:$1"; if [[ "$1" == apply ]]; then schema_current=true; fi; }
rc=0
acceptance_update_flow || rc=$?
[[ "$rc" == 1 && "$status" == stopped && "$active" == candidate ]]
echo RETRY
fail_activation=false
acceptance_update_flow
[[ "$status" == online ]]
echo HEALTHY
acceptance_update_flow
`],{env:{...process.env,NODE_BIN:process.execPath},encoding:'utf8'});
  expect(result.status,result.stderr).toBe(0);
  const retry=result.stdout.split('RETRY\n')[1]!.split('HEALTHY\n');
  expect(retry[0]!.trim().split('\n')).toEqual(['worker:prepare','worker:activate']);
  expect(retry[1]!.trim()).toBe('worker:prepare');
 });
 it('does not resume activation if schema is incomplete or the active SHA differs',()=>{
  for(const [active,current] of [['candidate','false'],['old','true']]) {
   const r=spawnSync(process.execPath,['scripts/deploy/acceptance-update-policy.mjs','next-action',active!,'candidate',current!,'stopped'],{encoding:'utf8'});
   expect(r.status).toBe(0);expect(r.stdout).toBe('update');
  }
 });
});
