// A bounded exception for the offline controller fixture, not general test selection.
// It copies scripts, infra and test fixtures, and synthesizes application/DB payloads.
// Only modifications to existing application source or prose are known independent.
export const OFFLINE_DEPLOYMENT_SUITE = 'tests/integration/acceptance-active-slot-chain.test.ts';
const independent = path => /^(?:apps\/(?:api|web)|packages\/(?:contracts|config|domain|ui))\/src\/.+\.(?:ts|tsx|css)$/.test(path)
  || /^(?:docs\/.+|README)\.md$/.test(path);

export function offlineDeploymentPlan(changes) {
  const fallback = reason => ({suite: OFFLINE_DEPLOYMENT_SUITE, required: true, reason});
  if (!Array.isArray(changes) || changes.length === 0) return fallback('empty-or-unknown-diff');
  for (const change of changes) {
    if (!change || change.status !== 'M') return fallback('added-deleted-renamed-or-unknown-status');
    const path = change.path;
    if (typeof path !== 'string' || path.split('/').some(p => !p || p === '.' || p === '..') || path.includes('\\')) return fallback('invalid-path');
    if (!independent(path)) return fallback('deployment-input-or-unclassified-path');
  }
  return {suite: OFFLINE_DEPLOYMENT_SUITE, required: false, reason: 'existing-application-source-or-prose-only'};
}

// --no-renames exposes both sides of moves. NUL records preserve unusual filenames;
// malformed/unknown records fall back rather than inventing a safe empty change.
export function parseChangedPaths(raw) {
  if (typeof raw !== 'string' || !raw.endsWith('\0')) return [];
  const parts = raw.slice(0, -1).split('\0');
  if (parts.length % 2) return [];
  const changes = [];
  for (let i = 0; i < parts.length; i += 2) changes.push({status: parts[i], path: parts[i + 1]});
  return changes;
}

export function nonDatabaseArguments(selection, reportPath) {
  if (!selection || selection.suite !== OFFLINE_DEPLOYMENT_SUITE || typeof selection.required !== 'boolean') throw Error('OFFLINE_DEPLOYMENT_PLAN_REQUIRED');
  return ['node_modules/vitest/vitest.mjs', 'run', '--reporter=default', '--reporter=json', '--outputFile=' + reportPath,
    ...(selection.required ? [] : ['--exclude', OFFLINE_DEPLOYMENT_SUITE])];
}
