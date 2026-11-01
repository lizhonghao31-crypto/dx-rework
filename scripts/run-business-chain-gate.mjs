import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import pg from "pg";

import { assertTestDatabaseTarget } from "./test-database-safety.mjs";

const { Pool } = pg;
const DEFAULT_ECS_ENV_FILE = "/opt/dx-rework/shared/.env";
const runtimeEnvFile = process.env.DX_REWORK_ENV_FILE || DEFAULT_ECS_ENV_FILE;
const hasSharedRuntimeEnv = existsSync(runtimeEnvFile);
const ISOLATED_GATE_SCHEMA = /^(?:full_chain|root_http_[12]|receiving|rework_v2|sourcing|sample|acceptance_roles|acceptance_people|own_tail|pattern_backfill)_[0-9a-f]{32}$/;
const RUNTIME_ENV_KEYS = new Set([
  "OSS_REGION",
  "OSS_ENDPOINT",
  "OSS_BUCKET",
  "OSS_ACCESS_KEY_ID",
  "OSS_ACCESS_KEY_SECRET",
  "OSS_PRIVATE_PREFIX",
  "DINGTALK_QR_REDIRECT_URI",
]);

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

async function hydrateRuntimeEnv() {
  if (!hasSharedRuntimeEnv) return;

  const text = await readFile(runtimeEnvFile, "utf8");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^(?:export\s+)?([A-Z0-9_]+)=(.*)$/);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (!RUNTIME_ENV_KEYS.has(key) || process.env[key]) continue;
    const value = parseEnvValue(rawValue);
    if (value) process.env[key] = value;
  }
}

await hydrateRuntimeEnv();

const databaseUrl = process.env.TEST_DATABASE_URL?.trim();
const requireDatabase = process.env.DX_REWORK_REQUIRE_TEST_DATABASE === "true";
if (requireDatabase && !databaseUrl) {
  throw new Error("BUSINESS_CHAIN_TEST_DATABASE_REQUIRED: explicit TEST_DATABASE_URL is required");
}
const hasDatabase = Boolean(databaseUrl);
if (databaseUrl) await assertTestDatabaseTarget(databaseUrl);
const hasOss = Boolean(process.env.OSS_BUCKET);
const runId = randomUUID().replaceAll("-", "").slice(0, 8);
const resourceManifestDir = await mkdtemp(join(tmpdir(), `dx-rework-business-chain-${runId}-`));

function ossBrowserBaseUrl(endpointValue, bucket) {
  const endpoint = new URL(endpointValue);
  if (endpoint.protocol !== "https:") {
    throw new Error("OSS runtime preflight requires an HTTPS endpoint");
  }
  if (endpoint.hostname.includes("-internal.")) {
    throw new Error("OSS runtime preflight requires a public browser-reachable endpoint");
  }
  if (endpoint.pathname !== "/" || endpoint.search || endpoint.hash) {
    throw new Error("OSS runtime preflight endpoint must not contain path/query/fragment");
  }
  if (!endpoint.hostname.startsWith(`${bucket}.`)) {
    endpoint.hostname = `${bucket}.${endpoint.hostname}`;
  }
  return endpoint;
}

async function verifyOssRuntime() {
  if (!hasOss) {
    if (hasSharedRuntimeEnv) {
      throw new Error(
        "OSS_RUNTIME_PREFLIGHT_FAILED: business acceptance runtime must configure OSS",
      );
    }
    process.stdout.write("OSS_RUNTIME_PREFLIGHT_SKIPPED: OSS is not configured in this local environment\n");
    return;
  }

  const required = [
    "OSS_REGION",
    "OSS_ENDPOINT",
    "OSS_BUCKET",
    "OSS_ACCESS_KEY_ID",
    "OSS_ACCESS_KEY_SECRET",
    "DINGTALK_QR_REDIRECT_URI",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`OSS_RUNTIME_PREFLIGHT_FAILED: missing ${missing.join(",")}`);
  }

  const bucket = process.env.OSS_BUCKET;
  const endpoint = process.env.OSS_ENDPOINT;
  const origin = new URL(process.env.DINGTALK_QR_REDIRECT_URI).origin;
  const baseUrl = ossBrowserBaseUrl(endpoint, bucket);
  const privatePrefix = (process.env.OSS_PRIVATE_PREFIX || "dx-rework/private").replace(/\/$/, "");
  const { AliyunOssV4RestClient } = await import(
    new URL("../apps/api/dist/tools/aliyun-oss-v4-client.js", import.meta.url)
  );
  const client = new AliyunOssV4RestClient({
    region: process.env.OSS_REGION,
    endpoint,
    bucket,
    accessKeyId: process.env.OSS_ACCESS_KEY_ID,
    accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  });

  const missingObjectKey = `${privatePrefix}/__runtime-preflight__/${randomUUID()}.txt`;
  let signedHeadReturnedNotFound = false;
  try {
    await client.head(missingObjectKey);
  } catch (error) {
    if (error && typeof error === "object" && error.statusCode === 404) {
      signedHeadReturnedNotFound = true;
    } else {
      throw new Error(
        `OSS_RUNTIME_PREFLIGHT_FAILED: signed HEAD did not authenticate (${error instanceof Error ? error.message : "unknown error"})`,
      );
    }
  }
  if (!signedHeadReturnedNotFound) {
    throw new Error("OSS_RUNTIME_PREFLIGHT_FAILED: random missing object unexpectedly exists");
  }

  const corsProbeUrl = new URL(
    `/dx-rework-cors-preflight/${randomUUID()}.txt`,
    baseUrl,
  );
  const cors = await fetch(corsProbeUrl, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
    },
  });
  const allowedOrigin = cors.headers.get("access-control-allow-origin");
  if (!cors.ok || (allowedOrigin !== origin && allowedOrigin !== "*")) {
    throw new Error(
      `OSS_RUNTIME_PREFLIGHT_FAILED: bucket CORS does not allow POST from ${origin}`,
    );
  }

  process.stdout.write("OSS_RUNTIME_PREFLIGHT_PASSED: signed HEAD + browser POST CORS\n");
}

