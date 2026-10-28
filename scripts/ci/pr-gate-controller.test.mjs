import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {checkTimeSiteInventory} from '../acceptance/time-site-inventory.mjs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {GitHub,GitHubError,decodeGitHubResponse,requestFinal,verifyMerge,reviewStep} from './pr-gate-controller.mjs';
import {REPOSITORY,REVIEW_BOT,FINAL_CHECK,LIGHT_CHECK,finalRef,RECEIPT_PREFIX} from './pr-gate-protocol.mjs';
const head='a'.repeat(40),base='b'.repeat(40),baseRef='release/digital-production-v1',prefix=`/repos/${REPOSITORY}`;
const plan={repository:REPOSITORY,pr:901,head,base,baseRef,kind:'full',phase:'final'};
const summary=(status='completed',commit_sha=head)=>({id:12,user:{login:REVIEW_BOT},updated_at:'2026-10-27T17:00:00Z',body:`<!-- codex-review-state:v1 ${JSON.stringify({code_review:{status,commit_sha}})} -->`});
const request={id:10,body:'@codex review',created_at:'2026-10-27T16:00:00Z'};
function fixture(){
 const state={pr:{state:'open',title:'[FULL] bounded change',head:{sha:head},base:{sha:base,ref:baseRef,repo:{full_name:REPOSITORY}}},comments:[request,summary()],threads:[],ref:null,writes:[],reads:[],runs:{light:[run(101,'light')],final:[]},jobs:{},logs:{}};
 function run(id,phase){return{id,run_attempt:1,head_sha:head,path:'.github/workflows/ci.yml',event:phase==='light'?'pull_request':'create',head_branch:finalRef(plan),status:'completed',conclusion:'success'};}
 function addProof(id,phase){const names=['title','checkout','head','policy',...(phase==='final'?['risk','install','audit','lint','types','build','tests','migration_lint','secrets']:[])];
  const receipt={version:1,...plan,phase,runId:id,attempt:1,jobStatus:'success',missing:[],checks:names.map(id=>({id,applicable:true,outcome:'success'}))};
  state.jobs[id]=[{id:id+100,run_id:id,name:phase==='light'?LIGHT_CHECK:FINAL_CHECK,status:'completed',conclusion:'success'}];
  state.logs[id+100]=RECEIPT_PREFIX+JSON.stringify(receipt);return receipt;
 }
 addProof(101,'light');
 const api={pr:async()=>structuredClone(state.pr),comments:async()=>structuredClone(state.comments),pages:async(path,key)=>{
  state.reads.push(path);
  if(path.includes('/jobs'))return structuredClone(state.jobs[Number(path.match(/runs\/(\d+)/)[1])]??[]);
  if(key==='workflow_runs')return structuredClone(path.includes('event=create')?state.runs.final:state.runs.light);
  throw new Error(`Unexpected pages ${path}`);
 },request:async(path,{method='GET',body}={})=>{
  if(method==='GET')state.reads.push(path);else state.writes.push({path,method,body});
  if(path==='/graphql')return {data:{repository:{pullRequest:{reviewThreads:{nodes:state.threads,pageInfo:{hasNextPage:false}}}}}};
  if(path.includes('/compare/'))return {status:'ahead',behind_by:0};
  if(path.includes('/logs'))return state.logs[Number(path.match(/jobs\/(\d+)/)[1])];
  if(path.includes('/git/ref/heads/')){if(!state.ref)throw new GitHubError(404,'Not Found');return structuredClone(state.ref);}
  if(path===`${prefix}/git/refs`){if(state.createError)throw state.createError;if(state.ref)throw new GitHubError(422,'Reference already exists');state.ref={ref:body.ref,object:{sha:body.sha}};return state.ref;}
  if(path.includes('/branches/'))return {name:baseRef,commit:{sha:state.actualBase??base},protected:false,protection:{required_status_checks:{enforcement_level:'off',contexts:[],checks:[]}}};
  if(path.endsWith('/comments')&&method==='POST'){if(state.postError)throw state.postError;await new Promise(r=>setTimeout(r,5));const c={...request,id:20,created_at:'2026-10-27T16:15:01Z'};state.comments.push(c);return c;}
  throw new Error(`Unexpected API ${method} ${path}`);
 }};
 return{state,api,addFinal(){state.runs.final=[run(102,'final')];return addProof(102,'final');}};
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
for(const fault of ['review','threads','head','light_skipped','light_old','final_skipped','final_old','final_running','final_failed','rewritten_ref','actual_base_moved'])test(`merge evidence fails closed for ${fault}`,async()=>{
 const{api,state,addFinal}=fixture();state.ref={ref:`refs/heads/${finalRef(plan)}`,object:{sha:head}};addFinal();
 if(fault==='actual_base_moved')state.actualBase='d'.repeat(40);
 if(fault==='review')state.comments=[request,summary('failed')];
 if(fault==='threads')state.threads=[{id:'r1',isResolved:false}];
 if(fault==='head')state.pr.head.sha='c'.repeat(40);
 if(fault==='light_skipped')state.jobs[101][0].conclusion='skipped';
 if(fault==='light_old')state.logs[201]=state.logs[201].replace(head,'c'.repeat(40));
 if(fault==='final_skipped')state.jobs[102][0].conclusion='skipped';
 if(fault==='final_old')state.runs.final[0].head_sha='c'.repeat(40);
 if(fault==='final_running')state.runs.final[0].status='in_progress';
 if(fault==='final_failed')state.runs.final[0].conclusion='failure';
 if(fault==='rewritten_ref')state.ref.object.sha='c'.repeat(40);
 await assert.rejects(()=>verifyMerge(api,901,head));assert.equal(state.writes.some(w=>w.path!=='/graphql'),false);
});
test('a newer failed light result cannot fall back to an older pass',async()=>{
 const{api,state}=fixture();state.runs.light.unshift({...state.runs.light[0],id:103,conclusion:'failure'});state.jobs[103]=[{...state.jobs[101][0],id:203,run_id:103,conclusion:'failure'}];
 await assert.rejects(()=>requestFinal(api,901,head,{apply:true}));assert.equal(state.ref,null);
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
