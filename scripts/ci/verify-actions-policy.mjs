import { readFile } from "node:fs/promises";

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

// Keep the integration branch subject to the same exact-Head gates as main.
for (const [name, source] of [["Quick Gate", quick], ["Full Gate", full]]) {
  const branches = source.match(/ {2}pull_request:\n {4}branches:\n((?: {6}- [^\n]+\n)+)/)?.[1]
    .trim().split("\n").map(line => line.trim().slice(2));
  assert(JSON.stringify(branches) === JSON.stringify(["main", "release/digital-production-v1", "feat/digital-production-a4", "unified-p*"]),
    `${name} must gate main and the approved digital-production integration and approved A4/unified-plan stacked base branches only`);
}

assert(quick.includes("timeout-minutes: 5"), "Quick Gate timeout must stay at 5 minutes");
const fullBudget=/^ {4}timeout-minutes: 30[ \t]*$/m;
assert(countOccurrences(full,'timeout-minutes:')===1&&fullBudget.test(full),"Full Gate must retain the explicitly approved finite 30-minute budget");
assert(quick.includes("!startsWith(github.event.pull_request.title, '[FULL] ')"), "Quick Gate must skip FULL-title PRs before allocating its job");
assert(stepBlock(quick, "Require explicit Quick Gate title").includes("[QUICK]"), "Quick Gate must require an explicit QUICK title");
assert(full.includes("startsWith(github.event.pull_request.title, '[FULL] ')"), "Full Gate must run only for FULL-title PRs");
assert(stepBlock(full, "Require explicit Full Gate title").includes("[FULL]"), "Full Gate must require an explicit FULL title");
for (const event of ["opened", "synchronize", "reopened", "edited"]) {
  assert(quick.includes(`- ${event}`), `Quick Gate must react to ${event}`);
  assert(full.includes(`- ${event}`), `Full Gate must react to ${event}`);
}
assert(quick.includes("cancel-in-progress: true"), "Quick Gate must cancel stale runs");
assert(full.includes("cancel-in-progress: true"), "Full Gate must cancel stale runs");
for (const [name, source] of [["Quick Gate", quick], ["Full Gate", full]]) {
  assert(!/^concurrency:/m.test(source), `${name} must not cancel a running gate before its job event filter`);
  assert(source.includes("    concurrency:\n      group: pr-gate-${{ github.event.pull_request.number || format('manual-{0}', github.ref) }}\n      cancel-in-progress: true"), `${name} must share job-level cancellation for meaningful PR changes`);
  assert(source.includes("github.event.action != 'edited' || github.event.changes.base || (github.event.changes.title &&"), `${name} must filter unrelated PR edits before runner allocation`);
  assert(source.includes("startsWith(github.event.changes.title.from, '[FULL] ') != startsWith(github.event.pull_request.title, '[FULL] ')")
    && source.includes("startsWith(github.event.changes.title.from, '[QUICK] ') != startsWith(github.event.pull_request.title, '[QUICK] ')"), `${name} must preserve mode changes without rerunning title wording edits`);
  assert(source.includes("GATE_STEPS_JSON: ${{ toJSON(steps) }}") && source.includes("if: always()"), `${name} must summarize actual step outcomes, including interruptions`);
  assert(!source.includes('Standard lint/typecheck/build/tests/migration-lint/secret-scan: completed'), `${name} must not claim unexecuted checks completed`);
}
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
assert(full.includes("if: env.DEPLOYMENT_SENSITIVE == 'true'"), "release and backup work must remain conditional");
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

// Explicit user exception for this one CI-maintenance branch and its frozen release base.
// The shared risk classifier is unchanged. Any unrelated file, fork or base must use it normally.
const maintenanceIndex = process.argv.indexOf("--approved-quick-maintenance");
if (maintenanceIndex >= 0) {
  const allowed = new Set([
    ".github/workflows/ci.yml", ".github/workflows/full-gate.yml",
    "scripts/ci/verify-actions-policy.mjs", "scripts/ci/gate-maintenance.test.mjs",
    "docs/governance/ci-event-cost-fix-20261023.md",
  ]);
  const changed = (await readFile(process.argv[maintenanceIndex + 1], "utf8")).trim().split(/\r?\n/);
  const approved = process.env.GITHUB_REPOSITORY === "lizhonghao31-crypto/dx-rework"
    && process.env.HEAD_REPO === process.env.GITHUB_REPOSITORY
    && process.env.GITHUB_HEAD_REF === "fix/ci-event-cost-summary"
    && process.env.BASE_SHA === "cab8412cbd4d0141044f05cd71f2102e874b518f"
    && changed.length > 0 && changed.every(path => allowed.has(path))
    && changed.some(path => path.startsWith(".github/workflows/"));
  if (!approved) process.exitCode = 1;
  else console.log("APPROVED_SINGLE_PR_QUICK_MAINTENANCE");
} else console.log("ACTIONS_USAGE_POLICY_OK");