async function ownedSchemasFromManifest() {
  const entries = await readdir(resourceManifestDir, { withFileTypes: true });
  const schemas = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const resource = JSON.parse(await readFile(join(resourceManifestDir, entry.name), "utf8"));
    if (resource?.kind !== "postgres-schema" || resource.runId !== runId
      || typeof resource.schema !== "string" || entry.name !== `${resource.schema}.json`
      || !ISOLATED_GATE_SCHEMA.test(resource.schema)
      || !resource.schema.slice(-32).startsWith(runId)) {
      throw new Error(`BUSINESS_CHAIN_RESOURCE_MANIFEST_REJECTED: ${entry.name}`);
    }
    schemas.push(resource.schema);
  }
  return [...new Set(schemas)].sort();
}

async function cleanupOwnedGateSchemas() {
  if (!databaseUrl) return;
  const schemas = await ownedSchemasFromManifest();
  if (schemas.length === 0) return;
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    for (const schema of schemas) {
      await pool.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      process.stdout.write(`BUSINESS_CHAIN_GATE_SCHEMA_CLEANED: ${schema}\n`);
    }
    process.stdout.write(`BUSINESS_CHAIN_GATE_CLEANUP_PASSED: run=${runId} resources=${schemas.length}\n`);
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
  "tests/unit/receiving-pr01-contract.test.ts",
  "tests/unit/n01-paper-report-entry.test.ts",
  "tests/unit/acceptance-control.test.ts",
  "tests/unit/acceptance-lab-web.test.ts",
  "tests/integration/acceptance-control-routes.test.ts",
];
if (hasDatabase) {
  tests.push(
    "tests/integration/full-business-chain-postgres.test.ts",
    "tests/integration/customer-quotation-postgres.test.ts",
    "tests/integration/own-tail-responsibility-history-postgres.test.ts",
    "tests/integration/root-single-account-two-pass-postgres.test.ts",
    "tests/integration/receiving-postgres.test.ts",
    "tests/integration/rework-v2-n01-postgres.test.ts",
    "tests/integration/rework-v2-process-worker-preassignment-postgres.test.ts",
    "tests/integration/sourcing-pr03-postgres.test.ts",
    "tests/integration/production-closure-postgres.test.ts",
    "tests/integration/sample-foundation-postgres.test.ts",
    "tests/integration/sample-read-postgres.test.ts",
    "tests/integration/sample-create-postgres.test.ts",
    "tests/integration/sample-workflow-postgres.test.ts",
    "tests/integration/sample-disposal-postgres.test.ts",
    "tests/integration/sample-import-postgres.test.ts",
    "tests/integration/acceptance-role-session-postgres.test.ts",
    "tests/integration/acceptance-worker-people-postgres.test.ts",
  );
  process.stdout.write(
    "BUSINESS_CHAIN_GATE_START: sourcing PR03 + receiving + N01 v2 + process-worker preassignment + current-schema N01-N11 + two fresh Root single-account HTTP passes + isolated acceptance role sessions/control switching + browser/root/storage regressions\n",
  );
} else {
  process.stdout.write(
    "BUSINESS_CHAIN_DB_GATE_SKIPPED: no database URL; running static chain gates only\n",
  );
}


const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
let exitCode;
let child;
let interruptedSignal;
const interrupt = (signal) => { interruptedSignal = signal; child?.kill(signal); };
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.once("SIGINT", onSigint);
process.once("SIGTERM", onSigterm);
try {
  child = spawn(npmCommand, [
    "exec", "--", "vitest", "run", "--config", "vitest.business-chain.config.ts", ...tests,
  ], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "", TEST_DATABASE_URL: databaseUrl ?? "", DX_REWORK_TEST_RUN_ID: runId, DX_REWORK_TEST_RESOURCE_MANIFEST_DIR: resourceManifestDir },
  });
  exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(signal ? 1 : (code ?? 1)));
  });
} finally {
  process.removeListener("SIGINT", onSigint);
  process.removeListener("SIGTERM", onSigterm);
  try { if (hasDatabase) await cleanupOwnedGateSchemas(); }
  finally { await rm(resourceManifestDir, { recursive: true, force: true }); }
}
if (interruptedSignal) throw new Error(`BUSINESS_CHAIN_GATE_INTERRUPTED: ${interruptedSignal}`);

if (exitCode !== 0) {
  throw new Error(`BUSINESS_CHAIN_GATE_FAILED: vitest exited ${exitCode}`);
}

process.stdout.write(
  hasDatabase
    ? "BUSINESS_CHAIN_CORE_GATE_PASSED: sourcing PR03 + receiving + N01 v2 + process-worker preassignment + N01-N11 + two fresh Root single-account passes + isolated acceptance role sessions/control switching\n"
    : "BUSINESS_CHAIN_STATIC_CORE_GATES_PASSED\n",
);

await verifyOssRuntime();

process.stdout.write(
  hasDatabase
    ? "BUSINESS_CHAIN_GATE_PASSED\n"
    : "BUSINESS_CHAIN_STATIC_GATES_PASSED\n",
);

