import { appendFileSync, existsSync, readFileSync } from "node:fs";

const normalize = (path) => path.trim().replaceAll("\\", "/");

const TESTS = Object.freeze({
  access: [
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
  || path === "scripts/ci/full-gate-risk-map.mjs"
  || path === "scripts/ci/ci-gate-runtime.mjs"
  || path === "scripts/ci/full-gate-lanes.mjs"
  || path === "scripts/ci/impact-shadow.mjs"
  || path === "scripts/ci/impact-shadow-graph.mjs"
  || path === "scripts/ci/impact-shadow-binding.mjs"
  || path === "scripts/ci/impact-shadow-policy.json"
  || path === "scripts/ci/pr-gate-protocol.mjs"
  || path === "scripts/ci/pr-gate-controller.mjs"
  || path === "scripts/ci/verify-actions-policy.mjs"
  || path === "scripts/ci/light-reuse.mjs"
  || path === "scripts/ci/construction-evidence.mjs";

const isBackendOrContract = (path) =>
  path.startsWith("apps/api/src/") || path.startsWith("packages/contracts/src/");

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
  "apps/api/src/production-platform/development-amendment-service.ts",
  "apps/api/src/production-platform/development-amendment-repository.ts",
  "apps/api/src/production-platform/development-service.ts",
  "apps/api/src/production-platform/development-routes.ts",
  "apps/api/src/production-platform/development-execution-service.ts",
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
  const mappedTests = new Set();
  const domains = new Set();
  let migrationSensitive = false;
  let receivingSensitive = false;
  let businessChainSensitive = false;
  let deploymentSensitive = false;
  let journeyPg13Compat = false;
  let maintenanceSensitive = false;
  let activationSensitive = false;
  let transferSensitive = false;

  for (const path of paths) {
    if (/^apps\/web\/src\/(?:sla-|development-cycle-settings|cockpit-production-settings|digital-cockpit-personnel|series-settings|series-plan-panel|auth-session)/.test(path)
      || /^apps\/api\/src\/production-platform\/(?:sla-|development-technical-service)/.test(path)
      || path.startsWith('apps/api/src/auth/')
      || ['apps/web/src/digital-production-api.ts','tests/acceptance/m01-settings-native-browser.ts','tests/fixtures/m01-settings-native-ui.tsx','scripts/ci/prepare-settings-browser.mjs'].includes(path)) {
      mappedTests.add('tests/integration/m01-settings-native-browser-postgres.test.ts');
      domains.add('settings-native-browser');
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
      mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
    }
    if (isDeployment(path)) {
      deploymentSensitive = true;
      const activationOnly = /^scripts\/deploy\/(?:activate-release|commit-online-generation|start-online-slot|save-online-processes|render-online-nginx|nginx-workers|drain-nginx-workers|static-release)\./.test(path);
      const transferOnly = /^scripts\/deploy\/(?:package-release|create-transfer-bundle|verify-runtime|build-release|dependency-bins|prepare-build-dependencies)\./.test(path);
      maintenanceSensitive ||= !activationOnly && !transferOnly;
      activationSensitive ||= !transferOnly;
      transferSensitive ||= !activationOnly;
      domains.add("deployment");
      mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
      mappedTests.add("tests/integration/acceptance-maintenance-postgres.test.ts");
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
      businessChainSensitive = true;
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

  maintenanceSensitive ||= migrationSensitive;
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
