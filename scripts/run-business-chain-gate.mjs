import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

const DEFAULT_ECS_ENV_FILE = "/opt/dx-rework/shared/.env";

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

const hasDatabase = Boolean(
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL,
);
const tests = [
  "tests/unit/current-migration-manifest-checksum.test.ts",
  "tests/unit/business-chain-ui-contract.test.ts",
];
if (hasDatabase) {
  tests.push(
    "tests/integration/full-business-chain-postgres.test.ts",
    "tests/integration/root-single-account-two-pass-postgres.test.ts",
  );
  process.stdout.write(
    "BUSINESS_CHAIN_GATE_START: current-schema N01-N10 + two fresh Root single-account passes\n",
  );
} else {
  process.stdout.write(
    "BUSINESS_CHAIN_DB_GATE_SKIPPED: no database URL; running static chain gates only\n",
  );
}

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
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

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`business chain gate terminated by ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

if (exitCode !== 0) {
  throw new Error(`BUSINESS_CHAIN_GATE_FAILED: vitest exited ${exitCode}`);
}

process.stdout.write(
  hasDatabase
    ? "BUSINESS_CHAIN_GATE_PASSED\n"
    : "BUSINESS_CHAIN_STATIC_GATES_PASSED\n",
);
