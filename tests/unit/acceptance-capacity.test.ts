import {readFileSync,writeFileSync,mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
describe('official staged capacity and fixed storage metadata',()=>{
 it('runs real Python estimator boundaries without privileged services',()=>{
  const result=spawnSync('python3',['-B','tests/integration/acceptance-capacity.test.py'],{encoding:'utf8',timeout:20000});
  expect(result.status,result.stdout+'\n'+result.stderr).toBe(0);expect(result.stderr).toContain('Ran 16 tests');expect(result.stderr).toContain('OK');
 });
 it.each(['build','backup','stop'])('rechecks the real %s estimator after download/archive and refuses before service stop',phase=>{
  const directory=mkdtempSync(join(tmpdir(),'acceptance-capacity-flow-'));
  try{
   const probe=join(directory,'probe.py'),storage=join(directory,'storage.json');
   writeFileSync(storage,JSON.stringify({database:'dx_rework_acceptance',databaseBytes:100,maxWalBytes:200,dataPaths:['/TEST/data'],walPath:'/TEST/wal',logPath:'/TEST/logs'}));
   writeFileSync(probe,`import importlib.util, os, sys\nspec = importlib.util.spec_from_file_location('capacity', os.environ['TEST_CAPACITY_SOURCE'])\ncapacity = importlib.util.module_from_spec(spec)\nspec.loader.exec_module(capacity)\ncapacity.tree_bytes = lambda *args: 0\ncapacity.git_bytes = lambda *args: 0\nphase = sys.argv[1]\ndef probe(path):\n    return {'device':'TEST-volume', 'probe':path, 'available':0 if phase == os.environ['TEST_FAIL_PHASE'] else 100 * capacity.GIB, 'total':200 * capacity.GIB}\nsys.exit(capacity.main([phase, '/TEST/missing-source', '/TEST/missing-tool', 'a' * 40, '--storage', os.environ['TEST_STORAGE']], probe))\n`);
   // Original controller dispatch, CLI/planner and update flow; only the final
   // privileged runtime effect and the measured filesystem metrics are TEST adapters.
   const source=readFileSync('scripts/dx-acceptance.sh','utf8'),start=source.indexOf('\nworker() {'),end=source.indexOf('\nmaintenance() {',start);
   expect(start).toBeGreaterThan(0);expect(end).toBeGreaterThan(start);
   const result=spawnSync('bash',['-c',`set -euo pipefail
capacity_check() { python3 -B "$TEST_PROBE" "$1"; }
runuser() { printf 'EFFECT:%s\\n' "\${@: -2:1}"; }
sha=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
snapshot=/TEST/snapshot
tool_root=/TEST/tool
${source.slice(start,end)}
maintenance() { printf 'MAINTENANCE:%s\\n' "$1"; }
source scripts/deploy/acceptance-update-flow.sh
capacity_check download
capacity_check archive
acceptance_update_flow
`],{encoding:'utf8',timeout:20000,env:{...process.env,TEST_PROBE:probe,TEST_STORAGE:storage,TEST_FAIL_PHASE:phase,TEST_CAPACITY_SOURCE:resolve('scripts/deploy/acceptance-capacity.py')}});
   expect(result.status,result.stderr).toBe(1);
   const rows=result.stdout.split('\n').filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
   expect(rows.slice(0,2).map(row=>[row.phase,row.status])).toEqual([['download','capacity_sufficient'],['archive','capacity_sufficient']]);
   expect(rows.at(-1)).toMatchObject({phase,status:'capacity_insufficient'});
   expect(result.stdout).not.toContain('EFFECT:stop');expect(result.stdout).not.toContain('MAINTENANCE:apply');expect(result.stdout).not.toContain('EFFECT:activate');
   if(phase==='build')expect(result.stdout).not.toContain('EFFECT:prepare');
   if(phase==='backup')expect(result.stdout).not.toContain('EFFECT:backup');
  }finally{rmSync(directory,{recursive:true,force:true});}
 });
});
