import {createHash} from 'node:crypto';
import {appendFileSync, readFileSync, writeFileSync} from 'node:fs';
import {posix, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {REPOSITORY, REVIEW_BOT, gateKind, requireSha, trustedReview} from './pr-gate-protocol.mjs';
import {AFFECTED_PREFIX, affectedEntryPlan, affectedReceipt, hostedTuple, pinnedInputs, revisionPaths, revisionText, mergeAffectedCases, runSelectedCases} from './affected-entry-preflight.mjs';

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

const threadQuery='query($number:Int!,$cursor:String){repository(owner:"lizhonghao31-crypto",name:"dx-rework"){nameWithOwner pullRequest(number:$number){number headRefOid reviewThreads(first:100,after:$cursor){totalCount nodes{id isResolved comments(first:1){nodes{databaseId}}} pageInfo{hasNextPage endCursor}}}}}';
async function readThreads(api,plan){
  let cursor=null, total=null;
  const ids=new Set(), roots=new Map(), cursors=new Set();
  for(let page=1;page<=100;page++){
    const result=await api.request('/graphql',{method:'POST',body:{query:threadQuery,variables:{number:plan.pr,cursor}}});
    const repository=result.data?.repository, pr=repository?.pullRequest, t=pr?.reviewThreads;
    if(result.errors?.length||repository?.nameWithOwner?.toLowerCase()!==plan.repository||pr?.number!==plan.pr||pr?.headRefOid!==plan.head||
      !Array.isArray(t?.nodes)||!Number.isSafeInteger(t.totalCount)||t.totalCount<0||
      typeof t.pageInfo?.hasNextPage!=='boolean'||(total!==null&&t.totalCount!==total))throw Error('Cannot verify complete GraphQL Review threads on the exact Head');
    total=t.totalCount;
    for(const node of t.nodes){
      if(!node?.id||ids.has(node.id)||node.isResolved!==true)throw Error('Review has unreadable, duplicate or unresolved threads');
      const commentId=node.comments?.nodes?.[0]?.databaseId;
      if(!Number.isSafeInteger(commentId)||commentId<=0||roots.has(commentId))throw Error('Cannot bind Review finding to its resolved thread');
      ids.add(node.id);
      roots.set(commentId,node.id);
    }
    if(!t.pageInfo.hasNextPage){
      if(ids.size!==total)throw Error('GraphQL Review thread count differs');
      return {ids:[...ids].sort(),roots};
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

// Static, named canonical tests only. Use Git contents on the two exact
// revisions rather than a claim in PR text or a candidate-supplied case map.
// Other registration styles can use a named regression in the same suite.
const nativeSuite=/^tests\/integration\/[A-Za-z0-9-]+-postgres\.test\.ts$/;
const staticTest=/^([ \t]*)(?:it|test)\(\s*(['"])([^\r\n]{1,300}?)\2\s*,\s*(?:async\s*)?\([^\r\n]*?\)\s*=>\s*\{/;
const meaning=text=>text.split(/\r?\n/).map(line=>line.trim()).filter(line=>line&&!/^(?:\/\/|\/\*|\*|\*\/)/.test(line)).join('\n');
const safeReviewPath=path=>typeof path==='string'&&/^[A-Za-z0-9_.@/-]{1,400}$/.test(path)&&path.split('/').every(part=>part&&part!=='.'&&part!=='..');

function namedCases(text){
  const result=new Map(), lines=(text??'').split(/\r?\n/);
  for(let line=0;line<lines.length;line++){
    const match=staticTest.exec(lines[line]);
    if(!match)continue;
    const [,indent,quote,name]=match;
    if(!name.trim()||name.includes(quote)||name.includes('\\')||[...name].some(c=>c.codePointAt(0)<32))continue;
    let end=line+1;
    while(end<lines.length&&(!lines[end].trim()||lines[end].startsWith(indent)&&
      /^[ \t]/.test(lines[end].slice(indent.length))))end++;
    if(!/^}\s*(?:,[^;]*)?\)\s*;?\s*$/.test(lines[end]?.slice(indent.length)??''))continue;
    result.set(name,result.has(name)?null:meaning(lines.slice(line+1,end).join('\n')));
    line=end;
  }
  return result;
}

function directlyConsumes(testSource,file,reviewPath){
  return [...testSource.matchAll(/^\s*import\s+(?!type\b)[^;]*?\sfrom\s*(['"])(\.[^'"\r\n]+)\1/gm)].some(([, ,specifier])=>{
    const resolved=posix.normalize(posix.join(posix.dirname(file),specifier));
    const stem=resolved.replace(/\.(?:m?js|tsx?)$/,'');
    return reviewPath===resolved||['.ts','.tsx','.mjs'].some(ext=>reviewPath===stem+ext);
  });
}

async function evidenceCases(registry,item,earlier,head,changed,readText){
  const files=changed.filter(file=>nativeSuite.test(file));
  if(files.length>25)throw Error('REVIEW_PROOF_SCOPE_TOO_LARGE: finding '+item.id);
  const result=[];
  for(const file of files){
    const text=await readText(head,file);
    if(!text?.includes('TEST_DATABASE_URL')||!(directlyConsumes(text,file,item.path)||
      registry?.entries.some(entry=>entry.file===file&&entry.paths.includes(item.path))))continue;
    const previous=namedCases(await readText(earlier,file));
    for(const [name,body] of namedCases(text)){
      if(body&&body!==previous.get(name)){
        const pinned=registry?.entries.find(entry=>entry.file===file&&(entry.name===name||entry.name.endsWith(' '+name)));
        result.push(pinned?{id:pinned.id,file,name:pinned.name}:
          {id:'review-'+sha(JSON.stringify([file,name])).slice(0,24),file,name,leaf:true});
      }
    }
  }
  if(!result.length)throw Error('REVIEW_CASE_EVIDENCE_MISSING: finding '+item.id+' '+item.path);
  if(result.length>20)throw Error('REVIEW_PROOF_SCOPE_TOO_LARGE: finding '+item.id);
  return result.sort((a,b)=>a.id.localeCompare(b.id));
}

export const affectedCasesWithReview=(pinned,review)=>mergeAffectedCases(pinned,
  review?.findings.flatMap(item=>item.proofs??[])??[]);

/** Match real changed regression bodies to the repaired, reviewed code and
 * resolved GitHub finding. Closing a thread is not the execution proof. */
export async function readHostedReview(api,plan,registry,changedPaths,compare,readText){
  await verifyTuple(api,plan);
  const prPath=prefix+'/pulls/'+plan.pr;
  const [comments,reviews,inline,threads]=await Promise.all([
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
  const files=new Set(changedPaths), seen=new Set();
  const texts=new Map();
  const read=async(commit,file)=>{
    const key=commit+':'+file;
    if(!texts.has(key))texts.set(key,Promise.resolve().then(()=>readText(commit,file)));
    return texts.get(key);
  };
  const findings=[];
  for(const item of inline.filter(knownFinding).sort((a,b)=>a.id-b.id)){
    if(!Number.isSafeInteger(item.id)||item.id<=0||seen.has(item.id))throw Error('Duplicate or unreadable GitHub Review finding');
    seen.add(item.id);
    const threadId=threads.roots.get(item.id);
    if(!threadId||!safeReviewPath(item.path))throw Error('Cannot bind Review finding to its resolved thread: '+item.id);
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
    const actual=(await after(submission.commit_id)).filter(path=>files.has(path));
    if(!actual.includes(item.path)||meaning((await read(submission.commit_id,item.path))??'')===meaning((await read(plan.head,item.path))??''))
      throw Error('REVIEW_FIX_NOT_ON_HEAD: finding '+item.id+' '+item.path);
    const proofs=await evidenceCases(registry,item,submission.commit_id,plan.head,actual,read);
    findings.push({id:item.id,path:item.path,digest,reviewedHead:submission.commit_id,threadId,cases:proofs.map(test=>test.id),proofs});
  }
  // Even a fix submitted after round two does not need a new bot summary.
  // The recorded reviewed revision, actual fix and same-run
  // named passing tests supply the evidence for its descendant.
  await verifyTuple(api,plan);
  return {reviewedHead:review.commit_sha,reviewCommentId:review.commentId,threadIds:threads.ids,findings};
}

export const reviewDigest = review => sha(JSON.stringify(review));

export function hostedPlan(plan,run,review,selected){
  const {repository,pr,head,base,baseRef,kind}=plan;
  return {version:1,repository,pr,head,base,baseRef,kind,runId:run.id,attempt:run.run_attempt,review,selected};
}

export function readPlannedReview(raw,expectedDigest,plan,run,selected){
  if(!/^[0-9a-f]{64}$/.test(expectedDigest??'')||sha(raw)!==expectedDigest)throw Error('Missing or changed pre-test hosted Review plan');
  const result=JSON.parse(raw);
  const expected=hostedPlan(plan,run,result.review,affectedCasesWithReview(selected,result.review));
  if(!result.review||JSON.stringify(result)!==JSON.stringify(expected))throw Error('Hosted Review plan belongs to another tuple or selected cases');
  return result.review;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const {plan,run}=hostedTuple();
  const {registry,paths}=pinnedInputs(plan.base,plan.head);
  const selected=affectedEntryPlan(registry,paths);
  const planned=resolve(process.env.RUNNER_TEMP,'dx-hosted-review-plan.json');
  if(process.argv[2]==='authorize'){
    const review=await readHostedReview(readOnlyReviewApi(process.env.REVIEW_READ_TOKEN),plan,registry,paths,revisionPaths,revisionText);
    const cases=affectedCasesWithReview(selected,review);
    const raw=JSON.stringify(hostedPlan(plan,run,review,cases));
    writeFileSync(planned,raw,{flag:'wx',mode:0o600});
    appendFileSync(process.env.GITHUB_OUTPUT,'required='+String(cases.length>0)+'\nplan_sha256='+sha(raw)+'\n');
    console.log('Frozen hosted Review '+review.reviewedHead+'; verified findings: '+review.findings.map(f=>f.id).join(',')+'; affected cases: '+cases.map(t=>t.id).join(','));
  }else if(process.argv[2]==='verify'){
    const review=readPlannedReview(readFileSync(planned),process.env.HOSTED_REVIEW_PLAN_SHA256,plan,run,selected);
    const cases=affectedCasesWithReview(selected,review);
    const hash=cases.length?runSelectedCases(cases,resolve(process.env.RUNNER_TEMP,'dx-affected-entry.json')):null;
    console.log(AFFECTED_PREFIX+JSON.stringify(affectedReceipt(plan,run,cases,hash,reviewDigest(review))));
  }else throw Error('Expected hosted Review authorize or verify');
}
