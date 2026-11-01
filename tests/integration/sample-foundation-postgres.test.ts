import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stageSampleSource } from "../../apps/api/src/samples/sample-migration.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const run = databaseUrl ? describe : describe.skip;
run("sample domain database boundaries", () => {
  const schema = ownedPostgresSchema("sample");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const userId = randomUUID();
  const actor = { actorId: userId, actorRoles: ["root_superuser"], authorizationCapability: "sample:archive", requestId: "sample-foundation-test" };
  const source = { samples: [{ id: "old-1", sampleCode: "YI-202609-0001", status: "BORROWED", purchasePrice: "10.01",
    purchaser: "historical-label", currentHolder: "historical-label", borrowHistory: [{}], disposalHistory: [], receiptImages: [] }],
  logs: [{ id: "log-1", sampleId: "old-1", actor: "historical-label", detail: "history retained" }], borrowRequests: [], updatedAt: "2026-09-01" };
  beforeAll(async () => {
    await createOwnedPostgresSchema(admin,schema);
    for (const name of ["0001_platform_foundation.sql", "0002_dingtalk_identity_access.sql", "0003_identity_union_continuity.sql", "0004_public_tools_foundation.sql", "0005_access_master_data.sql", "0152_sample_domain_foundation.sql"]) {
      await database.query(await readFile(new URL(`../../apps/api/migrations/${name}`, import.meta.url), "utf8"));
    }
    await database.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,'sample fixture',true)", [userId]);
  });
  afterAll(async () => {
    await database.end();
    await dropOwnedPostgresSchema(admin,schema);
    await admin.end();
  });
  const createItem = async (status: string, holder: string | null, location: string | null) => {
    const id = randomUUID();
    await database.query(`INSERT INTO sample_items(sample_id,sample_code,status,brand,style_name,color,department,purchase_date,
      purchaser_user_id,purchaser_name,holder_user_id,holder_name,storage_location,borrowed_at,created_by)
      VALUES($1,$2,$3,'test','test','blue','design','2026-09-01',$4,'test',$5,$6,$7,CURRENT_TIMESTAMP,$4)`,
    [id, `YI-test-${id}`, status, userId, holder, holder ? "test" : null, location]);
    return id;
  };
  it("enforces custody and stock location invariants and rejects arbitrary states", async () => {
    await expect(createItem("in_stock", userId, "rack")).rejects.toMatchObject({ code: "23514" });
    await expect(createItem("in_stock", null, null)).rejects.toMatchObject({ code: "23514" });
    await expect(createItem("borrowed", null, null)).rejects.toMatchObject({ code: "23514" });
    await expect(createItem("arbitrary", null, null)).rejects.toMatchObject({ code: "23514" });
    await expect(createItem("in_stock", null, "rack")).resolves.toBeTypeOf("string");
    await expect(createItem("borrowed", userId, null)).resolves.toBeTypeOf("string");
  });
  it("allows only one active request and one current custody record", async () => {
    const id = await createItem("borrowed", userId, null);
    const request = () => database.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by)
      VALUES($1,$2,'return','pending','borrowed',$3)`, [randomUUID(), id, userId]);
    await request();
    await expect(request()).rejects.toMatchObject({ code: "23505" });
    const custodyId = randomUUID();
    const custody = (key: string) => database.query(`INSERT INTO sample_custody_records(custody_id,sample_id,holder_user_id,holder_name,department,purpose,borrowed_at,requested_by,initial_custody)
      VALUES($1,$2,$3,'test','design','initial',CURRENT_TIMESTAMP,$3,true)`, [key, id, userId]);
    await custody(custodyId);
    await expect(custody(randomUUID())).rejects.toMatchObject({ code: "23505" });
    await expect(database.query("UPDATE sample_custody_records SET purpose='rewrite' WHERE custody_id=$1", [custodyId])).rejects.toMatchObject({ code: "55000" });
    await database.query("UPDATE sample_custody_records SET returned_at=CURRENT_TIMESTAMP WHERE custody_id=$1", [custodyId]);
    await expect(database.query("UPDATE sample_custody_records SET returned_at=NULL WHERE custody_id=$1", [custodyId])).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("DELETE FROM sample_items WHERE sample_id=$1", [id])).rejects.toMatchObject({ code: "55000" });
  });
  it("stages concurrent identical snapshots once with append-only evidence and no business import", async () => {
    const before = await database.query("SELECT count(*)::integer AS count FROM sample_items");
    const results = await Promise.all([stageSampleSource(database, actor, source), stageSampleSource(database, actor, source)]);
    expect(results[0]!.batchId).toBe(results[1]!.batchId);
    expect(results.filter((result) => result.reused)).toHaveLength(1);
    expect((await database.query("SELECT count(*)::integer AS count FROM sample_legacy_mappings")).rows[0].count).toBe(2);
    expect((await database.query("SELECT count(*)::integer AS count FROM operation_events WHERE action='sample.migration_staged'")).rows[0].count).toBe(1);
    expect((await database.query("SELECT count(*)::integer AS count FROM sample_items")).rows[0].count).toBe(before.rows[0].count);
    await expect(database.query("UPDATE sample_migration_batches SET source_updated_at='rewritten'")).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("DELETE FROM sample_legacy_mappings")).rejects.toMatchObject({ code: "55000" });
    const history = (await database.query("SELECT source_payload FROM sample_legacy_mappings WHERE entity_type='log'")).rows[0].source_payload;
    expect(history).toEqual(source.logs[0]);
  });
  it("does not give technical administrators sample access or finance mutation rights", async () => {
    const grants = await database.query("SELECT role_code,capability FROM role_capabilities WHERE capability LIKE 'sample:%'");
    expect(grants.rows.some((row) => row.role_code === "system_admin")).toBe(false);
    expect(grants.rows.some((row) => row.capability === "sample:archive" || row.capability === "sample:correct_finance")).toBe(false);
    expect(grants.rows.filter((row) => row.capability === "sample:dispose_approve").map((row) => row.role_code)).toEqual(["owner_group"]);
  });
  it("ties disposal identity, type and valid source state to its request and protects history", async () => {
    const first = await createItem("in_stock", null, "rack"), second = await createItem("in_stock", null, "rack");
    const request = async (kind: string, from: string) => {
      const key = randomUUID();
      await database.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by)
        VALUES($1,$2,$3,'pending',$4,$5)`, [key, first, kind, from, userId]);
      return key;
    };
    // Active records exercise source-state constraints without terminal resolution fields.
    for (const [kind, from] of [["borrow", "borrowed"], ["return", "in_stock"], ["sale", "borrowed"], ["gift", "borrowed"], ["loss", "in_stock"]]) {
      await expect(request(kind!, from!)).rejects.toMatchObject({ code: "23514" });
    }
    const requestId = randomUUID();
    await database.query(`INSERT INTO sample_workflow_requests(request_id,sample_id,request_type,status,from_status,requested_by)
      VALUES($1,$2,'sale','pending','in_stock',$3)`, [requestId, first, userId]);
    const disposal = (sampleId: string, kind: string, proposed: string | null, final: string | null, approved: boolean) => database.query(
      `INSERT INTO sample_disposals(disposal_id,request_id,sample_id,disposal_type,proposed_amount,final_amount,approved_by,approved_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [randomUUID(), requestId, sampleId, kind, proposed, final, approved ? userId : null, approved ? new Date() : null]);
    await expect(disposal(second, "sale", "10.00", null, false)).rejects.toMatchObject({ code: "23503" });
    await expect(disposal(first, "gift", null, null, false)).rejects.toMatchObject({ code: "23503" });
    await expect(disposal(first, "sale", null, null, false)).rejects.toMatchObject({ code: "23514" });
    await expect(disposal(first, "sale", "10.00", null, true)).rejects.toMatchObject({ code: "23514" });
    await expect(disposal(first, "sale", "10.00", "0.00", true)).rejects.toMatchObject({ code: "23514" });
    await disposal(first, "sale", "10.00", "10.00", true);
    await expect(database.query("DELETE FROM sample_disposals WHERE request_id=$1", [requestId])).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("DELETE FROM sample_workflow_requests WHERE request_id=$1", [requestId])).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("TRUNCATE sample_disposals")).rejects.toMatchObject({ code: "55000" });
    await expect(database.query("TRUNCATE sample_workflow_requests CASCADE")).rejects.toMatchObject({ code: "55000" });
  });
});
