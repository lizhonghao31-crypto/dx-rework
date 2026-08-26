import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("sourcing PR02 PostgreSQL foundation", () => {
  const schema = `sourcing_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({
    connectionString: databaseUrl!,
    options: `-c search_path=${schema}`,
  });
  const actorId = randomUUID();

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    for (const migration of [
      "0001_platform_foundation.sql",
      "0002_dingtalk_identity_access.sql",
      "0003_identity_union_continuity.sql",
      "0004_public_tools_foundation.sql",
      "0005_access_master_data.sql",
      "0096_sourcing_view_capability.sql",
      "0097_sourcing_foundation.sql",
    ]) {
      await database.query(await readFile(
        new URL(`../../apps/api/migrations/${migration}`, import.meta.url),
        "utf8",
      ));
    }
    await database.query(
      "INSERT INTO app_users(id,display_name,enabled) VALUES($1,'报价跟单',true)",
      [actorId],
    );
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("creates the complete append-only fact model and exact write grants", async () => {
    const tables = await database.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema=current_schema()
         AND table_name=ANY($1::text[])
       ORDER BY table_name`,
      [[
        "sourcing_cases",
        "sourcing_decisions",
        "sourcing_contract_executions",
        "sourcing_factory_change_requests",
        "sourcing_factory_change_decisions",
        "sourcing_finance_reconciliations",
        "sourcing_case_transitions",
      ]],
    );
    expect(tables.rows).toHaveLength(7);

    const grants = await database.query<{ role_code: string; capability: string }>(
      `SELECT role_code,capability
       FROM role_capabilities
       WHERE capability LIKE 'sourcing:%' AND capability<>'sourcing:view'
       ORDER BY capability,role_code`,
    );
    expect(grants.rows).toEqual([
      { role_code: "order_merchandiser", capability: "sourcing:contract:record" },
      { role_code: "production_management", capability: "sourcing:decision:record" },
      { role_code: "production_management", capability: "sourcing:exception:verify" },
      { role_code: "order_merchandiser", capability: "sourcing:factory_change:request" },
      { role_code: "production_management", capability: "sourcing:factory_change:verify" },
      { role_code: "factory_payables", capability: "sourcing:finance:reconcile" },
      { role_code: "order_merchandiser", capability: "sourcing:inquiry:create" },
    ]);
  });

  it("requires an audited initial transition and exposes the derived current state", async () => {
    const caseId = randomUUID();
    const eventId = randomUUID();
    const requestId = randomUUID();
    const reason = "正式 ERP 订单进入报价选厂";
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id,reason
       ) VALUES($1,$2,$3,ARRAY['order_merchandiser'],'sourcing:inquiry:create',
         'sourcing.case.create','sourcing_case',$4,$5)`,
      [eventId,requestId,actorId,caseId,reason],
    );

    const client = await database.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO sourcing_cases(
           sourcing_case_id,erp_order_id,erp_order_no,style_no,lane_key,
           order_quantity,created_by,operation_event_id,request_id,creation_reason
         ) VALUES($1,'erp-100','ERP-100','DX-100','garment_processing',
           100,$2,$3,$4,$5)`,
        [caseId,actorId,eventId,requestId,reason],
      );
      await client.query(
        `INSERT INTO sourcing_case_transitions(
           sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
           business_action,transition_reason,actor_id,operation_event_id,request_id
         ) VALUES($1,$2,1,NULL,'pending_decision','created',$3,$4,$5,$6)`,
        [randomUUID(),caseId,reason,actorId,eventId,requestId],
      );
      await client.query("COMMIT");
    } finally {
      client.release();
    }

    expect((await database.query(
      "SELECT status,version,lane_key FROM current_sourcing_cases WHERE sourcing_case_id=$1",
      [caseId],
    )).rows[0]).toEqual({
      status: "pending_decision",
      version: 1,
      lane_key: "garment_processing",
    });
    await expect(database.query(
      "UPDATE sourcing_cases SET erp_order_no='forged' WHERE sourcing_case_id=$1",
      [caseId],
    )).rejects.toMatchObject({ code: "55000" });
  });

  it("rejects a state jump without its matching immutable business fact", async () => {
    const current = await database.query<{ sourcing_case_id: string }>(
      "SELECT sourcing_case_id FROM sourcing_cases LIMIT 1",
    );
    const caseId = current.rows[0]!.sourcing_case_id;
    const eventId = randomUUID();
    const requestId = randomUUID();
    const reason = "尝试跳过选厂决定";
    await database.query(
      `INSERT INTO operation_events(
         event_id,request_id,actor_id,actor_roles,authorization_capability,
         action,entity_type,entity_id,reason
       ) VALUES($1,$2,$3,ARRAY['production_management'],'sourcing:decision:record',
         'sourcing.decision.record','sourcing_case',$4,$5)`,
      [eventId,requestId,actorId,caseId,reason],
    );
    await expect(database.query(
      `INSERT INTO sourcing_case_transitions(
         sourcing_transition_id,sourcing_case_id,sequence,from_status,to_status,
         business_action,transition_reason,actor_id,operation_event_id,request_id
       ) VALUES($1,$2,2,'pending_decision','pending_contract',
         'decision_recorded',$3,$4,$5,$6)`,
      [randomUUID(),caseId,reason,actorId,eventId,requestId],
    )).rejects.toMatchObject({ code: "55000" });
  });
});
