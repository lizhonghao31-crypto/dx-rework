import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname} from 'node:path';import {execFileSync} from 'node:child_process';import {expect,it} from 'vitest';
it('keeps every Full Gate at the authorized finite 30 minutes and rejects invalid budgets',async()=>{
 const root=await mkdtemp(join(tmpdir(),'dx-budget-policy-')),paths=['.github/workflows/ci.yml','.github/workflows/full-gate.yml','.github/workflows/governance.yml','.github/workflows/pr-preview.yml','.github/workflows/pr-17-release.yml','scripts/ci/full-gate-risk-map.mjs','scripts/ci/verify-actions-policy.mjs'];
 try{for(const path of paths){await mkdir(dirname(join(root,path)),{recursive:true});await writeFile(join(root,path),await readFile(path));}const file=join(root,'.github/workflows/full-gate.yml'),full=await readFile(file,'utf8'),line=full.split('\n').find(row=>row.trim().startsWith('timeout-minutes:'))!;const run=()=>execFileSync(process.execPath,[join(root,'scripts/ci/verify-actions-policy.mjs')],{stdio:'pipe',encoding:'utf8'});expect(run()).toContain('ACTIONS_USAGE_POLICY_OK');
 const invalid=[
  ['above limit',full.replace(line,'    timeout-minutes: 31')],
  ['larger number sharing prefix',full.replace(line,'    timeout-minutes: 300')],
  ['zero/unbounded',full.replace(line,'    timeout-minutes: 0')],
  ['missing',full.replace(line,'')],
  ['multiple',full.replace(line,line+'\n'+line)],
  ['null',full.replace(line,'    timeout-minutes: null')],
  ['old conditional scope',full.replace(line,"    timeout-minutes: ${{ github.event.pull_request.head.repo.full_name == github.repository && startsWith(github.head_ref, 'unified-p') && 30 || 20 }}")],
 ];
 for(const [label,changed] of invalid){expect(changed,label).not.toBe(full);await writeFile(file,changed!);expect(run,label).toThrow();}
 await writeFile(file,full);const quick=join(root,'.github/workflows/ci.yml');await writeFile(quick,(await readFile(quick,'utf8')).replace('timeout-minutes: 5','timeout-minutes: 30'));expect(run).toThrow();
 }finally{await rm(root,{recursive:true,force:true});}
});
