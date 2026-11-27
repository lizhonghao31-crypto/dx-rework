import {createHash} from 'node:crypto';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {REPOSITORY, REVIEW_BOT, gateKind, requireSha, trustedReview} from './pr-gate-protocol.mjs';
import {AFFECTED_PREFIX, affectedEntryPlan, affectedReceipt, hostedTuple, pinnedInputs, revisionPaths, runSelectedCases} from './affected-entry-preflight.mjs';

export const HOSTED_REVIEW_POLICY = 'scripts/ci/hosted-review-preflight.mjs';
const prefix = '/repos/' + REPOSITORY;
const sha = text => createHash('sha256').update(text).digest('hex');
const normalized = text => text.replaceAll('\r\n','\n').trim();
const knownFinding = c => c.user?.login===REVIEW_BOT && !c.in_reply_to_id &&
  /codex-code-review-finding:v1|\bP[0-3]\b/.test(c.body ?? '');
export const findingDigest = comment => sha(normalized(comment.body));

/** Hosted GitHub identity only. The caller passes the token to this step, not
 * to package build, Chromium, tests, or any candidate-supplied command. */
export function readOnlyReviewApi(token, fetcher = fetch) {
  if (!token) throw Error('Missing existing hosted GitHub read identity');
  const request = async (path, {method='GET',body}={}) => {
    if (method==='GET' ? !path.startsWith(prefix+'/') :
      !(method==='POST' && path==='/graphql' && /^query\b/.test(body?.query ?? ''))) throw Error('Unexpected hosted Review read');
    const result=await fetcher('https://api.github.com'+path,{method,redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json'},
      ...(body?{body:JSON.stringify(body)}:{})});
    if (!result.ok) throw Error('Hosted Review read failed (HTTP '+result.status+') for '+path.split('?')[0]);
    return result.json();
  };
  const pages=async path=>{
    const rows=[];
    for(let page=1;page<=100;page++){
      const batch=await request(path+'?per_page=100&page='+page);
      if(!Array.isArray(batch)||batch.length>100)throw Error('Invalid paginated GitHub Review result');
      rows.push(...batch);
      if(batch.length<100)return rows;
    }
    throw Error('GitHub Review limit exceeded; cannot verify complete evidence');
  };
  return {request,pages};
}

const threadQuery='query($number:Int!,$cursor:String){repository(owner:"lizhonghao31-crypto",name:"dx-rework"){nameWithOwner pullRequest(number:$number){number headRefOid reviewThreads(first:100,after:$cursor){totalCount nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}';
async function readThreads(api,plan){
  let cursor=null, total=null;
  const ids=new Set(), cursors=new Set();
  for(let page=1;page<=100;page++){
    const result=await api.request('/graphql',{method:'POST',body:{query:threadQuery,variables:{number:plan.pr,cursor}}});
    const repository=result.data?.repository, pr=repository?.pullRequest, t=pr?.reviewThreads;
    if(result.errors?.length||repository?.nameWithOwner?.toLowerCase()!==plan.repository||pr?.number!==plan.pr||pr?.headRefOid!==plan.head||
      !Array.isArray(t?.nodes)||!Number.isSafeInteger(t.totalCount)||t.totalCount<0||
      typeof t.pageInfo?.hasNextPage!=='boolean'||(total!==null&&t.totalCount!==total))throw Error('Cannot verify complete GraphQL Review threads on the exact Head');
    total=t.totalCount;
    for(const node of t.nodes){
      if(!node?.id||ids.has(node.id)||node.isResolved!==true)throw Error('Review has unreadable, duplicate or unresolved threads');
      ids.add(node.id);
    }
    if(!t.pageInfo.hasNextPage){
      if(ids.size!==total)throw Error('GraphQL Review thread count differs');
      return [...ids].sort();
    }
    cursor=t.pageInfo.endCursor;
    if(!cursor||cursors.has(cursor))throw Error('Review thread cursor did not advance');
    cursors.add(cursor);
  }
  throw Error('Review thread pagination exceeded the bounded read');
}

