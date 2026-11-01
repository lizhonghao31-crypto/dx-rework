import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
const source=readFileSync('scripts/dx-acceptance.sh','utf8');
const start=source.indexOf('# MAIN_RELEASE_COMPAT_START'),end=source.indexOf('# MAIN_RELEASE_COMPAT_END')+'# MAIN_RELEASE_COMPAT_END'.length;
describe('source compatibility gate in existing Acceptance controller',()=>{
 it('runs before production-history export and candidate maintenance using the exact candidate/tool SHA',()=>{
  expect(start).toBeGreaterThan(0);expect(source).not.toContain('export-production-history.sh');expect(source).toContain('--intent acceptance');expect(start).toBeLessThan(source.indexOf('acceptance_update_flow\n'));
  const workflow=readFileSync('.github/workflows/full-gate.yml','utf8');expect(workflow).toContain('Compare exact candidate with current remote main migration history');expect(workflow).toContain('--candidate-ref "$GIT_SHA" --tool-ref "$GIT_SHA"');
 });
 it.each([0,1])('keeps application credentials outside the checker and stops on checker exit %i',exitCode=>{
  const root=mkdtempSync(join(tmpdir(),'dx-compat-controller-'));try{
   const tool=join(root,'tool'),snapshot=join(root,'snapshot');mkdirSync(join(tool,'scripts'),{recursive:true});mkdirSync(snapshot);
   mkdirSync(join(tool,'scripts/deploy'),{recursive:true});writeFileSync(join(tool,'TOOL_SHA'),'a'.repeat(40));writeFileSync(join(tool,'scripts/deploy/lib.sh'),'load_node_config(){ :; }\nnode_exec(){ node "$@"; }\n');
   writeFileSync(join(tool,'scripts/check-main-release-compat.mjs'),`import assert from 'node:assert/strict';assert.equal(process.env.DATABASE_URL,undefined);assert.equal(process.env.TEST_DATABASE_URL,undefined);assert.deepEqual(process.argv.slice(-2),['--tool-ref','${'a'.repeat(40)}']);console.log(JSON.stringify({passed:${exitCode===0}}));process.exitCode=${exitCode};`);
   const hook=source.slice(start,end);
   const script=`set -euo pipefail\ntool_root='${tool}'\nsnapshot='${snapshot}'\nsrc='${root}'\nsha='${'a'.repeat(40)}'\nexport DATABASE_URL=TEST_PRIVATE TEST_DATABASE_URL=TEST_PRIVATE\nrunuser(){ while [[ "$1" != -- ]]; do shift; done; shift; "$@"; }\n${hook}\necho MAINTENANCE_REACHED\n`;
   const result=spawnSync('bash',['-c',script],{encoding:'utf8'});expect(result.status,result.stderr).toBe(exitCode);expect(result.stdout.includes('MAINTENANCE_REACHED')).toBe(exitCode===0);expect(result.stdout+result.stderr).toContain(JSON.stringify({passed:exitCode===0}));
  }finally{rmSync(root,{recursive:true,force:true});}
 });
});
