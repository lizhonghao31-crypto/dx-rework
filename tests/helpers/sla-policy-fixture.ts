import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

/** Only the real policy DDL/seeds and history trigger; this is not a full migration replay. */
export async function applySlaPolicyFixture(db: Pool) {
  const sql = await readFile(new URL("../../apps/api/migrations/0220_digital_production_tasks.sql", import.meta.url), "utf8");
  await db.query(sql.slice(0, sql.indexOf("CREATE TABLE digital_production_resource_lifecycle")));
  const trigger = sql.match(/CREATE TRIGGER digital_deadline_policy_history[^;]+;/)?.[0];
  if (!trigger) throw new Error("Policy fixture trigger missing");
  await db.query(trigger);
  await db.query(await readFile(new URL("../../apps/api/migrations/0254_digital_sla_policy_references.sql", import.meta.url), "utf8"));
}