async function verifyTuple(api,plan){
  const [pr,base]=await Promise.all([api.request(prefix+'/pulls/'+plan.pr),
    api.request(prefix+'/branches/'+encodeURIComponent(plan.baseRef))]);
  if(pr.number!==plan.pr||pr.state!=='open'||gateKind(pr.title)!=='full'||pr.head?.sha!==plan.head||
    pr.base?.repo?.full_name?.toLowerCase()!==plan.repository||pr.base.ref!==plan.baseRef||
    base.commit?.sha!==plan.base)throw Error('Hosted Review PR/Head/Base tuple moved or is not Full');
}

function bindings(registry){
  const all=registry ? affectedEntryPlan(registry, registry.entries.flatMap(entry=>entry.paths)) : [];
  const allIds=new Set(all.map(c=>c.id));
  const map=new Map();
  const data=registry?.reviewBindings??[];
  if(!Array.isArray(data))throw Error('Invalid pinned Review coverage');
  for(const item of data){
    const key=item?.path+'\0'+item?.findingSha256;
    if(typeof item?.path!=='string'||!item.path||!/^[0-9a-f]{64}$/.test(item.findingSha256??'')||
      !Array.isArray(item.repairPaths)||!item.repairPaths.length||
      item.repairPaths.some(path=>typeof path!=='string'||!path||path.startsWith('/')||path.split('/').some(p=>!p||p==='.'||p==='..'))||
      !Array.isArray(item.caseIds)||!item.caseIds.length||
      new Set(item.caseIds).size!==item.caseIds.length||item.caseIds.some(id=>!allIds.has(id))||
      map.has(key))throw Error('Invalid pinned Review coverage for '+item?.path);
    map.set(key,item);
  }
  return map;
}

/** Map authentic exact findings, not a PR author's test list. A path alone is
 * not proof that a test addresses the specific issue reported on that path. */
export async function readHostedReview(api,plan,registry,changedPaths,compare){
  await verifyTuple(api,plan);
  const prPath=prefix+'/pulls/'+plan.pr;
  const [comments,reviews,inline,threadIds]=await Promise.all([
    api.pages(prefix+'/issues/'+plan.pr+'/comments'),api.pages(prPath+'/reviews'),
    api.pages(prPath+'/comments'),readThreads(api,plan)
  ]);
  const review=trustedReview(comments);
  if(review?.status!=='completed'||!Number.isSafeInteger(review.commentId)||review.commentId<=0)throw Error('Independent Review has no completed code conclusion');
  const comparisons=new Map();
  const after=async (head,descendant=plan.head)=>{
    requireSha(head);
    if(head===descendant)return [];
    const key=head+':'+descendant;
    if(!comparisons.has(key))comparisons.set(key,compare(head,descendant));
    return comparisons.get(key);
  };
  await after(review.commit_sha);
  const policy=bindings(registry);
  const selected=affectedEntryPlan(registry,changedPaths);
  const selectedIds=new Set(selected.map(entry=>entry.id)), seen=new Set();
  const findings=[];
  for(const item of inline.filter(knownFinding).sort((a,b)=>a.id-b.id)){
    if(!Number.isSafeInteger(item.id)||item.id<=0||seen.has(item.id))throw Error('Duplicate or unreadable GitHub Review finding');
    seen.add(item.id);
    const submission=reviews.find(r=>r.id===item.pull_request_review_id&&r.user?.login===REVIEW_BOT);
    if(!submission||submission.commit_id!==(item.original_commit_id??item.commit_id)||submission.state==='PENDING')throw Error('Review finding original submission cannot be confirmed: '+item.id);
    const digest=findingDigest(item);
    // A previous-round finding may already have had its changed source
    // independently reviewed. A resolved flag or an unrelated newer review
    // cannot provide that evidence, and never waives the latest findings.
    if(submission.commit_id!==review.commit_sha){
      const subsequentlyReviewed=await after(submission.commit_id,review.commit_sha);
      if(subsequentlyReviewed.includes(item.path)){
        findings.push({id:item.id,path:item.path,digest,reviewedHead:submission.commit_id,
          independentlyReviewedAt:review.commit_sha,cases:[]});
        continue;
      }
    }
    const binding=policy.get(item.path+'\0'+digest);
    if(!binding)throw Error('REVIEW_CASE_MAPPING_MISSING: finding '+item.id+' '+item.path+' sha256='+digest);
    const actual=new Set(await after(submission.commit_id));
    if(!binding.repairPaths.some(path=>actual.has(path)))throw Error('REVIEW_FIX_NOT_ON_HEAD: finding '+item.id+' '+item.path);
    if(binding.caseIds.some(id=>!selectedIds.has(id)))throw Error('REVIEW_CASE_NOT_APPLICABLE_ON_FROZEN_DIFF: finding '+item.id);
    findings.push({id:item.id,path:item.path,digest,reviewedHead:submission.commit_id,cases:[...binding.caseIds].sort()});
  }
  // Even a fix submitted after round two does not need a new bot summary.
  // The recorded reviewed revision, trusted mapping, actual fix and same-run
  // named passing tests supply the evidence for its descendant.
  await verifyTuple(api,plan);
  return {reviewedHead:review.commit_sha,reviewCommentId:review.commentId,threadIds,findings};
}

