import { readFile } from "node:fs/promises";
if(process.argv.includes("--approved-quick-maintenance"))throw Error("RETIRED_SINGLE_PR_MAINTENANCE_AUTHORIZATION");

const files = {
  quick: ".github/workflows/ci.yml",
  full: ".github/workflows/full-gate.yml",
  governance: ".github/workflows/governance.yml",
  preview: ".github/workflows/pr-preview.yml",
  release: ".github/workflows/pr-17-release.yml",
  riskMap: "scripts/ci/full-gate-risk-map.mjs",
};

const read = async (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [quick, full, governance, preview, release, riskMap] = await Promise.all(Object.values(files).map(read));

const assert = (condition, message) => {
  if (!condition) throw new Error(`GitHub Actions usage policy violation: ${message}`);
};

const stepBlock = (source, name) => {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `workflow step missing: ${name}`);
  const next = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
};

const countOccurrences = (source, needle) => source.split(needle).length - 1;

export const containsSecretsContext = (source) => /\$\{\{\s*secrets\b/i.test(source);

for (const expression of [
  "${{ secrets.NAME }}",
  "${{secrets.NAME}}",
  "${{ secrets['NAME'] }}",
  "${{secrets[\"NAME\"]}}",
]) {
  assert(containsSecretsContext(expression), `secret context detector must reject ${expression}`);
}

// One caller filters supported PR bases before allocating light jobs. Expensive
// work is reusable-only and selected by an immutable explicit create request.
const branches = quick.match(/ {2}pull_request:\n {4}branches:\n((?: {6}- [^\n]+\n)+)/)?.[1]
  .trim().split("\n").map(line => line.trim().slice(2));
assert(JSON.stringify(branches) === JSON.stringify(["main", "release/digital-production-v1", "feat/digital-production-a4", "unified-p*", "deliver/sla-foundation-development-budget-20261024", "deliver/sla-preparation-cutting-dispatch-20261024"]),
  "CI caller must admit only the approved exact PR base branches");
assert(quick.includes("timeout-minutes: 5"), "Quick Gate timeout must stay at 5 minutes");
assert(countOccurrences(quick, 'timeout-minutes:') === 3 && countOccurrences(quick, 'timeout-minutes: 2') === 2,
  "Only two bounded request/certification metadata jobs may accompany the five-minute light/Quick worker");
assert(countOccurrences(full,'timeout-minutes:')===4 && (full.match(/^ {4}timeout-minutes: 30[ \t]*$/gm)||[]).length===2 && (full.match(/^ {4}timeout-minutes: 60[ \t]*$/gm)||[]).length===1 && (full.match(/^ {4}timeout-minutes: 2[ \t]*$/gm)||[]).length===1,
  "Full preparation/non-DB remain30minutes; expanded PG lane is bounded to60minutes, aggregation to2minutes");
for(const [job,budget]of [['prepare',30],['non-db',30],['postgres',60],['full-validate',2]]) {
  const block=full.split(`\n  ${job}:\n`)[1]?.split(/\n {2}[a-z][\w-]*:\n/)[0];
  assert(block && new RegExp(`^ {4}timeout-minutes: ${budget}[ \\t]*$`,'m').test(block), `Full ${job} budget must be ${budget}`);
}
assert(/^ {2}workflow_call:/m.test(full) && !/^ {2}(pull_request|push|create|workflow_dispatch):/m.test(full),
  "Full Gate must be reusable-only; pushes and metadata must not allocate an expensive worker");
for(const input of ['pr_number','head_sha','base_sha','base_ref','gate_kind']) {
  assert(full.includes(`      ${input}:\n        type: string\n        required: true`), `Full request must freeze ${input}`);
  assert(quick.includes(input + ": ${{ needs.request.outputs."), `Caller must pass frozen ${input}`);
}
for(const event of ['opened','synchronize','reopened','edited']) assert(quick.includes(`- ${event}`), `Light checks must react to ${event}`);
assert(/^ {2}create:/m.test(quick) && quick.includes("github.event.ref_type == 'branch'"), "Final requests must use branch creation only");
assert(quick.includes("startsWith(github.event.ref, 'gate/full/')") && quick.includes("startsWith(github.event.ref, 'gate/quick/')"),
  "Ordinary branch/tag creation must allocate no final job");
assert(quick.includes("github.event.action != 'edited' || github.event.changes.base || (github.event.changes.title &&"),
  "Body and same-mode wording edits must allocate no runner");
for(const mode of ['FULL','QUICK']) assert(quick.includes(`startsWith(github.event.changes.title.from, '[${mode}] ') != startsWith(github.event.pull_request.title, '[${mode}] ')`),
  "Risk mode and base edits must invalidate the old request");
assert(quick.includes("'Push light checks'") && quick.includes("'Final Gate exact Head' || 'Final approval not selected'"),
  "Skipped/metadata/light checks must not impersonate final approval");
assert(quick.includes("WORKER_RESULT:") && quick.includes("needs.full.result") && quick.includes("needs.validate.result")
  && quick.includes("WORKER_RECEIPT:") && quick.includes("ci-gate-runtime.mjs certify"),
  "Final approval must certify GitHub's actual selected worker result and receipt");
assert(quick.includes("uses: ./.github/workflows/full-gate.yml"), "Caller must select the existing full worker");
assert(quick.includes("group: pr-gate-${{ github.event.pull_request.number || needs.request.outputs.pr || format('manual-{0}', github.ref) }}")
  && quick.includes("cancel-in-progress: ${{ github.event_name != 'create' }}")
  && quick.includes("group: pr-gate-${{ needs.request.outputs.pr }}\n      cancel-in-progress: false"),
  "A new PR Head must cancel stale work; duplicate explicit final requests must not cancel/restart it");
for(const [name,source] of [["CI caller",quick],["Full worker",full]]) {
  assert(!/^concurrency:/m.test(source), `${name} must filter events before acquiring concurrency`);
  assert(source.includes("permissions:\n  contents: read") && !/(?:pull-requests|checks|issues):|contents: write|actions: write/.test(source),
    `${name} allows only contents/read and artifact actions/read, never writes`);
  assert(!/contents: write|secrets: inherit/.test(source), `${name} must remain read-only`);
  assert(source.includes(name === "Full worker" ? "run: node scripts/test-preflight.mjs" : "node --test scripts/ci/*.test.mjs"), `${name} must execute protocol regressions`);
  assert((source.includes("GATE_STEPS_JSON: ${{ toJSON(steps) }}") || name === "Full worker" && source.includes("GATE_STEPS_JSON: ${{ steps.aggregate.outputs.steps }}")) && source.includes("if: always()")
    && source.includes("ci-gate-runtime.mjs emit"), `${name} must retain actual interrupted/omitted-check reporting and structured evidence`);
  assert(!source.includes('Standard lint/typecheck/build/tests/migration-lint/secret-scan: completed'), `${name} must not claim unexecuted checks completed`);
}
assert(stepBlock(quick,"Require explicit Quick Gate title").includes('[QUICK]')
  && stepBlock(quick,"Require explicit Quick Gate title").includes('[FULL]'), "Light checks must accept both explicit risk modes");
assert(stepBlock(full,"Require explicit Full Gate title").includes('REQUEST_HEAD')
  && stepBlock(full,"Require explicit Full Gate title").includes('GITHUB_SHA'), "Full worker must enforce the actual request commit");
assert(quick.includes("full-gate-risk-map.mjs --require-quick-safe"), "Quick Gate must use the shared sensitive-path classifier");

const classifier = stepBlock(quick, "Classify Quick Gate scope");
assert(classifier.includes("BASE_SHA"), "Quick Gate classifier must use exact PR base SHA");
assert(classifier.includes("HEAD_SHA"), "Quick Gate classifier must use exact PR head SHA");
assert(classifier.includes('git diff --name-only "${BASE_SHA}" "${HEAD_SHA}"'), "Quick Gate classifier must classify exact PR diff");
assert(classifier.includes("governance_only=false"), "Quick Gate governance classifier must fail closed");
assert(classifier.includes("web_only=false"), "Quick Gate web classifier must fail closed");
assert(countOccurrences(quick, "backup-postgres.sh") === 0, "Quick Gate must delegate deployment sensitivity to the shared classifier");
assert(countOccurrences(quick, "restore-postgres.sh") === 0, "Quick Gate must delegate restore sensitivity to the shared classifier");
assert(riskMap.includes('path === "scripts/backup-postgres.sh"'), "shared classifier must protect backup-postgres.sh");
assert(riskMap.includes('path === "scripts/restore-postgres.sh"'), "shared classifier must protect restore-postgres.sh");
assert(riskMap.includes('path.startsWith("apps/api/src/")'), "shared classifier must fail closed for unknown API paths");
assert(riskMap.includes('path.startsWith("packages/contracts/src/")'), "shared classifier must fail closed for unknown shared-contract paths");

for (const forbidden of [
  "postgres:16-alpine",
  "npm test",
  "db:migrate:check",
  "pr17:acceptance",
  "package-release.sh",
  "playwright install",
]) {
  assert(!quick.includes(forbidden), `Quick Gate must not contain ${forbidden}`);
}

assert(quick.includes("npm run build --workspaces --if-present"), "Quick Gate must avoid root postbuild");
assert(full.includes("npm ci --no-audit --no-fund --prefer-offline"), "Full Gate dependency install must remain deterministic");
assert(full.includes("Classify Full Gate risk from exact PR diff"), "Full Gate must classify exact PR diff");
assert(full.includes("full-gate-risk-map.mjs --github-env"), "Full Gate must use the shared sensitive-path classifier");
assert(full.includes("Run mapped PostgreSQL sensitive-domain regressions"), "Full Gate must execute mapped PostgreSQL suites");
assert(full.includes("Mapped PostgreSQL suite executed no passing tests"), "Mapped PostgreSQL suites must fail when nothing actually runs");
assert(stepBlock(full, "Run PostgreSQL 13 Journey read compatibility").includes("if: env.JOURNEY_PG13_COMPAT == 'true'"), "Journey PostgreSQL 13 compatibility must use the exact-diff classifier");
assert(stepBlock(full, "Run PostgreSQL 13 Journey read compatibility").includes("node scripts/ci/journey-pg13-regression.mjs"), "Journey changes must execute the real PostgreSQL 13 read regression");
assert(full.includes("DB_REQUIRED"), "Full Gate must retain conditional PostgreSQL escalation");
assert(full.includes("if: env.DB_REQUIRED == 'true'"), "PostgreSQL work must remain conditional");
for(const flag of ['MAINTENANCE_SENSITIVE','ACTIVATION_SENSITIVE','TRANSFER_SENSITIVE'])assert(full.includes(`if: env.${flag} == 'true'`), 'release/backup/transfer must use exact risk scopes');
assert(stepBlock(full, 'Run mapped PostgreSQL sensitive-domain regressions').includes('node scripts/run-business-chain-gate.mjs --full-gate'), 'Local and CI must use the same canonical PostgreSQL runner');
assert(stepBlock(full, 'Run PostgreSQL business chain for business, migration or deployment-sensitive changes').includes('--verify-receipt'), 'Chain must verify exact actual coverage instead of repeating suites');
assert(full.includes("npm audit --omit=dev --audit-level=high"), "Full Gate must audit the production dependency graph");
assert(full.includes("npm run secret:scan:full"), "Full Gate must scan complete Git history and first-party build artifacts");
assert(stepBlock(full, "Full unit and integration suite without runtime DB escalation").includes("run: node node_modules/vitest/vitest.mjs run"), "Full Gate must execute the same complete Vitest suite without repeating npm pretest builds");
assert(!/^\s*run: npm test\s*$/m.test(full), "Full Gate must not rebuild packages through pretest");
assert(!containsSecretsContext(quick), "Quick Gate must not receive repository or environment secrets");
assert(!containsSecretsContext(full), "Full Gate must not receive repository or environment secrets");
assert(!containsSecretsContext(governance), "Governance validation must not receive repository or environment secrets");
assert(!containsSecretsContext(preview), "Preview validation must not receive repository or environment secrets");
assert(release.includes("permissions:\n  contents: read"), "manual release workflow must keep read-only repository contents permission");

const releaseDeployMarker = "\n  deploy:";
const releaseDeployStart = release.indexOf(releaseDeployMarker);
assert(releaseDeployStart >= 0, "manual release deploy job missing");
const releaseGate = release.slice(0, releaseDeployStart);
const releaseDeploy = release.slice(releaseDeployStart);
assert(!containsSecretsContext(releaseGate), "release build/gate job must not receive production secrets");
assert(releaseDeploy.includes("environment: ${{ inputs.target_environment }}"), "release deploy job must use a protected target environment");
assert(releaseDeploy.includes("${{ secrets.DX_REWORK_SSH_KEY }}"), "release deploy secrets must stay inside the protected deploy job");
assert(release.includes("npm audit --omit=dev --audit-level=high"), "manual release must audit the production dependency graph");
assert(release.includes("npm run secret:scan:full"), "manual release must rescan history and first-party build artifacts");

assert(!/^\s*pull_request:/m.test(governance), "standalone Governance must not auto-run on pull requests");
assert(!/^\s*pull_request:/m.test(preview), "Preview must not auto-run on pull requests");

assert(full.includes('needs: [prepare, non-db, postgres]') && full.includes('FULL_GATE_NEEDS: ${{ toJSON(needs) }}'), 'Full final result must depend on all three jobs');
assert(countOccurrences(full, 'needs: prepare') === 2 && !full.includes('needs: non-db'), 'Complete non-DB and PG must be siblings');
assert(!full.includes('continue-on-error:'), 'Required lanes may not suppress failures');
assert(!/^ {4}concurrency:/m.test(full), 'Sibling lanes must not serialize or cancel each other');
assert(countOccurrences(full, 'full-gate-lanes.mjs restore') === 2, 'Both lanes must verify shared inputs');
console.log("ACTIONS_USAGE_POLICY_OK");
