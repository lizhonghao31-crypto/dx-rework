import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {affectedEntryPlan,affectedReceipt,AFFECTED_JOB,AFFECTED_PREFIX} from './affected-entry-preflight.mjs';
import {checkTimeSiteInventory} from '../acceptance/time-site-inventory.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHub,GitHubError,decodeGitHubResponse,requestFinal as guardedRequestFinal,verifyMerge,reviewStep} from './pr-gate-controller.mjs';
import {closeoutFixture,disposeCloseoutFixtures,closeoutSha} from './final-closeout.fixture.mjs';
after(disposeCloseoutFixtures);
const closeouts=new WeakMap();
const requestFinal=(api,number,head,options={})=>guardedRequestFinal(api,number,head,{closeoutPath:closeouts.get(api)?.path,...options});
import {REPOSITORY,REVIEW_BOT,FINAL_CHECK,LIGHT_CHECK,finalRef,RECEIPT_PREFIX} from './pr-gate-protocol.mjs';
const head='a'.repeat(40),base='b'.repeat(40),baseRef='release/digital-production-v1',prefix=`/repos/${REPOSITORY}`;
const plan={repository:REPOSITORY,pr:901,head,base,baseRef,kind:'full',phase:'final'};
const summary=(status='completed',commit_sha=head)=>({id:12,user:{login:REVIEW_BOT},updated_at:'2026-10-27T17:00:00Z',body:`<!-- codex-review-state:v1 ${JSON.stringify({code_review:{status,commit_sha}})} -->`});
const request={id:10,body:'@codex review',created_at:'2026-10-27T16:00:00Z'};
function fixture(){
 const state={pr:{state:'open',title:'[FULL] bounded change',head:{sha:head},base:{sha:base,ref:baseRef,repo:{full_name:REPOSITORY}}},comments:[request,summary()],threads:[],inlineComments:[],ref:null,writes:[],reads:[],runs:{light:[run(101,'light')],final:[]},jobs:{},logs:{},closeout:closeoutFixture(plan)};
 function run(id,phase){return{id,run_attempt:1,head_sha:head,path:'.github/workflows/ci.yml',event:phase==='light'?'pull_request':'create',head_branch:finalRef(plan),status:'completed',conclusion:'success'};}
 function addProof(id,phase){const names=['title','checkout','head','policy',...(phase==='final'?['risk','install','audit','lint','types','build','tests','migration_lint','secrets']:[])];
  const receipt={version:1,...plan,phase,runId:id,attempt:1,jobStatus:'success',missing:[],checks:names.map(id=>({id,applicable:true,outcome:'success'}))};
  state.jobs[id]=[{id:id+100,run_id:id,name:phase==='light'?LIGHT_CHECK:FINAL_CHECK,status:'completed',conclusion:'success'}];
  state.logs[id+100]=RECEIPT_PREFIX+JSON.stringify(receipt);return receipt;
 }
 addProof(101,'light');
 const api={pr:async()=>structuredClone(state.pr),comments:async()=>structuredClone(state.comments),pages:async(path,key)=>{
  state.reads.push(path);
  if(path===`${prefix}/pulls/901/comments`)return structuredClone(state.inlineComments);
  if(path===`${prefix}/pulls/901/reviews`)return structuredClone(state.reviews??[]);
  if(path.includes('/jobs'))return structuredClone(state.jobs[Number(path.match(/runs\/(\d+)/)[1])]??[]);
  if(key==='workflow_runs')return structuredClone(path.includes('event=create')?state.runs.final:state.runs.light);
  throw new Error(`Unexpected pages ${path}`);
 },request:async(path,{method='GET',body}={})=>{
  if(method==='GET')state.reads.push(path);else state.writes.push({path,method,body});
  if(path==='/graphql')return {data:{repository:{pullRequest:{reviewThreads:{nodes:state.threads,pageInfo:{hasNextPage:false}}}}}};
  if(path.includes('/contents/scripts/ci/affected-entry-map.json'))throw new GitHubError(404,'Not Found');
  if(path.includes('/contents/docs/engineering/construction-evidence.json'))return state.closeout.encoded();
  if(path.includes('/compare/'))return {status:'ahead',behind_by:0};
  if(path.includes('/logs'))return state.logs[Number(path.match(/jobs\/(\d+)/)[1])];
  if(path.includes('/git/ref/heads/')){if(!state.ref)throw new GitHubError(404,'Not Found');return structuredClone(state.ref);}
  if(path===`${prefix}/git/refs`){if(state.createError)throw state.createError;if(state.ref)throw new GitHubError(422,'Reference already exists');state.ref={ref:body.ref,object:{sha:body.sha}};return state.ref;}
  if(path.includes('/branches/'))return {name:baseRef,commit:{sha:state.actualBase??base},protected:false,protection:{required_status_checks:{enforcement_level:'off',contexts:[],checks:[]}}};
  if(path.endsWith('/comments')&&method==='POST'){if(state.postError)throw state.postError;await new Promise(r=>setTimeout(r,5));const c={...request,id:20,created_at:'2026-10-27T16:15:01Z'};state.comments.push(c);return c;}
  throw new Error(`Unexpected API ${method} ${path}`);
 }};
 closeouts.set(api,state.closeout);return{state,api,addFinal(){state.runs.final=[run(102,'final')];return addProof(102,'final');}};
}
test('final request defaults to read-only; explicit apply atomically creates one complete frozen-Head ref',async()=>{
 const{api,state}=fixture();const preview=await requestFinal(api,901,head);
 assert.equal(preview.state,'plan');assert.equal(preview.request.sha,head);assert.equal(state.writes.filter(w=>w.path!=='/graphql').length,0);
 const first=await requestFinal(api,901,head,{apply:true}),second=await requestFinal(api,901,head,{apply:true});
 assert.equal(first.state,'requested');assert.equal(second.state,'requested');
 assert.equal(state.writes.filter(w=>w.path.endsWith('/git/refs')).length,1);assert.equal(state.ref.ref,`refs/heads/${finalRef(plan)}`);
});
test('concurrent final requests share one atomic ref; no nonce, force, delete or rerun path',async()=>{
 const{api,state}=fixture();await Promise.all([requestFinal(api,901,head,{apply:true}),requestFinal(api,901,head,{apply:true})]);
 assert.equal(new Set(state.writes.filter(w=>w.path.endsWith('/git/refs')).map(w=>w.body.ref)).size,1);
 assert.equal(state.writes.some(w=>['PATCH','DELETE'].includes(w.method)),false);
});
test('a completed actual final job is verified without writing or changing branch protection',async()=>{
 const{api,state,addFinal}=fixture();state.ref={ref:`refs/heads/${finalRef(plan)}`,object:{sha:head}};addFinal();
 const result=await verifyMerge(api,901,head);assert.equal(result.final.state,'approved');assert.equal(result.final.receipt.head,head);
 assert.equal(result.platform.protected,false);assert.deepEqual(state.writes.map(w=>w.path),['/graphql']);
});
for(const fault of ['review','threads','head','final_skipped','final_old','final_running','final_failed','rewritten_ref','actual_base_moved'])test(`merge evidence fails closed for ${fault}`,async()=>{
 const{api,state,addFinal}=fixture();state.ref={ref:`refs/heads/${finalRef(plan)}`,object:{sha:head}};addFinal();
 if(fault==='actual_base_moved')state.actualBase='d'.repeat(40);
 if(fault==='review')state.comments=[request,summary('failed')];
 if(fault==='threads')state.threads=[{id:'r1',isResolved:false}];
 if(fault==='head')state.pr.head.sha='c'.repeat(40);
 if(fault==='final_skipped')state.jobs[102][0].conclusion='skipped';
 if(fault==='final_old')state.runs.final[0].head_sha='c'.repeat(40);
 if(fault==='final_running')state.runs.final[0].status='in_progress';
 if(fault==='final_failed')state.runs.final[0].conclusion='failure';
 if(fault==='rewritten_ref')state.ref.object.sha='c'.repeat(40);
 await assert.rejects(()=>verifyMerge(api,901,head));assert.equal(state.writes.some(w=>w.path!=='/graphql'),false);
});
for(const stateName of ['absent','failed','cancelled','older_head','running'])test(`final validates its own Head without repeating Light: ${stateName}`,async()=>{
 const{api,state,addFinal}=fixture();
 if(stateName==='absent')state.runs.light=[];
 else if(stateName==='older_head')state.runs.light[0].head_sha='c'.repeat(40);
 else if(stateName==='running')state.runs.light[0].status='in_progress';
 else state.runs.light[0].conclusion=stateName==='failed'?'failure':'cancelled';
 assert.equal((await requestFinal(api,901,head,{apply:true})).state,'requested');
 addFinal();const result=await verifyMerge(api,901,head);
 assert.equal(result.final.state,'approved');assert.equal(result.lightRun,null);
 assert.equal(state.reads.some(path=>path.includes('event=pull_request')),false);
 assert.equal(state.writes.some(w=>w.path.includes('rerun')),false);
});
test('a final receipt claiming reuse still requires the actual same-Head Light source',async()=>{
 const{api,state,addFinal}=fixture();await requestFinal(api,901,head,{apply:true});
 const receipt=addFinal();const check=receipt.checks.find(c=>c.id==='lint');
 check.execution='verified_reuse';check.source={...plan,phase:'light',check:'lint',workflow:'.github/workflows/ci.yml',runId:101,attempt:1,jobId:201,fingerprint:'d'.repeat(64),artifactSha256:'e'.repeat(64)};
 state.logs[202]=RECEIPT_PREFIX+JSON.stringify(receipt);
 state.runs.light=[];
 await assert.rejects(()=>verifyMerge(api,901,head),/light/);
 state.runs.light=[{id:101,run_attempt:1,head_sha:'c'.repeat(40),path:'.github/workflows/ci.yml',event:'pull_request',status:'completed',conclusion:'success'}];
 await assert.rejects(()=>verifyMerge(api,901,head),/identity|differs/);
});
test('explicit denial is not retried; an uncertain create is inspected before treating it as successful',async()=>{
 const{api,state}=fixture();state.createError=new GitHubError(403,'Resource not accessible');await assert.rejects(()=>requestFinal(api,901,head,{apply:true}),/403/);assert.equal(state.ref,null);
 const other=fixture();const original=other.api.request;other.api.request=async(path,options)=>{if(path.endsWith('/git/refs')){other.state.ref={ref:options.body.ref,object:{sha:head}};throw new Error('network outcome uncertain');}return original(path,options);};
 assert.equal((await requestFinal(other.api,901,head,{apply:true})).state,'requested');
});
test('Review timeout double-check and local lock permit only one comment; repeated observation does not repost',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-lock-'));try{
 const{api,state}=fixture();state.comments=[request,summary('running')];const options={now:Date.parse(request.created_at)+900000,apply:true,stateDir:dir};
 const result=await Promise.all([reviewStep(api,901,head,10,options),reviewStep(api,901,head,10,options)]);
 assert.equal(result.filter(r=>r.action==='reopened').length,1);assert.equal(state.writes.filter(w=>w.path.endsWith('/comments')).length,1);
 assert.equal((await reviewStep(api,901,head,10,options)).action,'superseded');
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('late Review completion suppresses timeout write; denied or uncertain comment is never blindly repeated',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'review-failure-'));try{
 const{api,state}=fixture(),options={now:Date.parse(request.created_at)+900000,apply:true,stateDir:dir};
 assert.equal((await reviewStep(api,901,head,10,options)).action,'complete');assert.equal(state.writes.length,0);
 state.comments=[request,summary('running')];state.postError=new GitHubError(403,'denied');await assert.rejects(()=>reviewStep(api,901,head,10,options));
 assert.equal((await reviewStep(api,901,head,10,options)).action,'blocked_uncertain_or_denied');assert.equal(state.writes.filter(w=>w.path.endsWith('/comments')).length,1);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('API client rejects another repository before fetching or sending operator credentials',async()=>{
 let called=false;const api=new GitHub('local-dummy-not-a-token',async()=>{called=true;});
 await assert.rejects(()=>api.request('/repos/other/repo/actions/runs'));assert.equal(called,false);
});

test('managed CLI response decoding preserves real HTTP denial and redirect/final status without exposing auth',()=>{
 assert.deepEqual(decodeGitHubResponse('HTTP/2.0 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}'),{status:200,body:'{"ok":true}'});
 assert.equal(decodeGitHubResponse('HTTP/2.0 302 Found\nlocation: fixture\n\nHTTP/2.0 200 OK\ncontent-type: text/plain\n\n2026-10-27T00:00:00Z log').status,200);
 assert.deepEqual(decodeGitHubResponse('HTTP/2.0 403 Forbidden\ncontent-type: application/json\n\n{"message":"Resource not accessible"}'),{status:403,body:'{"message":"Resource not accessible"}'});
 assert.throws(()=>decodeGitHubResponse('connection refused'),/status missing/);
 assert.throws(()=>decodeGitHubResponse('HTTP/2.0 201 Created\ncontent-type: application/json'),/headers incomplete/);
});

test('base observed changing during proof verification invalidates the result before return',async()=>{
 const{api,state,addFinal}=fixture();state.ref={ref:`refs/heads/${finalRef(plan)}`,object:{sha:head}};addFinal();
 const original=api.request;let reads=0;
 api.request=async(path,options)=>{const result=await original(path,options);if(path.includes('/branches/')&&++reads===2)result.commit.sha='d'.repeat(40);return result;};
 await assert.rejects(()=>verifyMerge(api,901,head),/base|changed|stale/);
});
const noReview={required:false,reason:'Isolated low-risk documentation; no mandatory review domain',authorization:'AGENTS.md#8-codex-review / approved task scope'};
function quickFixture(){
 const f=fixture();f.addFinal();f.state.pr.title='[QUICK] isolated documentation';f.state.comments=[];
 const ref=finalRef({...plan,kind:'quick'});f.state.ref={ref:`refs/heads/${ref}`,object:{sha:head}};f.state.runs.final[0].head_branch=ref;
 for(const id of Object.keys(f.state.logs))f.state.logs[id]=f.state.logs[id].replace('"kind":"full"','"kind":"quick"');
 f.state.closeout.pack.kind='quick';f.state.closeout.pack.review={...noReview};f.state.closeout.save();
 return f;
}
test('authorized low-risk no-review decision works in final request and merge verification without a Codex summary',async()=>{
 const{api,state}=quickFixture();state.ref=null;
 assert.equal((await requestFinal(api,901,head,{reviewPolicy:noReview})).state,'plan');
 await requestFinal(api,901,head,{reviewPolicy:noReview,apply:true});
 const result=await verifyMerge(api,901,head,{reviewPolicy:noReview});
 assert.equal(result.reviewDecision.required,false);assert.equal(result.reviewDecision.authorization,noReview.authorization);
 assert.equal(result.reviewedHead,null);assert.equal(result.final.state,'approved');
});
for(const fault of ['missing_authority','missing_reason','full','unresolved','running'])test(`no-review declaration cannot bypass ${fault}`,async()=>{
 const f=quickFixture();let decision={...noReview};
 if(fault==='missing_authority')delete decision.authorization;
 if(fault==='missing_reason')delete decision.reason;
 if(fault==='full')f.state.pr.title='[FULL] permission change';
 if(fault==='unresolved')f.state.threads=[{id:'known',isResolved:false}];
 if(fault==='running')f.state.comments=[summary('running')];
 await assert.rejects(()=>requestFinal(f.api,901,head,{reviewPolicy:decision,apply:true}));
 assert.equal(f.state.writes.some(w=>w.path.endsWith('/git/refs')),false);
});

for(const fault of ['head','mode','base_ref'])test(`late ${fault} drift is rejected after otherwise successful evidence`,async()=>{
 const{api,state,addFinal}=fixture();state.ref={ref:`refs/heads/${finalRef(plan)}`,object:{sha:head}};addFinal();
 const original=api.pr;let reads=0;api.pr=async number=>{
  const result=await original(number);if(++reads===2){
   if(fault==='head')result.head.sha='d'.repeat(40);
   if(fault==='mode')result.title='[QUICK] retitled';
   if(fault==='base_ref')result.base.ref='main';
  }return result;
 };
 await assert.rejects(()=>verifyMerge(api,901,head),/moved|changed/);
 assert.equal(state.writes.some(w=>w.path!=='/graphql'),false);
});

test('cheap CI preflight includes the shared time-source inventory and explicit real audit/security classification',async()=>{
 assert.deepEqual(await checkTimeSiteInventory(),[]);
 const inventory=JSON.parse(await readFile('docs/engineering/acceptance-time-sites-20261027.json','utf8'));
 const entry=inventory.entries.find(e=>e.path==='scripts/ci/pr-gate-controller.mjs');
 assert.equal(entry.timeDomain,'real-audit-security');
 assert.equal(entry.semanticStatus,'reviewed-real-audit-security');
 assert.ok(entry.semanticReview);assert.ok(entry.evidence);
});

test('keeps the reviewed responsibility sources when task display loading changes',async()=>{
 const inventory=JSON.parse(await readFile('docs/engineering/acceptance-time-sites-20261027.json','utf8'));
 const entry=inventory.entries.find(e=>e.path==='apps/web/src/digital-production-tasks-panel.tsx');
 assert.equal(entry?.semanticStatus,'reviewed-responsibility-provenance');
 assert.match(entry?.semanticReview??'',/original business clock stay authoritative/);
 assert.match(entry?.evidence??'',/development-responsibility-provenance.md/);
 assert.deepEqual(await checkTimeSiteInventory(),[]);
});

for(const lightState of ['running','failed','absent'])test(`Review observation is independent of initial Light: ${lightState}`,async()=>{
 const{api,state}=fixture();
 state.comments=[request,summary('running')];
 if(lightState==='absent')state.runs.light=[];
 else if(lightState==='running')state.runs.light[0].status='in_progress';
 else state.runs.light[0].conclusion='failure';
 const result=await reviewStep(api,901,head,10,{now:Date.parse(request.created_at)+60_000});
 assert.equal(result.action,'wait');
 assert.equal(state.reads.some(path=>path.includes('/actions/')),false);
 assert.equal(state.writes.length,0);
});
test('parallel Light does not let unfinished Review or unresolved findings start Full',async()=>{
 for(const fault of ['running_review','unresolved_finding']){
  const{api,state}=fixture();state.runs.light[0].status='in_progress';
  if(fault==='running_review')state.comments=[request,summary('running')];
  else state.threads=[{id:'known',isResolved:false}];
  await assert.rejects(()=>requestFinal(api,901,head,{apply:true}),/Review/);
  assert.equal(state.writes.some(write=>write.path.endsWith('/git/refs')),false);
 }
});

async function withPinnedImpact(f,{path='apps/web/src/digital-development-create-form.tsx',truncated=false}={}){
 const bytes=await readFile('scripts/ci/affected-entry-map.json'),registry=JSON.parse(bytes);
 const original=f.api.request;
 const baseTree='1'.repeat(40),headTree='2'.repeat(40),file='scripts/ci/affected-entry-map.json';
 const map={path:file,type:'blob',mode:'100644',sha:'3'.repeat(40)};
 const touched={path,type:'blob',mode:'100644',sha:'4'.repeat(40)};
 f.api.request=async(apiPath,options)=>{
  if(apiPath.endsWith('/contents/'+file+'?ref='+base))return {type:'file',encoding:'base64',content:bytes.toString('base64')};
  if(apiPath.endsWith('/git/commits/'+base))return {sha:base,tree:{sha:baseTree}};
  if(apiPath.endsWith('/git/commits/'+head))return {sha:head,tree:{sha:headTree}};
  if(apiPath.includes('/git/trees/'+baseTree))return {sha:baseTree,truncated,tree:[map,touched]};
  if(apiPath.includes('/git/trees/'+headTree))return {sha:headTree,truncated:false,tree:[map,{...touched,sha:'5'.repeat(40)}]};
  return original(apiPath,options);
 };
 return affectedEntryPlan(registry,[path]);
}

async function closeoutBrowser(f,tests,{stale=false}={}){
 const c=f.state.closeout,cwd=c.dir,byFile=Map.groupBy(tests,test=>test.file);
 const body=JSON.stringify({success:true,numFailedTests:0,numPassedTests:tests.length,numPendingTests:0,
  testResults:[...byFile].map(([file,tests])=>({name:join(cwd,file),assertionResults:tests.map(test=>({fullName:test.name,status:'passed'}))}))});
 await writeFile(c.log,body);
 const proof=c.evidence.checks[0];
 Object.assign(proof,{cwd,logSha256:closeoutSha(body),passed:tests.length,sourceFingerprint:stale?'d'.repeat(64):c.evidence.sourceFingerprint,testedHead:head});
 c.pack.reports[0]={checkId:proof.id,path:c.log,format:'vitest-json',sha256:closeoutSha(body)};
 c.pack.scopeChecks[0].testNames=[tests[0].name];
 c.pack.constructionEvidenceSha256=closeoutSha(JSON.stringify(c.evidence));c.save();
}

test('the creation-equivalent diff with only the new wizard blocks Full before any immutable write',async()=>{
 const f=fixture(),selected=await withPinnedImpact(f);
 await closeoutBrowser(f,selected.filter(c=>c.id==='original-numbered-creation'));
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true}),
  e=>/AFFECTED_ENTRY_PROOF_MISSING: original-fixed-timeline-creation, original-preorder-conversion, original-preorder-investment-from-task/.test(e.message));
 assert.equal(f.state.ref,null);
 await closeoutBrowser(f,selected,{stale:true});
 await assert.rejects(()=>requestFinal(f.api,901,head,{apply:true}),/AFFECTED_ENTRY_PROOF_MISSING/);
 assert.equal(f.state.ref,null);
 await closeoutBrowser(f,selected);
 assert.equal((await requestFinal(f.api,901,head,{apply:true})).state,'requested');
 assert.equal(f.state.writes.filter(w=>w.path.endsWith('/git/refs')).length,1);
});

