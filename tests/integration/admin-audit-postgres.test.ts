import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { AdminAuditService } from "../../apps/api/src/admin-audit-service.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

runWithPostgres("PR-15 admin audit query PostgreSQL integration", () => {
  const schema = `admin_audit_${randomUUID().replaceAll("-", "")}`;
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const ids = { admin: randomUUID(), owner: randomUUID(), production: randomUUID(), tail: randomUUID() };
  let service: AdminAuditService;

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}`);
    const directory = new URL("../../apps/api/migrations/", import.meta.url);
    const migrations = (await readdir(directory)).filter((name) => /^\d{4}_.+\.sql$/.test(name)).sort();
    expect(migrations.at(-1)).toBe("0053_root_rework_order_logical_deletion.sql");
    for (const migration of migrations) await database.query(await readFile(new URL(migration, directory), "utf8"));
    for (const [id, name, role] of [
      [ids.admin, "Audit Admin", "system_admin"],
      [ids.owner, "Owner", "owner_group"],
      [ids.production, "Production", "production_management"],
      [ids.tail, "Tail", "tail_supervisor"],
    ] as const) {
      await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)", [id, name]);
      await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$2,'fixture')", [randomUUID(), id, role]);
    }
    service = new AdminAuditService(database);
  });

  afterAll(async () => {
    await database.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await admin.end();
  });

  it("grants audit:read only to system_admin and keeps query service read-only", async () => {
    const grants = await database.query("SELECT role_code FROM role_capabilities WHERE capability='audit:read' ORDER BY role_code");
    expect(grants.rows).toEqual([{ role_code: "system_admin" }]);
    for (const role of ["owner_group", "production_management", "tail_supervisor", "worker"]) {
      expect(grants.rows).not.toContainEqual({ role_code: role });
    }
    await expect(service.events({ limit: 100 })).resolves.toEqual({ items: [], nextCursor: null });
  });

  it("returns historical actor role snapshots, display names, states, reasons, filters and stable cursors", async () => {
    const requestId = `req-${randomUUID()}`;
    const eventIds = [randomUUID(), randomUUID(), randomUUID()];
    await database.query(
      `INSERT INTO operation_events(event_id,request_id,actor_id,actor_roles,authorization_capability,action,entity_type,entity_id,before_state,after_state,reason,created_at) VALUES
       ($1,$4,$5,ARRAY['owner_group'],'report:export','report.exported','report_export','rework_overview',$6,$7,'export reason','2026-08-05T12:00:03Z'),
       ($2,'req-two',$5,ARRAY['owner_group'],'tools:user','export.created','export_job','job-1',NULL,$8,NULL,'2026-08-05T12:00:02Z'),
       ($3,'req-three',$9,ARRAY['tail_supervisor'],'submission:audit','work.reported','work_report','wr-1',$10,$11,'business reason','2026-08-05T12:00:01Z')`,
      [eventIds[0], eventIds[1], eventIds[2], requestId, ids.owner, { old: true }, { reportType: "rework_overview", filters: { q: "a" } }, { exportType: "custom_export" }, ids.tail, { qty: 1 }, { qty: 2 }],
    );
    await database.query(
      "INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,'tail_supervisor',$2,'fixture role change')",
      [randomUUID(), ids.owner],
    );
    const currentRoles = await database.query<{ role_code: string }>(
      "SELECT role_code FROM user_role_assignments WHERE user_id=$1 AND revoked_at IS NULL ORDER BY role_code",
      [ids.owner],
    );
    expect(currentRoles.rows).toEqual([{ role_code: "owner_group" }, { role_code: "tail_supervisor" }]);

    const page1 = await service.events({ limit: 2 });
    const page2 = await service.events({ limit: 2, cursor: page1.nextCursor ?? undefined });
    expect([...page1.items, ...page2.items].map((item) => item.eventId)).toEqual(eventIds);
    expect(new Set([...page1.items, ...page2.items].map((item) => item.eventId)).size).toBe(3);
    expect(page1.items[0]).toMatchObject({ actorId: ids.owner, actorDisplayName: "Owner", actorRoles: ["owner_group"], beforeState: { old: true }, reason: "export reason" });
    await expect(service.events({ limit: 10, cursor: "not-a-valid-cursor" })).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect((await service.events({ from: "2026-08-05T12:00:02Z", to: "2026-08-05T12:00:03Z", actorId: ids.owner, action: "report.exported", entityType: "report_export", entityId: "rework_overview", authorizationCapability: "report:export", requestId, limit: 10 })).items.map((item) => item.eventId)).toEqual([eventIds[0]]);
    expect((await service.exports({ reportType: "rework_overview", limit: 10 })).items[0]).toMatchObject({ action: "report.exported", reportType: "rework_overview", exportType: null });
    expect((await service.exports({ exportType: "custom_export", limit: 10 })).items[0]).toMatchObject({ action: "export.created", exportType: "custom_export", reportType: null });
    expect((await database.query("SELECT count(*)::int count FROM operation_events")).rows[0].count).toBe(3);
  });
});
