import assert from 'node:assert/strict';
import {test} from 'node:test';
import {REPOSITORY, REVIEW_BOT, REVIEW_TIMEOUT_MS, FINAL_CHECK, LIGHT_CHECK,
  finalRef, parseFinalRef, eventPlan, trustedReview, reviewDecision, parseReceipt,
  assertReceipt, assertRunBinding} from './pr-gate-protocol.mjs';

const head = 'a'.repeat(40), base = 'b'.repeat(40), other = 'c'.repeat(40);
const event = (action = 'opened', title = '[FULL] safe', label = '') => ({
  repository: {full_name: REPOSITORY}, action, label: {name: label}, changes: {},
  pull_request: {number: 901, title, head: {sha: head},
    base: {sha: base, ref: 'release/digital-production-v1', repo: {full_name: REPOSITORY}}},
});
const request = {id: 10, body: '@codex review', created_at: '2026-10-27T16:00:00Z'};
const now = Date.parse(request.created_at);
const summary = (status = 'running', sha = head) => ({id: 11, user: {login: REVIEW_BOT},
  updated_at: request.created_at,
  body: `<!-- codex-review-state:v1 ${JSON.stringify({code_review: {status, commit_sha: sha}})} -->`,
});

const requestRef = kind => finalRef({kind, pr: 901, head, base, baseRef: 'release/digital-production-v1'});
test('final request refs bind the full Head/base SHA, PR, mode and base branch', () => {
  for (const kind of ['full', 'quick']) {
    const parsed = parseFinalRef('refs/heads/' + requestRef(kind), head);
    assert.equal(parsed.head, head); assert.equal(parsed.base, base);
    assert.equal(parsed.pr, 901); assert.equal(parsed.kind, kind);
    assert.equal(parsed.baseRef, 'release/digital-production-v1');
  }
  for (const sha of ['a', head.toUpperCase(), `${head};command`, '', null])
    assert.throws(() => finalRef({kind: 'full', pr: 901, head: sha, base, baseRef: 'main'}));
  assert.throws(() => parseFinalRef(requestRef('full'), other));
  assert.throws(() => finalRef({kind: 'unknown', pr: 901, head, base, baseRef: 'main'}));
});
for (const kind of ['full', 'quick']) {
  const title = kind === 'full' ? '[FULL] safe' : '[QUICK] safe';
  for (const action of ['opened', 'synchronize', 'reopened']) test(`${kind} ${action} runs Light only on opening`, () => {
    assert.equal(eventPlan('pull_request', event(action, title)).phase, action === 'opened' ? 'light' : 'ignore');
  });
  test(`${kind} accepts only creation of its explicit immutable request`, () => {
    const create = {repository: {full_name: REPOSITORY}, ref_type: 'branch', ref: requestRef(kind)};
    assert.equal(eventPlan('create', create, REPOSITORY, head).phase, 'final');
    assert.throws(() => eventPlan('create', create, REPOSITORY, other));
    assert.throws(() => eventPlan('create', {...create, ref_type: 'tag'}, REPOSITORY, head));
    assert.equal(eventPlan('pull_request', event('labeled', title, 'documentation')).phase, 'ignore');
  });
}
test('all later metadata changes skip Light; final tuple still binds mode and base', () => {
  const wording = event('edited'); wording.changes = {title: {from: '[FULL] old'}, body: {from: 'old'}};
  assert.equal(eventPlan('pull_request', wording).phase, 'ignore');
  const mode = event('edited'); mode.changes.title = {from: '[QUICK] old'};
  assert.equal(eventPlan('pull_request', mode).phase, 'ignore');
  const retarget = event('edited'); retarget.changes.base = {ref: {from: 'main'}};
  assert.equal(eventPlan('pull_request', retarget).phase, 'ignore');
});
test('unknown repositories, unsupported bases and malformed Heads fail closed', () => {
  const wrongRepo = event(); wrongRepo.repository.full_name = 'other/repo';
  assert.throws(() => eventPlan('pull_request', wrongRepo));
  const wrongBase = event(); wrongBase.pull_request.base.ref = 'release/other';
  assert.throws(() => eventPlan('pull_request', wrongBase));
  const short = event(); short.pull_request.head.sha = 'short';
  assert.throws(() => eventPlan('pull_request', short));
});
test('legacy manual Quick remains manual and cannot claim final PR evidence', () => {
  assert.deepEqual(eventPlan('workflow_dispatch', {}), {phase: 'manual', kind: 'quick'});
});
test('only the actual Codex bot can provide trusted Review state', () => {
  const forged = summary('completed'); forged.user.login = 'ordinary-user';
  assert.equal(trustedReview([forged]), null);
  assert.equal(trustedReview([forged, summary()]).status, 'running');
  const malformed = summary(); malformed.body = '<!-- codex-review-state:v1 {} -->';
  assert.throws(() => trustedReview([malformed]));
  assert.throws(() => trustedReview([{...summary(), updated_at: null}]));
});
test('fifteen-minute timeout uses request time and has an exact boundary', () => {
  const comments = [request, summary()];
  assert.equal(reviewDecision({comments, requestId: 10, now: now + REVIEW_TIMEOUT_MS - 1, expectedHead: head}).action, 'wait');
  assert.equal(reviewDecision({comments, requestId: 10, now: now + REVIEW_TIMEOUT_MS, expectedHead: head}).action, 'reopen');
  assert.throws(() => reviewDecision({comments, requestId: 10, now: now - 1, expectedHead: head}));
});
test('fresh completion or a newer request suppresses an overdue duplicate', () => {
  assert.equal(reviewDecision({comments: [request, summary('completed')], requestId: 10, now: now + REVIEW_TIMEOUT_MS, expectedHead: head}).action, 'complete');
  const newer = {...request, id: 12, created_at: '2026-10-27T16:15:00Z'};
  assert.equal(reviewDecision({comments: [request, summary(), newer], requestId: 10, now: now + REVIEW_TIMEOUT_MS, expectedHead: head}).action, 'superseded');
});
test('an earlier request in the same server second is not a new request', () => {
  const earlier = {...request, id: 9};
  assert.equal(reviewDecision({comments: [earlier, request, summary()], requestId: 10, now: now + REVIEW_TIMEOUT_MS, expectedHead: head}).action, 'reopen');
});
test('service failure is never a pass and remains eligible for the authorized timed retry', () => {
  const comments = [request, summary('failed')];
  assert.equal(reviewDecision({comments, requestId: 10, now: now + 1000, expectedHead: head}).abnormal, true);
  assert.equal(reviewDecision({comments, requestId: 10, now: now + REVIEW_TIMEOUT_MS, expectedHead: head}).action, 'reopen');
});

