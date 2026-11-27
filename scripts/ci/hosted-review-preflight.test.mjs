import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {REPOSITORY, REVIEW_BOT} from './pr-gate-protocol.mjs';
import {AFFECTED_PREFIX, affectedEntryPlan, affectedReceipt, parseAffectedReceipt, requireAffectedCases} from './affected-entry-preflight.mjs';
import {findingDigest, hostedPlan, readHostedReview, readOnlyReviewApi, readPlannedReview, reviewDigest} from './hosted-review-preflight.mjs';

const head='a'.repeat(40),base='b'.repeat(40),first='c'.repeat(40),second='d'.repeat(40);
const plan={repository:REPOSITORY,pr:901,head,base,baseRef:'release/digital-production-v1',kind:'full'};
const create='apps/web/src/digital-development-create-form.tsx',unrelated='apps/api/src/receiving/receiving-service.ts';
const stableMap=JSON.parse(readFileSync(new URL('./affected-entry-map.json',import.meta.url)));
const tokenUser={login:REVIEW_BOT};
const summary=(commit=second,status='completed',user=tokenUser)=>({id:42,user,updated_at:'2026-11-27T10:00:00Z',
 body:'<!-- codex-review-state:v1 '+JSON.stringify({code_review:{status,commit_sha:commit}})+' -->'});
const finding=(id,commit,path=create)=>({id,path,body:'P1 Original entry '+id+'\n<!-- codex-code-review-finding:v1 -->',
 original_commit_id:commit,commit_id:commit,pull_request_review_id:100+id,user:tokenUser});
const approval=(f)=>({id:f.pull_request_review_id,commit_id:f.original_commit_id,state:'COMMENTED',user:tokenUser});
const firstFinding=finding(23,first),secondFinding=finding(24,second);
const mapping=(f,caseId)=>({path:f.path,findingSha256:findingDigest(f),repairPaths:[f.path],caseIds:[caseId]});
const registry=()=>({...stableMap,reviewBindings:[mapping(firstFinding,'original-fixed-timeline-creation'),mapping(secondFinding,'original-preorder-conversion')]});
const sha=text=>createHash('sha256').update(text).digest('hex');

function fixture(){
  const state={before:[create],comments:[summary()],findings:[firstFinding,secondFinding],reviews:[approval(firstFinding),approval(secondFinding)],
    requestReads:0,baseReads:0,reviewCalls:[],comparisons:[],threads:[{id:'r1',isResolved:true},{id:'r2',isResolved:true}]};
  const api={
    request:async(path,options)=>{
      if(path==='/graphql'){
        assert.equal(options.method,'POST');
        const {number,cursor}=options.body.variables;
        assert.equal(number,901);
        state.reviewCalls.push(cursor);
        const nodes=cursor==='next'?[state.threads[1]]:state.threads.slice(0,state.threads.length===2?1:0);
        const hasNextPage=state.threads.length===2&&cursor===null;
        return{data:{repository:{nameWithOwner:REPOSITORY,pullRequest:{number:901,headRefOid:state.graphHead??head,
          reviewThreads:{totalCount:state.threadCount??state.threads.length,nodes,pageInfo:{hasNextPage,endCursor:hasNextPage?'next':null}}}}}};
      }
      if(path.endsWith('/pulls/901')){state.requestReads++;return{number:901,state:state.closed?'closed':'open',title:state.title??'[FULL] exact',
        head:{sha:head},base:{ref:plan.baseRef,repo:{full_name:REPOSITORY}}};}
      if(path.includes('/branches/')){state.baseReads++;return{commit:{sha:state.moveBase?'e'.repeat(40):base}};}
      throw Error('Unexpected fixture read '+path);
    },
    pages:async path=>{
      if(path.includes('/issues/'))return state.comments;
      if(path.endsWith('/reviews'))return state.reviews;
      if(path.endsWith('/comments'))return state.findings;
      throw Error('Unexpected fixture pages '+path);
    }
  };
  const compare=async(a,b)=>{assert.equal(b,head);state.comparisons.push(a);if(state.diverged===a)throw Error('non-ancestor');
    return state.before;};
  return {state,api,authorize:(map=registry(),paths=[create])=>readHostedReview(api,plan,map,paths,compare)};
}

