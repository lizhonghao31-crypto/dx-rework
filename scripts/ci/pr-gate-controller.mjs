import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {verifyFinalCloseout} from './final-closeout.mjs';
import {AFFECTED_MAP_PATH, affectedEntryPlan} from './full-gate-risk-map.mjs';
import {AFFECTED_JOB, parseAffectedReceipt} from './affected-entry-preflight.mjs';
import {HOSTED_REVIEW_POLICY, affectedCasesWithReview, readHostedReview, reviewDigest} from './hosted-review-preflight.mjs';
import {REPOSITORY, FINAL_CHECK, LIGHT_CHECK, REVIEW_BOT, gateKind, finalRef, requireSha,
  trustedReview, reviewDecision, parseReceipt, assertRunBinding, assertReuseLineage, allowedBase} from './pr-gate-protocol.mjs';

// Operator-side only. CI uses ci-gate-runtime.mjs and needs no API permission.
export class GitHubError extends Error {
  constructor(status, message) { super(`GitHub ${status}: ${message}`); this.status = status; }
}
export function decodeGitHubResponse(output) {
  const text = String(output).replace(/\r\n/g, '\n');
  const headers = [...text.matchAll(/^HTTP\/[\d.]+[ \t]+(\d{3})[^\n]*\n/gm)];
  const header = headers.at(-1);
  if (!header) throw new Error('GitHub CLI response status missing; outcome may be unknown');
  const end = text.indexOf('\n\n', header.index);
  if (end < 0) throw new Error('GitHub CLI response headers incomplete; outcome may be unknown');
  return {status: Number(header[1]), body: text.slice(end + 2)};
}
export class GitHub {
  constructor(token, fetcher) { this.token = token; this.fetcher = fetcher; }
  async request(path, {method = 'GET', body, raw = false} = {}) {
    if (!path.startsWith(`/repos/${REPOSITORY}/`) && path !== '/graphql') throw new Error('Unexpected API repository');
    if (process.env.GITHUB_ACTIONS === 'true' && method !== 'GET'
      && !(path === '/graphql' && /^query\b/.test(body?.query ?? ''))) throw new Error('Operator writes are not a CI permission');
    let response;
    if (this.fetcher) {
      response = await this.fetcher(`https://api.github.com${path}`, {method,
        headers: {authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28', ...(body ? {'content-type': 'application/json'} : {})},
        ...(body ? {body: JSON.stringify(body)} : {})});
    } else {
      // Reuse the installed operator connection and its proxy/auth handling.
      // No shell interpolation, token printing or dependency installation.
      const args = ['api', '--hostname', 'github.com', '--include', '--method', method,
        '-H', 'X-GitHub-Api-Version: 2022-11-28', ...(body ? ['--input', '-'] : []), path];
      let output;
      try {
        output = execFileSync('gh', args, {encoding: 'utf8', timeout: 30_000, maxBuffer: 32 * 1024 * 1024,
          input: body ? JSON.stringify(body) : undefined, stdio: ['pipe', 'pipe', 'pipe'],
          env: {...process.env, ...(this.token ? {GH_TOKEN: this.token} : {})}});
      } catch (error) {
        if (!error.stdout) throw new Error('GitHub CLI transport failed; operation outcome may be unknown');
        output = error.stdout;
      }
      const decoded = decodeGitHubResponse(output);
      response = {ok: decoded.status >= 200 && decoded.status < 300, status: decoded.status,
        text: async () => decoded.body};
    }
    const text = await response.text();
    if (!response.ok) {
      let message = 'request failed'; try { message = JSON.parse(text).message; } catch { /* No response payload in diagnostics. */ }
      throw new GitHubError(response.status, message);
    }
    return raw ? text : JSON.parse(text);
  }
  async pages(path, key) {
    const rows = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.request(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      const batch = key ? result[key] : result;
      if (!Array.isArray(batch)) throw new Error('Unexpected paginated API response');
      rows.push(...batch);
      if (batch.length < 100) return rows;
    }
    throw new Error('Pagination exceeded the supported bounded read');
  }
  pr(number) { return this.request(`/repos/${REPOSITORY}/pulls/${number}`); }
  comments(number) { return this.pages(`/repos/${REPOSITORY}/issues/${number}/comments`); }
}

const prefix = `/repos/${REPOSITORY}`;
export async function inspect(api, number, head) {
  requireSha(head);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('A PR number is required');
  const pr = await api.pr(number);
  if (pr.state !== 'open' || pr.head.sha !== head || pr.base.repo.full_name !== REPOSITORY) {
    throw new Error('PR is closed, has moved, or belongs to another repository');
  }
  if (!allowedBase(pr.base.ref)) throw new Error('Unsupported PR base');
  const kind = gateKind(pr.title);
  // PR snapshots can retain an older base SHA. Bind the actual branch tip,
  // so a base update cannot reuse a previous light/final receipt.
  const branch = await api.request(`${prefix}/branches/${encodeURIComponent(pr.base.ref)}`);
  const actualBase = requireSha(branch.commit?.sha);
  const plan = {repository: REPOSITORY, pr: number, head, base: actualBase,
    baseRef: pr.base.ref, kind, phase: 'final'};
  return {pr, plan, ref: finalRef(plan), branch};
}

export async function approvedReview(api, number, head) {
  const review = trustedReview(await api.comments(number));
  if (review?.status !== 'completed') throw new Error('Independent Review has no completed code conclusion');
  if (review.commit_sha !== head) {
    const comparison = await api.request(`${prefix}/compare/${review.commit_sha}...${head}`);
    if (comparison.status !== 'ahead' || comparison.behind_by !== 0) throw new Error('Reviewed commit is not an ancestor of the final Head');
  }
  await resolvedThreads(api, number);
  return {...review, required: true};
}

async function resolvedThreads(api, number) {
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const result = await api.request('/graphql', {method: 'POST', body: {
      query: 'query($owner:String!,$repo:String!,$number:Int!,$cursor:String){repository(owner:$owner,name:$repo){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}',
      variables: {owner: 'lizhonghao31-crypto', repo: 'dx-rework', number, cursor}}});
    if (result.errors?.length) throw new Error('Cannot read Review thread resolution');
    const threads = result.data?.repository?.pullRequest?.reviewThreads;
    if (!threads || threads.nodes.some(t => !t.isResolved)) throw new Error('Review has unreadable or unresolved threads');
    if (!threads.pageInfo.hasNextPage) return;
    if (!threads.pageInfo.endCursor || threads.pageInfo.endCursor === cursor) throw new Error('Review cursor did not advance');
    cursor = threads.pageInfo.endCursor;
  }
  throw new Error('Review pagination exceeded the bounded read');
}

