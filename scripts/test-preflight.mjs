import {execFileSync} from 'node:child_process';
import {readFileSync,readdirSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {POSTGRES_CHAIN_TESTS} from './test-suite-plan.mjs';
import {SCHEMA_PREFIXES} from './test-resource-contract.mjs';

export function resourceChangedPaths(repo='.',base=process.env.BASE_SHA){
 const git=args=>execFileSync('git',['-C',repo,...args],{encoding:'utf8'}).trim().split('\n').filter(Boolean);
 return new Set([...git(['diff','--name-only',base??'HEAD']),...git(['ls-files','--others','--exclude-standard'])]);
}
export function assertManagedSchemaCreation(source,path){
 // Every CREATE is forbidden in consumers, even if another call in the same file is registered.
 // Only the shared creation API may issue DDL after checking generation and live DB identity.
 if(/CREATE\s+SCHEMA\b/i.test(source))throw Error('TEST_RESOURCE_CREATOR_NOT_REGISTERED: '+path);
}
export function checkResourceRegistration(){
 const changed=resourceChangedPaths();
 const managed=new Set(POSTGRES_CHAIN_TESTS);
 const walk=dir=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(dir+'/'+e.name):e.name.endsWith('.ts')?[dir+'/'+e.name]:[]);
 for(const path of walk('tests')){
  if(path.startsWith('tests/unit/'))continue;
  const source=readFileSync(path,'utf8');
  if(/(?:from\s*|^import\s*)["'][^"']+\.test\.js["']/m.test(source))throw Error('TEST_SUITE_IMPORT_DUPLICATES_COVERAGE: '+path);
  for(const [,prefix]of source.matchAll(/ownedPostgresSchema\(['"]([a-z0-9_]+)['"]/g))if(!SCHEMA_PREFIXES.includes(prefix))throw Error('TEST_RESOURCE_UNREGISTERED: '+path+':'+prefix);
  if(managed.has(path)||changed.has(path))assertManagedSchemaCreation(source,path);
 }
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url){
checkResourceRegistration();
if(process.argv.includes('--database')){
 const {resourceSmoke}=await import('./test-resource-lifecycle.mjs');await resourceSmoke(process.env.TEST_DATABASE_URL);
}else{
 execFileSync(process.execPath,['--test',...readdirSync('scripts/ci').filter(p=>p.endsWith('.test.mjs')).map(p=>'scripts/ci/'+p)],{stdio:'inherit'});
 execFileSync(process.execPath,['scripts/check-migrations.mjs'],{stdio:'inherit'});
}
console.log('TEST_PREFLIGHT_PASSED');
}
