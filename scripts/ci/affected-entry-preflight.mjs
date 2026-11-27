import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, appendFileSync, lstatSync} from 'node:fs';
import {isAbsolute, relative, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

export const AFFECTED_MAP_PATH = 'scripts/ci/affected-entry-map.json';
export const AFFECTED_JOB = 'Verify affected native entry points';
export const AFFECTED_PREFIX = 'DX_AFFECTED_ENTRY_V1=';
const HASH = /^[0-9a-f]{64}$/;
const ID = /^[a-z0-9-]{1,100}$/;
const safePath = path => /^[A-Za-z0-9_.@/-]{1,400}$/.test(path) && path.split('/').every(p=>p&&p!=='.'&&p!=='..');
const SUITE = /^tests\/integration\/[A-Za-z0-9-]+-browser-postgres\.test\.ts$/;
const sha = value => createHash('sha256').update(value).digest('hex');
const caseKey = ({file, name}) => JSON.stringify([file, name]);

/** The exact-tree diff is supplied by Git or GitHub, never by the PR author. */
export function affectedEntryPlan(registry, changedPaths) {
  if (registry === null) return [];
  if (registry?.version !== 1 || !Array.isArray(registry.entries) || !registry.entries.length) {
    throw Error('Invalid pinned affected-entry risk map');
  }
  const paths = new Set(changedPaths);
  const ids = new Set(), cases = new Set();
  return registry.entries.flatMap(({id, paths: inputs, file, name}) => {
    if (!ID.test(id) || !SUITE.test(file) || typeof name !== 'string' || !name.trim() || name.length > 300
      || /[\u0000-\u001f]/.test(name) || !Array.isArray(inputs) || !inputs.length
      || inputs.some(path => typeof path !== 'string' || !safePath(path))
      || ids.has(id) || cases.has(caseKey({file, name}))) throw Error('Invalid pinned affected-entry case');
    ids.add(id);
    cases.add(caseKey({file, name}));
    return inputs.some(path => paths.has(path)) ? [{id, file, name}] : [];
  }).sort((a,b) => a.id.localeCompare(b.id));
}

export function vitestCases(report, cwd = process.cwd()) {
  return report.testResults.flatMap(result => {
    if (typeof result.name !== 'string' || !isAbsolute(result.name)) return [];
    const file = relative(cwd, result.name).replaceAll('\\','/');
    return (result.assertionResults ?? []).map(a => ({file, name:a.fullName, status:a.status}));
  });
}

export function requireAffectedCases(expected, results) {
  const missing = expected.filter(test => {
    const hits = results.filter(result => caseKey(test) === caseKey(result));
    return hits.length !== 1 || hits[0].status !== 'passed';
  });
  if (missing.length) throw Error('AFFECTED_ENTRY_PROOF_MISSING: ' + missing.map(t => t.id).join(', '));
}

export function affectedReceipt(plan, run, selected, reportHash) {
  if (selected.length ? !HASH.test(reportHash ?? '') : reportHash !== null) throw Error('Missing or unexpected actual affected-entry report');
  const {repository,pr,head,base,baseRef,kind} = plan;
  return {version:1,repository,pr,head,base,baseRef,kind,runId:run.id,attempt:run.run_attempt,
    cases:selected.map(test=>test.id),reportSha256:reportHash};
}

export function parseAffectedReceipt(log, plan, run, selected) {
  const lines = String(log).split(/\r?\n/).map(line => line.match(/(?:^|[\t ])DX_AFFECTED_ENTRY_V1=(.+)$/)?.[1]).filter(Boolean);
  if (lines.length !== 1) throw Error('Expected one actual hosted affected-entry receipt');
  const receipt = JSON.parse(lines[0]);
  const expected = affectedReceipt(plan,run,selected,receipt.reportSha256);
  if (Object.keys(expected).some(k => JSON.stringify(receipt[k]) !== JSON.stringify(expected[k]))) {
    throw Error('Hosted affected-entry evidence is stale, missing or for another run/Head/Base');
  }
  return receipt;
}

const git = (...args) => execFileSync('git',args,{encoding:'utf8',maxBuffer:16*1024*1024});
function hostedTuple(env = process.env) {
  const {AFFECTED_HEAD:head,AFFECTED_BASE:base,AFFECTED_PR:pr,AFFECTED_BASE_REF:baseRef,GITHUB_REPOSITORY:repository,
    GITHUB_RUN_ID:id,GITHUB_RUN_ATTEMPT:attempt} = env;
  if (![head,base].every(s=>/^[0-9a-f]{40}$/.test(s??'')) || ![pr,id,attempt].every(n=>/^[1-9][0-9]*$/.test(n??''))
    || !baseRef || Number(attempt)!==1 || repository !== 'lizhonghao31-crypto/dx-rework'
    || git('rev-parse','HEAD').trim() !== head) throw Error('Hosted affected-entry tuple differs from checkout');
  return {plan:{repository,pr:Number(pr),head,base,baseRef,kind:'full'},run:{id:Number(id),run_attempt:Number(attempt)}};
}

export function pinnedSelection(base, head) {
  const mapExists = git('ls-tree',base,'--',AFFECTED_MAP_PATH).length !== 0;
  // Historical base has not adopted this profile. Never read the candidate's
  // map to select cases for its own change.
  const registry = mapExists ? JSON.parse(git('show',base+':'+AFFECTED_MAP_PATH)) : null;
  const paths = git('diff','--no-renames','--name-only','-z',base,head).split('\0').filter(Boolean);
  return affectedEntryPlan(registry,paths);
}

export function runSelectedCases(selected, reportFile, cwd = process.cwd()) {
  if (!selected.length) throw Error('No affected case selected');
  if (existsSync(reportFile)) throw Error('Refusing stale affected-entry report');
  const files = [...new Set(selected.map(test=>test.file))];
  const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern = '^(?:' + selected.map(test => escape(test.name)).join('|') + ')$';
  const result = spawnSync(process.execPath,['node_modules/vitest/vitest.mjs','run',
    '--config','vitest.business-chain.config.ts','--maxWorkers','1','--reporter=default','--reporter=json',
    '--outputFile.json',reportFile,'--testNamePattern',pattern,...files],
  {cwd,stdio:'inherit',env:{...process.env,NODE_ENV:'test',DX_REWORK_TEST_SUITE_KIND:'postgres'}});
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error('Affected native entry cases did not succeed');
  const file = lstatSync(reportFile);
  if (!file.isFile() || file.size > 16*1024*1024) throw Error('Invalid actual affected-entry report file');
  const bytes = readFileSync(reportFile), report = JSON.parse(bytes);
  if (report.success !== true || report.numFailedTests !== 0 || !Array.isArray(report.testResults)) throw Error('Failed/invalid affected-entry report');
  requireAffectedCases(selected,vitestCases(report,cwd));
  return sha(bytes);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const {plan,run} = hostedTuple();
  const selected = pinnedSelection(plan.base,plan.head);
  if (process.argv[2] === 'select') {
    appendFileSync(process.env.GITHUB_OUTPUT,'required='+String(selected.length>0)+'\n');
    console.log('Affected entry cases: ' + (selected.map(t=>t.id).join(', ') || 'none'));
  } else if (process.argv[2] === 'verify') {
    const hash = selected.length ? runSelectedCases(selected,resolve(process.env.RUNNER_TEMP,'dx-affected-entry.json')) : null;
    console.log(AFFECTED_PREFIX + JSON.stringify(affectedReceipt(plan,run,selected,hash)));
  } else throw Error('Expected affected-entry select or verify');
}
