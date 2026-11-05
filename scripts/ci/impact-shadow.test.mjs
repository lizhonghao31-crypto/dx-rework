import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import {hash,caseKey,parseShadowChanges,proposeShadow,observeShadow,captureShadow} from './impact-shadow.mjs';
import {classifyFullGatePaths} from './full-gate-risk-map.mjs';
import {validateNonDatabase} from './full-gate-lanes.mjs';

const root='apps/api/src/pilot.ts',service='apps/api/src/service.ts',direct='tests/unit/direct.test.ts',indirect='tests/unit/indirect.test.ts',other='tests/unit/other.test.ts';
function fixture(){
 const expectedCases=[{file:direct,ancestors:['family'],title:'first',rowKey:'one',parameterHash:hash({caseId:'one',amount:1})},{file:indirect,ancestors:['family'],title:'second',rowKey:'two',parameterHash:hash({caseId:'two',amount:2})}];
 const edges=[[direct,root],[service,root],[indirect,service]];
 return {identity:{head:'a'.repeat(40),base:'b'.repeat(40),runId:'1',attempt:'1'},inputs:{nonDatabase:[direct,indirect,other],postgres:{status:'required',plan:[{path:'tests/integration/canonical-postgres.test.ts',profile:'pg16-lowpriv'}]}},changes:[{status:'M',path:root}],policy:{version:1,root,reviewedBase:'b'.repeat(40),rootImports:['./dependency.js'],requiredEdges:edges,pinnedSources:{[service]:'pin'},expectedCases,toolchain:{nodeMajor:22,vitest:'4.1.10',typescript:'5.9.3'}},graph:{rootImports:['./dependency.js'],edges,conservativeConsumers:[],unsupported:[]},declarations:structuredClone(expectedCases),sourceHashes:{[service]:'pin'},toolchain:{node:'22.22.2',vitest:'4.1.10',typescript:'5.9.3'}};
}
function report(f){return {success:true,numFailedTests:0,numFailedTestSuites:0,testResults:f.inputs.nonDatabase.map(file=>({name:'/checkout/'+file,status:'passed',assertionResults:f.policy.expectedCases.filter(c=>c.file===file).map(c=>({ancestorTitles:c.ancestors,title:c.title,status:'passed'})).concat(file===other?[{ancestorTitles:[],title:'unrelated case',status:'passed'}]:[])}))};}
function observe(f,manifest=proposeShadow(f),r=report(f),extra={}){return observeShadow(manifest,{identity:f.identity,inputs:f.inputs,policy:f.policy,report:r,testOutcome:'success',...extra});}
function fallback(f,reason){const r=proposeShadow(f);assert.equal(r.decision,'fallback');if(reason)assert.equal(r.reason,reason);assert.deepEqual(r.candidate,r.actualExecution);assert.deepEqual(r.proposedExclusions,[]);assert.equal(r.selectionApproved,false);}

