import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReworkInitiationService } from "../../apps/api/src/rework/service.js";
import { ownedPostgresSchema } from "../helpers/owned-postgres-schema.js";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const runWithPostgres = databaseUrl ? describe : describe.skip;

// Exercise the real entry query with separate, stable source identities.
// These tables are an isolated read-model fixture, never business data.
const sourceTables = `
  CREATE TABLE receiving_batches(receiving_batch_id uuid PRIMARY KEY,style_no text,cutting_order_id uuid,deleted_at timestamptz);
  CREATE TABLE cutting_orders(cutting_order_id uuid PRIMARY KEY,sourcing_case_id uuid,sourcing_line_position integer,approval_snapshot_id uuid);
  CREATE TABLE sourcing_cases(sourcing_case_id uuid PRIMARY KEY,created_by uuid,workflow_generation text,deleted_at timestamptz);
  CREATE TABLE current_sourcing_case_lines(sourcing_case_id uuid,position integer,image_attachment_id uuid);
  CREATE TABLE sourcing_approval_snapshots(sourcing_approval_snapshot_id uuid PRIMARY KEY,supplier_id uuid);
  CREATE TABLE rework_orders(rework_order_id uuid PRIMARY KEY,source_receiving_batch_id uuid,status text);
`;
const digitalTables = `
  CREATE TABLE digital_production_orders(production_order_id uuid PRIMARY KEY,primary_merchandiser_id uuid);
  CREATE TABLE digital_production_child_links(module text,child_id uuid,production_order_id uuid,PRIMARY KEY(module,child_id));
`;

