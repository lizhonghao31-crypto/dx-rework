import {stripVTControlCharacters} from 'node:util';
// Repository-scoped protocol. Network effects belong to the controller; these
// decisions are deterministic and can be exercised without GitHub credentials.
export const REPOSITORY = 'lizhonghao31-crypto/dx-rework';
export const FINAL_CHECK = 'Final Gate exact Head';
export const LIGHT_CHECK = 'Push light checks';
export const RECEIPT_PREFIX = 'DX_GATE_RECEIPT_V1=';
export const REUSABLE_CHECKS=Object.freeze(['lint','types','build','migration_lint']);
export const REVIEW_BOT = 'chatgpt-codex-connector[bot]';
export const REVIEW_TIMEOUT_MS = 15 * 60 * 1000;
const SHA = /^[0-9a-f]{40}$/;
const BASES = new Set(['main', 'release/digital-production-v1', 'feat/digital-production-a4',
  'deliver/sla-foundation-development-budget-20261024', 'deliver/sla-preparation-cutting-dispatch-20261024']);

export function requireSha(sha) {
  if (!SHA.test(sha ?? '')) throw new Error('A complete lowercase Head SHA is required');
  return sha;
}
export function gateKind(title) {
  if (title?.startsWith('[FULL] ')) return 'full';
  if (title?.startsWith('[QUICK] ')) return 'quick';
  throw new Error('PR title must start with [QUICK] or [FULL]');
}
export function allowedBase(base) {
  return BASES.has(base) || /^unified-p[^/]*$/.test(base ?? '')
    && ![...base].some(c => c.codePointAt(0) <= 32 || c.codePointAt(0) === 127 || '~^:?*[\\'.includes(c))
    && !base.includes('..') && !base.includes('@{') && !base.endsWith('.') && !base.endsWith('.lock');
}
export function finalRef({kind, pr, head, base, baseRef}) {
  if (!['quick', 'full'].includes(kind) || !Number.isSafeInteger(pr) || pr <= 0 || !allowedBase(baseRef)) {
    throw new Error('Invalid final request kind, PR or base');
  }
  const ref = `gate/${kind}/${pr}/${requireSha(head)}/${requireSha(base)}/${Buffer.from(baseRef).toString('base64url')}`;
  if (ref.length > 240) throw new Error('Final request ref exceeds the supported length');
  return ref;
}
export function parseFinalRef(ref, actualHead) {
  const name = ref?.replace(/^refs\/heads\//, '');
  const match = name?.match(/^gate\/(quick|full)\/([1-9][0-9]*)\/([0-9a-f]{40})\/([0-9a-f]{40})\/([A-Za-z0-9_-]+)$/);
  if (!match) throw new Error('Malformed immutable final request ref');
  const request = {kind: match[1], pr: Number(match[2]), head: match[3], base: match[4],
    baseRef: Buffer.from(match[5], 'base64url').toString('utf8')};
  if (finalRef(request) !== name || request.head !== requireSha(actualHead)) {
    throw new Error('Final request ref does not match its actual commit');
  }
  return {...request, ref: name, phase: 'final', repository: REPOSITORY};
}
export function eventPlan(eventName, event, repository = REPOSITORY, actualHead) {
  if (eventName === 'workflow_dispatch') return { phase: 'manual', kind: 'quick' };
  if (eventName === 'create') {
    if (event.repository?.full_name !== repository) throw new Error('Unexpected request repository');
    if (event.ref_type !== 'branch') throw new Error('A final request must create a branch ref, not a tag');
    return parseFinalRef(event.ref, actualHead);
  }
  if (eventName !== 'pull_request') return { phase: 'ignore' };
  const pr = event.pull_request;
  if (!pr || event.repository?.full_name && event.repository.full_name !== repository
    || pr.base.repo.full_name !== repository || !allowedBase(pr.base.ref)) {
    throw new Error('Unexpected PR repository or base');
  }
  const head = requireSha(pr.head.sha), base = requireSha(pr.base.sha);
  let kind;
  try { kind = gateKind(pr.title); } catch { kind = 'invalid'; }
  const common = { kind, head, base, pr: pr.number, repository };
  if (event.action === 'edited') {
    let oldKind;
    try { oldKind = gateKind(event.changes?.title?.from ?? pr.title); } catch { oldKind = 'invalid'; }
    if (event.changes?.base || oldKind !== kind) return { ...common, phase: 'invalidate' };
    return { ...common, phase: 'ignore' };
  }
  if (['opened', 'synchronize', 'reopened'].includes(event.action)) return { ...common, phase: 'light' };
  return { ...common, phase: 'ignore' };
}

export function trustedReview(comments) {
  const summaries = comments.filter(c => c.user?.login === REVIEW_BOT
    && c.body?.includes('<!-- codex-review-state:v1 '))
    .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
  if (!summaries.length) return null;
  const comment = summaries[0];
  if (!Number.isFinite(Date.parse(comment.updated_at))) throw new Error('Trusted Review time is unknown');
  const match = comment.body.match(/<!-- codex-review-state:v1 (.*?) -->/s);
  if (!match) throw new Error('Malformed trusted Review state');
  const review = JSON.parse(match[1]).code_review;
  if (!review || !SHA.test(review.commit_sha ?? '')) throw new Error('Review lacks a complete commit SHA');
  return { ...review, commentId: comment.id, updatedAt: comment.updated_at };
}

// Both a running review and an explicit service failure have no code conclusion.
// The interval is measured from the posted request, never the later bot start.
export function reviewDecision({ comments, requestId, now, expectedHead }) {
  requireSha(expectedHead);
  const request = comments.find(c => c.id === requestId && c.body?.trim() === '@codex review');
  if (!request) throw new Error('Cannot identify the posted Review request');
  const requestedAt = Date.parse(request.created_at);
  if (!Number.isFinite(requestedAt) || !Number.isFinite(now) || now < requestedAt) {
    throw new Error('Invalid Review observation time');
  }
  const newer = comments.filter(c => c.body?.trim() === '@codex review'
    && (Date.parse(c.created_at) > requestedAt
      || Date.parse(c.created_at) === requestedAt && c.id > requestId))
    .sort((a, b) => b.id - a.id)[0];
  const review = trustedReview(comments);
  if (review?.status === 'completed' && review.commit_sha === expectedHead) {
    return { action: 'complete', review };
  }
  if (newer) return { action: 'superseded', requestId: newer.id };
  if (now - requestedAt >= REVIEW_TIMEOUT_MS) return { action: 'reopen', abnormal: true, review };
  return { action: 'wait', abnormal: review?.status === 'failed', review,
    deadline: new Date(requestedAt + REVIEW_TIMEOUT_MS).toISOString() };
}

export function parseReceipt(log) {
  const receipts = stripVTControlCharacters(log).split('\n')
    .map(line => line.match(/(?:^|\s)DX_GATE_RECEIPT_V1=(\{.*\})\s*$/)?.[1]).filter(Boolean);
  if (receipts.length !== 1) throw new Error('Gate log must contain one structured receipt');
  const receipt = JSON.parse(receipts[0]);
  if (receipt.version !== 1) throw new Error('Unsupported Gate receipt version');
  return receipt;
}

export function assertReceipt(receipt, expected) {
  for (const key of ['repository', 'pr', 'head', 'base', 'phase', 'kind']) {
    if (receipt[key] !== expected[key]) throw new Error(`Gate receipt ${key} differs`);
  }
  requireSha(receipt.head); requireSha(receipt.base);
  if (receipt.jobStatus !== 'success' || !Array.isArray(receipt.missing) || receipt.missing.length) {
    throw new Error('Gate did not complete every applicable check');
  }
  if (!Number.isSafeInteger(receipt.runId) || receipt.runId <= 0
    || !Number.isSafeInteger(receipt.attempt) || receipt.attempt <= 0) throw new Error('Gate run identity missing');
  if (receipt.reusedFrom || receipt.executedThisRun === false) throw new Error('A final result must point to actual executed checks');
  if (!Array.isArray(receipt.checks)) throw new Error('Gate actual check results missing');
  const required = new Set(['title', 'checkout', 'head', 'policy']);
  for (const id of expected.requiredIds ?? []) required.add(id);
  if (expected.phase === 'final' && expected.kind === 'full') {
    for (const id of ['risk', 'install', 'audit', 'lint', 'types', 'build', 'tests', 'migration_lint', 'secrets']) required.add(id);
  }
  const rows = new Map(receipt.checks.map(check => [check.id, check]));
  if (rows.size !== receipt.checks.length) throw new Error('Duplicate Gate check identities');
  for (const id of required) {
    if (rows.get(id)?.applicable !== true || rows.get(id)?.outcome !== 'success') {
      throw new Error(`Required actual check absent or skipped: ${id}`);
    }
  }
  for (const check of rows.values()) {
    if (check.applicable !== true && check.applicable !== false) throw new Error('Unknown Gate applicability');
    if (check.applicable && check.outcome !== 'success') throw new Error(`Applicable check not successful: ${check.id}`);
    if(check.execution==='verified_reuse'){
      const s=check.source;
      if(expected.phase!=='final'||expected.kind!=='full'||!REUSABLE_CHECKS.includes(check.id)||!s||s.check!==check.id||s.phase!=='light'||s.workflow!=='.github/workflows/ci.yml')throw Error('Invalid reused check source');
      for(const key of ['repository','pr','head','base','kind'])if(s[key]!==expected[key])throw Error('Reused check tuple differs: '+key);
      if(expected.baseRef!==undefined&&s.baseRef!==expected.baseRef)throw Error('Reused check target branch differs');
      if(!Number.isSafeInteger(s.runId)||s.runId<=0||s.runId===receipt.runId||!Number.isSafeInteger(s.jobId)||s.jobId<=0||!Number.isSafeInteger(s.attempt)||s.attempt<1||! /^[0-9a-f]{64}$/.test(s.fingerprint??'')||! /^[0-9a-f]{64}$/.test(s.artifactSha256??''))throw Error('Reused check provenance missing');
    }else if(check.execution!==undefined&&check.execution!=='executed')throw Error('Unknown check execution source');
  }
  return receipt;
}
export function assertReuseLineage(receipt,light){
 for(const c of receipt.checks??[])if(c.execution==='verified_reuse'){
  const s=c.source;if(s.runId!==light.runId||s.jobId!==light.jobId||s.attempt!==light.receipt.attempt||s.head!==light.receipt.head||s.base!==light.receipt.base||(light.receipt.baseRef!==undefined&&s.baseRef!==light.receipt.baseRef))throw Error('Reused check is not the verified current light job');
  const row=light.receipt.checks.find(r=>r.id===c.id);if(row?.outcome!=='success'||row.applicable!==true)throw Error('Reused light check was not successful');
 }
 return receipt;
}

export function assertRunBinding(run, job, receipt, expected) {
  assertReceipt(receipt, expected);
  const workflow = '.github/workflows/ci.yml';
  const checkName = expected.phase === 'final' ? FINAL_CHECK : LIGHT_CHECK;
  if (run.id !== receipt.runId || run.run_attempt !== receipt.attempt
    || run.head_sha !== expected.head || run.path !== workflow
    || run.event !== (expected.phase === 'final' ? 'create' : 'pull_request')
    || run.status !== 'completed'
    || run.conclusion !== 'success'
    || job.run_id !== run.id || job.name !== checkName
    || job.status !== 'completed' || job.conclusion !== 'success') {
    throw new Error('Gate workflow/job identity or actual conclusion differs');
  }
  return receipt;
}