test('pilot closes over direct and unchanged transitive consumers while actual execution and PG remain complete',()=>{
 const f=fixture(),r=proposeShadow(f);assert.equal(r.decision,'candidate');assert.deepEqual(r.candidate.nonDatabase,[direct,indirect]);assert.deepEqual(r.candidate.postgres,f.inputs.postgres);assert.deepEqual(r.actualExecution,{nonDatabase:[direct,indirect,other],postgres:f.inputs.postgres});assert.equal(r.proposedExclusions[0].file,other);assert.equal(r.executionChanged,false);assert.equal(r.selectionApproved,false);
 assert.equal(observe(f,r).status,'observed');
});
test('independent edge catalog rejects a missing edge even if conservative traversal still finds every expected test',()=>{
 const f=fixture();f.graph.edges=f.graph.edges.filter(e=>e[0]!==service);f.graph.conservativeConsumers=[indirect];fallback(f,'missing-reviewed-consumer-edge');
});
test('a known PG consumer absent from the original plan is a gap even with a complete green non-DB report',()=>{
 const f=fixture(),required='tests/integration/legacy-correction-postgres.test.ts';f.policy.requiredPostgresFiles=[required];const m=proposeShadow(f);assert.equal(m.decision,'candidate');assert.deepEqual(m.knownPlanGaps,[required]);assert.deepEqual(m.candidate.postgres,f.inputs.postgres);const o=observe(f,m);assert.equal(o.fullRunComplete,true);assert.equal(o.status,'gap');assert.deepEqual(o.knownPlanGaps,[required]);assert.equal(o.selectionApproved,false);
});
test('unknown runtime readers and their unchanged consumers are conservatively included',()=>{
 const f=fixture();f.graph.conservativeConsumers=['apps/api/src/reader.ts'];f.graph.edges.push([other,'apps/api/src/reader.ts']);assert.deepEqual(proposeShadow(f).candidate.nonDatabase,f.inputs.nonDatabase);
});
for(const [label,mutate]of [
 ['missing row',f=>f.declarations.pop()],['same-count parameter substitution',f=>f.declarations[1].parameterHash=hash({caseId:'two',amount:999})],['duplicate row',f=>f.declarations.push(f.declarations[0])],['empty family',f=>f.declarations=[]],['source drift',f=>f.sourceHashes[service]='changed'],['unknown import',f=>f.graph.rootImports.push('new-package')],['unsupported graph',f=>f.graph.unsupported.push('parse-error')],['version drift',f=>f.toolchain.vitest='next'],['unreviewed baseline',f=>f.identity.base='c'.repeat(40)],['missing expected file',f=>f.inputs.nonDatabase=f.inputs.nonDatabase.filter(p=>p!==direct)],['duplicate expected identity',f=>f.policy.expectedCases.push(f.policy.expectedCases[0])],
])test('falls back for '+label,()=>{const f=fixture();mutate(f);fallback(f);});
for(const [status,path]of [['M','unknown/file.ts'],['M','package-lock.json'],['M','vitest.config.ts'],['A',root],['D',root],['R100',root],['T',root],['M','../escape'],['M','/absolute'],['M','a\\b'],['M','bad\npath']])test(`complete fallback for ${status} ${JSON.stringify(path)}`,()=>{const f=fixture();f.changes=[{status,path}];fallback(f);});
test('strict NUL changes reject malformed, duplicate and rename records without guessing',()=>{
 assert.deepEqual(parseShadowChanges('M\0'+root+'\0'),[{status:'M',path:root}]);
 for(const raw of ['','M\0'+root,'R100\0old.ts\0new.ts\0','M\0']){const f=fixture();f.changes=parseShadowChanges(raw);fallback(f);}
 const f=fixture();f.changes.push({...f.changes[0]});fallback(f);
});
test('source declarations and independent native identities reject omission, duplicate, skip and same-count replacement',()=>{
 for(const mutate of [r=>r.testResults[0].assertionResults=[],r=>r.testResults[0].assertionResults.push(r.testResults[0].assertionResults[0]),r=>r.testResults[0].assertionResults[0].status='skipped',r=>r.testResults[0].assertionResults[0].title='substituted']){
  const f=fixture(),r=report(f);mutate(r);assert.equal(observe(f,undefined,r).status,'gap');
 }
});
test('a failure in a proposed exclusion is a diagnosed miss and still fails the existing Full validator',()=>{
 const f=fixture(),r=report(f);r.success=false;r.numFailedTests=1;r.testResults[2].status='failed';r.testResults[2].assertionResults[0].status='failed';const o=observe(f,undefined,r);assert.equal(o.status,'gap');assert.equal(o.missedFailures.length,1);assert.equal(o.fullRunComplete,false);assert.throws(()=>validateNonDatabase(r,f.inputs.nonDatabase));
});
test('all-skipped, empty and todo-only excluded files cannot claim complete observation; the existing 11-case skip remains disclosed',()=>{
 for(const states of [[],['skipped'],['pending'],['passed','todo']]){const f=fixture(),r=report(f);r.testResults[2].assertionResults=states.map((status,i)=>({ancestorTitles:[],title:'outside '+i,status}));assert.equal(observe(f,undefined,r).status,'unverified');assert.throws(()=>validateNonDatabase(r,f.inputs.nonDatabase));}
 const f=fixture(),known='tests/acceptance/v2-pr06-postgres.test.ts';f.inputs.nonDatabase.push(known);const r=report(f);r.testResults.at(-1).assertionResults=Array.from({length:11},(_,i)=>({ancestorTitles:[],title:'existing '+i,status:'skipped'}));validateNonDatabase(r,f.inputs.nonDatabase);const o=observe(f,undefined,r);assert.equal(o.status,'observed');assert.equal(o.fileTimings.at(-1).skipped,11);assert.equal(o.selectionApproved,false);
});
test('missing or mixed Full context and incomplete or failed report cannot yield an observed comparison',()=>{
 for(const mutate of [r=>r.testResults.pop(),r=>r.numFailedTestSuites=1,r=>r.testResults[2].status='failed',r=>r.success=false,r=>r.testResults.push(r.testResults[0]),r=>r.testResults[2].assertionResults[0].status='unknown']){const f=fixture(),r=report(f);mutate(r);assert.equal(observe(f,undefined,r).status,'unverified');}
 const f=fixture(),m=proposeShadow(f);assert.equal(observe(f,m,report(f),{testOutcome:'failure'}).status,'unverified');
 for(const field of ['head','base','runId','attempt'])assert.equal(observe(f,m,report(f),{identity:{...f.identity,[field]:'different'}}).status,'unverified');
 assert.equal(observe(f,m,report(f),{inputs:{...f.inputs,postgres:{status:'different'}}}).status,'unverified');
 const p=structuredClone(f.policy);p.expectedCases[0].parameterHash='different';assert.equal(observe(f,m,report(f),{policy:p}).status,'unverified');
 assert.notEqual(caseKey(f.policy.expectedCases[0]),caseKey(f.policy.expectedCases[1]));
});
test('observer exceptions remain unverified diagnostics and fallback does not claim observed evidence',async()=>{
 const r=await captureShadow(()=>{throw Error('fixture observer failure');});assert.equal(r.status,'unverified');assert.equal(r.selectionApproved,false);const f=fixture();f.changes=[{status:'M',path:'shared.ts'}];assert.equal(observe(f).status,'fallback');
});
test('malformed candidate cannot claim evidence, and native file times remain explicit diagnostic durations',()=>{
 const f=fixture(),m=proposeShadow(f);
 for(const mutate of [m=>m.selectionApproved=true,m=>m.actualExecution.nonDatabase.pop(),m=>m.candidate.postgres={},m=>m.candidate.nonDatabase.push(other,other),m=>m.candidate.nonDatabase=m.candidate.nonDatabase.filter(p=>p!==direct)]){const bad=structuredClone(m);mutate(bad);assert.equal(observe(f,bad).status,'unverified');}
 const r=report(f);r.testResults[0].startTime=100;r.testResults[0].endTime=150;const o=observe(f,m,r);assert.equal(o.fileTimings[0].durationMs,50);assert.equal(o.fileTimings[2].durationMs,null);assert.equal(o.fileTimings[2].proposed,'excluded');assert.equal(o.selectionApproved,false);
});
test('shadow files alone require the same broad Full risk as the lane executor',()=>{
 for(const path of ['scripts/ci/impact-shadow.mjs','scripts/ci/impact-shadow-graph.mjs','scripts/ci/impact-shadow-policy.json'])assert.deepEqual(classifyFullGatePaths([path]),classifyFullGatePaths(['scripts/ci/full-gate-lanes.mjs']));
});
test('workflow only archives shadow output and still invokes the complete original Vitest command',()=>{
 const w=readFileSync('.github/workflows/full-gate.yml','utf8'),lanes=readFileSync('scripts/ci/full-gate-lanes.mjs','utf8');
 assert.match(w,/run: node node_modules\/vitest\/vitest.mjs run --reporter=default --reporter=json --outputFile=\$\{\{ runner.temp \}\}\/non-db-results.json/);
 assert.equal(w.split('\n').filter(l=>l.includes('impact-shadow')).every(l=>/^ +\$\{\{ runner.temp \}\}\//.test(l)),true);
 assert.doesNotMatch(lanes,/candidate\.nonDatabase/);assert.match(lanes,/validateNonDatabase\(json\(report\),inputs.nonDatabase\)/);
});
