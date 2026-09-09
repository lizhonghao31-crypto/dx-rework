import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { describe, it } from "vitest";

import { verifyOwnTailHistory } from "./own-tail-responsibility-history.cases.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("confirmed own-tail historical responsibility repair", () => {
  it("repairs completed and draft orders once, preserves source facts and rejects incomplete history", async () => {
    const pool = new pg.Pool({ connectionString: databaseUrl! });
    const client = await pool.connect();
    const schema = `own_tail_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(`CREATE SCHEMA ${schema}`);
      await client.query(`SET search_path TO ${schema}`);
      await client.query("CREATE TABLE schema_migrations (version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz DEFAULT now())");
      const manifest = JSON.parse(await readFile("apps/api/src/platform/migration-manifest.json", "utf8")) as { migrations: Array<{ version: string; checksum: string }> };
      const repairVersion = "0165_own_tail_responsibility_history";
      for (const entry of manifest.migrations) {
        if (entry.version === repairVersion) break;
        await client.query("BEGIN");
        await client.query(await readFile(`apps/api/migrations/${entry.version}.sql`, "utf8"));
        await client.query("INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)", [entry.version, entry.checksum]);
        await client.query("COMMIT");
      }
      await verifyOwnTailHistory(client, await readFile(`apps/api/migrations/${repairVersion}.sql`, "utf8"));
    } finally {
      await client.query("ROLLBACK");
      await client.query("SET search_path TO public");
      await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      client.release();
      await pool.end();
    }
  }, 120_000);
});
