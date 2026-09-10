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

const stepBlock = (source, name) => {
  const marker = `      - name: ${name}`;
  const start = source.indexOf(marker);
  assert(start >= 0, `workflow step missing: ${name}`);
  const next = source.indexOf("\n      - name:", start + marker.length);
  return source.slice(start, next >= 0 ? next : source.length);
};

assert(quick.includes("timeout-minutes: 5"), "Quick Gate timeout must stay at 5 minutes");
assert(quick.includes("!startsWith(github.event.pull_request.title, '[FULL]')"), "Quick Gate must skip FULL-title PRs before allocating its job");
assert(stepBlock(quick, "Require explicit Quick Gate title").includes("[QUICK]"), "Quick Gate must require an explicit QUICK title");
assert(full.includes("startsWith(github.event.pull_request.title, '[FULL]')"), "Full Gate must run only for FULL-title PRs");
assert(stepBlock(full, "Require explicit Full Gate title").includes("[FULL]"), "Full Gate must require an explicit FULL title");
for (const event of ["opened", "synchronize", "reopened", "edited"]) {
  assert(quick.includes(`- ${event}`), `Quick Gate must react to ${event}`);
  assert(full.includes(`- ${event}`), `Full Gate must react to ${event}`);
}
assert(quick.includes("cancel-in-progress: true"), "Quick Gate must cancel stale runs");
assert(full.includes("cancel-in-progress: true"), "Full Gate must cancel stale runs");
assert(quick.includes("high_risk=false"), "Quick Gate must fail closed when high-risk paths are detected");
assert(quick.includes("This diff requires [FULL] Gate"), "Quick Gate must reject a high-risk diff misclassified as QUICK");

const classifier = stepBlock(quick, "Classify Quick Gate scope");
assert(classifier.includes("BASE_SHA"), "Quick Gate classifier must use exact PR base SHA");
assert(classifier.includes("HEAD_SHA"), "Quick Gate classifier must use exact PR head SHA");
assert(classifier.includes('git diff --name-only "${BASE_SHA}" "${HEAD_SHA}"'), "Quick Gate classifier must classify exact PR diff");
assert(classifier.includes("governance_only=false"), "Quick Gate governance classifier must fail closed");
assert(classifier.includes("web_only=false"), "Quick Gate web classifier must fail closed");

for (const forbidden of [
  "postgres:16-alpine",
  "npm test",
  "db:migrate:check",
  "backup-postgres.sh",
  "restore-postgres.sh",
  "pr17:acceptance",
  "package-release.sh",
  "playwright install",
]) {
  assert(!quick.includes(forbidden), `Quick Gate must not contain ${forbidden}`);
}

assert(quick.includes("npm run build --workspaces --if-present"), "Quick Gate must avoid root postbuild");
assert(full.includes("npm ci --no-audit --no-fund --prefer-offline"), "Full Gate dependency install must remain deterministic");
assert(full.includes("Classify Full Gate risk from exact PR diff"), "Full Gate must classify exact PR diff");
assert(full.includes("DB_REQUIRED"), "Full Gate must retain conditional PostgreSQL escalation");
assert(full.includes("if: env.DB_REQUIRED == 'true'"), "PostgreSQL work must remain conditional");
assert(full.includes("if: env.DEPLOYMENT_SENSITIVE == 'true'"), "release and backup work must remain conditional");

assert(!/^\s*pull_request:/m.test(governance), "standalone Governance must not auto-run on pull requests");
assert(!/^\s*pull_request:/m.test(preview), "Preview must not auto-run on pull requests");

console.log("ACTIONS_USAGE_POLICY_OK");
