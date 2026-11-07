import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';
import{sourceFingerprint,validateEvidence,inputFingerprint,assertCandidateIndex}from'./construction-evidence.mjs';
function fixture(work){const cwd=mkdtempSync(join(tmpdir(),'dx-evidence-')),git=(...a)=>execFileSync('git',['-C',cwd,...a],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();try{
 git('init','-q');git('config','user.name','TEST');git('config','user.email','test@example.invalid');writeFileSync(join(cwd,'source.mjs'),'export const original=1;');writeFileSync(join(cwd,'existing.test.mjs'),'// Existing consumer coverage');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');writeFileSync(join(cwd,'source.mjs'),'export const original=2;');
 const fingerprint=sourceFingerprint(cwd),record={version:1,base,sourceFingerprint:fingerprint,rules:[{rule:'Actual changed business contract',source:'User approved current change',writes:['source.mjs#original'],reads:['existing.test.mjs'],oldTests:['existing.test.mjs'],initialization:'No schema change; existing fixture retained',dateAndPermission:'No date or permission change in this fixture',expectation:'The original consumer accepts value two',checks:['focused']}],checks:[{id:'focused',command:'node --test existing.test.mjs',status:'passed',exitCode:0,passed:1,failed:0,skipped:0,testedHead:base,sourceFingerprint:fingerprint,context:'Node22 isolated test fixture, no database',startedAt:'2026-11-01T00:00:00Z',endedAt:'2026-11-01T00:00:01Z',logSha256:'a'.repeat(64)}]};work({cwd,base,git,record});
 }finally{rmSync(cwd,{recursive:true,force:true});}}
test('source-bound evidence accepts actual references and ignores evidence-document self-reference',()=>fixture(({cwd,base,record})=>{assert.equal(validateEvidence(record,{cwd,base}).rules,1);mkdirSync(join(cwd,'docs'));writeFileSync(join(cwd,'docs','evidence.json'),JSON.stringify(record));assert.equal(validateEvidence(record,{cwd,base}).checks,1);}));
test('changed source, wrong base, omitted old consumer and failed/all-skipped checks fail closed',()=>fixture(({cwd,base,record})=>{
 for(const mutate of [r=>r.base='b'.repeat(40),r=>r.rules[0].oldTests=[],r=>r.checks[0].exitCode=1,r=>r.checks[0].passed=0,r=>r.checks[0].status='not-run',r=>r.checks[0].logSha256='',r=>r.rules[0].reads=['missing.mjs'],r=>r.rules[0].writes=[],r=>r.checks[0].sourceFingerprint='a'.repeat(64)]){const r=structuredClone(record);mutate(r);assert.throws(()=>validateEvidence(r,{cwd,base}));}
 writeFileSync(join(cwd,'source.mjs'),'export const original=3;');assert.throws(()=>validateEvidence(record,{cwd,base}),/SOURCE_CHANGED/);
}));
test('deleted source and untracked consumers require explicit coverage too',()=>fixture(({cwd,base,record})=>{
 rmSync(join(cwd,'source.mjs'));record.sourceFingerprint=sourceFingerprint(cwd);record.checks[0].sourceFingerprint=record.sourceFingerprint;assert.equal(validateEvidence(record,{cwd,base}).rules,1);
 writeFileSync(join(cwd,'forgotten.mjs'),'export const notWired=1');record.sourceFingerprint=sourceFingerprint(cwd);record.checks[0].sourceFingerprint=record.sourceFingerprint;assert.throws(()=>validateEvidence(record,{cwd,base}),/CHANGED_FILE_UNCOVERED/);
}));
test('successful build/lint commands carry exit provenance without invented passing-test counts',()=>fixture(({cwd,base,record})=>{
 const command={...record.checks[0],id:'lint',kind:'command',command:'node eslint.js source.mjs'};delete command.passed;delete command.failed;delete command.skipped;record.checks.push(command);assert.equal(validateEvidence(record,{cwd,base}).checks,2);
 command.passed=1;assert.throws(()=>validateEvidence(record,{cwd,base}),/INVENT_TEST_COUNTS/);delete command.passed;
 record.checks=[command];assert.throws(()=>validateEvidence(record,{cwd,base}),/NO_EXECUTED_CHECK/);
}));

test('local check reuse requires unchanged declared inputs and every write still needs a covered check',()=>fixture(({cwd,base,record})=>{
 const old=record.checks[0];old.inputPaths=['source.mjs'];old.inputFingerprint=inputFingerprint(cwd,old.inputPaths);
 writeFileSync(join(cwd,'existing.test.mjs'),'// New independent test consumer');record.sourceFingerprint=sourceFingerprint(cwd);
 const fresh={...old,id:'fresh',sourceFingerprint:record.sourceFingerprint,inputPaths:['existing.test.mjs']};fresh.inputFingerprint=inputFingerprint(cwd,fresh.inputPaths);record.checks.push(fresh);record.rules[0].writes.push('existing.test.mjs');record.rules[0].checks.push('fresh');
 assert.equal(validateEvidence(record,{cwd,base}).checks,2);
 writeFileSync(join(cwd,'forgotten.mjs'),'export const newSource=1');record.sourceFingerprint=sourceFingerprint(cwd);record.rules[0].writes.push('forgotten.mjs');assert.throws(()=>validateEvidence(record,{cwd,base}),/WITHOUT_CURRENT_CHECK_SCOPE/);record.rules[0].writes.pop();rmSync(join(cwd,'forgotten.mjs'));
 writeFileSync(join(cwd,'source.mjs'),'export const changedDependency=3');record.sourceFingerprint=sourceFingerprint(cwd);assert.throws(()=>validateEvidence(record,{cwd,base}),/INPUT_CHANGED/);
 for(const scope of [[],['../outside'],['/tmp'],['node_modules'],['not-present']])assert.throws(()=>inputFingerprint(cwd,scope));
}));
test('a real shallow CI clone rejects missing ancestry; complete history proves the same source evidence',()=>fixture(({cwd,base,git,record})=>{
 git('add','.');git('commit','-qm','candidate with measured source');const container=mkdtempSync(join(tmpdir(),'dx-shallow-evidence-')),clone=join(container,'clone');
 try{
  execFileSync('git',['clone','--quiet','--depth=1','file://'+cwd,clone],{stdio:['ignore','pipe','pipe']});
  execFileSync('git',['-C',clone,'fetch','--quiet','--depth=1','origin',base],{stdio:['ignore','pipe','pipe']});
  assert.throws(()=>validateEvidence(record,{cwd:clone,base}),/NOT_ANCESTOR/);
  execFileSync('git',['-C',clone,'fetch','--quiet','--unshallow','origin'],{stdio:['ignore','pipe','pipe']});
  assert.equal(validateEvidence(record,{cwd:clone,base}).checks,1);
 }finally{rmSync(container,{recursive:true,force:true});}
}));

test('actual CI base fetch preserves pre-base test ancestry after a complete checkout',()=>fixture(({cwd,git})=>{
 git('add','.');git('commit','-qm','original measured source');const tested=git('rev-parse','HEAD');
 writeFileSync(join(cwd,'later.txt'),'integration base');git('add','.');git('commit','-qm','integration base');const base=git('rev-parse','HEAD');
 writeFileSync(join(cwd,'later.txt'),'homepage candidate');git('add','.');git('commit','-qm','homepage candidate');
 const container=mkdtempSync(join(tmpdir(),'dx-ci-base-history-')),clone=join(container,'clone'),workflow=readFileSync(new URL('../../.github/workflows/ci.yml',import.meta.url),'utf8');
 try{
  execFileSync('git',['clone','--quiet','file://'+cwd,clone],{stdio:['ignore','pipe','pipe']});
  const run=(...args)=>execFileSync('git',['-C',clone,...args],{stdio:['ignore','pipe','pipe']});
  const fetch=workflow.split('\n').find(line=>line.includes('git fetch')&&line.includes('${BASE_SHA}'));
  assert.ok(fetch,'actual CI base fetch must be present');
  execFileSync('bash',['-c',fetch.trim()],{cwd:clone,env:{...process.env,BASE_SHA:base},stdio:['ignore','pipe','pipe']});
  assert.doesNotThrow(()=>run('merge-base','--is-ancestor',tested,'HEAD'));
  run('fetch','--quiet','--no-tags','--depth=1','origin',base);
  assert.throws(()=>run('merge-base','--is-ancestor',tested,'HEAD'),'old shallow fetch really cuts otherwise valid ancestry');
 }finally{rmSync(container,{recursive:true,force:true});}
}));

test('a genuinely new module names its new tests instead of inventing an old consumer test',()=>fixture(({cwd,base,record})=>{
 record.rules[0].oldTests=[];record.rules[0].noExistingTestsReason='This is a new module with no prior applicable tests; new behavior is covered explicitly.';record.rules[0].newTests=['existing.test.mjs'];assert.equal(validateEvidence(record,{cwd,base}).checks,1);
 record.rules[0].newTests=[];assert.throws(()=>validateEvidence(record,{cwd,base}),/NEW_TESTS_REQUIRED/);
}));
test('static material/rule changes can use real alternative command evidence, executable/business changes cannot',()=>fixture(({cwd,base,record})=>{
 writeFileSync(join(cwd,'source.mjs'),'export const original=1;');writeFileSync(join(cwd,'asset.css'),'.status { color: green; }');record.sourceFingerprint=sourceFingerprint(cwd);
 const c=record.checks[0];c.kind='command';c.command='node verify-css-and-inspection-evidence.mjs';c.sourceFingerprint=record.sourceFingerprint;delete c.passed;delete c.failed;delete c.skipped;
 record.rules[0].writes=['asset.css'];record.rules[0].reads=['asset.css'];record.rules[0].oldTests=[];record.rules[0].noExistingTestsReason='Only static CSS material is changed; no executable module or corresponding old test exists.';
 record.automaticTestsNotApplicable='The change contains static CSS only and has no business, authorization or automatic behavior.';
 record.alternativeVerification={reason:'Actual static validation and recorded visual comparison cover the changed material without unrelated tests.',checks:['focused']};assert.equal(validateEvidence(record,{cwd,base}).risk,'quick');
 const bad=structuredClone(record);bad.automaticTestsNotApplicable='';assert.throws(()=>validateEvidence(bad,{cwd,base}),/NO_EXECUTED_CHECK/);
 mkdirSync(join(cwd,'apps/api'),{recursive:true});writeFileSync(join(cwd,'apps/api/service.mjs'),'export const mutation=1;');record.sourceFingerprint=sourceFingerprint(cwd);c.sourceFingerprint=record.sourceFingerprint;assert.throws(()=>validateEvidence(record,{cwd,base}),/NO_EXECUTED_CHECK/);
}));

test('the final candidate rejects an evidence record generated after staging, even when code fingerprint matches',()=>fixture(({cwd,git})=>{
 mkdirSync(join(cwd,'docs/engineering'),{recursive:true});const p=join(cwd,'docs/engineering/construction-evidence.json');writeFileSync(p,'old staged result');git('add','.');assert.doesNotThrow(()=>assertCandidateIndex(cwd));
 const fp=sourceFingerprint(cwd);writeFileSync(p,'actual newly generated result');assert.equal(sourceFingerprint(cwd),fp);assert.throws(()=>assertCandidateIndex(cwd),/CANDIDATE_NOT_STAGED/);
 git('add','.');assert.doesNotThrow(()=>assertCandidateIndex(cwd));writeFileSync(join(cwd,'forgotten-new-module.mjs'),'export const forgotten=1');assert.throws(()=>assertCandidateIndex(cwd),/CANDIDATE_NOT_STAGED/);git('add','.');assert.doesNotThrow(()=>assertCandidateIndex(cwd));
}));