async function reviewFor(api, snapshot, decision) {
  const {plan} = snapshot;
  if (decision === undefined || decision?.required === true) return approvedReview(api, plan.pr, plan.head);
  if (decision?.required !== false || plan.kind !== 'quick') throw new Error('Only explicitly authorized low-risk Quick changes can declare Review not required');
  for (const field of ['reason', 'authorization']) {
    const value = decision[field];
    if (typeof value !== 'string' || !value.trim() || value.length > 1000
      || [...value].some(c => c.codePointAt(0) < 32 || c.codePointAt(0) === 127)) {
      throw new Error(`No-review ${field} must identify the risk decision and existing authority`);
    }
  }
  // A declaration cannot erase a started/failed Review or known open findings.
  if (trustedReview(await api.comments(plan.pr))) return approvedReview(api, plan.pr, plan.head);
  await resolvedThreads(api, plan.pr);
  return {required: false, reason: decision.reason.trim(), authorization: decision.authorization.trim()};
}

async function jobs(api, run) { return api.pages(`${prefix}/actions/runs/${run.id}/jobs`, 'jobs'); }

async function commitTree(api, sha) {
  const commit = await api.request(`${prefix}/git/commits/${requireSha(sha)}`);
  if (commit.sha !== sha) throw Error('GitHub returned a different commit for affected entries');
  const ref = requireSha(commit.tree?.sha);
  const result = await api.request(`${prefix}/git/trees/${ref}?recursive=1`);
  if (result.sha !== ref || result.truncated !== false || !Array.isArray(result.tree)) {
    throw Error('Cannot obtain complete pinned GitHub tree for affected entries');
  }
  return new Map(result.tree.filter(entry=>entry.type!=='tree')
    .map(entry=>[entry.path,entry.type+':'+entry.mode+':'+entry.sha]));
}

