import { applyMigrations } from "./migration-lib.mjs";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const result = await applyMigrations(databaseUrl);
process.stdout.write(`${JSON.stringify({ success: true, ...result })}\n`);
