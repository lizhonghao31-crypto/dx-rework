import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { POSTGRES_CHAIN_TESTS, SLA_JOURNEY_CHAIN_EXCLUSIONS } from "../test-suite-plan.mjs";

const normalize = (path) => path.trim().replaceAll("\\", "/");

const TESTS = Object.freeze({
  access: [
    "tests/integration/master-data-pages-postgres.test.ts",
    "tests/integration/master-data-pages-native-browser-postgres.test.ts",
    "tests/integration/access-postgres.test.ts",
    "tests/integration/employee-access-lifecycle-postgres.test.ts",
    "tests/integration/full-business-chain-postgres.test.ts",
  ],
  wages: [
    "tests/integration/finance-wage-access-postgres.test.ts",
    "tests/integration/wage-settlement-postgres.test.ts",
  ],
  suppliers: [
    "tests/integration/supplier-maintenance-postgres.test.ts",
    "tests/integration/supplier-onboarding-postgres.test.ts",
  ],
  tools: [
    "tests/integration/public-tools-postgres.test.ts",
  ],
  receiving: [
    "tests/integration/receiving-postgres.test.ts",
  ],
});

// Case modules are imported by runnable Vitest suites, never CLI entry points.
export const POSTGRES_CASE_SUITES = Object.freeze({
  "tests/integration/receiving-analysis-postgres.cases.ts": "tests/integration/receiving-postgres.test.ts",
  "tests/integration/work-analysis-postgres.cases.ts": "tests/integration/sourcing-pr03-postgres.test.ts",
  "tests/integration/production-analysis-postgres.cases.ts": "tests/integration/production-closure-postgres.test.ts",
  "tests/integration/sample-analysis-postgres.cases.ts": "tests/integration/sample-read-postgres.test.ts",
  "tests/integration/member-module-policy-postgres.cases.ts": "tests/integration/full-business-chain-postgres.test.ts",
  "tests/integration/own-tail-responsibility-history.cases.ts": "tests/integration/own-tail-responsibility-history-postgres.test.ts",
});

// Reviewed test-only leaf entries. Shared permission/history wrappers stay broad.
// This changes only the automatic chain supplement, never Full or suite contents.
export const INDEPENDENT_POSTGRES_TESTS = Object.freeze([
  "tests/integration/receiving-postgres.test.ts",
  "tests/integration/sourcing-pr03-postgres.test.ts",
  "tests/integration/production-closure-postgres.test.ts",
  "tests/integration/sample-read-postgres.test.ts",
]);

// Dependency-free: resolve/certify run before npm install. This bounded lexer
// recognizes only top-level, literal, semicolon-terminated side-effect imports.
// Unsupported templates/regex before the binding fail closed, never match text.
export const hasStaticPostgresCaseImport = (source, modulePath) => {
  const expected = "./" + modulePath.split("/").at(-1).replace(/\.ts$/, ".js");
  let position = 0;
  const stack = [];
  const trivia = () => {
    while (position < source.length) {
      if (/\s/.test(source[position])) { position++; continue; }
      if (source.startsWith("//", position)) {
        const end = source.indexOf("\n", position + 2);
        position = end < 0 ? source.length : end + 1; continue;
      }
      if (source.startsWith("/*", position)) {
        const end = source.indexOf("*/", position + 2);
        if (end < 0) return false;
        position = end + 2; continue;
      }
      break;
    }
    return true;
  };
  const quoted = () => {
    const quote = source[position++];
    const start = position;
    let escaped = false;
    while (position < source.length) {
      const char = source[position++];
      if (char === "\\") { escaped = true; position++; continue; }
      if (char === quote) return {value: source.slice(start, position - 1), escaped};
      if (char === "\n" || char === "\r") return null;
    }
    return null;
  };
  while (position < source.length) {
    if (!trivia()) return false;
    const char = source[position];
    if (char === undefined) break;
    if (char === "'" || char === '"') { if (!quoted()) return false; continue; }
    if (char === "\x60" || char === "/") return false;
    if (/[A-Za-z_$]/.test(char)) {
      const start = position++;
      while (position < source.length && /[\w$]/.test(source[position])) position++;
      if (source.slice(start, position) !== "import" || stack.length) continue;
      if (!trivia()) return false;
      if (source[position] !== "'" && source[position] !== '"') continue;
      const literal = quoted();
      if (!literal || !trivia()) return false;
      if (source[position] === ";" && !literal.escaped && literal.value === expected) return true;
      continue;
    }
    if ("({[".includes(char)) stack.push(char);
    else if (")}]".includes(char)) {
      const open = stack.pop();
      if (open !== {")":"(", "}":"{", "]":"["}[char]) return false;
    }
    position++;
  }
  return false;
};

export const assertStaticPostgresCaseImport = (source, module, owner) => {
  if (!hasStaticPostgresCaseImport(source, module)) {
    throw new Error(`POSTGRES_CASE_IMPORT_REQUIRED: ${module} -> ${owner}`);
  }
};

const independentTestOnlyChange = (paths) => {
  if (!paths.length) return false;
  const owners = new Set();
  let eligible = true;
  for (const path of paths) {
    const owner = POSTGRES_CASE_SUITES[path] ?? path;
    if (!INDEPENDENT_POSTGRES_TESTS.includes(owner) || !existsSync(path) || !existsSync(owner)) {
      eligible = false;
      continue;
    }
    // Validate all known case bindings even if only the owner changed, and even
    // in a mixed diff. A broad chain cannot execute a case whose import is gone.
    for (const [module, runnable] of Object.entries(POSTGRES_CASE_SUITES)) {
      if (runnable !== owner) continue;
      if (!existsSync(module)) {
        throw new Error(`POSTGRES_CASE_IMPORT_REQUIRED: ${module} -> ${owner}`);
      }
      assertStaticPostgresCaseImport(readFileSync(owner, "utf8"), module, owner);
    }
    owners.add(owner);
  }
  return eligible && owners.size === 1;
};