runWithPostgres("QC receiving entry follows the stable digital primary merchandiser", () => {
  const schema = ownedPostgresSchema("rework_source");
  const legacySchema = ownedPostgresSchema("rework_source_legacy");
  const admin = new pg.Pool({ connectionString: databaseUrl! });
  const database = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${schema}` });
  const legacyDatabase = new pg.Pool({ connectionString: databaseUrl!, options: `-c search_path=${legacySchema}` });
  const service = new ReworkInitiationService(database, "corp");
  const creator = randomUUID();
  const primary = randomUUID();

  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema}; CREATE SCHEMA ${legacySchema}`);
    await database.query(sourceTables + digitalTables);
    await legacyDatabase.query(sourceTables);
  });
  afterAll(async () => {
    await database.end();
    await legacyDatabase.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE; DROP SCHEMA IF EXISTS ${legacySchema} CASCADE`);
    await admin.end();
  });

  const source = async (options: { generation?: string; createdBy?: string; primaryId?: string | null } = {}, db = database) => {
    const ids = {
      batch: randomUUID(), cutting: randomUUID(), sourcing: randomUUID(), snapshot: randomUUID(),
      order: randomUUID(), image: randomUUID(), factory: randomUUID(),
    };
    await db.query("INSERT INTO sourcing_cases VALUES($1,$2,$3,NULL)",
      [ids.sourcing, options.createdBy ?? creator, options.generation ?? "digital_production_v1"]);
    await db.query("INSERT INTO current_sourcing_case_lines VALUES($1,1,$2)", [ids.sourcing, ids.image]);
    await db.query("INSERT INTO sourcing_approval_snapshots VALUES($1,$2)", [ids.snapshot, ids.factory]);
    await db.query("INSERT INTO cutting_orders VALUES($1,$2,1,$3)", [ids.cutting, ids.sourcing, ids.snapshot]);
    await db.query("INSERT INTO receiving_batches VALUES($1,'SOURCE-PO', $2,NULL)", [ids.batch, ids.cutting]);
    if (db === database) {
      await db.query("INSERT INTO digital_production_orders VALUES($1,$2)",
        [ids.order, options.primaryId === undefined ? primary : options.primaryId]);
      await db.query("INSERT INTO digital_production_child_links VALUES('sourcing',$1,$3),('cutting',$2,$3)",
        [ids.sourcing, ids.cutting, ids.order]);
    }
    return ids;
  };

  it("uses the primary merchandiser for Root-created digital sourcing, retaining original factory and source photo", async () => {
    const ids = await source();
    expect(await service.getReceivingEntry(ids.batch)).toEqual({
      receivingBatchId: ids.batch, styleNo: "SOURCE-PO", merchandiserUserId: primary,
      processingFactorySupplierId: ids.factory, sourceImageAttachmentId: ids.image,
    });
    expect(primary).not.toBe(creator);
    const currentPrimary = randomUUID();
    await database.query("UPDATE digital_production_orders SET primary_merchandiser_id=$2 WHERE production_order_id=$1",
      [ids.order, currentPrimary]);
    expect((await service.getReceivingEntry(ids.batch)).merchandiserUserId).toBe(currentPrimary);
  });

  it("also preserves the ordinary primary-merchandiser creation path", async () => {
    const ids = await source({ createdBy: primary });
    expect((await service.getReceivingEntry(ids.batch)).merchandiserUserId).toBe(primary);
  });

  it("keeps legacy created_by even when digital tables or unrelated links exist", async () => {
    const ids = await source({ generation: "legacy" });
    expect((await service.getReceivingEntry(ids.batch)).merchandiserUserId).toBe(creator);
    const legacy = await source({ generation: "legacy" }, legacyDatabase);
    expect((await new ReworkInitiationService(legacyDatabase, "corp").getReceivingEntry(legacy.batch)).merchandiserUserId).toBe(creator);
  });

  it("never falls back to the creator when the digital primary or either stable link is absent", async () => {
    const empty = await source({ primaryId: null });
    expect((await service.getReceivingEntry(empty.batch)).merchandiserUserId).toBeNull();
    for (const module of ["cutting", "sourcing"] as const) {
      const ids = await source();
      await database.query("DELETE FROM digital_production_child_links WHERE module=$1 AND child_id=$2",
        [module, module === "cutting" ? ids.cutting : ids.sourcing]);
      expect((await service.getReceivingEntry(ids.batch)).merchandiserUserId).toBeNull();
    }
  });

  it("refuses a different mother-order link and never guesses by the repeated style number", async () => {
    const ids = await source();
    const other = await source({ primaryId: randomUUID() });
    await database.query("UPDATE digital_production_child_links SET production_order_id=$2 WHERE module='sourcing' AND child_id=$1",
      [ids.sourcing, other.order]);
    expect((await service.getReceivingEntry(ids.batch)).merchandiserUserId).toBeNull();
    const noCutting = randomUUID();
    await database.query("INSERT INTO receiving_batches VALUES($1,'SOURCE-PO',NULL,NULL)", [noCutting]);
    expect(await service.getReceivingEntry(noCutting)).toEqual({
      receivingBatchId: noCutting, styleNo: "SOURCE-PO", merchandiserUserId: null,
      processingFactorySupplierId: null, sourceImageAttachmentId: null,
    });
  });

  it("retains deleted-source, deleted-batch and duplicate-rework boundaries", async () => {
    const deletedSource = await source();
    await database.query("UPDATE sourcing_cases SET deleted_at=CURRENT_TIMESTAMP WHERE sourcing_case_id=$1", [deletedSource.sourcing]);
    expect((await service.getReceivingEntry(deletedSource.batch)).merchandiserUserId).toBeNull();
    const ids = await source();
    await database.query("UPDATE receiving_batches SET deleted_at=CURRENT_TIMESTAMP WHERE receiving_batch_id=$1", [ids.batch]);
    await expect(service.getReceivingEntry(ids.batch)).rejects.toMatchObject({ code: "NOT_FOUND", statusCode: 404 });
    const duplicate = await source();
    await database.query("INSERT INTO rework_orders VALUES($1,$2,'draft')", [randomUUID(), duplicate.batch]);
    await expect(service.getReceivingEntry(duplicate.batch)).rejects.toMatchObject({ code: "CONFLICT", statusCode: 409 });
  });
});