test('unrelated paths use the existing closeout and branch binding, while a truncated pinned diff denies',async()=>{
 const independent=fixture();assert.deepEqual(await withPinnedImpact(independent,{path:'apps/api/src/production-platform/rework-service.ts'}),[]);
 assert.equal((await requestFinal(independent.api,901,head,{apply:true})).state,'requested');
 const incomplete=fixture();await withPinnedImpact(incomplete,{truncated:true});
 await assert.rejects(()=>requestFinal(incomplete.api,901,head,{apply:true}),/complete pinned GitHub tree/);
 assert.equal(incomplete.state.ref,null);
});

test('merge requires the real hosted affected check and refuses skips, forged context names or an old attempt',async()=>{
 const f=fixture(),selected=await withPinnedImpact(f);await closeoutBrowser(f,selected);
 await requestFinal(f.api,901,head,{apply:true});f.addFinal();
 await assert.rejects(()=>verifyMerge(f.api,901,head),/actual hosted affected-entry job/);
 const hosted={id:302,name:AFFECTED_JOB,run_id:102,run_attempt:1,head_sha:head,status:'completed',conclusion:'success',
  steps:[{name:'Run and verify exact affected cases',conclusion:'skipped'}]};
 f.state.jobs[102].push(hosted);
 await assert.rejects(()=>verifyMerge(f.api,901,head),/skipped/);
 hosted.steps[0].conclusion='success';
 f.state.logs[302]=AFFECTED_PREFIX+JSON.stringify(affectedReceipt(plan,{id:102,run_attempt:2},selected,'a'.repeat(64)));
 await assert.rejects(()=>verifyMerge(f.api,901,head),/stale/);
 f.state.logs[302]=AFFECTED_PREFIX+JSON.stringify(affectedReceipt(plan,{id:102,run_attempt:1},selected,'a'.repeat(64)));
 assert.deepEqual((await verifyMerge(f.api,901,head)).final.affectedReceipt.cases,selected.map(t=>t.id));
});

test('Full Review retry does not create a third round after either two requests or one automatic round and a request',async()=>{
 for(const autoRound of [true,false]){
  const f=fixture(),created='2026-10-27T17:00:01Z',second={...request,id:20,created_at:created};
  f.state.comments=autoRound?[second,summary('running')]:[request,second,summary('running')];
  if(autoRound)f.state.reviews=[{user:{login:REVIEW_BOT},state:'COMMENTED',submitted_at:'2026-10-27T16:54:00Z'}];
  assert.deepEqual(await reviewStep(f.api,901,head,20,{apply:true,now:Date.parse(created)+900000}),{action:'review_round_limit',limit:2});
  assert.equal(f.state.writes.length,0);
 }
});
