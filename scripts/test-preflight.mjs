import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {POSTGRES_CHAIN_TESTS} from './test-suite-plan.mjs';
import {SCHEMA_PREFIXES} from './test-resource-contract.mjs';

export function checkResourceRegistration(){
 const changed=new Set(execFileSync('git',['diff','--name-only',...(process.env.BASE_SHA?[process.env.BASE_SHA]:[])],{encoding:'utf8'}).trim().split('\n'));
 for(const path of execFileSync('git',['ls-files','--others','--exclude-standard'],{encoding:'utf8'}).trim().split('\n'))changed.add(path);
 const managed=new Set(POSTGRES_CHAIN_TESTS);
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):e.name.endsWith('.ts')?[dir+'/'+e.name]:[]);
 for(const path of walk('tests')){
  if(path.startsWith('tests/unit/'))continue;
  const source=readFileSync(path,'utf8');
  if(/(?:from\s*|^import\s*)["'][^"']+\.test\.js["']/m.test(source))throw Error('TEST_SUITE_IMPORT_DUPLICATES_COVERAGE: '+path);
  for(const [,prefix]of source.matchAll(/ownedPostgresSchema\(['"]([a-z0-9_]+)['"]/g))if(!SCHEMA_PREFIXES.includes(prefix))throw Error('TEST_RESOURCE_UNREGISTERED: '+path+':'+prefix);
  if(/CREATE SCHEMA/.test(source)&&!source.includes('ownedPostgresSchema')&&(managed.has(path)||changed.has(path)))throw Error('TEST_RESOURCE_CREATOR_NOT_REGISTERED: '+path);
 }
}
checkResourceRegistration();
if(process.argv.includes('--database')){
 const {resourceSmoke}=await import('./test-resource-lifecycle.mjs');await resourceSmoke(process.env.TEST_DATABASE_URL);
}else{
 execFileSync(process.execPath,['--test',...readdirSync('scripts/ci').filter(p=>p.endsWith('.test.mjs')).map(p=>'scripts/ci/'+p)],{stdio:'inherit'});
 execFileSync(process.execPath,['scripts/check-migrations.mjs'],{stdio:'inherit'});
}
console.log('TEST_PREFLIGHT_PASSED');
