import assert from 'node:assert/strict';import {test} from 'node:test';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs';import{tmpdir}from'node:os';import{join}from'node:path';import{execFileSync}from'node:child_process';
import{sourceFingerprint,validateEvidence}from'./construction-evidence.mjs';
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
