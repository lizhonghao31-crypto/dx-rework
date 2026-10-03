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
