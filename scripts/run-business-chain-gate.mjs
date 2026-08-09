import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

import pg from "pg";

const { Pool } = pg;
const DEFAULT_ECS_ENV_FILE = "/opt/dx-rework/shared/.env";
const ISOLATED_GATE_SCHEMA = /^(?:full_chain_[0-9a-f]{32}|root_http_[12]_[0-9a-f]{32})$/;

function parseEnvValue(raw) {
  const value = raw.trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

async function hydrateDatabaseUrl() {
  if (process.env.TEST_DATABASE_URL || process.env.DATABASE_URL) return;
  const envFile = process.env.DX_REWORK_ENV_FILE || DEFAULT_ECS_ENV_FILE;
  if (!existsSync(envFile)) return;

  const text = await readFile(envFile, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?(TEST_DATABASE_URL|DATABASE_URL)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    const value = parseEnvValue(rawValue);
    if (value) process.env[key] = value;
  }
}

await hydrateDatabaseUrl();

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const hasDatabase = Boolean(databaseUrl);

async function cleanupIsolatedGateSchemas() {
  if (!databaseUrl) return;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const result = await pool.query(
      `SELECT nspname
       FROM pg_namespace
       WHERE nspname LIKE 'full_chain_%'
          OR nspname LIKE 'root_http_%'`,
    );
    for (const row of result.rows) {
      const schema = String(row.nspname);
      if (!ISOLATED_GATE_SCHEMA.test(schema)) continue;
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      process.stdout.write(`BUSINESS_CHAIN_GATE_SCHEMA_CLEANED: ${schema}\n`);
    }
  } finally {
    await pool.end();
  }
}

const tests = [
  "tests/unit/current-migration-manifest-checksum.test.ts",
  "tests/unit/business-chain-ui-contract.test.ts",
  "tests/unit/business-chain-schema-cleanup.test.ts",
  "tests/unit/aliyun-oss-v4-client.test.ts",
  "tests/unit/work-reporting.test.ts",
  "tests/unit/root-superuser-self-review.test.ts",
  "tests/unit/root-global-business-bypass.test.ts",
  "tests/unit/root-ui-entry-contract.test.ts",
];
if (hasDatabase) {
  tests.push(
    "tests/integration/full-business-chain-postgres.test.ts",
    "tests/integration/root-single-account-two-pass-postgres.test.ts",
  );
  process.stdout.write(
    "BUSINESS_CHAIN_GATE_START: current-schema N01-N10 + two fresh Root single-account HTTP passes + browser/root/storage regressions\n",
  );
} else {
  process.stdout.write(
    "BUSINESS_CHAIN_DB_GATE_SKIPPED: no database URL; running static chain gates only\n",
  );
}

if (hasDatabase) await cleanupIsolatedGateSchemas();

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let exitCode;
try {
  const child = spawn(
    npmCommand,
    [
      "exec",
      "--",
      "vitest",
      "run",
      "--config",
      "vitest.business-chain.config.ts",
      ...tests,
    ],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`business chain gate terminated by ${signal}`));
        return;
      }
      resolve(code ?? 1);
    });
  });
} finally {
  if (hasDatabase) await cleanupIsolatedGateSchemas();
}

if (exitCode !== 0) {
  throw new Error(`BUSINESS_CHAIN_GATE_FAILED: vitest exited ${exitCode}`);
}

process.stdout.write(
  hasDatabase
    ? "BUSINESS_CHAIN_GATE_PASSED\n"
    : "BUSINESS_CHAIN_STATIC_GATES_PASSED\n",
);