export const reviewDigest = review => sha(JSON.stringify(review));

export function hostedPlan(plan,run,review,selected){
  const {repository,pr,head,base,baseRef,kind}=plan;
  return {version:1,repository,pr,head,base,baseRef,kind,runId:run.id,attempt:run.run_attempt,review,selected};
}

export function readPlannedReview(raw,expectedDigest,plan,run,selected){
  if(!/^[0-9a-f]{64}$/.test(expectedDigest??'')||sha(raw)!==expectedDigest)throw Error('Missing or changed pre-test hosted Review plan');
  const result=JSON.parse(raw);
  const expected=hostedPlan(plan,run,result.review,selected);
  if(!result.review||JSON.stringify(result)!==JSON.stringify(expected))throw Error('Hosted Review plan belongs to another tuple or selected cases');
  return result.review;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {plan,run}=hostedTuple();
  const {registry,paths}=pinnedInputs(plan.base,plan.head);
  const selected=affectedEntryPlan(registry,paths);
  const planned=resolve(process.env.RUNNER_TEMP,'dx-hosted-review-plan.json');
  if(process.argv[2]==='authorize'){
    const review=await readHostedReview(readOnlyReviewApi(process.env.REVIEW_READ_TOKEN),plan,registry,paths,revisionPaths);
    const raw=JSON.stringify(hostedPlan(plan,run,review,selected));
    writeFileSync(planned,raw,{flag:'wx',mode:0o600});
    appendFileSync(process.env.GITHUB_OUTPUT,'required='+String(selected.length>0)+'\nplan_sha256='+sha(raw)+'\n');
    console.log('Frozen hosted Review '+review.reviewedHead+'; mapped findings: '+review.findings.map(f=>f.id).join(',')+'; affected cases: '+selected.map(t=>t.id).join(','));
  }else if(process.argv[2]==='verify'){
    const review=readPlannedReview(readFileSync(planned),process.env.HOSTED_REVIEW_PLAN_SHA256,plan,run,selected);
    const hash=selected.length?runSelectedCases(selected,resolve(process.env.RUNNER_TEMP,'dx-affected-entry.json')):null;
    console.log(AFFECTED_PREFIX+JSON.stringify(affectedReceipt(plan,run,selected,hash,reviewDigest(review))));
  }else throw Error('Expected hosted Review authorize or verify');
}
