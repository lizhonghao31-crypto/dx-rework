import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;
const migrations = [
  "0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql",
  "0003_identity_union_continuity.sql", "0004_public_tools_foundation.sql",
  "0005_access_master_data.sql", "0006_rework_initiation.sql",
  "0007_process_configuration_ie_review.sql", "0008_worker_assignment_reporting.sql",
  "0009_whole_order_review_quantity_adjustment.sql", "0010_responsibility_determination_amount_engine.sql",
  "0011_responsibility_authorization_handler_closure.sql", "0012_responsibility_direct_delegation.sql",
  "0013_responsibility_review_closure.sql", "0014_responsibility_source_share_coverage.sql",
  "0015_own_factory_responsibility_approval.sql", "0016_responsibility_amount_contract_restore.sql",
  "0017_external_responsibility_deduction.sql", "0018_external_responsibility_review_closure.sql",
  "0019_external_revision_seed_ordering.sql",
] as const;

runWithPostgres("external responsibility migration replay", () => {
  const schema = `external_responsibility_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of migrations) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${migration}`, import.meta.url), "utf8"));
    }
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("replays the reviewed ledger, capabilities, version triggers, and draft link", async () => {
    const [tables, functions, completed, revisionCapability, roleCapabilities, seededColumn, triggers, signDefinition] = await Promise.all([
      database.query<{ table_name: string }>(`SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name=ANY($1::text[]) ORDER BY table_name`, [[
        "rework_external_responsibility_batches", "rework_external_responsibility_items",
        "rework_external_responsibility_cases", "rework_external_deduction_entries",
        "rework_external_deduction_closures", "rework_external_responsibility_revision_requests",
      ]]),
      database.query<{ proname: string }>(`SELECT proname FROM pg_proc WHERE pronamespace=current_schema()::regnamespace AND proname=ANY($1::text[]) ORDER BY proname`, [[
        "external_responsibility_can_sign", "external_responsibility_can_payables",
        "external_responsibility_can_view_case", "guard_external_responsibility_attachment_binding",
        "bump_external_case_version_from_ledger",
      ]]),
      database.query<{ definition: string }>(`SELECT pg_get_constraintdef(constraint_row.oid) definition FROM pg_constraint constraint_row JOIN pg_class relation ON relation.oid=constraint_row.conrelid WHERE relation.relname='rework_orders' AND constraint_row.conname='rework_orders_status_check'`),
      database.query<{ count: number }>("SELECT count(*)::int count FROM capability_catalog WHERE capability='external_responsibility:approve_revision'"),
      database.query<{ capability: string }>(`SELECT capability FROM role_capabilities WHERE role_code='embroidery_washing_merchandiser' AND capability=ANY($1::text[]) ORDER BY capability`, [["supplier_catalog:read", "tools:user"]]),
      database.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='rework_external_responsibility_revision_requests' AND column_name='seeded_determination_id'`),
      database.query<{ tgname: string }>(`SELECT tgname FROM pg_trigger WHERE tgrelid=ANY(ARRAY['rework_external_deduction_follow_ups'::regclass,'rework_external_deduction_entries'::regclass]) AND NOT tgisinternal AND tgname=ANY($1::text[]) ORDER BY tgname`, [["external_deductions_bump_case_version", "external_followups_bump_case_version"]]),
      database.query<{ definition: string }>("SELECT pg_get_functiondef('external_responsibility_can_sign(uuid,uuid,text)'::regprocedure) definition"),
    ]);
    expect(tables.rows.map((row) => row.table_name)).toHaveLength(6);
    expect(functions.rows.map((row) => row.proname)).toHaveLength(5);
    expect(completed.rows[0]?.definition).toContain("completed");
    expect(revisionCapability.rows[0]).toEqual({ count: 1 });
    expect(roleCapabilities.rows.map((row) => row.capability)).toEqual([
      "supplier_catalog:read",
      "tools:user",
    ]);
    expect(seededColumn.rows).toEqual([{ column_name: "seeded_determination_id" }]);
    expect(triggers.rows.map((row) => row.tgname)).toEqual([
      "external_deductions_bump_case_version",
      "external_followups_bump_case_version",
    ]);
    expect(signDefinition.rows[0]?.definition).toContain(
      "order_record.merchandiser_user_id = delegation.grantor_user_id",
    );
    await expect(database.query(
      `INSERT INTO delegated_authorizations(
         delegation_id,grantor_user_id,grantee_user_id,capability,scope_type,scope_id,
         valid_from,valid_until,granted_by,grant_reason
       ) VALUES($1,$2,$3,'external_responsibility:approve_revision','rework_order','x',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP+interval '1 hour',$2,'migration guard')`,
      [randomUUID(), randomUUID(), randomUUID()],
    )).rejects.toMatchObject({ code: "23514" });
  });
});
