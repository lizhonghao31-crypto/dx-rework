import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
describe('official staged capacity and fixed storage metadata',()=>{
 it('runs real Python estimator boundaries without privileged services',()=>{
  const result=spawnSync('python3',['-B','tests/integration/acceptance-capacity.test.py'],{encoding:'utf8',timeout:20000});
  expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);expect(result.stderr).toContain('Ran 14 tests');expect(result.stderr).toContain('OK');
 });
});