test('second Review findings can close on a real descendant without a third Review or updated bot summary',async()=>{
  const f=fixture(), verified=await f.authorize();
  assert.deepEqual(f.state.reviewCalls,[null,'next']);
  assert.deepEqual(f.state.comparisons,[second,first]);
  assert.equal(f.state.requestReads,2);
  assert.equal(verified.reviewedHead,second);
  assert.deepEqual(verified.findings.map(v=>[v.id,...v.cases]),[[23,'original-fixed-timeline-creation'],[24,'original-preorder-conversion']]);
  const selected=affectedEntryPlan(registry(),[create]),run={id:1001,run_attempt:2};
  const raw=JSON.stringify(hostedPlan(plan,run,verified,selected));
  const bound=readPlannedReview(raw,sha(raw),plan,run,selected);
  const actual=selected.map(x=>({...x,status:'passed'}));
  assert.doesNotThrow(()=>requireAffectedCases(selected,actual));
  const receipt=affectedReceipt(plan,run,selected,'e'.repeat(64),reviewDigest(bound));
  assert.deepEqual(parseAffectedReceipt(AFFECTED_PREFIX+JSON.stringify(receipt),plan,run,selected,reviewDigest(verified)),receipt);
  for(const patch of [{reviewSha256:null},{reviewSha256:'1'.repeat(64)},{attempt:1},{head:second}]){
    const bad=AFFECTED_PREFIX+JSON.stringify({...receipt,...patch});
    assert.throws(()=>parseAffectedReceipt(bad,plan,run,selected,reviewDigest(verified)),/stale/);
  }
  assert.throws(()=>readPlannedReview(raw+' ',sha(raw),plan,run,selected),/changed pre-test/);
  assert.throws(()=>requireAffectedCases(selected,actual.filter(x=>x.id!=='original-preorder-conversion')),/original-preorder-conversion/);
  assert.throws(()=>requireAffectedCases(selected,actual.map(x=>x.id==='original-preorder-conversion'?{...x,status:'skipped'}:x)),/original-preorder-conversion/);
});

test('missing, running, or self-reported Review cannot authorize preparation',async()=>{
  for(const comments of [[],[summary(second,'running')],[summary(second,'completed',{login:'author'})]]){
    const f=fixture();f.state.comments=comments;
    await assert.rejects(f.authorize(),/no completed code conclusion/);
  }
});
test('resolved alone and an authors matching claim are not trusted bindings or evidence',async()=>{
  const f=fixture();
  f.state.findings=[{...secondFinding,testNames:['original-preorder-conversion'],resolution:'passed'}];
  await assert.rejects(f.authorize(stableMap),/REVIEW_CASE_MAPPING_MISSING: finding 24/);
  await assert.rejects(f.authorize(null),/REVIEW_CASE_MAPPING_MISSING: finding 24/);
  f.state.before=[unrelated];
  await assert.rejects(f.authorize(),/REVIEW_FIX_NOT_ON_HEAD: finding 24/);
});
test('actual fix plus unrelated case coverage and altered issued finding still fail',async()=>{
  const f=fixture();
  await assert.rejects(f.authorize(registry(),[unrelated]),/REVIEW_CASE_NOT_APPLICABLE_ON_FROZEN_DIFF/);
  f.state.findings=[{...secondFinding,body:secondFinding.body+' body changed'}];
  await assert.rejects(f.authorize(),/REVIEW_CASE_MAPPING_MISSING: finding 24/);
  f.state.findings=[secondFinding];f.state.reviews=[];
  await assert.rejects(f.authorize(),/original submission cannot be confirmed/);
});
test('actual review threads, exact live tuple and reviewed-commit lineage fail closed',async()=>{
  for(const [patch,error] of [
    [{threads:[{id:'r1',isResolved:true},{id:'r2',isResolved:false}]},/unresolved threads/],
    [{threadCount:3},/thread count differs/],
    [{graphHead:second},/exact Head/],
    [{moveBase:true},/tuple moved/],
    [{title:'[QUICK] changed'},/tuple moved/],
    [{closed:true},/tuple moved/],
    [{diverged:second},/non-ancestor/],
  ]){
    const f=fixture();Object.assign(f.state,patch);
    await assert.rejects(f.authorize(),error);
  }
});
test('unrelated PR gets a real independent Review but none of the original numbered, fixed-timeline or preorder tests',async()=>{
  const f=fixture();
  Object.assign(f.state,{findings:[],reviews:[],comments:[summary(head)],threads:[]});
  const checked=await f.authorize(registry(),[unrelated]);
  assert.deepEqual(checked.findings,[]);
  assert.deepEqual(affectedEntryPlan(registry(),[unrelated]),[]);
  const run={id:1001,run_attempt:1};
  assert.equal(affectedReceipt(plan,run,[],null,reviewDigest(checked)).reportSha256,null);
});
test('hosted GitHub read client paginates REST and never allows mutation or other hosts',async()=>{
  const calls=[];
  const api=readOnlyReviewApi('fixture-not-a-credential',async(url,request)=>{
    calls.push([url,request.method,request.redirect]);
    const page=new URL(url).searchParams.get('page');
    return {ok:true,json:async()=>page==='1'?Array.from({length:100},(_,i)=>i):[100]};
  });
  const list=await api.pages('/repos/'+REPOSITORY+'/pulls/901/reviews');
  assert.equal(list.length,101);
  assert.deepEqual(calls.map(c=>c.slice(1)),[['GET','error'],['GET','error']]);
  await assert.rejects(api.request('/graphql',{method:'POST',body:{query:'mutation{anything}'}}),/Unexpected hosted Review read/);
  await assert.rejects(api.request('/repos/not/our-repo/pulls/901'),/Unexpected hosted Review read/);
});