const changedTreePaths=(base,head)=>[...new Set([...base.keys(),...head.keys()])].filter(path=>base.get(path)!==head.get(path));

export async function affectedEntriesFor(api, plan) {
  if (plan.kind !== 'full') return {active:false, selected:[], registry:null, paths:[]};
  let pinned;
  try { pinned = await api.request(`${prefix}/contents/${AFFECTED_MAP_PATH}?ref=${plan.base}`); }
  catch (error) {
    if (error instanceof GitHubError && error.status === 404) return {active:false, selected:[], registry:null, paths:[]};
    throw error;
  }
  if (pinned.type!=='file' || pinned.encoding!=='base64' || typeof pinned.content!=='string'
    || pinned.content.length>131072) throw Error('Cannot read pinned affected-entry risk map');
  const registry = JSON.parse(Buffer.from(pinned.content,'base64').toString('utf8'));
  const [base,head] = await Promise.all([commitTree(api,plan.base),commitTree(api,plan.head)]);
  if (!base.has(AFFECTED_MAP_PATH)) throw Error('Pinned affected-entry map is missing from its commit tree');
  const paths=changedTreePaths(base,head);
  return {active:true, registry, paths, selected:affectedEntryPlan(registry,paths)};
}

async function hostedReviewFor(api,plan,affected){
  if(plan.kind!=='full')return null;
  const present=async sha=>{
    try{
      const policy=await api.request(`${prefix}/contents/${HOSTED_REVIEW_POLICY}?ref=${sha}`);
      if(policy.type!=='file')throw Error('Cannot identify the frozen hosted Review policy');
      return true;
    }catch(error){
      if(error instanceof GitHubError&&error.status===404)return false;
      throw error;
    }
  };
  const [base,head]=await Promise.all([present(plan.base),present(plan.head)]);
  if(!base&&!head)return null; // Historical workflow and receipts only.
  const trees=new Map();
  const tree=sha=>{
    if(!trees.has(sha))trees.set(sha,commitTree(api,sha));
    return trees.get(sha);
  };
  return readHostedReview(api,plan,affected.registry,affected.paths,async (earlier,later)=>{
    const comparison=await api.request(`${prefix}/compare/${earlier}...${later}`);
    if(comparison.status!=='ahead'||comparison.behind_by!==0||comparison.merge_base_commit?.sha!==earlier)
      throw Error('Reviewed commit is not an ancestor of the final Head');
    const [oldTree,newTree]=await Promise.all([tree(earlier),tree(later)]);
    return changedTreePaths(oldTree,newTree);
  },async (commit,file)=>{
    const entry=(await tree(commit)).get(file);
    if(!entry)return null;
    const object=/^blob:100(?:644|755):([0-9a-f]{40})$/.exec(entry)?.[1];
    if(!object)throw Error('Review evidence must be a regular Git blob');
    const blob=await api.request(`${prefix}/git/blobs/${object}`);
    if(blob.sha!==object||blob.encoding!=='base64'||typeof blob.content!=='string'||
      !Number.isSafeInteger(blob.size)||blob.size<0||blob.size>3*1024*1024)
      throw Error('Cannot read exact Review evidence blob');
    const bytes=Buffer.from(blob.content,'base64');
    if(bytes.length!==blob.size)throw Error('Review evidence blob bytes differ');
    return bytes.toString('utf8');
  });
}