const expected = {repository: REPOSITORY, pr: 901, head, base, phase: 'final', kind: 'full'};
const checks = ['title', 'checkout', 'head', 'policy', 'risk', 'install', 'audit', 'lint', 'types', 'build', 'tests', 'migration_lint', 'secrets'];
const receipt = () => ({version: 1, ...expected, runId: 501, attempt: 1, jobStatus: 'success', missing: [],
  checks: checks.map(id => ({id, applicable: true, outcome: 'success'}))});
const run = {id: 501, run_attempt: 1, head_sha: head, path: '.github/workflows/ci.yml', event: 'create', status: 'completed', conclusion: 'success'};
const job = {id: 601, run_id: 501, name: FINAL_CHECK, status: 'completed', conclusion: 'success'};

test('only one complete structured log receipt is accepted', () => {
  const line = `2026-10-27T17:00:00Z DX_GATE_RECEIPT_V1=${JSON.stringify(receipt())}`;
  assert.equal(parseReceipt(line).head, head);
  assert.throws(() => parseReceipt(line + '\n' + line));
  assert.throws(() => parseReceipt('Tests 7 passed (7)'));
  assert.throws(() => parseReceipt('DX_GATE_RECEIPT_V1={"version":2}'));
});
test('new Head/base/mode/PR or light success cannot approve a final Gate', () => {
  for (const [key, value] of [['head', other], ['base', other], ['kind', 'quick'], ['phase', 'light'], ['pr', 902]])
    assert.throws(() => assertReceipt({...receipt(), [key]: value}, expected), key);
});
test('skipped, missing or failed required actual checks reject a green-looking result', () => {
  const skipped = receipt(); skipped.checks.find(c => c.id === 'tests').outcome = 'skipped';
  assert.throws(() => assertReceipt(skipped, expected));
  const missing = receipt(); missing.checks = missing.checks.filter(c => c.id !== 'tests');
  assert.throws(() => assertReceipt(missing, expected));
  assert.throws(() => assertReceipt({...receipt(), missing: ['tests']}, expected));
  assert.throws(() => assertReceipt(receipt(), {...expected, requiredIds: ['db_migrate']}));
});
test('server run/job conclusions and identity are required in addition to the receipt', () => {
  assert.equal(assertRunBinding(run, job, receipt(), expected).head, head);
  for (const bad of [{...job, conclusion: 'skipped'}, {...job, name: LIGHT_CHECK}, {...job, run_id: 502}])
    assert.throws(() => assertRunBinding(run, bad, receipt(), expected));
  for (const bad of [{...run, head_sha: other}, {...run, path: '.github/workflows/other.yml'}, {...run, event: 'workflow_dispatch'}, {...run, conclusion: 'failure'}])
    assert.throws(() => assertRunBinding(bad, job, receipt(), expected));
});
test('a new green-looking receipt cannot replace actual checks with an old reference', () => {
  assert.throws(() => assertReceipt({...receipt(), reusedFrom: 500, executedThisRun: false, checks: []}, expected));
});
test('light success never approves a final Gate or excuses an unsuccessful workflow', () => {
  const light = {...expected, kind: 'full', phase: 'light'};
  const proof = {...receipt(), ...light};
  const lightRun = {...run, path: '.github/workflows/ci.yml', event: 'pull_request', conclusion: 'failure'};
  const lightJob = {...job, name: LIGHT_CHECK};
  assert.throws(() => assertRunBinding(lightRun, lightJob, proof, light));
  assert.equal(assertRunBinding({...lightRun, conclusion: 'success'}, lightJob, proof, light).phase, 'light');
  assert.throws(() => assertRunBinding(lightRun, lightJob, proof, expected));
});
