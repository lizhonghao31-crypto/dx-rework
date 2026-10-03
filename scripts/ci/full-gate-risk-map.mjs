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
  || path === "apps/api/src/platform/migration-manifest.json"
  || [
    "scripts/seed-base-migrations.sh",
    "scripts/migrate.mjs",
    "scripts/migration-lib.mjs",
    "scripts/migration-integration-check.mjs",
    "scripts/migration-history-policy.mjs",
    "scripts/migration-branches.json",
    "scripts/check-migration-export.mjs",
    "scripts/check-migrations.mjs",
  ].includes(path);

const isDeployment = (path) =>
  path.startsWith("scripts/deploy/")
  || path === "scripts/dx-acceptance.sh"
  || path === "scripts/ci/acceptance-maintenance-drill.mjs"
  || path === "scripts/backup-postgres.sh"
  || path === "scripts/restore-postgres.sh"
  || path.startsWith("infra/")
  || path.startsWith(".github/workflows/")
  || path === "scripts/ci/full-gate-risk-map.mjs";

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

  for (const path of paths) {
    if (isMigration(path)) {
      migrationSensitive = true;
      businessChainSensitive = true;
      domains.add("migration");
      mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
    }
    if (isDeployment(path)) {
      deploymentSensitive = true;
      domains.add("deployment");
      mappedTests.add("tests/integration/migration-compatibility-postgres.test.ts");
      mappedTests.add("tests/integration/acceptance-maintenance-postgres.test.ts");
    }
    if (isBackendOrContract(path)) {
      // Unknown backend/contract paths fail closed into the real PostgreSQL chain.
      businessChainSensitive = true;
      domains.add("backend");
    }
    if (path === "scripts/run-business-chain-gate.mjs") {
      businessChainSensitive = true;
      domains.add("business-chain");
    }
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
