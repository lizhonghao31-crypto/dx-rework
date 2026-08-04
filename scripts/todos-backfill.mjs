import pg from "pg";

import { TodoBackfillService } from "../apps/api/dist/todos/backfill-service.js";

const args = process.argv.slice(2);
const readValue = (name) => {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
};
const has = (name) => args.includes(name);
const known = new Set(["--dry-run", "--apply", "--actor-user-id", "--batch-size", "--resume-run-id"]);
for (const argument of args) {
  if (argument.startsWith("--") && !known.has(argument)) throw new Error(`Unknown argument: ${argument}`);
}
if (has("--dry-run") && has("--apply")) throw new Error("Choose either --dry-run or --apply");
const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");

const mode = has("--apply") ? "apply" : "dry_run";
const batchSizeSource = readValue("--batch-size");
const batchSize = batchSizeSource === undefined ? undefined : Number(batchSizeSource);
if (batchSizeSource !== undefined && (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 500)) {
  throw new Error("--batch-size must be an integer between 1 and 500");
}
const actorUserId = readValue("--actor-user-id");
if (mode === "apply" && !actorUserId) throw new Error("--actor-user-id is required for --apply");

const database = new pg.Pool({ connectionString: databaseUrl, max: 4 });
try {
  const result = await new TodoBackfillService(database).run({
    mode,
    actorUserId,
    batchSize,
    resumeRunId: readValue("--resume-run-id"),
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  await database.end();
}
