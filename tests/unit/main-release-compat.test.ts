import {readFileSync,mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
import {describe,it,expect} from 'vitest';
import {inspectCompatibility,readComparedHistories} from '../../scripts/check-main-release-compat.mjs';

type Entry={version:string;checksum:string};
const manifestPath='apps/api/src/platform/migration-manifest.json';
const inventoryPath='scripts/deploy/acceptance-migration-requirements.json';
const rows:Entry[]=JSON.parse(readFileSync(manifestPath,'utf8')).migrations;
const branches=JSON.parse(readFileSync('scripts/migration-branches.json','utf8'));
const extensions=JSON.parse(readFileSync('scripts/migration-main-extensions.json','utf8'));
const mainNames=new Set([...branches.main,...extensions].map((r:Entry)=>r.version));
const mainRows=rows.filter(r=>Number(r.version.slice(0,4))<=217||mainNames.has(r.version));
const originalRelease=rows.filter(r=>Number(r.version.slice(0,4))<=247&&!['0226_external_revision_preserve_handler','0227_qc_other_craft'].includes(r.version));
const late=['0226_external_revision_preserve_handler','0227_qc_other_craft'];
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
function snapshot(catalog:Entry[],id:string){
 const files=new Map<string,string>();
 for(const r of catalog)files.set(`apps/api/migrations/${r.version}.sql`,readFileSync(`apps/api/migrations/${r.version}.sql`,'utf8'));
 files.set(manifestPath,JSON.stringify({migrations:catalog}));
 for(const path of ['scripts/migration-history-policy.mjs','scripts/migration-branches.json','scripts/migration-main-extensions.json',inventoryPath])files.set(path,readFileSync(path,'utf8'));
 return {sha:id,files,read:(path:string)=>{const value=files.get(path);if(value===undefined)throw Error('Missing fixture file '+path);return value;},paths:()=>[...files.keys()].filter(p=>p.startsWith('apps/api/migrations/'))};
}
function fixtures(){return {main:snapshot(mainRows,'a'.repeat(40)),candidate:snapshot(rows,'b'.repeat(40)),baseline:snapshot(originalRelease,'c'.repeat(40))};}
const has=(report:{issues:{kind:string;version?:string}[]},kind:string,version?:string)=>report.issues.some(x=>x.kind===kind&&(version===undefined||x.version===version));
describe('actual main/candidate migration source compatibility',()=>{
 it('follows an advanced actual release Git baseline and rejects an unreadable baseline without fallback',()=>{
  const repo=mkdtempSync(join(tmpdir(),'dx-release-baseline-'));
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const commit=(catalog:Entry[])=>{mkdirSync(dirname(join(repo,manifestPath)),{recursive:true});writeFileSync(join(repo,manifestPath),JSON.stringify({migrations:catalog}));git('add','.');git('commit','-m','TEST release baseline');return git('rev-parse','HEAD');};
  try{
   git('init');git('config','user.name','TEST');git('config','user.email','test@example.invalid');
   const old=commit(rows.slice(0,1)),advanced=commit(rows.slice(0,2));
   expect(readComparedHistories(repo,{mainSha:advanced,baselineSha:old})[1]).toEqual({label:'release',sha:old,rows:rows.slice(0,1)});
   expect(readComparedHistories(repo,{mainSha:advanced,baselineSha:advanced})[1]).toEqual({label:'release',sha:advanced,rows:rows.slice(0,2)});
   expect(()=>readComparedHistories(repo,{mainSha:advanced,baselineSha:'f'.repeat(40)})).toThrow();
  }finally{rmSync(repo,{recursive:true,force:true});}
 });
 it('accepts the complete reviewed union and preserves both original history paths',async()=>{const d=fixtures(),r=await inspectCompatibility(d);expect(r.passed).toBe(true);expect(r.mainCount).toBe(227);expect(r.candidateCount).toBe(rows.length);});
 it.each(late)('rejects missing main identity %s before deployment',async version=>{const d=fixtures();d.candidate.files.set(manifestPath,JSON.stringify({migrations:rows.filter(r=>r.version!==version)}));d.candidate.files.delete(`apps/api/migrations/${version}.sql`);expect(has(await inspectCompatibility(d),'MISSING_MAIN_IDENTITY',version)).toBe(true);});
 it('rejects unchanged-name checksum drift and actual SQL drift',async()=>{const d=fixtures(),version=late[0]!;d.candidate.files.set(manifestPath,JSON.stringify({migrations:rows.map(r=>r.version===version?{...r,checksum:'f'.repeat(64)}:r)}));const r=await inspectCompatibility(d);expect(has(r,'MAIN_CHECKSUM_DRIFT',version)).toBe(true);expect(has(r,'SQL_CHECKSUM_DRIFT',version)).toBe(true);});
 it.each(late)('rejects missing or incorrectly bound permission inventory %s',async version=>{const d=fixtures();const inventory=JSON.parse(d.candidate.read(inventoryPath));delete inventory[version];d.candidate.files.set(inventoryPath,JSON.stringify(inventory));expect(has(await inspectCompatibility(d),'INVENTORY_MISSING',version)).toBe(true);inventory[version]=JSON.parse(readFileSync(inventoryPath,'utf8'))[version];inventory[version].checksum='f'.repeat(64);d.candidate.files.set(inventoryPath,JSON.stringify(inventory));expect(has(await inspectCompatibility(d),'INVENTORY_CHECKSUM_DRIFT',version)).toBe(true);});
 it('rejects an unregistered main lane identity and a third same-prefix identity',async()=>{const d=fixtures();d.candidate.files.set('scripts/migration-main-extensions.json',JSON.stringify(extensions.filter((r:Entry)=>r.version!==late[1])));expect(has(await inspectCompatibility(d),'MAIN_LANE_IDENTITY_SET_MISMATCH')).toBe(true);const clean=fixtures(),sql='-- TEST forbidden third fork\nSELECT 1;\n',version='0226_unapproved_third_fork';clean.candidate.files.set(`apps/api/migrations/${version}.sql`,sql);clean.candidate.files.set(manifestPath,JSON.stringify({migrations:[...rows,{version,checksum:sha(sql)}].sort((a,b)=>a.version.localeCompare(b.version))}));expect(has(await inspectCompatibility(clean),'POLICY_REJECTION')).toBe(true);});
 it('rejects tool/candidate mismatch and excess owner scope',async()=>{const d=fixtures(),tool={...d.candidate,sha:'d'.repeat(40)};expect(has(await inspectCompatibility({...d,tool}),'TOOL_CANDIDATE_SHA_MISMATCH')).toBe(true);const inventory=JSON.parse(d.candidate.read(inventoryPath));inventory[late[1]!].tables.push('unrelated_business_table');d.candidate.files.set(inventoryPath,JSON.stringify(inventory));expect(has(await inspectCompatibility(d),'OWNER_SCOPE_MISMATCH',late[1])).toBe(true);});
 it('resolves remote main anew and inspects its real SQL after main advances',()=>{
  const scratch=mkdtempSync(join(tmpdir(),'dx-live-main-source-')),repo=join(scratch,'repo'),remote=join(scratch,'remote.git'),output=join(scratch,'report.json');
  const git=(...args:string[])=>execFileSync('git',['-C',repo,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  const write=(source:ReturnType<typeof snapshot>)=>{for(const [name,text]of source.files){const path=join(repo,name);mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);}};
  const invoke=(extra:string[]=[])=>spawnSync(process.execPath,[resolve('scripts/check-main-release-compat.mjs'),'--repo',repo,'--candidate-ref','HEAD','--output',output,...extra],{encoding:'utf8'});
  try{
   mkdirSync(repo);execFileSync('git',['init','--bare',remote],{stdio:'ignore'});git('init','-b','main');git('config','user.name','TEST');git('config','user.email','test@example.invalid');git('remote','add','origin',remote);
   write(snapshot(mainRows,'a'.repeat(40)));git('add','.');git('commit','-m','TEST reviewed main');git('push','origin','main');const before=git('rev-parse','HEAD');
   git('checkout','-b','candidate');write(snapshot(rows,'b'.repeat(40)));git('add','.');git('commit','-m','TEST candidate');let result=invoke();expect(result.status,result.stderr).toBe(0);expect(JSON.parse(readFileSync(output,'utf8')).mainSha).toBe(before);
   git('checkout','main');const sql='-- TEST next main identity\nSELECT 1;\n',version='0228_future_main_fixture';writeFileSync(join(repo,'apps/api/migrations',version+'.sql'),sql);writeFileSync(join(repo,manifestPath),JSON.stringify({migrations:[...mainRows,{version,checksum:sha(sql)}]}));git('add','.');git('commit','-m','TEST advance remote main');git('push','origin','main');const after=git('rev-parse','HEAD');git('checkout','candidate');
   result=invoke();expect(result.status).toBe(1);const report=JSON.parse(readFileSync(output,'utf8'));expect(report.mainSha).toBe(after);expect(has(report,'MISSING_MAIN_IDENTITY',version)).toBe(true);
   result=invoke(['--expected-main-sha',before]);expect(result.status).toBe(1);expect(result.stderr,JSON.stringify({status:result.status,stdout:result.stdout,stderr:result.stderr,error:result.error?.message})).toContain('Remote main advanced');expect(JSON.parse(readFileSync(output,'utf8')).passed).toBe(false);
  }finally{rmSync(scratch,{recursive:true,force:true});}
 },20000);
});