// Reviewed source-domain profile, not a global backend exception. The original
// mapped readers and shared-write/security bridges stay mandatory; only
// independently audited, non-consuming suites are omitted from the supplement.
export const SLA_JOURNEY_SOURCE_PATHS = Object.freeze([
  "apps/api/src/production-platform/development-captured-window.ts",
  "apps/api/src/production-platform/development-craft-instance-evidence.ts",
  "apps/api/src/production-platform/development-sla-evidence.ts",
  "apps/api/src/production-platform/fixed-schedule-basis.ts",
  "apps/api/src/production-platform/fixed-schedule-progress.ts",
  "apps/api/src/production-platform/journey-display.ts",
  "apps/api/src/production-platform/journey-fact-generation.ts",
  "apps/api/src/production-platform/journey-fact-model.ts",
  "apps/api/src/production-platform/journey-fact-repository.ts",
  "apps/api/src/production-platform/journey-fact-updates.ts",
  "apps/api/src/production-platform/journey-native-times.ts",
  "apps/api/src/production-platform/journey-progress-dates.ts",
  "apps/api/src/production-platform/journey-projection.ts",
  "apps/api/src/production-platform/journey-query.ts",
  "apps/api/src/production-platform/journey-selection-clock.ts",
  "apps/api/src/production-platform/journey-selection-facts.ts",
  "apps/api/src/production-platform/journey-selection-query.ts",
  "apps/api/src/production-platform/journey-supervision.ts",
  "apps/api/src/production-platform/journey-terminal-timing.ts",
  "apps/web/src/cockpit-fixed-schedule.tsx",
  "apps/web/src/cockpit-node-summary.tsx",
  "apps/web/src/digital-journey-cockpit-model.ts",
  "apps/web/src/journey-sla-details.tsx",
  "packages/contracts/src/digital-production-journey.ts",

]);
export const SLA_JOURNEY_SUPPORT_PATHS = Object.freeze([
  "docs/engineering/acceptance-time-sites-20261027.json",
  "docs/engineering/construction-evidence.json",
  "docs/engineering/sla-repair-rp2.md",
  "tests/integration/digital-journey-postgres.test.ts",
  "tests/integration/effective-packing-postgres.test.ts",
  "tests/integration/fixed-progress-postgres.test.ts",
  "tests/integration/journey-fact-model-postgres.test.ts",
  "tests/integration/order-time-requests-postgres.test.ts",
  "tests/integration/special-craft-native-postgres.test.ts",
  "tests/unit/development-captured-window.test.ts",
  "tests/unit/development-craft-instance-supervision.test.ts",
  "tests/unit/development-ordinary-instance-projection.test.ts",
  "tests/unit/development-round-window-projection.test.ts",
  "tests/unit/digital-journey-projection.test.ts",
  "tests/unit/digital-pmc-readonly-access.test.ts",
  "tests/unit/fixed-schedule-progress.test.ts",
  "tests/unit/fixed-schedule-selection.test.ts",
  "tests/unit/journey-compatible-fallback.test.ts",
  "tests/unit/journey-fact-model.test.ts",
  "tests/unit/journey-native-times.test.ts",
  "tests/unit/journey-packing-native-time.test.ts",
  "tests/unit/journey-progress-dates.test.ts",
  "tests/unit/journey-projection-isolation.test.ts",
  "tests/unit/journey-terminal-timing.test.ts",
  "tests/unit/m01-time-consumers.test.ts",
  "tests/unit/sla-native-window-projection.test.ts"
]);
export const SLA_JOURNEY_REQUIRED_TESTS = Object.freeze([
  "tests/integration/bulk-washing-postgres.test.ts",
  "tests/integration/terminal-quality-projections-browser-postgres.test.ts",
  "tests/integration/order-time-washing-rework-postgres.test.ts",
  "tests/integration/order-time-washing-rework-browser-postgres.test.ts",
  "tests/integration/development-execution-read-native-browser-postgres.test.ts",
  "tests/integration/development-responsibility-postgres.test.ts",
  "tests/integration/development-round-history-clock-postgres.test.ts",
  "tests/integration/development-sla-enrollment-postgres.test.ts",
  "tests/integration/development-technical-postgres.test.ts",
  "tests/integration/digital-journey-postgres.test.ts",
  "tests/integration/digital-production-tasks-postgres.test.ts",
  "tests/integration/effective-packing-postgres.test.ts",
  "tests/integration/factory-logistics-cockpit-postgres.test.ts",
  "tests/integration/fixed-progress-postgres.test.ts",
  "tests/integration/fixed-timeline-native-browser-postgres.test.ts",
  "tests/integration/fixed-timeline-postgres.test.ts",
  "tests/integration/journey-diagnostic-postgres.test.ts",
  "tests/integration/journey-fact-model-postgres.test.ts",
  "tests/integration/journey-fact-updates-postgres.test.ts",
  "tests/integration/journey-page-native-browser-postgres.test.ts",
  "tests/integration/m01-cockpit-home-native-browser-postgres.test.ts",
  "tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts",
  "tests/integration/m01-journey-performance-postgres.test.ts",
  "tests/integration/order-time-reading-postgres.test.ts",
  "tests/integration/order-time-requests-browser-postgres.test.ts",
  "tests/integration/order-time-requests-postgres.test.ts",
  "tests/integration/order-time-settings-postgres.test.ts",
  "tests/integration/production-readiness-postgres.test.ts",
  "tests/integration/sourcing-pr03-postgres.test.ts",
  "tests/integration/special-craft-browser-postgres.test.ts",
  "tests/integration/special-craft-library-postgres.test.ts",
  "tests/integration/special-craft-native-postgres.test.ts",
  "tests/integration/supplychain-board-native-browser-postgres.test.ts",
  "tests/integration/time-framework-cockpit-native-browser-postgres.test.ts",
  "tests/integration/workspace-page-facts-postgres.test.ts",
  "tests/integration/workspace-page-native-browser-postgres.test.ts"
]);
export const SLA_JOURNEY_UNRELATED_CHAIN_TESTS = SLA_JOURNEY_CHAIN_EXCLUSIONS;
const slaJourneyProfileApplies = paths => paths.some(path => SLA_JOURNEY_SOURCE_PATHS.includes(path))
  && paths.every(path => existsSync(path) && (SLA_JOURNEY_SOURCE_PATHS.includes(path) || SLA_JOURNEY_SUPPORT_PATHS.includes(path)));

const isMigration = (path) =>
  path.startsWith("apps/api/migrations/")
  || path.startsWith("scripts/deploy/migration-execution-compatibility.")
  || path === "apps/api/src/platform/migration-manifest.json"
  || path === "scripts/deploy/acceptance-migration-requirements.json"
  || [
    "scripts/seed-base-migrations.sh",
    "scripts/migrate.mjs",
    "scripts/migration-lib.mjs",
    "scripts/migration-integration-check.mjs",
    "scripts/migration-history-policy.mjs",
    "scripts/migration-branches.json",
    "scripts/migration-main-extensions.json",
    "scripts/check-migration-export.mjs",
    "scripts/check-migrations.mjs",
  ].includes(path);

// Shared gate selection/receipt code still requires Full and the real DB chain.
// It does not itself migrate, back up, activate or transfer a release.
const SHARED_GATE_INPUTS = new Set([
  ".github/workflows/ci.yml",
  ".github/workflows/full-gate.yml",
  "scripts/ci/full-gate-risk-map.mjs",
  "scripts/ci/ci-gate-runtime.mjs",
  "scripts/ci/full-gate-lanes.mjs",
  "scripts/ci/impact-shadow.mjs",
  "scripts/ci/impact-shadow-graph.mjs",
  "scripts/ci/impact-shadow-binding.mjs",
  "scripts/ci/impact-shadow-policy.json",
  "scripts/ci/pr-gate-protocol.mjs",
  "scripts/ci/pr-gate-controller.mjs",
  "scripts/ci/verify-actions-policy.mjs",
  "scripts/ci/light-reuse.mjs",
  "scripts/ci/construction-evidence.mjs",
]);

// Business migrations and their inventories are validated and applied to the
// fresh test DB. Historical upgrade/recovery simulations are tool-change or
// explicit pre-release checks, rather than a requirement for each business PR.
const isMigrationTool = (path) => isMigration(path)
  && !path.startsWith("apps/api/migrations/")
  && ![
    "apps/api/src/platform/migration-manifest.json",
    "scripts/deploy/acceptance-migration-requirements.json",
    "scripts/migration-branches.json",
    "scripts/migration-main-extensions.json",
  ].includes(path);

