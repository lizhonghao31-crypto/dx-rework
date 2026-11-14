import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, open, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {pathToFileURL} from 'node:url';
import {verifyFinalCloseout} from './final-closeout.mjs';
import {REPOSITORY, FINAL_CHECK, LIGHT_CHECK, gateKind, finalRef, requireSha,
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
  return {state: 'approved', ref, ...await proofForRun(api, run, plan, 'final')};
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
  const closeout = await verifyFinalCloseout(api,snapshot.plan,closeoutPath,review);
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
  await inspect(api, number, head);
  const decide = async () => reviewDecision({comments: await api.comments(number), requestId, now, expectedHead: head});
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
