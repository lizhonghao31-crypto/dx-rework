import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {writeFileSync} from 'node:fs';
import {requestFinal,GitHubError} from './pr-gate-controller.mjs';
import {closeoutReport} from './final-closeout.mjs';
import {closeoutFixture,disposeCloseoutFixtures,closeoutSha} from './final-closeout.fixture.mjs';
import {REPOSITORY,REVIEW_BOT,LIGHT_CHECK,RECEIPT_PREFIX} from './pr-gate-protocol.mjs';
after(disposeCloseoutFixtures);
const head='a'.repeat(40),base='b'.repeat(40),plan={repository:REPOSITORY,pr:901,head,base,baseRef:'release/digital-production-v1',kind:'full',phase:'final'},prefix=`/repos/${REPOSITORY}`;
function setup(){
 const closeout=closeoutFixture(plan),state={ref:null,writes:[],inline:[]};
 const api={pr:async()=>({number:901,state:'open',title:'[FULL] TEST exact closeout',head:{sha:head},base:{ref:plan.baseRef,repo:{full_name:REPOSITORY}}}),comments:async()=>[{id:12,user:{login:REVIEW_BOT},updated_at:'2026-11-02T00:00:00Z',body:`<!-- codex-review-state:v1 ${JSON.stringify({code_review:{status:'completed',commit_sha:head}})} -->`}],
  pages:async(path)=>{if(path===`${prefix}/pulls/901/comments`)return state.inline;if(path.includes('/jobs'))return [{id:201,run_id:101,name:LIGHT_CHECK,status:'completed',conclusion:'success'}];if(path.includes('event=create'))return [];if(path.includes('/runs?'))return [{id:101,run_attempt:1,head_sha:head,path:'.github/workflows/ci.yml',event:'pull_request',status:'completed',conclusion:'success'}];throw Error('unexpected read '+path);},
  request:async(path,{method='GET',body}={})=>{
   if(path==='/graphql')return {data:{repository:{pullRequest:{reviewThreads:{nodes:[],pageInfo:{hasNextPage:false}}}}}};
   if(path.includes('/branches/'))return {commit:{sha:base}};
   if(path.includes('/contents/'))return closeout.encoded();
   if(path.includes('/logs'))return RECEIPT_PREFIX+JSON.stringify({version:1,...plan,phase:'light',runId:101,attempt:1,jobStatus:'success',missing:[],checks:['title','checkout','head','policy'].map(id=>({id,applicable:true,outcome:'success'}))});
   if(path.includes('/git/ref/heads/')){if(!state.ref)throw new GitHubError(404,'not found');return state.ref;}
   if(path===`${prefix}/git/refs`&&method==='POST'){state.writes.push(body);state.ref={ref:body.ref,object:{sha:body.sha}};return state.ref;}
   throw Error('unexpected API '+path);
  }};return {closeout,state,api};
}
test('missing closure blocks both preview and apply before any final ref POST',async()=>{
 const f=setup();for(const apply of [false,true])await assert.rejects(()=>requestFinal(f.api,901,head,{apply}),/missing --closeout/);assert.equal(f.state.writes.length,0);
});
test('old head and base are reported together and never create a final request',async()=>{
 const f=setup();f.closeout.pack.head='d'.repeat(40);f.closeout.pack.base='e'.repeat(40);f.closeout.save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),e=>e.message.includes('mismatched head')&&e.message.includes('mismatched base'));assert.equal(f.state.writes.length,0);
});
test('an unresolved finding and unproven counterexample are rejected together',async()=>{
 const f=setup();f.closeout.pack.findings=[{id:'PARENT-1',status:'open',source:'TEST point-check source',conclusion:'TEST direct caller regression is still unresolved.',checkId:'unit',testNames:['TEST case that did not run']}];f.closeout.save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),e=>e.message.includes('unclosed/unexplained PARENT-1')&&e.message.includes('unproven real case PARENT-1'));assert.equal(f.state.writes.length,0);
});
test('a complete exact closure validates real report bytes and atomically creates one request',async()=>{
 const f=setup();f.state.inline=[{id:77,user:{login:REVIEW_BOT},body:'TEST codex-code-review-finding:v1'}];f.closeout.pack.findings=[{id:'REVIEW-77',reviewCommentId:77,status:'closed',source:'TEST actual Review finding 77',conclusion:'TEST original real regression case is verified and closed.',checkId:'unit',testNames:[f.closeout.name]}];f.closeout.save();
 const preview=await requestFinal(f.api,901,head,{closeoutPath:f.closeout.path});assert.equal(preview.state,'plan');assert.equal(f.state.writes.length,0);assert.deepEqual(preview.closeout.findings,['REVIEW-77']);
 await requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path});assert.equal(f.state.writes.length,1);
 // Polling an existing immutable request is not a second launch or a reapproval.
 assert.equal((await requestFinal(f.api,901,head,{apply:true})).state,'requested');assert.equal(f.state.writes.length,1);
});
test('self-labelled passed cannot replace a changed or failed actual report',async()=>{
 const f=setup();writeFileSync(f.closeout.log,'TAP version 13\nnot ok 1 - failed\n# pass 0\n# fail 1\n');f.closeout.pack.reports[0].sha256=closeoutSha('TAP version 13\nnot ok 1 - failed\n# pass 0\n# fail 1\n');f.closeout.save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/actual command log digest differs/);assert.equal(f.state.writes.length,0);
});
test('a local construction replacement cannot substitute for the pinned head record',async()=>{
 const f=setup();f.closeout.pack.constructionEvidenceSha256='0'.repeat(64);f.closeout.save();await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/pinned construction evidence digest differs/);assert.equal(f.state.writes.length,0);
});
test('known Review findings cannot be omitted by supplying an empty findings collection',async()=>{
 const f=setup();f.state.inline=[{id:99,user:{login:REVIEW_BOT},body:'TEST codex-code-review-finding:v1'}];await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/Review finding omitted 99/);assert.equal(f.state.writes.length,0);
});
test('empty, failed, skipped-only or unknown result formats are not a real passing counterexample',()=>{
 for(const body of ['', '# pass 0\n# fail 0\n', 'ok 1 - TEST # SKIP\n# pass 1\n# fail 0\n'])assert.throws(()=>closeoutReport(body,'node-tap'));
 assert.throws(()=>closeoutReport(JSON.stringify({success:false,testResults:[],numPassedTests:1,numFailedTests:0}),'vitest-json'));
 assert.throws(()=>closeoutReport('passed','plain-passed'));
});
test('same totals from an unrelated report cannot close a case absent from the pinned command log',async()=>{
 const f=setup(),name='TEST unrelated stale test never executed by the pinned command';
 const body=`TAP version 13\nok 1 - ${name}\n1..1\n# tests 1\n# pass 1\n# fail 0\n# skipped 0\n`,path=f.closeout.dir+'/unrelated.log';writeFileSync(path,body);
 f.closeout.pack.reports=[{checkId:'unit',path,sha256:closeoutSha(body),format:'node-tap'}];f.closeout.pack.scopeChecks[0].testNames=[name];f.closeout.save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/test case identities differ from original command log/);assert.equal(f.state.writes.length,0);
});
test('a names-free command summary needs structured result bytes pinned by that exact construction check',async()=>{
 const f=setup(),summary=' Tests  1 passed (1)\n';writeFileSync(f.closeout.log,summary);f.closeout.evidence.checks[0].logSha256=closeoutSha(summary);
 const body=JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,numPendingTests:0,testResults:[{assertionResults:[{status:'passed',fullName:f.closeout.name}]}]}),path=f.closeout.dir+'/vitest.json';writeFileSync(path,body);
 f.closeout.pack.reports=[{checkId:'unit',path,sha256:closeoutSha(body),format:'vitest-json'}];f.closeout.pack.constructionEvidenceSha256=closeoutSha(JSON.stringify(f.closeout.evidence));f.closeout.save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/structured report digest is not bound/);assert.equal(f.state.writes.length,0);
 f.closeout.evidence.checks[0].resultReports=[{format:'vitest-json',sha256:closeoutSha(body)}];f.closeout.pack.constructionEvidenceSha256=closeoutSha(JSON.stringify(f.closeout.evidence));f.closeout.save();
 assert.equal((await requestFinal(f.api,901,head,{closeoutPath:f.closeout.path})).state,'plan');assert.equal(f.state.writes.length,0);
});
test('JSON initialization lines before Vitest summaries require the same pinned reports and exact totals',async()=>{
 const f=setup(),summary='{"status":"ok","database":"synthetic-test"}\n{"success":true,"applied":[]}\n\n RUN v4\n Tests  1 passed (1)\n';
 const body=JSON.stringify({success:true,numPassedTests:1,numFailedTests:0,numPendingTests:0,testResults:[{assertionResults:[{status:'passed',fullName:f.closeout.name}]}]}),path=f.closeout.dir+'/vitest.json';writeFileSync(path,body);
 writeFileSync(f.closeout.log,summary);f.closeout.evidence.checks[0].logSha256=closeoutSha(summary);
 f.closeout.pack.reports=[{checkId:'unit',path,sha256:closeoutSha(body),format:'vitest-json'}];
 const save=()=>{f.closeout.pack.constructionEvidenceSha256=closeoutSha(JSON.stringify(f.closeout.evidence));f.closeout.save();};save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/structured report digest is not bound/);assert.equal(f.state.writes.length,0);
 f.closeout.evidence.checks[0].resultReports=[{format:'vitest-json',sha256:closeoutSha(body)}];save();
 assert.equal((await requestFinal(f.api,901,head,{closeoutPath:f.closeout.path})).state,'plan');
 const wrong=summary.replace('1 passed','2 passed');writeFileSync(f.closeout.log,wrong);f.closeout.evidence.checks[0].logSha256=closeoutSha(wrong);save();
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/actual test\/log counts differ/);assert.equal(f.state.writes.length,0);
});
test('failed or truncated JSON test reports cannot fall through to a passing text summary',async()=>{
 for(const log of [
  '{"success":false,"numPassedTests":0,"numFailedTests":1,"testResults":[],"summary":" Tests 1 passed (1)"}',
  '{"success":false,"numPassedTests":0,"numFailedTests":1,"testResults":[]}\n Tests 1 passed (1)\n',
  '{"testResults":[\n Tests 1 passed (1)\n',
  '{"status":"ok"}\n Test Files 1 failed\n Tests 1 passed (1)\n',
  '{"status":"ok"}\n Tests 1 passed | 1 failed (2)\n'
 ]){
  const f=setup();writeFileSync(f.closeout.log,log);f.closeout.evidence.checks[0].logSha256=closeoutSha(log);f.closeout.pack.constructionEvidenceSha256=closeoutSha(JSON.stringify(f.closeout.evidence));f.closeout.save();
  await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true,closeoutPath:f.closeout.path}),/FINAL_CLOSEOUT_REJECTED/);assert.equal(f.state.writes.length,0);
 }
});