const isDeployment = (path) =>
  (path.startsWith("scripts/deploy/") && path !== "scripts/deploy/acceptance-migration-requirements.json" && !path.startsWith("scripts/deploy/migration-execution-compatibility."))
  || path === "scripts/dx-acceptance.sh"
  || path === "scripts/ci/acceptance-maintenance-drill.mjs"
  || path === "scripts/ci/main-release-history-drill.mjs"
  || path === "scripts/check-main-release-compat.mjs"
  || path === "docs/operations/g1-acceptance-compat-update.sh"
  || path === "scripts/backup-postgres.sh"
  || path === "scripts/restore-postgres.sh"
  || path.startsWith("infra/")
  || path.startsWith(".github/workflows/")
  || SHARED_GATE_INPUTS.has(path);

const isBackendOrContract = (path) =>
  path.startsWith("apps/api/src/") || path.startsWith("packages/contracts/src/") || path.startsWith("packages/domain/src/");

const isPostgresTest = (path) =>
  /^tests\/integration\/.*postgres.*\.(?:test|cases)\.ts$/.test(path);


const matchesAccess = (path) =>
  path.startsWith("apps/api/src/access/")
  || path.startsWith("apps/api/src/auth/")
  || path === "packages/contracts/src/employee-access.ts";

const matchesWages = (path) =>
  path.startsWith("apps/api/src/wages/")
  || path === "packages/contracts/src/wages.ts"
  || path === "packages/contracts/src/finance-access.ts"
  || /^apps\/api\/src\/reporting\/(?:finance-|management-reporting-financial)/.test(path);

const matchesSuppliers = (path) =>
  /^apps\/api\/src\/access\/supplier-/.test(path)
  || /^packages\/contracts\/src\/supplier-/.test(path);

const matchesTools = (path) =>
  path.startsWith("apps/api/src/tools/");

const matchesReceiving = (path) =>
  path.startsWith("apps/api/src/receiving/")
  || /^packages\/contracts\/src\/receiving/.test(path);

const matchesPatternRoom = (path) =>
  path.startsWith("apps/api/src/pattern-room/")
  || /^packages\/contracts\/src\/pattern/.test(path);

// Reviewed P02/P03 correction inputs, including HTTP adapters, effective reads,
// returned-material prerequisites and the long generated pattern-size consumer.
// A generic backend fallback remains the existing chain; it is not every PG suite.
const DEVELOPMENT_AMENDMENT_INPUTS = new Set([
  "apps/api/src/production-platform/development-document-format.ts",
  "apps/api/src/production-platform/development-commercial-fields.ts",
  "apps/api/src/production-platform/quotation-assembly.ts",
  "apps/api/src/production-platform/quotation-material-unit.ts",
  "apps/api/src/production-platform/development-amendment-service.ts",
  "apps/api/src/production-platform/development-amendment-repository.ts",
  "apps/api/src/production-platform/development-service.ts",
  "apps/api/src/production-platform/development-routes.ts",
  "apps/api/src/production-platform/development-execution-service.ts",
  "apps/api/src/production-platform/development-execution-read.ts",
  "apps/api/src/production-platform/development-execution-routes.ts",
  "apps/api/src/production-platform/development-supply.ts",
  "apps/api/src/production-platform/development-material-reopen.ts",
  "apps/api/src/production-platform/development-material-verification.ts",
  "apps/api/src/production-platform/development-material-readiness.ts",
  "apps/api/src/production-platform/development-material-check-rules.ts",
  "apps/api/src/production-platform/development-round-repository.ts",
  "apps/api/src/production-platform/development-round-service.ts",
  "apps/api/src/production-platform/development-route-service.ts",
  "apps/api/src/production-platform/development-route.ts",
  "apps/api/src/production-platform/access-policy.ts",
  "apps/api/src/pattern-room/order-service.ts",
  "packages/contracts/src/digital-development.ts",
  "packages/contracts/src/digital-development-amendments.ts",
  "packages/contracts/src/digital-development-execution.ts",
  "packages/contracts/src/pattern-orders.ts",
]);

const addAll = (target, values) => {
  for (const value of values) target.add(value);
};