async function verifyHostedAffected(api, run, plan, selected, reviewSha256) {
  const attempts=await api.pages(`${prefix}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`,'jobs');
  const matching=attempts.filter(j=>j.name===AFFECTED_JOB);
  if (matching.length!==1) throw Error('Missing or ambiguous actual hosted affected-entry job');
  const job=matching[0];
  if (job.run_id!==run.id || job.run_attempt!==run.run_attempt || job.head_sha!==plan.head
    || job.status!=='completed' || job.conclusion!=='success'
    || !job.steps?.some(step=>step.name==='Run and verify exact affected cases'&&step.conclusion==='success')) {
    throw Error('Hosted affected-entry check failed, was skipped, or belongs to a different attempt/Head');
  }
  if(reviewSha256&&selected.length&&!job.steps?.some(step=>step.name==='Preserve the original named test report'&&step.conclusion==='success')){
    throw Error('Hosted affected-entry job did not retain the original named test report');
  }
  return parseAffectedReceipt(await api.request(`${prefix}/actions/jobs/${job.id}/logs`,{raw:true}),plan,run,selected,reviewSha256);
}

export async function proofForRun(api, run, plan, phase) {
  const name = phase === 'light' ? LIGHT_CHECK : FINAL_CHECK;
  const named = (await jobs(api, run)).filter(job => job.name === name);
  if (named.length !== 1) throw new Error(`Expected one actual ${name} job, not a missing/ambiguous context`);
  const job = named[0];
  if (job.status !== 'completed' || job.conclusion !== 'success') throw new Error(`${name} did not actually succeed`);
  const log = await api.request(`${prefix}/actions/jobs/${job.id}/logs`, {raw: true});
  const receipt = parseReceipt(log);
  const expected = {...plan, phase};
  assertRunBinding(run, job, receipt, expected);
  return {runId: run.id, jobId: job.id, receipt};
}

export async function lightProof(api, plan) {
  const runs = await api.pages(`${prefix}/actions/workflows/ci.yml/runs?head_sha=${plan.head}&event=pull_request`, 'workflow_runs');
  for (const run of runs.sort((a, b) => b.id - a.id)) {
    const named = (await jobs(api, run)).filter(job => job.name === LIGHT_CHECK);
    if (!named.length) continue; // An ignored metadata event must have no required-name job.
    return proofForRun(api, run, plan, 'light'); // Never bypass a newer actual failure with an older pass.
  }
  throw new Error('This exact Head has no completed light-check evidence');
}

export async function finalStatus(api, plan, ref) {
  const runs = await api.pages(`${prefix}/actions/workflows/ci.yml/runs?head_sha=${plan.head}&event=create&branch=${encodeURIComponent(ref)}`, 'workflow_runs');
  if (!runs.length) return {state: 'requested', ref};
  const run = runs.sort((a, b) => b.id - a.id)[0];
  if (run.head_branch !== ref || run.head_sha !== plan.head) throw new Error('Final run is not bound to its immutable request ref');
  if (run.status !== 'completed') return {state: 'running', runId: run.id, ref};
  if (run.conclusion !== 'success') return {state: 'failed', runId: run.id, ref, conclusion: run.conclusion};
  const proof=await proofForRun(api,run,plan,'final');
  const affected=await affectedEntriesFor(api,plan);
  const hosted=await hostedReviewFor(api,plan,affected);
  const affectedReceipt=affected.active||hosted ? await verifyHostedAffected(api,run,plan,affectedCasesWithReview(affected.selected,hosted),hosted?reviewDigest(hosted):undefined) : null;
  return {state: 'approved', ref, ...proof, ...(affectedReceipt?{affectedReceipt}:{})};
}

