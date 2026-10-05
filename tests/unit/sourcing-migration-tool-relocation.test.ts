import {copyFileSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {expect,it} from 'vitest';
it('loads checksummed main222/digital0222 identities from a relocated release tool',()=>{
 const directory=mkdtempSync(join(tmpdir(),'sourcing-migration-policy-'));
 try{
  const packager=readFileSync('scripts/deploy/package-release.sh','utf8');
  for(const name of ['migration-history-policy.mjs','migration-branches.json','migration-main-extensions.json']){
   expect(packager).toContain(`scripts/${name}`);copyFileSync(`scripts/${name}`,join(directory,name));
  }
  const target=JSON.parse(readFileSync('apps/api/src/platform/migration-manifest.json','utf8')).migrations;
  const result=execFileSync(process.execPath,['--input-type=module','-e',`import {assertMigrationSequence,assertAppliedMigrationHistory} from ${JSON.stringify(join(directory,'migration-history-policy.mjs'))};const target=${JSON.stringify(target)};assertMigrationSequence(target);assertAppliedMigrationHistory(target,target);console.log('verified');`],{encoding:'utf8'});
  expect(result.trim()).toBe('verified');
 }finally{rmSync(directory,{recursive:true,force:true});}
});
