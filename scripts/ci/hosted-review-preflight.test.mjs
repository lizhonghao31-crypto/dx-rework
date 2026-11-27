import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {REPOSITORY, REVIEW_BOT} from './pr-gate-protocol.mjs';
import {AFFECTED_PREFIX, affectedEntryPlan, affectedReceipt, parseAffectedReceipt, requireAffectedCases} from './affected-entry-preflight.mjs';
import {affectedCasesWithReview, hostedPlan, readHostedReview, readOnlyReviewApi, readPlannedReview, reviewDigest} from './hosted-review-preflight.mjs';

const head='a'.repeat(40),base='b'.repeat(40),first='c'.repeat(40),second='d'.repeat(40);
const plan={repository:REPOSITORY,pr:901,head,base,baseRef:'release/digital-production-v1',kind:'full'};
const create='apps/web/src/digital-development-create-form.tsx',unrelated='apps/api/src/receiving/receiving-service.ts';
const repair='apps/api/src/production-platform/production-readiness-service.ts';
const suite='tests/integration/production-readiness-postgres.test.ts';
const leaf='revokes an original receipt link after its purchasing scope changes';
const declared=(title,body)=>[" it('"+title+"',async()=>{",...body," });"].join('\n');
const preamble=[
 "import {service} from '../../apps/api/src/production-platform/production-readiness-service.js';",
 "const url=process.env.TEST_DATABASE_URL;",
 "(url?describe:describe.skip)('original production lifecycle',()=>{",
 declared('existing different case',["  expect(await service.read()).toBe('other');"]),
];
const previousTest=[...preamble,declared(leaf,["  expect(await service.original()).toBe('record');"]),'});'].join('\n');
const fixedTest=[...preamble,declared(leaf,["  await service.correctPurchase({po:'new'});","  expect(await service.revokeOriginal()).toBe('revoked');"]),'});'].join('\n');
const registry=JSON.parse(readFileSync(new URL('./affected-entry-map.json',import.meta.url)));
const bot={login:REVIEW_BOT};
const summary=(commit=second,status='completed',user=bot)=>({id:42,user,updated_at:'2026-11-27T10:00:00Z',
 body:'<!-- codex-review-state:v1 '+JSON.stringify({code_review:{status,commit_sha:commit}})+' -->'});
const finding=(id,commit,path)=>({id,path,body:'P1 Original entry '+id+'\n<!-- codex-code-review-finding:v1 -->',
 original_commit_id:commit,commit_id:commit,pull_request_review_id:100+id,user:bot});
const approval=f=>({id:f.pull_request_review_id,commit_id:f.original_commit_id,state:'COMMENTED',user:bot});
const firstFinding=finding(23,first,create),secondFinding=finding(24,second,repair);
const thread=(id,databaseId,isResolved=true)=>({id,isResolved,comments:{nodes:[{databaseId}]}});
const sha=text=>createHash('sha256').update(text).digest('hex');

