import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {existsSync,lstatSync,readFileSync,readlinkSync} from 'node:fs';
import {pathToFileURL} from 'node:url';

const sha=v=>createHash('sha256').update(v).digest('hex');
const git=(cwd,...args)=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const lines=s=>s.split('\n').filter(Boolean);
const sourcePath=p=>!p.startsWith('docs/')&&!/^(?:README(?:\.[^/]*)?|LICENSE|CHANGELOG(?:\.[^/]*)?)$/.test(p);
export function sourceFingerprint(cwd='.'){
 const files=[...new Set(lines(git(cwd,'ls-files','--cached','--others','--exclude-standard')))].filter(sourcePath).sort();
 return sha(JSON.stringify(files.map(p=>{const f=cwd+'/'+p;if(!existsSync(f))return[p,'deleted'];const s=lstatSync(f);return[p,sha(s.isSymbolicLink()?readlinkSync(f):readFileSync(f))];})));
}
export function inputFingerprint(cwd,paths){
 if(!Array.isArray(paths)||!paths.length)throw Error('EVIDENCE_INPUT_SCOPE_REQUIRED');
 for(const p of paths)if(typeof p!=='string'||!p||p.startsWith('/')||p.includes('..')||p.includes('\\')||p==='node_modules'||p.startsWith('node_modules/')||!existsSync(cwd+'/'+p))throw Error('EVIDENCE_INPUT_SCOPE_REJECTED');
 const files=[...new Set(lines(git(cwd,'ls-files','--cached','--others','--exclude-standard')))].filter(p=>paths.some(scope=>p===scope||p.startsWith(scope+'/'))).sort();
 if(!files.length)throw Error('EVIDENCE_INPUT_SCOPE_EMPTY');
 return sha(JSON.stringify(files.map(p=>{const f=cwd+'/'+p;if(!existsSync(f))return[p,'deleted'];const s=lstatSync(f);return[p,sha(s.isSymbolicLink()?readlinkSync(f):readFileSync(f))];})));
}
function requireText(v,label){if(typeof v!=='string'||v.trim().length<8||/^(?:已检查|checked|ok|正常|通过)$/i.test(v.trim()))throw Error('EVIDENCE_DETAIL_REQUIRED: '+label);}
function fileRef(cwd,value,base,allowDeleted=false){
 if(typeof value!=='string'||value.includes('..')||value.startsWith('/')||value.includes('\\'))throw Error('EVIDENCE_FILE_REFERENCE_REQUIRED');
 const [p,symbol]=value.split('#');let content;
 if(existsSync(cwd+'/'+p))content=readFileSync(cwd+'/'+p,'utf8');
 else if(allowDeleted)try{content=git(cwd,'show',base+':'+p);}catch{throw Error('EVIDENCE_FILE_MISSING: '+p);}
 else throw Error('EVIDENCE_FILE_MISSING: '+p);
 if(symbol&&!content.includes(symbol))throw Error('EVIDENCE_SYMBOL_MISSING: '+value);
 return p;
}
export function validateEvidence(record,{cwd='.',base,head=git(cwd,'rev-parse','HEAD')}={}){
 if(!/^[0-9a-f]{40}$/.test(base??'')||record.version!==1||record.base!==base)throw Error('EVIDENCE_BASE_MISMATCH');
 if(record.sourceFingerprint!==sourceFingerprint(cwd))throw Error('EVIDENCE_SOURCE_CHANGED');
 if(!Array.isArray(record.rules)||!record.rules.length||!Array.isArray(record.checks)||!record.checks.length)throw Error('EVIDENCE_EMPTY');
 const checks=new Map();
 for(const c of record.checks){
  if(!/^[a-z0-9_-]{2,80}$/.test(c.id??''))throw Error('EVIDENCE_CHECK_ID_REQUIRED');
  requireText(c.command,'command');if(checks.has(c.id))throw Error('EVIDENCE_DUPLICATE_CHECK');
  if(c.status==='not-applicable'){requireText(c.reason,'not-applicable reason');}
  else{
   if(c.status!=='passed'||c.exitCode!==0)throw Error('EVIDENCE_CHECK_INCOMPLETE: '+c.id);
   if(c.kind==='command'){
    if(['passed','failed','skipped'].some(k=>c[k]!==undefined))throw Error('EVIDENCE_COMMAND_MUST_NOT_INVENT_TEST_COUNTS');
   }else if(c.kind!==undefined&&c.kind!=='tests'||!Number.isInteger(c.passed)||c.passed<1||c.failed!==0||!Number.isInteger(c.skipped)||c.skipped<0)throw Error('EVIDENCE_CHECK_INCOMPLETE: '+c.id);
   if(!/^[0-9a-f]{64}$/.test(c.logSha256??'')||!Number.isFinite(Date.parse(c.startedAt))||!Number.isFinite(Date.parse(c.endedAt))||Date.parse(c.endedAt)<Date.parse(c.startedAt))throw Error('EVIDENCE_RESULT_PROVENANCE_REQUIRED');
   if(c.inputPaths!==undefined){if(!/^[0-9a-f]{64}$/.test(c.sourceFingerprint??'')||c.inputFingerprint!==inputFingerprint(cwd,c.inputPaths))throw Error('EVIDENCE_CHECK_INPUT_CHANGED');}
   else if(c.sourceFingerprint!==record.sourceFingerprint)throw Error('EVIDENCE_CHECK_SOURCE_CHANGED');
   if(!/^[0-9a-f]{40}$/.test(c.testedHead??''))throw Error('EVIDENCE_TESTED_HEAD_REQUIRED');
   if(c.testedHead!==head)try{git(cwd,'merge-base','--is-ancestor',c.testedHead,head);}catch{throw Error('EVIDENCE_TESTED_HEAD_NOT_ANCESTOR');}
   requireText(c.context,'runtime context');
  }
  checks.set(c.id,c);
 }
 if(!record.checks.some(c=>c.status==='passed'&&c.kind!=='command'))throw Error('EVIDENCE_NO_EXECUTED_CHECK');
 const covered=new Set();
 for(const r of record.rules){
  for(const key of ['rule','source','initialization','dateAndPermission','expectation'])requireText(r[key],key);
  for(const key of ['writes','reads','oldTests']){if(!Array.isArray(r[key])||!r[key].length)throw Error('EVIDENCE_CONSUMERS_REQUIRED: '+key);for(const ref of r[key]){const p=fileRef(cwd,ref,base,key==='writes');if(key==='writes')covered.add(p);}}
  if(!Array.isArray(r.checks)||!r.checks.length||r.checks.some(id=>!checks.has(id)))throw Error('EVIDENCE_RULE_CHECK_REQUIRED');
  for(const ref of r.writes){const p=ref.split('#')[0];if(!r.checks.some(id=>{const c=checks.get(id);return c.status==='passed'&&(!c.inputPaths||c.inputPaths.some(scope=>p===scope||p.startsWith(scope+'/')));}))throw Error('EVIDENCE_WRITE_WITHOUT_CURRENT_CHECK_SCOPE: '+p);}
 }
 const changed=[...new Set([...lines(git(cwd,'diff','--name-only',base)),...lines(git(cwd,'ls-files','--others','--exclude-standard'))])].filter(sourcePath);
 const missing=changed.filter(p=>!covered.has(p));if(missing.length)throw Error('EVIDENCE_CHANGED_FILE_UNCOVERED: '+missing.join(','));
 return {rules:record.rules.length,checks:checks.size,sourceFingerprint:record.sourceFingerprint,base,head,boundary:'Structural and source checks, not proof that every semantic consumer was discovered.'};
}
if(import.meta.url===pathToFileURL(process.argv[1]??'').href){
 const [mode,path,base]=process.argv.slice(2);
 if(mode==='fingerprint')console.log(sourceFingerprint());
 else if(mode==='verify')console.log(JSON.stringify(validateEvidence(JSON.parse(readFileSync(path,'utf8')),{base:base??process.env.BASE_SHA})));
 else if(mode==='verify-change'){
  const actualBase=path??process.env.BASE_SHA;if(!/^[0-9a-f]{40}$/.test(actualBase??''))throw Error('EVIDENCE_BASE_REQUIRED');
  const changed=lines(git('.','diff','--name-only',actualBase)).filter(sourcePath);
  if(changed.length)console.log(JSON.stringify(validateEvidence(JSON.parse(readFileSync('docs/engineering/construction-evidence.json','utf8')),{base:actualBase})));
  else console.log('CONSTRUCTION_EVIDENCE_NOT_APPLICABLE: documentation-only diff');
 }
 else throw Error('Expected fingerprint, verify <record> <base>, or verify-change <base>');
}
