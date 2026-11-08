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

// Shared gate selection/receipt code still requires Full and the real DB chain.
// It does not itself migrate, back up, activate or transfer a release.
const SHARED_GATE_INPUTS = new Set([
  ".github/workflows/ci.yml",
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
  if(paths.some(path=>/^apps\/web\/src\/(?:cockpit-home(?:-[^/]*)?|cockpit-detail(?:-[^/]*)?|cockpit-stage-progress|cockpit-documents|cockpit-operation-log|node-materials-panel|cockpit-timing-coverage|digital-journey-cockpit)\.(?:tsx?|css)$/.test(path)||['apps/api/src/production-platform/journey-projection.ts','packages/contracts/src/digital-production-journey.ts','tests/acceptance/m01-cockpit-home-native-browser.ts','tests/fixtures/m01-cockpit-home-native-ui.tsx','tests/integration/m01-cockpit-home-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/m01-cockpit-home-native-browser-postgres.test.ts');domains.add('cockpit-home-browser');}
  if (paths.some(path => path.startsWith('apps/api/src/auth/') || path === 'packages/config/src/index.ts' || path === 'tests/integration/acceptance-session-retention-postgres.test.ts')) {
    mappedTests.add('tests/integration/acceptance-session-retention-postgres.test.ts');
    domains.add('acceptance-session-retention');
  }
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/journey-(?:selection[^/]*|query|fact-updates)\.ts$/.test(path)||['apps/web/src/cockpit-reads.ts','apps/web/src/cockpit-home.tsx','apps/web/src/digital-journey-cockpit.tsx','packages/contracts/src/digital-production-journey.ts','tests/integration/journey-page-native-browser-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-page-native-browser-postgres.test.ts');domains.add('journey-page-reads');}
  if(paths.some(path=>['apps/api/src/production-platform/journey-fact-updates.ts','apps/api/src/production-platform/journey-fact-repository.ts','apps/api/src/server.ts','apps/api/migrations/0279_journey_fact_incremental_updates.sql','tests/integration/journey-fact-updates-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-fact-updates-postgres.test.ts');domains.add('journey-fact-updates');}
  if(paths.some(path=>/^apps\/api\/src\/production-platform\/journey-fact-(?:model|repository)\.ts$/.test(path)||['apps/api/src/production-platform/journey-query.ts','apps/api/src/production-platform/journey-supervision.ts','apps/api/src/production-platform/order-closure-service.ts','apps/api/src/production-platform/sla-order-service.ts','apps/api/src/production-platform/bulk-preparation-service.ts','apps/api/migrations/0278_journey_fact_read_model.sql','tests/integration/journey-fact-model-postgres.test.ts'].includes(path))){mappedTests.add('tests/integration/journey-fact-model-postgres.test.ts');domains.add('journey-fact-model');}
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
      || ['packages/contracts/src/production-statistics.ts','packages/contracts/src/digital-production-analysis.ts','packages/domain/src/production-statistics.ts','tests/integration/m01-production-statistics-postgres.test.ts'].includes(path)) {
      mappedTests.add('tests/integration/m01-production-statistics-postgres.test.ts');
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