function fixture(){
  const state={before:[repair,suite],earlierBefore:[create],comments:[summary()],findings:[firstFinding,secondFinding],
    reviews:[approval(firstFinding),approval(secondFinding)],requestReads:0,baseReads:0,
    reviewCalls:[],comparisons:[],threads:[thread('r1',23),thread('r2',24)]};
  const api={
    request:async(path,options)=>{
      if(path==='/graphql'){
        assert.equal(options.method,'POST');
        const {number,cursor}=options.body.variables;
        assert.equal(number,901);
        state.reviewCalls.push(cursor);
        const nodes=cursor==='next'?[state.threads[1]]:state.threads.slice(0,state.threads.length===2?1:state.threads.length);
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
  const compare=async(a,b)=>{assert.ok(b===head||b===second);state.comparisons.push([a,b]);if(state.diverged===a)throw Error('non-ancestor');
    return b===second?state.earlierBefore:state.before;};
  const readText=async(commit,file)=>{
    if(file===suite)return commit===head?(state.fixedTest??fixedTest):(state.previousTest??previousTest);
    if(file===repair||file===create)return commit===head?(state.fixedSource??'return updatedOriginal();'):'return original();';
    return null;
  };
  return {state,api,authorize:(map=registry)=>readHostedReview(api,plan,map,compare,readText)};
}

test('second-round new finding closes on changed source and exact test without prior Base mapping',async()=>{
  const f=fixture(),verified=await f.authorize();
  assert.deepEqual(f.state.reviewCalls,[null,'next']);
  assert.deepEqual(f.state.comparisons,[[second,head],[first,second]]);
  assert.equal(f.state.requestReads,2);
  assert.equal(verified.reviewedHead,second);
  assert.deepEqual(verified.findings.map(v=>v.id),[23,24]);
  assert.equal(verified.findings[0].independentlyReviewedAt,second);
  assert.deepEqual(verified.findings[1].proofs.map(({file,name})=>[file,name]),[[suite,leaf]]);
  assert.equal(verified.findings[1].threadId,'r2');
  const pinned=affectedEntryPlan(registry,[repair,suite]),run={id:1001,run_attempt:2};
  const selected=affectedCasesWithReview(pinned,verified);
  const raw=JSON.stringify(hostedPlan(plan,run,verified,selected));
  const bound=readPlannedReview(raw,sha(raw),plan,run,pinned);
  const actual=selected.map(x=>({...x,name:'original production lifecycle '+x.name,status:'passed'}));
  assert.doesNotThrow(()=>requireAffectedCases(selected,actual));
  const receipt=affectedReceipt(plan,run,selected,'e'.repeat(64),reviewDigest(bound));
  assert.deepEqual(parseAffectedReceipt(AFFECTED_PREFIX+JSON.stringify(receipt),plan,run,selected,reviewDigest(verified)),receipt);
  for(const patch of [{reviewSha256:null},{reviewSha256:'1'.repeat(64)},{attempt:1},{head:second},{base:first},{pr:42},{runId:12}]){
    assert.throws(()=>parseAffectedReceipt(AFFECTED_PREFIX+JSON.stringify({...receipt,...patch}),plan,run,selected,reviewDigest(verified)),/stale/);
  }
  assert.throws(()=>readPlannedReview(raw+' ',sha(raw),plan,run,pinned),/changed pre-test/);
  assert.throws(()=>requireAffectedCases(selected,[]),/AFFECTED_ENTRY_PROOF_MISSING/);
  for(const status of ['skipped','failed'])assert.throws(()=>requireAffectedCases(selected,actual.map(x=>({...x,status}))),/AFFECTED_ENTRY_PROOF_MISSING/);
  assert.throws(()=>requireAffectedCases(selected,[...actual,...actual]),/AFFECTED_ENTRY_PROOF_MISSING/);
});

test('an already re-reviewed changed file preserves the earlier Review without requesting another round',async()=>{
  const f=fixture();f.state.findings=[firstFinding];
  const checked=await f.authorize(null);
  assert.equal(checked.findings[0].independentlyReviewedAt,second);
  f.state.earlierBefore=[unrelated];
  await assert.rejects(f.authorize(null),/REVIEW_FIX_NOT_ON_HEAD: finding 23/);
});

test('missing, running or self-reported Review cannot authorize preparation',async()=>{
  for(const comments of [[],[summary(second,'running')],[summary(second,'completed',{login:'author'})]]){
    const f=fixture();f.state.comments=comments;
    await assert.rejects(f.authorize(),/no completed code conclusion/);
  }
});
test('closing a thread, self-reporting passing tests, or a comment-only edit do not replace the actual repair',async()=>{
  const f=fixture();f.state.findings=[{...secondFinding,testNames:[leaf],resolution:'passed'}];
  f.state.fixedTest=previousTest;
  await assert.rejects(f.authorize(),/REVIEW_CASE_EVIDENCE_MISSING: finding 24/);
  f.state.before=[suite,unrelated];
  await assert.rejects(f.authorize(),/REVIEW_FIX_NOT_ON_HEAD: finding 24/);
  f.state.before=[repair,suite];f.state.fixedSource='// merely resolved\nreturn original();';
  await assert.rejects(f.authorize(),/REVIEW_FIX_NOT_ON_HEAD: finding 24/);
});

test('a genuine named newly added regression needs no case-specific registration',async()=>{
  const f=fixture();f.state.previousTest=[...preamble,'});'].join('\n');
  const checked=await f.authorize();
  assert.deepEqual(affectedCasesWithReview([],checked).map(v=>v.name),[leaf]);
});
test('an unrelated, duplicate or missing test and mismatched actual Review fail closed',async()=>{
  const f=fixture();f.state.findings=[secondFinding];
  f.state.fixedTest=fixedTest.replace('production-readiness-service.js','unrelated.js');
  await assert.rejects(f.authorize(),/REVIEW_CASE_EVIDENCE_MISSING/);
  f.state.fixedTest=fixedTest+'\n'+declared(leaf,['  expect(true).toBe(true);']);
  await assert.rejects(f.authorize(),/REVIEW_CASE_EVIDENCE_MISSING/);
  f.state.fixedTest=fixedTest;f.state.findings=[{...secondFinding,id:99}];
  await assert.rejects(f.authorize(),/to its resolved thread: 99/);
  f.state.findings=[secondFinding];f.state.reviews=[];
  await assert.rejects(f.authorize(),/original submission cannot be confirmed/);
});

test('commented, quoted, type-only and dynamic import text cannot prove a runtime dependency',async()=>{
  const f=fixture(), original=preamble[0],spec=original.split("'")[1];
  for(const decoy of [
    '// disabled import\n/*\n'+original+'\n*/',
    'const decoy=String.raw\x60\n'+original+'\n\x60;',
    "import type {service} from '"+spec+"';",
    "import {type service} from '"+spec+"';",
    "const service=await import('"+spec+"');",
  ]){
    f.state.fixedTest=fixedTest.replace(original,decoy);
    await assert.rejects(f.authorize(),/REVIEW_CASE_EVIDENCE_MISSING/);
  }
  f.state.fixedTest=fixedTest.replace(original,"/* leading notes */\nimport {type Example, service} from '"+spec+"';");
  assert.equal((await f.authorize()).findings[1].proofs[0].name,leaf);
});
test('a repair reverting a source file to Base is still evidence from the reviewed tree',async()=>{
  const f=fixture();
  // Only the test remains different from Base. The actual reviewed commit
  // temporarily contained the issue in the repaired source file.
  const pinned=affectedEntryPlan(registry,[suite]);
  assert.deepEqual(pinned,[]);
  const checked=await f.authorize();
  assert.deepEqual(affectedCasesWithReview(pinned,checked).map(t=>t.name),[leaf]);
});

test('actual Review threads, exact live tuple and reviewed-commit lineage fail closed',async()=>{
  for(const [patch,error] of [
    [{threads:[thread('r1',23),thread('r2',24,false)]},/unresolved threads/],
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
test('unrelated PR gets completed Review but no original creation or additional Review cases',async()=>{
  const f=fixture();
  Object.assign(f.state,{findings:[],reviews:[],comments:[summary(head)],threads:[]});
  const checked=await f.authorize(registry);
  assert.deepEqual(checked.findings,[]);
  const selected=affectedCasesWithReview(affectedEntryPlan(registry,[unrelated]),checked);
  assert.deepEqual(selected,[]);
  assert.equal(affectedReceipt(plan,{id:1001,run_attempt:1},selected,null,reviewDigest(checked)).reportSha256,null);
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