export const classifyFullGatePaths = (inputPaths) => {
  const paths = [...new Set(inputPaths.map(normalize).filter(Boolean))];
  const independentTestOnly = independentTestOnlyChange(paths);
  let chainProfile = "full";
  const mappedTests = new Set();
  if(paths.some(path=>/packing-quality-coverage|terminal-quality-projections|digital-journey-cockpit-model|order-time-rewash-fixture|apps\/web\/src\/cockpit-home\.tsx/.test(path)))addAll(mappedTests,['tests/integration/terminal-quality-projections-browser-postgres.test.ts','tests/integration/bulk-washing-postgres.test.ts']);
  if(paths.some(path=>/washing-rework|order-time-rewash|0295_order_time_rewash_input/.test(path)||/^apps\/api\/src\/production-platform\/(?:bulk-washing-service|order-time-(?:plan-repository|operation-state|request-(?:service|routes)|reading|native-timing)|fixed-schedule-(?:basis|progress)|journey-time-framework)\.ts$/.test(path)))addAll(mappedTests,['tests/integration/order-time-washing-rework-postgres.test.ts','tests/integration/order-time-washing-rework-browser-postgres.test.ts']);
  if(paths.some(path=>/factory-(?:task-completion|completion-occurrence)|production-facts-consistency|receiving-(?:service|routes|board-edit-session)|order-board-page|0294_receiving_correction_provenance/.test(path)))addAll(mappedTests,['tests/integration/production-facts-consistency-postgres.test.ts','tests/integration/receiving-postgres.test.ts','tests/integration/receiving-board-native-browser-postgres.test.ts','tests/integration/factory-logistics-cockpit-postgres.test.ts']);
  if(paths.some(path=>/development-responsibility|order-time-native-timing|order-time-reading|development-sla-evidence|journey-task-summary|task-service|digital-production-tasks-panel/.test(path)))addAll(mappedTests,['tests/integration/development-responsibility-postgres.test.ts','tests/integration/development-execution-read-native-browser-postgres.test.ts','tests/integration/digital-production-tasks-postgres.test.ts']);
  if(paths.some(path=>/^apps\/web\/src\/(?:document-upload-previews|digital-development-execution-panel|development-external-pattern|development-result-upload|task-workbench-sample)\.tsx$/.test(path)))addAll(mappedTests,['tests/integration/development-execution-read-native-browser-postgres.test.ts','tests/integration/digital-development-execution-postgres.test.ts','tests/integration/development-technical-postgres.test.ts']);
  if(paths.some(path=>/budget-washing-fee|0293_budget_washing_fee_supplements|digital-budget|budget-service|budget-routes|bulk-washing-repository/.test(path)))addAll(mappedTests,['tests/integration/budget-washing-fees-postgres.test.ts','tests/integration/budget-washing-fees-browser-postgres.test.ts','tests/integration/digital-budget-shared-postgres.test.ts','tests/integration/customer-quotation-postgres.test.ts','tests/integration/bulk-washing-postgres.test.ts']);
  if(paths.some(path=>/cockpit|journey-visual-progress|journey-framework-events|journey-time-framework|journey-time-ratio|framework-node-targets|time-framework-journey|fixed-schedule-basis|order-time-activation|special-craft-activation/.test(path)))addAll(mappedTests,['tests/integration/time-framework-cockpit-native-browser-postgres.test.ts']);
  if(paths.some(path=>/bulk-washing|factory-flow-(?:service|panel|read)|production-closure-service|production-reporting-service|garment-quality|packing-quality-coverage|receiving-service|todo-destination/.test(path)))addAll(mappedTests,['tests/integration/bulk-washing-postgres.test.ts','tests/integration/bulk-washing-browser-postgres.test.ts']);
  if(paths.some(path=>/special-craft|digital-craft|sla-settings-workspace|task-routes|task-service|development-craft-instance-evidence|task-craft-display|development-sla-evidence|journey-supervision|journey-task-summary/.test(path)))addAll(mappedTests,['tests/integration/special-craft-library-postgres.test.ts','tests/integration/special-craft-native-postgres.test.ts','tests/integration/special-craft-browser-postgres.test.ts']);
  if(paths.some(path=>/quotation|development-commercial-fields|0288_automatic_quotation_sources/.test(path))){
    addAll(mappedTests,['tests/integration/customer-quotation-postgres.test.ts','tests/integration/development-technical-postgres.test.ts','tests/integration/automatic-quotation-native-browser-postgres.test.ts']);
  }
  if(paths.some(path=>/development-comment-time|customer-comment-time-fields/.test(path)))addAll(mappedTests,['tests/integration/development-technical-postgres.test.ts','tests/integration/series-plan-postgres.test.ts','tests/integration/order-time-requests-browser-postgres.test.ts']);
  if(paths.some(path=>path==='apps/api/src/production-platform/task-readiness-facts.ts'))addAll(mappedTests,[
    'tests/integration/production-readiness-postgres.test.ts',
    'tests/integration/development-technical-postgres.test.ts',
    'tests/integration/digital-production-tasks-postgres.test.ts',
    'tests/integration/journey-fact-model-postgres.test.ts',
  ]);
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/development-execution-(?:read|service|routes)\.ts$/.test(path))) addAll(mappedTests,[
    "tests/integration/digital-development-execution-postgres.test.ts",
    "tests/integration/development-sla-enrollment-postgres.test.ts",
    "tests/integration/development-technical-postgres.test.ts",
    "tests/integration/development-execution-read-native-browser-postgres.test.ts",
  ]);
  const domains = new Set();
  if(paths.some(path=>/digital-production-read-requests|digital-production-api|digital-development-create-form|public-error-message|platform-method-error-feedback/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-requests-browser-postgres.test.ts','tests/integration/m01-short-lead-native-browser-postgres.test.ts','tests/integration/request-identity-postgres.test.ts']);
    domains.add('native-read-check-and-command-outcome');
  }
  if(paths.some(path=>/journey-(?:time-framework|washing-(?:facts|projection))|time-framework-journey/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-requests-postgres.test.ts','tests/integration/order-time-reading-postgres.test.ts','tests/integration/journey-fact-model-postgres.test.ts','tests/integration/m01-journey-performance-postgres.test.ts','tests/integration/bulk-washing-postgres.test.ts']);
    domains.add('time-framework-journey-reading');
  }
  if(paths.some(path=>/first-effective-receipt|factory-delivery-reading|receiving-span|factory-return-logistics/.test(path))){addAll(mappedTests,['tests/integration/fixed-progress-postgres.test.ts','tests/integration/order-time-reading-postgres.test.ts','tests/integration/m01-journey-performance-postgres.test.ts']);domains.add('native-first-delivery');}
  if(paths.some(path=>/whole-order-(?:deletion|native-deletion|visibility)|cockpit-order-deletion|0287_whole_order/.test(path))){addAll(mappedTests,['tests/integration/whole-order-deletion-postgres.test.ts','tests/integration/whole-order-deletion-browser-postgres.test.ts']);domains.add('whole-order-deletion');}
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/(?:fixed-development-work|fixed-order-work|fixed-work-definition)\.ts$/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-requests-postgres.test.ts','tests/integration/order-time-requests-browser-postgres.test.ts']);
    domains.add('native-craft-choice-boundary');
  }
  if(paths.some(path=>/order-time-(?:request|admission|automatic|native|operation|application|publication|production-route|route-identities|factory-commitments|washing)|0286_order_time_requests/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-requests-postgres.test.ts','tests/integration/order-time-requests-browser-postgres.test.ts','tests/integration/order-time-reading-postgres.test.ts','tests/integration/order-time-settings-postgres.test.ts','tests/integration/development-technical-postgres.test.ts','tests/integration/development-round-history-clock-postgres.test.ts','tests/integration/production-readiness-postgres.test.ts']);
    domains.add('order-time-first-effective-and-requests');
  }
  if(paths.some(path=>/order-time-(?:settings|standard-editor|calculator|node-fields|route-fields|milestone-fields)|customer-default-merchandisers|customer-merchandiser-defaults|order-merchandisers|additional-merchandisers|digital-customer-merchandisers|0285_order_time_settings_and_merchandisers/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-settings-postgres.test.ts','tests/integration/customer-default-merchandisers-postgres.test.ts','tests/integration/r5-settings-native-browser-postgres.test.ts','tests/integration/m01-settings-native-browser-postgres.test.ts','tests/integration/digital-production-identity-postgres.test.ts']);
    domains.add('order-time-settings-and-merchandisers');
  }
  if(paths.some(path=>/framework-node-targets|order-time-(?:framework|completion-target|plan|schedule|reading)|cutting-completion-facts|0284_order_time_plan_versions/.test(path))){
    addAll(mappedTests,['tests/integration/order-time-plan-postgres.test.ts','tests/integration/order-time-reading-postgres.test.ts','tests/integration/fixed-timeline-postgres.test.ts','tests/integration/fixed-progress-postgres.test.ts']);
    domains.add('order-time-plan-core');
  }
  if(paths.some(path=>['apps/api/src/production-platform/development-occurrence.ts','apps/web/src/development-occurrence-input.tsx','apps/web/src/development-material-event-form.tsx'].includes(path))){
    addAll(mappedTests,['tests/integration/digital-development-execution-postgres.test.ts','tests/integration/production-readiness-postgres.test.ts']);
    domains.add('native-development-occurrence');
  }
  if(paths.some(path=>['apps/api/src/production-platform/sourcing-owner-readiness.ts','apps/api/src/production-platform/sourcing-todo-sla.ts','apps/api/src/production-platform/access-service.ts','apps/api/src/sourcing/sourcing-service.ts','tests/integration/sourcing-owner-readiness-postgres.test.ts'].includes(path))){
    mappedTests.add('tests/integration/sourcing-owner-readiness-postgres.test.ts');domains.add('sourcing-owner-readiness');
  }
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/(?:fixed-[^/]+|factory-step-ledger)\.ts$/.test(path)
    || ['packages/contracts/src/digital-craft.ts','apps/web/src/independent-craft-field.tsx','apps/web/src/independent-craft-field.css','apps/api/migrations/0281_fixed_timeline_adoptions.sql'].includes(path))){
    addAll(mappedTests,['tests/integration/fixed-timeline-postgres.test.ts','tests/integration/fixed-timeline-native-browser-postgres.test.ts',
      'tests/integration/development-sla-enrollment-postgres.test.ts','tests/integration/development-technical-postgres.test.ts',
      'tests/integration/production-readiness-postgres.test.ts','tests/integration/factory-logistics-cockpit-postgres.test.ts','tests/integration/sourcing-pr03-postgres.test.ts']);
    domains.add('fixed-timeline-native-crafts');
  }
  if(paths.some(path=>/sla-settings-(?:sets|set-repository|calculation)|0283_sla_settings_sets|supplychain-settings-browser/.test(path))){
    addAll(mappedTests,['tests/integration/sla-settings-sets-postgres.test.ts','tests/integration/m01-settings-native-browser-postgres.test.ts','tests/integration/sla-settings-drafts-postgres.test.ts','tests/integration/fixed-timeline-postgres.test.ts','tests/integration/series-plan-postgres.test.ts']);
    domains.add('settings-atomic-sets');
  }
  if(paths.some(path=>/fixed-(?:schedule|rework|task-targets)|0282_journey_fixed_progress|fixed-progress-postgres/.test(path))){
    addAll(mappedTests,['tests/integration/fixed-progress-postgres.test.ts','tests/integration/journey-fact-model-postgres.test.ts','tests/integration/journey-fact-updates-postgres.test.ts','tests/integration/fixed-timeline-postgres.test.ts']);
    domains.add('fixed-schedule-progress');
  }
  if(paths.some(path=>['apps/api/src/receiving/packing-receipt-allocations.ts','apps/api/src/production-platform/packing-scope-readiness.ts','apps/api/src/production-platform/packing-readiness-evidence.ts','apps/api/src/production-platform/packing-allocation-evidence.ts','apps/api/src/receiving/packing-actual-time.ts','apps/api/src/receiving/packing-alias-invalidation.ts','apps/api/src/receiving/receiving-service.ts','apps/api/src/receiving/receiving-quantity-query.ts','apps/api/src/receiving/receiving-board-query.ts','apps/api/src/receiving/receiving-board-filters.ts','apps/api/src/receiving/receiving-analysis.ts','apps/api/src/production-platform/order-closure-service.ts','apps/api/src/production-platform/packing-sla-evidence.ts','apps/api/src/production-platform/packing-quality-coverage.ts','apps/api/src/production-platform/delivery-calendar-facts.ts','packages/contracts/src/receiving-packing-time.ts','tests/integration/effective-packing-postgres.test.ts'].includes(path))){
    mappedTests.add('tests/integration/effective-packing-postgres.test.ts');
    domains.add('effective-packing-scope');
  }
  let migrationSensitive = false;
  let receivingSensitive = false;
  let businessChainSensitive = false;
  let deploymentSensitive = false;
  let journeyPg13Compat = false;
  let maintenanceSensitive = false;
  let activationSensitive = false;
  let transferSensitive = false;
  if(paths.some(path=>['apps/api/src/wages/wage-service.ts','apps/api/src/wages/wage-routes.ts','tests/helpers/wage-page-fixture.ts','tests/integration/wage-period-pages-postgres.test.ts'].includes(path))){for(const suite of ['wage-period-pages','wage-period-pages-native-browser'])mappedTests.add('tests/integration/'+suite+'-postgres.test.ts');domains.add('wage-period-pages');}
  if(paths.some(path=>/^apps\/api\/src\/rework\/(?:responsibility-determination-queue-service|own-factory-approval-service|external-responsibility-service|production-external-responsibility-service|queue-page)\.ts$/.test(path)||path==='tests/integration/responsibility-queue-pages-postgres.test.ts'||path==='tests/helpers/responsibility-queue-fixture.ts')){
    for(const suite of ['responsibility-queue-pages','responsibility-queue-pages-native-browser'])mappedTests.add('tests/integration/'+suite+'-postgres.test.ts');domains.add('responsibility-queue-pages');
  }
  if(paths.some(path=>/^apps\/web\/src\/sourcing-(?:workspace-page|detail-[^/]+|price-reapplication)\.tsx?$/.test(path)||path==='tests/integration/sourcing-detail-native-browser-postgres.test.ts')){mappedTests.add('tests/integration/sourcing-detail-native-browser-postgres.test.ts');domains.add('sourcing-detail-browser');}
  if(paths.some(path=>/^apps\/web\/src\/(?:packing-receipt-allocation-fields|order-board-page|receiving-board-(?:read|edit-session|types|request))\.tsx?$/.test(path)||path==='tests/integration/receiving-board-native-browser-postgres.test.ts')){mappedTests.add('tests/integration/receiving-board-native-browser-postgres.test.ts');domains.add('receiving-board-browser');}
  if(paths.some(path=>['apps/api/src/sourcing/sourcing-service.ts','apps/api/src/sourcing/sourcing-case-read.ts','apps/api/src/sourcing/sourcing-case-mapping.ts','tests/integration/sourcing-page-details-postgres.test.ts'].includes(path))){
    for(const suite of ['sourcing-page-details','contract-return-clock','contract-return-routes-clock','contract-return-cycles'])mappedTests.add('tests/integration/'+suite+'-postgres.test.ts');domains.add('sourcing-page-details');
  }
  if(paths.some(path=>/^apps\/api\/src\/todos\/(?:service|selection|content-reads|global-search)\.ts$/.test(path)||path==='apps/api/src/production-platform/notification-service.ts')){
    for(const suite of ['todo-global-search','digital-my-todo-context','digital-production-notifications'])mappedTests.add('tests/integration/'+suite+'-postgres.test.ts');
    domains.add('todo-read-split');
  }
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/(?:development-workspace-query|journey-workspace-facts|journey-selection-query|journey-query)\.ts$/.test(path)||['packages/contracts/src/digital-development-workspace.ts','apps/web/src/digital-designer-workspace.tsx','apps/web/src/digital-pattern-workspace.tsx','tests/integration/workspace-page-facts-postgres.test.ts','tests/integration/workspace-page-native-browser-postgres.test.ts'].includes(path))){
    mappedTests.add('tests/integration/workspace-page-facts-postgres.test.ts');mappedTests.add('tests/integration/workspace-page-native-browser-postgres.test.ts');domains.add('workspace-page-reads');
  }
  if(paths.some(path=>['apps/web/src/cockpit-photo-preview.tsx','tests/acceptance/cockpit-thumbnail-fixture.ts','tests/acceptance/m01-cockpit-home-native-browser.ts','tests/fixtures/m01-cockpit-home-native-ui.tsx','tests/integration/cockpit-thumbnails-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/cockpit-thumbnails-native-browser-postgres.test.ts');domains.add('cockpit-thumbnails-browser');}
  if(paths.some(path=>['apps/api/src/tools/attachment-image-preview.ts','apps/api/src/tools/attachments.ts','apps/api/src/tools/storage.ts','apps/api/src/tools/aliyun-oss-v4-client.ts','apps/api/src/production-platform/development-routes.ts','apps/api/src/production-platform/development-service.ts','apps/api/src/production-platform/production-instruction-routes.ts','apps/web/src/cockpit-photo-preview.tsx','tests/integration/attachment-image-preview-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/attachment-image-preview-postgres.test.ts');domains.add('private-image-previews');}
  if(paths.some(path=>['apps/web/src/App.tsx','apps/web/src/main.tsx','apps/web/src/lazy-business-page.tsx','tests/integration/module-bundles-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/module-bundles-native-browser-postgres.test.ts');domains.add('business-module-bundles');}
  if(paths.some(path=>['apps/web/src/cockpit-fixed-schedule.tsx','apps/web/src/components.tsx','apps/api/src/production-platform/journey-visual-progress.ts','packages/contracts/src/fixed-schedule-progress.ts','tests/integration/supplychain-board-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/supplychain-board-native-browser-postgres.test.ts');mappedTests.add('tests/integration/fixed-progress-postgres.test.ts');domains.add('supplychain-board-integration');}
  if(paths.some(path=>/^apps\/web\/src\/(?:cockpit-home(?:-[^/]*)?|cockpit-detail(?:-[^/]*)?|cockpit-stage-progress|cockpit-documents|cockpit-operation-log|node-materials-panel|cockpit-timing-coverage|digital-journey-cockpit)\.(?:tsx?|css)$/.test(path)||['apps/api/src/production-platform/journey-projection.ts','packages/contracts/src/digital-production-journey.ts','tests/acceptance/m01-cockpit-home-native-browser.ts','tests/fixtures/m01-cockpit-home-native-ui.tsx','tests/integration/supplychain-board-native-browser-postgres.test.ts', 'tests/integration/m01-cockpit-home-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/m01-cockpit-home-native-browser-postgres.test.ts');domains.add('cockpit-home-browser');}
  if (paths.some(path => path.startsWith('apps/api/src/auth/') || path === 'packages/config/src/index.ts' || path === 'tests/integration/acceptance-session-retention-postgres.test.ts')) {
    mappedTests.add('tests/integration/acceptance-session-retention-postgres.test.ts');
    domains.add('acceptance-session-retention');
  }
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/journey-(?:selection[^/]*|query|fact-updates)\.ts$/.test(path)||['apps/web/src/cockpit-reads.ts','apps/web/src/cockpit-home.tsx','apps/web/src/digital-journey-cockpit.tsx','packages/contracts/src/digital-production-journey.ts','tests/integration/journey-page-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-page-native-browser-postgres.test.ts');domains.add('journey-page-reads');}
  if(paths.some(path=>['apps/api/src/production-platform/journey-fact-updates.ts','apps/api/src/production-platform/journey-fact-repository.ts','apps/api/src/server.ts','apps/api/migrations/0279_journey_fact_incremental_updates.sql','tests/integration/journey-fact-updates-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-fact-updates-postgres.test.ts');domains.add('journey-fact-updates');}
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/journey-fact-(?:model|repository)\.ts$/.test(path)||['apps/api/src/production-platform/journey-query.ts','apps/api/src/production-platform/journey-supervision.ts','apps/api/src/production-platform/journey-cut-scopes.ts','apps/api/src/production-platform/journey-termination.ts','apps/api/src/production-platform/order-closure-service.ts','apps/api/src/production-platform/sla-order-service.ts','apps/api/src/production-platform/bulk-preparation-service.ts','apps/api/migrations/0278_journey_fact_read_model.sql','tests/integration/journey-fact-model-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-fact-model-postgres.test.ts');domains.add('journey-fact-model');}
  if(paths.some(path=>['apps/api/src/production-platform/journey-query.ts','apps/api/src/production-platform/journey-snapshot-reads.ts','apps/api/src/production-platform/journey-snapshot-batches.ts','apps/api/src/production-platform/journey-batch-templates.ts','apps/api/src/production-platform/journey-task-summary.ts','tests/integration/m01-journey-performance-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/m01-journey-performance-postgres.test.ts');domains.add('journey-request-batches');}
  if(paths.some(path=>['tests/acceptance/m01-current-production-native-browser.ts','tests/fixtures/m01-current-production-native-ui.tsx'].includes(path))){for(const suite of ['m01-current-production','m01-production-period','m01-production-collaboration'])mappedTests.add('tests/integration/'+suite+'-native-browser-postgres.test.ts');domains.add('shared-production-browser');}
  if(paths.some(path=>/production-collaboration|m01-production-collaboration/.test(path))){mappedTests.add('tests/integration/m01-production-collaboration-postgres.test.ts');mappedTests.add('tests/integration/m01-production-collaboration-native-browser-postgres.test.ts');domains.add('production-collaboration');}
  if(paths.some(path=>/production-period|m01-production-period/.test(path))){mappedTests.add('tests/integration/m01-production-period-postgres.test.ts');mappedTests.add('tests/integration/m01-production-period-native-browser-postgres.test.ts');domains.add('production-period');}
  if(paths.some(path=>/^apps\/web\/src\/delivery-calendar(?:-[^/]*)?\.(?:tsx?|css)$/.test(path)||/^apps\/api\/src\/production-platform\/delivery-calendar-(?:query|images|debt-summary)\.ts$/.test(path)||path==='packages/contracts/src/delivery-calendar.ts'||['apps/web/src/digital-cockpit-page.tsx','apps/web/src/digital-journey-cockpit-model.ts','tests/acceptance/m01-cockpit-home-native-browser.ts','tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/m01-delivery-calendar-native-browser-postgres.test.ts');domains.add('delivery-calendar-browser');}
  if(paths.some(path=>/^(?:apps\/api\/src\/production-platform|packages\/(?:contracts|domain)\/src)\/delivery-calendar(?:-[^/]*)?\.ts$/.test(path)||path==='tests/integration/m01-delivery-calendar-postgres.test.ts')){mappedTests.add('tests/integration/m01-delivery-calendar-postgres.test.ts');domains.add('delivery-calendar');}
  if(paths.some(path=>/^(?:apps\/web\/src\/current-production|apps\/api\/src\/production-platform\/production-statistics-(?:groups|dimensions)|tests\/(?:acceptance|fixtures|integration)\/m01-current-production)/.test(path))){mappedTests.add('tests/integration/m01-current-production-native-browser-postgres.test.ts');domains.add('current-production-browser');}


  for (const path of paths) {
    if (/^apps\/web\/src\/(?:short-lead-(?:panel|workspace)|digital-development-(?:create-form|editing)|digital-detail-route|digital-production-page|todo-content-read|series-settings)\.tsx?$/.test(path)
      || /^apps\/api\/src\/production-platform\/(?:short-lead-[^/]+|identity-service|access-policy|notification-service)\.ts$/.test(path)
      || /^apps\/api\/src\/(?:auth|todos)\//.test(path)
      || /^packages\/contracts\/src\/(?:short-commitment|todo[^/]*)\.ts$/.test(path)
      || ['tests/acceptance/m01-short-lead-native-browser.ts','tests/fixtures/m01-short-lead-native-ui.tsx','scripts/ci/prepare-settings-browser.mjs'].includes(path)) {
      mappedTests.add('tests/integration/m01-short-lead-native-browser-postgres.test.ts');
      mappedTests.add('tests/integration/series-plan-postgres.test.ts');
    }
    if (/^apps\/api\/src\/production-platform\/(?:production-statistics[^/]*|analysis-result-store|reporting-query|reporting-routes|factory-production-facts)\.ts$/.test(path)
      || ['packages/contracts/src/production-statistics.ts','packages/contracts/src/digital-production-analysis.ts','packages/domain/src/production-statistics.ts','tests/integration/m01-production-statistics-postgres.test.ts','tests/integration/production-read-batches-postgres.test.ts'].includes(path)) {
      mappedTests.add('tests/integration/m01-production-statistics-postgres.test.ts');
      mappedTests.add('tests/integration/production-read-batches-postgres.test.ts');
      mappedTests.add('tests/integration/m01-production-period-postgres.test.ts');
      mappedTests.add('tests/integration/m01-production-collaboration-postgres.test.ts');
    }
    if (['apps/api/src/production-platform/reporting-query.ts','apps/api/src/production-platform/reporting-routes.ts','packages/contracts/src/digital-production-analysis.ts','tests/helpers/business-anchor-fixture.ts'].includes(path)) {
      mappedTests.add('tests/integration/time-reading-clock-postgres.test.ts');
    }
    if (/^apps\/web\/src\/(?:sla-|use-sla-saved-draft|development-cycle-settings|cockpit-production-settings|digital-cockpit-personnel|series-settings|series-plan-panel|auth-session)/.test(path)
      || /^apps\/api\/src\/production-platform\/(?:sla-|development-technical-service)/.test(path)
      || path.startsWith('apps/api/src/auth/')
      || ['packages/domain/src/sla-relative-calculation.ts','packages/domain/src/sla-calculation.ts','apps/web/src/digital-production-api.ts','tests/acceptance/m01-settings-native-browser.ts','tests/fixtures/m01-settings-native-ui.tsx','scripts/ci/prepare-settings-browser.mjs'].includes(path)) {
      mappedTests.add('tests/integration/m01-settings-native-browser-postgres.test.ts');
      domains.add('settings-native-browser');
      if(['packages/domain/src/sla-relative-calculation.ts','packages/domain/src/sla-calculation.ts'].includes(path))mappedTests.add('tests/integration/sla-calculation-postgres.test.ts');
    }
    if (['apps/api/src/production-platform/sla-notification-preferences.ts','apps/api/src/production-platform/notification-service.ts','apps/api/src/production-platform/ship-sample-timing.ts','packages/contracts/src/digital-sla.ts','tests/integration/sla-notification-preferences-postgres.test.ts'].includes(path)) {
      for(const suite of ['sla-notification-preferences','digital-production-notifications','digital-production-notification-delivery'])mappedTests.add('tests/integration/'+suite+'-postgres.test.ts');
      domains.add('settings-notification-preferences');
    }
    if (['apps/api/src/production-platform/sla-settings-history.ts','apps/api/src/production-platform/sla-policy-values.ts','apps/api/src/production-platform/sla-settings-drafts.ts','packages/contracts/src/sla-settings-history.ts','packages/contracts/src/sla-settings-drafts.ts','apps/api/migrations/0277_sla_draft_source_version.sql','tests/integration/m01-sla-history-postgres.test.ts'].includes(path)) {
      mappedTests.add('tests/integration/m01-sla-history-postgres.test.ts');
      domains.add('settings-history');
    }
    if (['apps/api/src/production-platform/sla-settings-drafts.ts','apps/api/src/production-platform/sla-settings-service.ts','apps/api/src/production-platform/development-technical-settings.ts','packages/contracts/src/sla-settings-drafts.ts','apps/api/migrations/0276_sla_settings_drafts.sql','tests/integration/sla-settings-drafts-postgres.test.ts'].includes(path)) {
      mappedTests.add('tests/integration/sla-settings-drafts-postgres.test.ts');
      domains.add('settings-drafts');
    }
    if (DEVELOPMENT_AMENDMENT_INPUTS.has(path)) {
      businessChainSensitive = true;
      domains.add("development-amendment");
      mappedTests.add("tests/integration/development-amendment-postgres.test.ts");
    }
    if (path === 'apps/api/src/platform/journey-diagnostic.ts'
      || path === 'apps/api/src/app.ts' || path === 'apps/api/src/server.ts'
      || path === 'apps/api/src/acceptance-clock/hooks.ts'
      || /^apps\/api\/src\/production-platform\/(?:journey[^/]*|identity-routes)\.ts$/.test(path)
      || path === 'tests/unit/journey-diagnostic.test.ts'
      || path === 'tests/integration/journey-diagnostic-postgres.test.ts') {
      mappedTests.add('tests/integration/journey-diagnostic-postgres.test.ts');
    }
    if (path === 'tests/helpers/business-anchor-fixture.ts'
      || path === 'tests/helpers/bulk-preparation-fixture.ts'
      || path === 'tests/helpers/bulk-preshrink-correction-fixture.ts'
      || /^apps\/api\/src\/production-platform\/(?:bulk-(?:preparation|preshrink|sla)[^/]*|task-service)\.ts$/.test(path)) {
      businessChainSensitive = true;
      domains.add('bulk-preshrink-consumers');
      addAll(mappedTests, ['tests/integration/business-anchors-clock-postgres.test.ts',
        'tests/integration/production-readiness-postgres.test.ts',
        'tests/integration/sourcing-pr03-postgres.test.ts',
        'tests/integration/bulk-preshrink-correction-postgres.test.ts']);
    }
    if (/^apps\/api\/src\/production-platform\/journey[^/]*\.ts$/.test(path)
      || path === "apps/api/src/production-platform/identity-routes.ts"
      || path === "packages/contracts/src/digital-production-journey.ts"
      || path === "tests/integration/digital-journey-postgres.test.ts"
      || path === "scripts/ci/journey-pg13-regression.mjs") {
      journeyPg13Compat = true;
      businessChainSensitive = true;
      domains.add("journey-pg13");
      mappedTests.add("tests/integration/digital-journey-postgres.test.ts");
    }
    if (isMigration(path)) {
      migrationSensitive = true;
      businessChainSensitive = true;
      domains.add("migration");
      if (isMigrationTool(path)) {
        maintenanceSensitive = true;
        mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
      }
    }
    if (isDeployment(path)) {
      deploymentSensitive = true;
      const activationOnly = /^scripts\/deploy\/(?:activate-release|commit-online-generation|start-online-slot|save-online-processes|render-online-nginx|nginx-workers|drain-nginx-workers|static-release)\./.test(path);
      const transferOnly = /^scripts\/deploy\/(?:package-release|create-transfer-bundle|verify-runtime|build-release|dependency-bins|prepare-build-dependencies)\./.test(path);
      domains.add("deployment");
      if (!SHARED_GATE_INPUTS.has(path)) {
        maintenanceSensitive ||= !activationOnly && !transferOnly;
        activationSensitive ||= !transferOnly;
        transferSensitive ||= !activationOnly;
        mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
        mappedTests.add("tests/integration/acceptance-maintenance-postgres.test.ts");
      }
    }
    if (isBackendOrContract(path)) {
      // Unknown backend/contract paths fail closed into the real PostgreSQL chain.
      businessChainSensitive = true;
      domains.add("backend");
    }
    if (["scripts/test-fixture-prerequisites.mjs","scripts/owned-command.mjs","scripts/test-execution-config.mjs","scripts/ci/test-runtime-metadata.mjs","scripts/run-business-chain-gate.mjs","scripts/test-suite-plan.mjs","scripts/test-resource-contract.mjs","scripts/test-resource-lifecycle.mjs","scripts/test-database-safety.mjs","scripts/test-preflight.mjs","tests/helpers/owned-postgres-schema.ts","vitest.config.ts","vitest.postgres-immediate.config.ts","vitest.business-chain.config.ts"].includes(path)) {
      businessChainSensitive = true;
      domains.add("business-chain");
    }
    if (path.startsWith("tests/helpers/") && (path === "tests/helpers/owned-postgres-schema.ts" || !existsSync(path) || readFileSync(path,"utf8").includes("ownedPostgresSchema"))) {
      businessChainSensitive = true;
      domains.add("postgres-fixture");
    }
    if (path === "scripts/test-database-safety.mjs" || path.startsWith("scripts/test-resource-")) mappedTests.add("tests/integration/test-resource-contract-postgres.test.ts");
    if (isPostgresTest(path) || Object.hasOwn(POSTGRES_CASE_SUITES, path)) {
      businessChainSensitive ||= !independentTestOnly;
      if (independentTestOnly) domains.add("independent-postgres-test");
      domains.add("postgres-test");
      if (path.endsWith(".cases.ts")) {
        const suite = POSTGRES_CASE_SUITES[path];
        if (!suite && existsSync(path)) throw new Error(`PostgreSQL case module has no mapped suite: ${path}`);
        if (suite) mappedTests.add(suite);
      } else if (existsSync(path)) mappedTests.add(path);
    }
    if (matchesAccess(path)) {
      businessChainSensitive = true;
      domains.add("access");
      addAll(mappedTests, TESTS.access);
    }
    if (matchesWages(path)) {
      businessChainSensitive = true;
      domains.add("wages");
      addAll(mappedTests, TESTS.wages);
    }
    if (matchesSuppliers(path)) {
      businessChainSensitive = true;
      domains.add("suppliers");
      addAll(mappedTests, TESTS.suppliers);
    }
    if (matchesTools(path)) {
      businessChainSensitive = true;
      domains.add("tools");
      addAll(mappedTests, TESTS.tools);
    }
    if (matchesReceiving(path)) {
      receivingSensitive = true;
      businessChainSensitive = true;
      domains.add("receiving");
      addAll(mappedTests, TESTS.receiving);
    }
    if (matchesPatternRoom(path)) {
      businessChainSensitive = true;
      domains.add("pattern-room");
    }
  }

  // The domain barrel loads this shared engine indirectly via naturalTimeRatio.
  // Engine changes keep the reviewed shared-engine chain (only SQL own-tail excluded),
  // plus the explicit native consumers.
  if (paths.includes("packages/domain/src/digital-sla-plan.ts")) {
    addAll(mappedTests, SLA_JOURNEY_REQUIRED_TESTS);
    businessChainSensitive = true;
    domains.add("shared-sla-engine-full-chain");
    if (paths.every(path => existsSync(path) && (path === "packages/domain/src/digital-sla-plan.ts" || SLA_JOURNEY_SOURCE_PATHS.includes(path) || SLA_JOURNEY_SUPPORT_PATHS.includes(path)))) chainProfile = "sla-journey-engine-v1";
  }

  // Shared writes are still exercised by the retained real full-business,
  // Root, readiness, sourcing, closure, rework and operational consumers.
  // Any extra unknown/auth/schema/helper/CI path invalidates the whole profile.
  if (slaJourneyProfileApplies(paths) && !migrationSensitive && !deploymentSensitive && !receivingSensitive) {
    addAll(mappedTests, SLA_JOURNEY_REQUIRED_TESTS);
    addAll(mappedTests, POSTGRES_CHAIN_TESTS.filter(test => !SLA_JOURNEY_UNRELATED_CHAIN_TESTS.includes(test)));
    businessChainSensitive = true;
    chainProfile = "sla-journey-v1";
    domains.add("sla-journey-reviewed-source-profile");
  }

  const tests = [...mappedTests].sort();
  const dbRequired = migrationSensitive
    || receivingSensitive
    || businessChainSensitive
    || deploymentSensitive
    || tests.length > 0;
  const highRisk = dbRequired;

  return Object.freeze({
    migrationSensitive,
    receivingSensitive,
    businessChainSensitive,
    chainProfile,
    deploymentSensitive,
    journeyPg13Compat,
    maintenanceSensitive,
    activationSensitive,
    transferSensitive,
    dbRequired,
    highRisk,
    domains: [...domains].sort(),
    mappedPostgresTests: tests,
  });
};

export const assertMappedPostgresTests = (tests) => {
  for (const test of tests) {
    if (!test.endsWith(".test.ts")) throw new Error(`Mapped PostgreSQL entry is not a runnable test suite: ${test}`);
    if (!existsSync(test)) throw new Error(`Mapped PostgreSQL test does not exist: ${test}`);
    const source = readFileSync(test, "utf8");
    if (!source.includes("TEST_DATABASE_URL")) {
      throw new Error(`Mapped PostgreSQL test does not declare TEST_DATABASE_URL: ${test}`);
    }
  }
};

const runCli = () => {
  const args = process.argv.slice(2);
  const quickSafe = args.includes("--require-quick-safe");
  const envIndex = args.indexOf("--github-env");
  const envPath = envIndex >= 0 ? args[envIndex + 1] : null;
  const positional = args.filter((arg, index) =>
    !arg.startsWith("--") && (envIndex < 0 || index !== envIndex + 1));
  const changedFileList = positional.at(-1);
  if (!changedFileList) throw new Error("Usage: full-gate-risk-map.mjs [--require-quick-safe] [--github-env PATH] CHANGED_FILES");
  const paths = readFileSync(changedFileList, "utf8").split(/\r?\n/).filter(Boolean);
  const result = classifyFullGatePaths(paths);
  assertMappedPostgresTests(Object.values(TESTS).flat());
  assertMappedPostgresTests(result.mappedPostgresTests);

  if (quickSafe && result.highRisk) {
    process.stderr.write(`This diff requires [FULL] Gate. Sensitive domains: ${result.domains.join(",") || "unknown"}\n`);
    process.exitCode = 2;
    return;
  }

  if (envPath) {
    const entries = [
      ["MIGRATION_SENSITIVE", result.migrationSensitive],
      ["RECEIVING_SENSITIVE", result.receivingSensitive],
      ["BUSINESS_CHAIN_SENSITIVE", result.businessChainSensitive],
      ["CHAIN_PROFILE", result.chainProfile],
      ["DEPLOYMENT_SENSITIVE", result.deploymentSensitive],
      ["JOURNEY_PG13_COMPAT", result.journeyPg13Compat],
      ["MAINTENANCE_SENSITIVE", result.maintenanceSensitive],
      ["ACTIVATION_SENSITIVE", result.activationSensitive],
      ["TRANSFER_SENSITIVE", result.transferSensitive],
      ["DB_REQUIRED", result.dbRequired],
      ["FULL_GATE_DOMAINS", result.domains.join(",")],
      ["MAPPED_POSTGRES_TESTS", result.mappedPostgresTests.join(",")],
    ];
    appendFileSync(envPath, entries.map(([key, value]) => `${key}=${value}\n`).join(""));
  } else {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }
};

if (process.argv[1]?.endsWith("full-gate-risk-map.mjs")) runCli();
