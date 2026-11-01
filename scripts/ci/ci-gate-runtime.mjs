import {appendFileSync, readFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
import {classifyFullGatePaths} from './full-gate-risk-map.mjs';
import {REPOSITORY, RECEIPT_PREFIX, eventPlan, assertReceipt} from './pr-gate-protocol.mjs';

export function scopeRequired(kind, scope) {
  const flag = key => scope[key] === true || scope[key] === 'true';
  if (kind === 'always') return true;
  if (kind === 'pr') return scope.event === 'pull_request';
  if (kind === 'pr_or_final') return scope.event === 'pull_request' || flag('final');
  if (kind === 'release') return scope.base === 'release/digital-production-v1';
  if (kind === 'release_deployment') return flag('maintenance') && scope.base === 'release/digital-production-v1';
  if (kind === 'chain') return flag('business_chain') || flag('migration') || flag('deployment');
  if (kind === 'mapped') return Boolean(scope.mapped);
  if (kind === 'governance') return flag('governance');
  if (kind === 'not_governance') return !flag('governance');
  if (kind === 'business') return !flag('governance') && !flag('web');
  if (kind === 'light_build') return scope.event==='pull_request'&&!flag('governance')&&!flag('web');
  if (kind === 'optional') return false;
  if (['db', 'journey', 'migration', 'deployment', 'activation', 'transfer', 'web', 'maintenance'].includes(kind)) return flag(kind);
  throw new Error(`Unknown required-check applicability: ${kind}`);
}

export function quickScope(paths) {
  const governance = paths.length > 0 && paths.every(p =>
    /^(?:\.github\/workflows\/|docs\/(?:governance|roadmap)\/|scripts\/ci\/)/.test(p)
    || ['AGENTS.md', '.github/pull_request_template.md'].includes(p));
  const web = paths.some(p => /^(apps\/web|packages\/ui)\//.test(p))
    && paths.every(p => /^(apps\/web|packages\/ui|tests\/unit)\//.test(p));
  return {governance: String(governance), web: String(web), maintenance: 'false'};
}

export function scopeFor(plan, paths) {
  if (plan.phase === 'manual') return {event: 'workflow_dispatch', base: '', ...quickScope([])};
  if (plan.phase !== 'final' || plan.kind === 'quick') {
    return {event: plan.phase === 'final' ? 'create' : 'pull_request', base: plan.baseRef,
      final: String(plan.phase === 'final'), ...quickScope(paths)};
  }
  const risk = classifyFullGatePaths(paths);
  return {event: 'create', base: plan.baseRef, final: 'true', db: String(risk.dbRequired),
    mapped: risk.mappedPostgresTests.join(','), journey: String(risk.journeyPg13Compat),
    migration: String(risk.migrationSensitive), business_chain: String(risk.businessChainSensitive),
    deployment: String(risk.deploymentSensitive),maintenance: String(risk.maintenanceSensitive),activation: String(risk.activationSensitive),transfer: String(risk.transferSensitive)};
}

export function checkCatalog(kind, phase = 'final') {
  const file = phase === 'final' && kind === 'full' ? 'full-gate.yml' : 'ci.yml';
  const source = readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8');
  const match = source.match(/GATE_CHECKS_JSON: >-\n {12}([^\n]+)/);
  if (!match) throw new Error('Frozen workflow check catalog missing');
  return JSON.parse(match[1]);
}

export function currentPlan(environment = process.env) {
  if (environment.GITHUB_REPOSITORY !== REPOSITORY) throw new Error('Unexpected workflow repository');
  const event = JSON.parse(readFileSync(environment.GITHUB_EVENT_PATH, 'utf8'));
  const plan = eventPlan(environment.GITHUB_EVENT_NAME, event, REPOSITORY, environment.GITHUB_SHA);
  if (plan.phase === 'ignore') throw new Error('This event does not request a check');
  if (plan.phase === 'manual') return {...plan, head: environment.GITHUB_SHA,
    base: environment.GITHUB_SHA, pr: 0, repository: REPOSITORY, baseRef: ''};
  return {...plan, baseRef: plan.baseRef ?? event.pull_request.base.ref};
}

function outputs(values, environment) {
  const text = Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join('');
  if (!environment.GITHUB_OUTPUT) throw new Error('Workflow output file missing');
  appendFileSync(environment.GITHUB_OUTPUT, text);
}
export function resolveEvent(environment = process.env) {
  const plan = currentPlan(environment);
  for (const [key, field] of [['KIND', 'kind'], ['HEAD', 'head'], ['BASE', 'base'], ['PR', 'pr'], ['BASE_REF', 'baseRef']]) {
    const expected = environment[`EXPECTED_GATE_${key}`];
    if (expected !== undefined && expected !== String(plan[field])) throw new Error(`Reusable request ${field} differs`);
  }
  outputs({phase: plan.phase, kind: plan.kind, head: plan.head, base: plan.base,
    pr: plan.pr, base_ref: plan.baseRef}, environment);
  return plan;
}

export function emitReceipt(environment = process.env) {
  const plan = currentPlan(environment);
  if (execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() !== plan.head) {
    throw new Error('Executed checkout differs from the request Head');
  }
  const scope = JSON.parse(environment.GATE_SCOPE_JSON), steps = JSON.parse(environment.GATE_STEPS_JSON);
  const catalog = JSON.parse(environment.GATE_CHECKS_JSON);
  const checks = catalog.map(([id, , kind]) => ({id,
    applicable: scopeRequired(kind, scope) && !(id === 'web_tests' && steps[id]?.outputs?.has_tests === 'false'),
    outcome: steps[id]?.outcome ?? 'not_run',...(steps[id]?.outputs?.reuse_source?{execution:'verified_reuse',source:JSON.parse(steps[id].outputs.reuse_source)}:{execution:'executed'})}));
  const missing = checks.filter(c => c.applicable && c.outcome !== 'success').map(c => c.id);
  const receipt = {version: 1, repository: REPOSITORY, pr: plan.pr, head: plan.head, base: plan.base,
    baseRef: plan.baseRef, kind: plan.kind, phase: plan.phase === 'invalidate' ? 'light' : plan.phase,
    runId: Number(environment.GITHUB_RUN_ID), attempt: Number(environment.GITHUB_RUN_ATTEMPT),
    jobStatus: environment.GATE_JOB_STATUS, scope, checks, missing};
  if (receipt.jobStatus !== 'success' || missing.length) throw new Error(`Gate incomplete: ${missing.join(',')}`);
  outputs({receipt: JSON.stringify(receipt)}, environment);
  console.log(RECEIPT_PREFIX + JSON.stringify(receipt));
  return receipt;
}

// This job consumes GitHub's needs.<worker>.result and outputs. It does not
// query APIs, receive a new token permission, or create a green skipped check.
export function certifyFinal(environment = process.env) {
  const plan = currentPlan(environment);
  if (plan.phase !== 'final') throw new Error('FINAL_GATE_NOT_REQUESTED: Review/light checks are not final approval');
  if (environment.WORKER_RESULT !== 'success') throw new Error('Selected Gate worker did not succeed');
  const receipt = JSON.parse(environment.WORKER_RECEIPT || 'null');
  if (!receipt) throw new Error('Selected Gate worker provided no actual receipt');
  const scope = receipt.scope;
  if (execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim() !== plan.head) throw new Error('Approval checkout differs');
  try { execFileSync('git', ['cat-file', '-e', `${plan.base}^{commit}`], {stdio: 'ignore'}); }
  catch { execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', plan.base], {stdio: 'pipe'}); }
  const paths = execFileSync('git', ['diff', '--name-only', plan.base, plan.head], {encoding: 'utf8'}).trim().split('\n').filter(Boolean);
  const expectedScope = scopeFor(plan, paths);
  if (plan.kind === 'quick' && classifyFullGatePaths(paths).highRisk) throw new Error('Sensitive diff cannot receive a Quick approval');
  for (const [key, value] of Object.entries(expectedScope)) if (scope[key] !== value) throw new Error(`Actual scope ${key} differs`);
  const catalog = checkCatalog(plan.kind);
  const requiredIds = catalog.filter(([, , kind]) => scopeRequired(kind, expectedScope)).map(([id]) => id)
    .filter(id => id !== 'web_tests' || paths.some(p => /^tests\/unit\/.*\.test\.(?:js|jsx|ts|tsx)$/.test(p)));
  assertReceipt(receipt, {...plan, requiredIds});
  if (receipt.runId !== Number(environment.GITHUB_RUN_ID)
    || receipt.attempt !== Number(environment.GITHUB_RUN_ATTEMPT)
    || scope.event !== 'create' || scope.base !== plan.baseRef) throw new Error('Actual run/scope identity differs');
  console.log(RECEIPT_PREFIX + JSON.stringify(receipt));
  return receipt;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const command = process.argv[2];
  if (command === 'resolve') resolveEvent();
  else if (command === 'emit') emitReceipt();
  else if (command === 'certify') certifyFinal();
  else throw new Error('Expected resolve, emit or certify');
}
