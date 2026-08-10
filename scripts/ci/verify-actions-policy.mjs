import { readFile } from "node:fs/promises";

const files = {
  quick: ".github/workflows/ci.yml",
  full: ".github/workflows/full-gate.yml",
  governance: ".github/workflows/governance.yml",
  preview: ".github/workflows/pr-preview.yml",
};

const read = async (path) => readFile(new URL(`../../${path}`, import.meta.url), "utf8");
const [quick, full, governance, preview] = await Promise.all(Object.values(files).map(read));

const assert = (condition, message) => {
  if (!condition) throw new Error(`GitHub Actions usage policy violation: ${message}`);
};

const stepBlock = (name) => {
  const marker = `      - name: ${name}`;
  const start = quick.indexOf(marker);
  assert(start >= 0, `Quick Gate step missing: ${name}`);
  const next = quick.indexOf("\n      - name:", start + marker.length);
  return quick.slice(start, next >= 0 ? next : quick.length);
};

const businessGuard = "if: ${{ steps.classify.outputs.governance_only != 'true' }}";
const governanceGuard = "if: ${{ steps.classify.outputs.governance_only == 'true' }}";

assert(quick.includes("timeout-minutes: 5"), "Quick Gate timeout must stay at 5 minutes");
assert(quick.includes("cancel-in-progress: true"), "Quick Gate must cancel stale runs");
assert(quick.includes("node scripts/ci/verify-actions-policy.mjs"), "Quick Gate must verify its own usage policy");

const classifier = stepBlock("Classify Quick Gate scope");
assert(classifier.includes("id: classify"), "Quick Gate classifier must expose step outputs");
assert(classifier.includes("BASE_SHA"), "Quick Gate classifier must use the exact PR base SHA");
assert(classifier.includes("HEAD_SHA"), "Quick Gate classifier must use the exact PR head SHA");
assert(classifier.includes('git diff --name-only "${BASE_SHA}" "${HEAD_SHA}"'), "Quick Gate classifier must classify the exact PR diff");
assert(classifier.includes("governance_only=false"), "Quick Gate classifier must fail closed by default");
assert(classifier.includes("governance_only=true"), "Quick Gate classifier must explicitly enter governance-only mode");
assert(classifier.includes("GOVERNANCE_ONLY=${governance_only}"), "Quick Gate classifier must publish the canonical GOVERNANCE_ONLY value");
for (const allowed of [
  ".github/workflows/*",
  ".github/pull_request_template.md",
  "AGENTS.md",
  "docs/governance/*",
  "scripts/ci/*",
]) {
  assert(classifier.includes(allowed), `governance-only allowlist must include ${allowed}`);
}
assert(classifier.includes("*)\n                    governance_only=false"), "unknown paths must force governance-only classification off");

const syntaxStep = stepBlock("Verify changed governance script syntax");
assert(syntaxStep.includes(governanceGuard), "governance script syntax validation must run only for governance-only changes");
assert(syntaxStep.includes("node --check"), "governance-only changes must syntax-check changed CI scripts");

for (const name of [
  "Set up Node 22",
  "Pin npm 10",
  "Install locked dependencies",
  "Lint",
  "Typecheck",
  "Build workspaces without root postbuild business-chain gate",
  "Validate migration files statically",
  "Scan repository for committed secret signatures",
  "Write business quick-gate summary",
]) {
  assert(stepBlock(name).includes(businessGuard), `${name} must be skipped for governance-only changes`);
}

const governanceSummary = stepBlock("Write governance-only quick-gate summary");
assert(governanceSummary.includes(governanceGuard), "governance-only summary must use the governance-only guard");
assert(governanceSummary.includes("Business checks skipped: governance-only change"), "governance-only summary must not claim business checks passed");

assert(quick.includes("npm run build --workspaces --if-present"), "Quick Gate must avoid the root postbuild business-chain gate");
for (const forbidden of [
  "postgres:16-alpine",
  "npm test",
  "db:migrate:check",
  "backup-postgres.sh",
  "restore-postgres.sh",
  "pr17:acceptance",
  "package-release.sh",
  "actions/upload-artifact",
  "playwright install",
]) {
  assert(!quick.includes(forbidden), `Quick Gate must not contain ${forbidden}`);
}

assert(!/^\s*pull_request:/m.test(governance), "standalone Governance must not auto-run on pull requests");
assert(!/^\s*pull_request:/m.test(preview), "Preview must not auto-run on pull requests");
assert(full.includes("contains(github.event.pull_request.labels.*.name, 'full-gate')"), "Full Gate label guard must remain explicit");
assert(full.includes("cancel-in-progress: true"), "Full Gate must cancel stale runs");
assert(full.includes("synchronize"), "a labeled PR must re-run Full Gate when its Head changes");
assert(full.includes("Classify Full Gate risk from exact PR diff"), "Full Gate must classify the exact PR diff before heavy work");
assert(full.includes("MIGRATION_SENSITIVE"), "Full Gate must retain migration-sensitive escalation");
assert(full.includes("DEPLOYMENT_SENSITIVE"), "Full Gate must retain deployment-sensitive escalation");
assert(full.includes("DB_REQUIRED"), "Full Gate must gate PostgreSQL startup behind exact diff classification");
assert(!/^\s{4}services:/m.test(full), "Full Gate must not allocate PostgreSQL as an unconditional job service");
assert(full.includes("if: env.DB_REQUIRED == 'true'"), "PostgreSQL work must be conditional");
assert(full.includes("if: env.DEPLOYMENT_SENSITIVE == 'true'"), "release and backup work must be conditional");

console.log("ACTIONS_USAGE_POLICY_OK");
