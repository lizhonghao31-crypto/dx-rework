import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { requireFinanceWageAccess } from "../../apps/api/src/wages/wage-access.js";

const url = process.env.TEST_DATABASE_URL;
(url ? describe : describe.skip)("finance wage persisted authorization", () => {
  const schema = ownedPostgresSchema("finance_access");
  const admin = new pg.Pool({ connectionString: url });
  const db = new pg.Pool({ connectionString: url, options: `-c search_path=${schema}` });
  const allowed = ["owner_group", "production_management", "finance_director", "wage_month_close_accountant", "finance_read"];
  const denied = ["worker", "tail_supervisor", "sample_designer", "pattern_room_supervisor", "warehouse_receiver"];
  const markers = ["finance_director", "wage_month_close_accountant", "finance_read"];
  const actors = new Map([...allowed, ...denied, "root_superuser"].map(role => [role, randomUUID()]));

  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
    await db.query(`
      CREATE TABLE role_capabilities(role_code text,capability text,PRIMARY KEY(role_code,capability));
      CREATE TABLE test_roles(user_id uuid,role_code text);
      CREATE TABLE delegated_grants(user_id uuid,capability text);
      CREATE TABLE historical_wages(id uuid PRIMARY KEY, amount numeric, marked_at timestamptz);
      CREATE FUNCTION immutable_catalog() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'immutable'; END $$;
      CREATE FUNCTION access_authorized_actor_roles(target uuid,requested text) RETURNS text[] LANGUAGE plpgsql AS $$
      DECLARE roles text[];
      BEGIN
        SELECT array_agg(role_code ORDER BY role_code) INTO roles FROM test_roles WHERE user_id=target;
        IF 'root_superuser'=ANY(roles) THEN RETURN roles; END IF;
        IF roles IS NULL OR NOT (EXISTS(SELECT 1 FROM role_capabilities WHERE role_code=ANY(roles) AND capability=requested)
          OR EXISTS(SELECT 1 FROM delegated_grants WHERE user_id=target AND capability=requested)) THEN
          RAISE EXCEPTION 'forbidden' USING ERRCODE='42501';
        END IF;
        RETURN roles;
      END $$;
    `);
    for (const role of [...allowed, ...denied]) {
      await db.query("INSERT INTO role_capabilities VALUES($1,'wage:view'),($1,'wage:export')", [role]);
    }
    for (const role of markers) await db.query("INSERT INTO role_capabilities VALUES($1,'wage:settlement_mark')", [role]);
    for (const [role, id] of actors) await db.query("INSERT INTO test_roles VALUES($1,$2)", [id, role]);
    // Delegated old capabilities must not bypass the new explicit role whitelist.
    await db.query("INSERT INTO delegated_grants VALUES($1,'wage:view'),($2,'wage:settlement_mark')", [actors.get("worker"), actors.get("owner_group")]);
    await db.query("INSERT INTO historical_wages VALUES($1,12.345,'2026-09-01T00:00:00Z')", [randomUUID()]);
    await db.query(`CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities FOR EACH ROW EXECUTE FUNCTION immutable_catalog();
      CREATE TRIGGER role_capabilities_no_delete BEFORE DELETE ON role_capabilities FOR EACH ROW EXECUTE FUNCTION immutable_catalog();`);
    await db.query(await readFile(new URL("../../apps/api/migrations/0174_finance_wage_access.sql", import.meta.url), "utf8"));
  });
  afterAll(async () => { await db.end(); await dropOwnedPostgresSchema(admin,schema); await admin.end(); });

  it("grants all five role categories read/export and preserves only existing markers", async () => {
    for (const role of allowed) {
      for (const capability of ["wage:view", "wage:export"]) {
        expect((await db.query("SELECT finance_authorized_wage_roles($1,$2)", [actors.get(role), capability])).rowCount).toBe(1);
      }
      const mark = db.query("SELECT finance_authorized_wage_roles($1,'wage:settlement_mark')", [actors.get(role)]);
      if (markers.includes(role)) await expect(mark).resolves.toMatchObject({ rowCount: 1 });
      else await expect(mark).rejects.toThrow();
    }
    expect((await db.query("SELECT role_code FROM role_capabilities WHERE capability='wage:view' ORDER BY role_code")).rows.map(row => row.role_code)).toEqual([...allowed].sort());
  });
  it("rejects excluded identities and forged caller roles even with delegated legacy grants", async () => {
    for (const role of denied) await expect(db.query("SELECT finance_authorized_wage_roles($1,'wage:view')", [actors.get(role)])).rejects.toThrow();
    await expect(requireFinanceWageAccess(db, {
      actorId: actors.get("worker")!, actorRoles: ["finance_read"], requestId: "forged-test",
      authorizationCapability: "wage:view", authorizationCapabilities: ["wage:view"],
    }, "wage:view")).rejects.toThrow();
  });
  it("honors compound roles and Root, leaving historical wages and marks intact", async () => {
    await db.query("INSERT INTO test_roles VALUES($1,'finance_read')", [actors.get("owner_group")]);
    expect((await db.query("SELECT finance_authorized_wage_roles($1,'wage:settlement_mark')", [actors.get("owner_group")])).rowCount).toBe(1);
    for (const cap of ["wage:view", "wage:export", "wage:settlement_mark"]) expect((await db.query("SELECT finance_authorized_wage_roles($1,$2)", [actors.get("root_superuser"), cap])).rowCount).toBe(1);
    expect((await db.query("SELECT amount::text,marked_at FROM historical_wages")).rows).toEqual([{ amount: "12.345", marked_at: new Date("2026-09-01T00:00:00Z") }]);
  });
});
