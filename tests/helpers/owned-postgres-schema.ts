import { randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RUN_ID_PATTERN = /^[0-9a-f]{8}$/;
const PREFIX_PATTERN = /^[a-z][a-z0-9_]{1,40}$/;

export const ownedPostgresSchema = (prefix: string): string => {
  if (!PREFIX_PATTERN.test(prefix)) throw new Error(`Invalid PostgreSQL test schema prefix: ${prefix}`);
  const runId = process.env.DX_REWORK_TEST_RUN_ID?.trim().toLowerCase();
  const manifestDir = process.env.DX_REWORK_TEST_RESOURCE_MANIFEST_DIR?.trim();
  if (Boolean(runId) !== Boolean(manifestDir)) {
    throw new Error("DX_REWORK_TEST_RUN_ID and DX_REWORK_TEST_RESOURCE_MANIFEST_DIR must be configured together");
  }
  if (runId && !RUN_ID_PATTERN.test(runId)) {
    throw new Error("DX_REWORK_TEST_RUN_ID must be exactly 8 lowercase hexadecimal characters");
  }
  const random = randomUUID().replaceAll("-", "");
  const token = runId ? `${runId}${random.slice(runId.length)}` : random;
  const schema = `${prefix}_${token}`;
  if (runId && manifestDir) {
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, `${schema}.json`),
      `${JSON.stringify({ kind: "postgres-schema", runId, schema })}\n`,
      { encoding: "utf8", flag: "wx" });
  }
  return schema;
};
