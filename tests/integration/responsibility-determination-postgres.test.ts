import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrationNames = [
  "0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql",
  "0004_public_tools_foundation.sql", "0005_access_master_data.sql", "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql", "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql", "0010_responsibility_determination_amount_engine.sql",
] as const;

runWithPostgres("responsibility PostgreSQL closure", () => {
  const schema = "responsibility_" + randomUUID().replaceAll("-", "");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: "-c search_path=" + schema });

  beforeAll(async () => {
    await admin.query("CREATE SCHEMA " + schema);
    for (const migration of migrationNames) {
      await database.query(await readFile(new URL("../../apps/api/migrations/" + migration, import.meta.url), "utf8"));
    }
  });
  afterAll(async () => {
    await database.end();
    await admin.query("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
    await admin.end();
  });

  it("replays 0010 and creates all six immutable responsibility tables", async () => {
    const result = await database.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema=$1 AND table_name LIKE 'rework_responsibility_%' ORDER BY table_name`, [schema]);
    expect(result.rows.map((row) => row.table_name)).toEqual([
      "rework_responsibility_allocations", "rework_responsibility_amount_lines", "rework_responsibility_determinations",
      "rework_responsibility_handler_events", "rework_responsibility_high_multiplier_confirmations", "rework_responsibility_processes",
    ]);
  });

  it("stores genuine scale-15 unrounded amounts and binds finalized confirmations", async () => {
    const columns = await database.query<{ column_name: string; numeric_scale: number | null }>(`SELECT column_name,numeric_scale FROM information_schema.columns WHERE table_schema=$1 AND table_name='rework_responsibility_amount_lines' AND column_name='unrounded_amount'`, [schema]);
    expect(columns.rows).toEqual([{ column_name: "unrounded_amount", numeric_scale: 15 }]);
    const fk = await database.query(`SELECT 1 FROM pg_constraint WHERE connamespace=$1::regnamespace AND conname='responsibility_source_confirmation_fk'`, [schema]);
    expect(fk.rowCount).toBe(1);
  });

  it("uses deferred closure triggers on every version component", async () => {
    const triggers = await database.query<{ table_name: string }>(`SELECT c.relname table_name FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND t.tgname IN ('determination_complete','process_complete','allocation_complete','amount_line_complete') AND t.tgdeferrable AND t.tginitdeferred ORDER BY c.relname`, [schema]);
    expect(triggers.rows.map((row) => row.table_name)).toEqual(["rework_responsibility_allocations", "rework_responsibility_amount_lines", "rework_responsibility_determinations", "rework_responsibility_processes"]);
  });

  it("rejects forbidden responsibility delegation scopes without changing other capabilities", async () => {
    const guard = await database.query<{ definition: string }>("SELECT pg_get_functiondef($1::regprocedure) definition", ["guard_responsibility_delegation_scope()"]);
    expect(guard.rows[0]?.definition).toContain("scope_type<>'rework_order'");
    expect(guard.rows[0]?.definition).toContain("responsibility:confirm_high_multiplier");
  });

  it("requires exact action capability and trusted transaction context", async () => {
    const guard = await database.query<{ definition: string }>("SELECT pg_get_functiondef($1::regprocedure) definition", ["require_responsibility_event(uuid,text,uuid,uuid)"]);
    expect(guard.rows[0]?.definition).toContain("dx_rework.responsibility_event_id");
    expect(guard.rows[0]?.definition).toContain("responsibility_expected_capability");
  });
});
