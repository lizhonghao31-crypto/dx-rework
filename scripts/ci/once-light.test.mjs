import assert from 'node:assert/strict';
import {test,after} from 'node:test';
import {GitHubError,requestFinal as guardedRequestFinal,verifyMerge} from './pr-gate-controller.mjs';
import {closeoutFixture,disposeCloseoutFixtures} from './final-closeout.fixture.mjs';
import {REPOSITORY,REVIEW_BOT,FINAL_CHECK,LIGHT_CHECK,finalRef,RECEIPT_PREFIX} from './pr-gate-protocol.mjs';
after(disposeCloseoutFixtures);
const closeouts=new WeakMap();
const requestFinal=(api,number,head,options={})=>guardedRequestFinal(api,number,head,{closeoutPath:closeouts.get(api)?.path,...options});
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
  if(path.includes('/jobs'))return structuredClone(state.jobs[Number(path.match(/runs\/(\d+)/)[1])]??[]);
  if(key==='workflow_runs')return structuredClone(path.includes('event=create')?state.runs.final:state.runs.light);
  throw new Error(`Unexpected pages ${path}`);
 },request:async(path,{method='GET',body}={})=>{
  if(method==='GET')state.reads.push(path);else state.writes.push({path,method,body});
  if(path==='/graphql')return {data:{repository:{pullRequest:{reviewThreads:{nodes:state.threads,pageInfo:{hasNextPage:false}}}}}};
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