async function existingRef(api, ref, head) {
  let result;
  try { result = await api.request(`${prefix}/git/ref/heads/${ref}`); }
  catch (error) { if (error instanceof GitHubError && error.status === 404) return null; throw error; }
  if (result.ref !== `refs/heads/${ref}` || result.object?.sha !== head) throw new Error('Existing request ref was rewritten or differs');
  return result;
}
export async function requestFinal(api, number, head, {apply = false, reviewPolicy, closeoutPath} = {}) {
  const snapshot = await inspect(api, number, head);
  const review = await reviewFor(api, snapshot, reviewPolicy);
  if (await existingRef(api, snapshot.ref, head)) {
    const status = await finalStatus(api, snapshot.plan, snapshot.ref);
    if ((await inspect(api, number, head)).ref !== snapshot.ref) throw new Error('PR base/mode changed while inspecting the existing final request');
    return {...status, reviewDecision: review};
  }
  const affected = await affectedEntriesFor(api,snapshot.plan);
  const hosted = await hostedReviewFor(api,snapshot.plan,affected);
  if(hosted&&hosted.reviewedHead!==review.commit_sha)throw Error('Hosted Review and operator Review differ');
  const closeout = await verifyFinalCloseout(api,snapshot.plan,closeoutPath,review,affectedCasesWithReview(affected.selected,hosted));
  const request = {ref: `refs/heads/${snapshot.ref}`, sha: head};
  const fresh = await inspect(api, number, head);
  if (fresh.ref !== snapshot.ref) throw new Error('PR base/mode changed before the final request');
  if (!apply) return {state: 'plan', request, closeout, review: review.commentId ?? null, reviewDecision: review};
  try { await api.request(`${prefix}/git/refs`, {method: 'POST', body: request}); }
  catch (error) {
    // Atomic create is the idempotency boundary. Never update, force, delete or
    // make a new nonce ref to evade an existing failure or an uncertain result.
    if (error instanceof GitHubError && ![422].includes(error.status)) throw error;
    if (!await existingRef(api, snapshot.ref, head)) throw error;
  }
  return {state: 'requested', ref: snapshot.ref, head, closeout, review: review.commentId ?? null, reviewDecision: review};
}

export async function verifyMerge(api, number, head, {reviewPolicy} = {}) {
  const snapshot = await inspect(api, number, head);
  const review = await reviewFor(api, snapshot, reviewPolicy);
  if (!await existingRef(api, snapshot.ref, head)) throw new Error('No explicit final request for this Head/base/mode');
  const final = await finalStatus(api, snapshot.plan, snapshot.ref);
  if (final.state !== 'approved') throw new Error(`Final Gate is ${final.state}, not approved`);
  // Light is optional evidence reuse, never a prerequisite for a later Head.
  // If Full actually reused checks, still verify their exact original provenance.
  const light = final.receipt.checks.some(check => check.execution === 'verified_reuse')
    ? await lightProof(api, snapshot.plan) : null;
  assertReuseLineage(final.receipt,light);
  const fresh = await inspect(api, number, head);
  if (fresh.ref !== snapshot.ref) throw new Error('PR Head/base/mode changed during merge verification');
  const {branch} = fresh;
  return {head, base: snapshot.plan.base, review: review.commentId ?? null, reviewedHead: review.commit_sha ?? null, reviewDecision: review,
    lightRun: light?.runId ?? null, final, platform: {protected: branch.protected,
      visibleRequiredChecks: branch.protection?.required_status_checks ?? null,
      boundary: 'Read-only evidence permits the governed merge operation; this command does not merge or change server protection.'}};
}

export async function reviewStep(api, number, head, requestId, {now = Date.now(), apply = false, stateDir = tmpdir()} = {}) {
  const {plan}=await inspect(api, number, head);
  const decide = async () => {
    const comments=await api.comments(number);
    const decision=reviewDecision({comments,requestId,now,expectedHead:head});
    if (plan.kind!=='full'||decision.action!=='reopen') return decision;
    const manual=comments.filter(comment=>comment.body?.trim()==='@codex review');
    if(manual.length>=2)return {action:'review_round_limit',limit:2};
    const reviews=await api.pages(`${prefix}/pulls/${number}/reviews`);
    const requested=manual.find(comment=>comment.id===requestId);
    // Count an earlier automatic completed round even if no issue comment
    // requested it. The current timed-out request is one round of its own.
    if(reviews.some(review=>review.user?.login===REVIEW_BOT&&review.state!=='PENDING'
      && Date.parse(review.submitted_at)<Date.parse(requested.created_at)))
      return {action:'review_round_limit',limit:2};
    return decision;
  };
  const first = await decide();
  if (first.action !== 'reopen' || !apply) return first;
  const key = createHash('sha256').update(`${REPOSITORY}:${number}:${head}:${requestId}`).digest('hex');
  await mkdir(stateDir, {recursive: true});
  const lock = join(stateDir, `review-${key}.lock`), record = join(stateDir, `review-${key}.json`);
  let handle;
  try { handle = await open(lock, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return {action: 'locked'}; throw error; }
  try {
    try {
      const prior = JSON.parse(await readFile(record, 'utf8'));
      if (prior.outcome !== 'sent') return {action: 'blocked_uncertain_or_denied', record};
      return {action: 'superseded', requestId: prior.id};
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    await inspect(api, number, head);
    const fresh = await decide();
    if (fresh.action !== 'reopen') return fresh;
    await writeFile(record, JSON.stringify({outcome: 'uncertain', requestId, number, head}) + '\n', {mode: 0o600});
    try {
      const comment = await api.request(`${prefix}/issues/${number}/comments`, {method: 'POST', body: {body: '@codex review'}});
      if (!comment.id || !comment.created_at) throw new Error('Review post outcome lacks its server identity');
      await writeFile(record, JSON.stringify({outcome: 'sent', id: comment.id, requestedAt: comment.created_at}) + '\n', {mode: 0o600});
      return {action: 'reopened', id: comment.id, requestedAt: comment.created_at};
    } catch (error) {
      if (error instanceof GitHubError) await writeFile(record, JSON.stringify({outcome: 'denied', status: error.status}) + '\n', {mode: 0o600});
      throw error;
    }
  } finally { await handle.close(); await rm(lock); }
}

async function main() {
  if (process.env.GITHUB_ACTIONS === 'true') throw new Error('Use the read-free CI runtime, not operator credentials, inside Actions');
  const {values, positionals} = parseArgs({allowPositionals: true, options: {
    pr: {type: 'string'}, head: {type: 'string'}, closeout: {type:'string'}, apply: {type: 'boolean', default: false},
    'request-id': {type: 'string'}, watch: {type: 'boolean', default: false},
    'review-retry-authorized': {type: 'boolean', default: false}, 'state-dir': {type: 'string'},
    'review-not-required': {type: 'boolean', default: false}, 'review-reason': {type: 'string'}, 'review-authorization': {type: 'string'},
  }});
  const api = new GitHub(), number = Number(values.pr), head = requireSha(values.head);
  const reviewPolicy = values['review-not-required'] ? {required: false, reason: values['review-reason'], authorization: values['review-authorization']} : undefined;
  if (positionals[0] === 'request-final') console.log(JSON.stringify(await requestFinal(api, number, head, {apply: values.apply, reviewPolicy, closeoutPath:values.closeout}), null, 2));
  else if (positionals[0] === 'verify-merge') console.log(JSON.stringify(await verifyMerge(api, number, head, {reviewPolicy}), null, 2));
  else if (positionals[0] === 'watch-review') {
    if (values.apply && !values['review-retry-authorized']) throw new Error('Review retry requires the explicit standing authorization flag');
    let requestId = Number(values['request-id']);
    do {
      const decision = await reviewStep(api, number, head, requestId, {apply: values.apply, stateDir: values['state-dir']});
      console.log(JSON.stringify({...decision, observedAt: new Date().toISOString()}));
      if (decision.action === 'reopened') requestId = decision.id;
      else if (decision.action === 'superseded') requestId = decision.requestId;
      else if (decision.action === 'complete') break;
      else if (!['wait', 'locked'].includes(decision.action)) break;
      if (!values.watch) break;
      await new Promise(resolve => setTimeout(resolve, 30_000));
    } while (values.watch);
  } else throw new Error('Expected request-final, verify-merge or watch-review; no merge/permission command exists');
}
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
