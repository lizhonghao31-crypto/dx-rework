import {readFile} from "node:fs/promises";
import { ownedPostgresSchema, createOwnedPostgresSchema, dropOwnedPostgresSchema } from "../helpers/owned-postgres-schema.js";
import {randomUUID} from "node:crypto";
import {RECEIVING_BOARD_BASE_SQL} from "../../apps/api/src/receiving/receiving-service.js";
import pg from "pg";
import {afterAll, beforeAll, describe, expect, it} from "vitest";
import {readReceivingAnalysis, RECEIVING_ANALYSIS_LINKS_SQL} from "../../apps/api/src/receiving/receiving-analysis.js";

const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
(url ? describe : describe.skip)("receiving analysis SQL contracts", () => {
  const schema = ownedPostgresSchema("receiving");
  const admin = new pg.Pool({connectionString: url!});
  const database = new pg.Pool({connectionString: url!, options: `-c search_path=${schema}`});
  const actor = {actorId: randomUUID(), actorRoles: ["warehouse_receiver"], authorizationCapability: "receiving:read", requestId: randomUUID()};
  const batch = randomUUID(), secondBatch = randomUUID(), receipt = randomUUID(), production = randomUUID(), supplier = randomUUID();
  const oldPacking = randomUUID(), packing = randomUUID(), historicalResolution = randomUUID();
  let base = "";
  const query = {startDate: "2026-09-01", endDate: "2026-09-07"};
  beforeAll(async () => {
    base = RECEIVING_BOARD_BASE_SQL;
    await createOwnedPostgresSchema(admin,schema);
    // Isolated table fixtures for the production SQL, not replacement business migrations.
    await database.query(`CREATE TABLE receiving_batches(receiving_batch_id uuid PRIMARY KEY,style_no text,cutting_order_id uuid,deleted_at timestamptz,
      delivery_note_quantity bigint,actual_quantity_adjustment bigint DEFAULT 0,defective_quantity_adjustment bigint DEFAULT 0,version int DEFAULT 1);
      CREATE TABLE receiving_receipts(receipt_id uuid PRIMARY KEY,receiving_batch_id uuid,received_at timestamptz,document_quantity bigint,actual_quantity bigint,defective_quantity bigint DEFAULT 0,receiving_source text DEFAULT 'jiashun',operation_event_id uuid);
      CREATE TABLE operation_events(entity_id text,action text,entity_type text,after_state jsonb,before_state jsonb,created_at timestamptz,event_id uuid DEFAULT gen_random_uuid());
      CREATE TABLE receiving_receipt_corrections(correction_id uuid,receipt_id uuid,actual_quantity bigint,document_quantity bigint,receiving_source text,created_at timestamptz);
      CREATE TABLE receiving_packing_revisions(packing_revision_id uuid,receiving_batch_id uuid,packing_quantity bigint,created_at timestamptz);
      CREATE TABLE receiving_difference_resolutions(resolution_id uuid,receiving_batch_id uuid,difference_type text,document_quantity_snapshot bigint,
        actual_quantity_snapshot bigint,packing_revision_id uuid,packing_quantity_snapshot bigint,difference_quantity_snapshot bigint,result text,created_at timestamptz,operation_event_id uuid);
      CREATE TABLE sourcing_production_receipt_links(receipt_id uuid PRIMARY KEY,production_order_id uuid);
      CREATE TABLE sourcing_production_orders(production_order_id uuid PRIMARY KEY,supplier_id uuid,supplier_name_snapshot text,contract_number text,sourcing_contract_document_id uuid);
      CREATE TABLE sourcing_contract_documents(sourcing_contract_document_id uuid PRIMARY KEY,sourcing_case_id uuid,contract_version int,prepared_at timestamptz);
      CREATE TABLE sourcing_contract_content_overrides(sourcing_contract_document_id uuid PRIMARY KEY,content jsonb);
      CREATE TABLE sourcing_production_exclusions(production_order_id uuid PRIMARY KEY);
      CREATE TABLE attachments(attachment_id uuid,original_filename text,entity_type text,entity_id text,status text,mime_type text);
      CREATE TABLE receiving_attachment_retirements(attachment_id uuid);`);
    await database.query(await readFile(new URL("../../apps/api/migrations/0220_contract_display_consistency.sql",import.meta.url),"utf8"));
    await database.query("INSERT INTO receiving_batches(receiving_batch_id,style_no,delivery_note_quantity) VALUES($1,'SAME',200),($2,' same ',200)", [batch, secondBatch]);
    await database.query("INSERT INTO receiving_receipts(receipt_id,receiving_batch_id,received_at,document_quantity,actual_quantity) VALUES($1,$2,'2026-09-02',200,70),($3,$4,'2026-09-03',200,30)", [receipt, batch, randomUUID(), secondBatch]);
    const contract=randomUUID();
    await database.query("INSERT INTO sourcing_production_orders VALUES($1,$2,'同名供应商','HT-1',$3)", [production, supplier,contract]);
    await database.query("INSERT INTO sourcing_contract_content_overrides VALUES($1,$2)",[contract,{contractNumber:"人工-HT-1"}]);
    await database.query("INSERT INTO sourcing_production_receipt_links VALUES($1,$2)", [receipt, production]);
    await database.query("INSERT INTO receiving_packing_revisions VALUES($1,$2,80,'2026-09-04'),($3,$2,90,'2026-09-05')", [oldPacking, secondBatch, packing]);
    await database.query("INSERT INTO receiving_difference_resolutions(resolution_id,receiving_batch_id,difference_type,document_quantity_snapshot,actual_quantity_snapshot,packing_revision_id,packing_quantity_snapshot,difference_quantity_snapshot,result,created_at) VALUES($1,$2,'packing',200,100,$3,80,20,'旧方向快照','2026-09-04'),($4,$2,'packing',200,100,$5,90,-10,'短装待继续','2026-09-05')", [historicalResolution, secondBatch, oldPacking, randomUUID(), packing]);
    for (let index = 0; index < 16; index++) {
      const id = randomUUID();
      await database.query("INSERT INTO receiving_batches(receiving_batch_id,style_no,delivery_note_quantity) VALUES($1,$2,10)", [id, `OTHER-${index}`]);
      await database.query("INSERT INTO receiving_receipts(receipt_id,receiving_batch_id,received_at,document_quantity,actual_quantity) VALUES($1,$2,'2026-09-03',10,10)", [randomUUID(), id]);
    }
  });
  afterAll(async () => {await database.end(); await dropOwnedPostgresSchema(admin,schema); await admin.end();});
  it("aggregates all matching styles before pagination without repeating the delivery note for split batches", async () => {
    const result = await readReceivingAnalysis(database, base, actor, query);
    expect(result.items).toHaveLength(15); expect(result.summary.totalCount).toBe(17);
    expect(result.summary).toMatchObject({batchCount: "18", documentQuantity: "360", actualQuantity: "260", receivingDifference: "-100", packingQuantity: "90", packingDifference: "-10", missingPackingCount: "16", handledCount: "1", unlinkedReceiptCount: "17"});
    const next = await readReceivingAnalysis(database, base, actor, {...query, page: 2});
    expect(next.items).toHaveLength(2); expect(next.summary).toEqual(result.summary);
  });
  it("retains latest packing, nonzero handled difference and immutable historical direction", async () => {
    const result = await readReceivingAnalysis(database, base, actor, {...query, fact: "handled"});
    expect(result.items).toHaveLength(1); const item = result.items[0]!;
    expect(item).toMatchObject({packingRevisionId: packing, packingQuantity: "90", packingDifference: "-10", packingHandled: true});
    expect(item.resolutions.find(row => row.resolutionId === historicalResolution)?.differenceQuantity).toBe("20");
    expect(item.batchIds).toHaveLength(2); expect(item.receipts).toHaveLength(2);
    expect(item.receipts.find(row => row.receiptId === receipt)?.productionOrderId).toBe(production);
    expect(item.receipts.find(row => row.receiptId === receipt)?.contractNumber).toBe("人工-HT-1");
    expect(item.receipts.filter(row => row.productionOrderId === null)).toHaveLength(1);
  });
  it("missing packing stays null and does not become a final loss", async () => {
    const result = await readReceivingAnalysis(database, base, actor, {...query, fact: "missing_packing"});
    expect(result.summary.totalCount).toBe(16); expect(result.summary.packingQuantity).toBeNull();
    expect(result.summary.packingDifference).toBeNull(); expect(result.items.every(row => row.packingDifference === null)).toBe(true);
  });
  it("uses current explicit receipt revisions for downstream linkage without assigning batch corrections", async () => {
    const correction = randomUUID();
    await database.query("INSERT INTO receiving_receipt_corrections VALUES($1,$2,65,200,'jiashun','2026-09-06')", [correction, receipt]);
    const rows = await database.query(RECEIVING_ANALYSIS_LINKS_SQL);
    const linked = rows.rows.find(row => row.receipt_id === receipt)!;
    expect(String(linked.actual_quantity)).toBe("65");
    expect(linked).toMatchObject({correction_id: correction, production_order_id: production});
    await database.query("DELETE FROM receiving_receipt_corrections WHERE correction_id=$1", [correction]);
  });
  it("masks excluded production context while retaining warehouse facts and explicit coverage", async () => {
    await database.query("INSERT INTO sourcing_production_exclusions VALUES($1)", [production]);
    const result = await readReceivingAnalysis(database, base, actor, {...query, q: "SAME"});
    expect(result.summary.excludedReceiptCount).toBe("1"); expect(result.summary.actualQuantity).toBe("100");
    const row = result.items[0]!.receipts.find(item => item.receiptId === receipt)!;
    expect(row).toMatchObject({productionOrderId: null, supplierId: null, supplierName: null, excluded: true});
    expect(JSON.stringify(result)).not.toContain("同名供应商");
    await database.query("DELETE FROM sourcing_production_exclusions WHERE production_order_id=$1", [production]);
  });
  it("empty results preserve a valid snapshot and zero totals", async () => {
    const result = await readReceivingAnalysis(database, base, actor, {...query, q: "NO-MATCH"});
    expect(result.summary.totalCount).toBe(0); expect(result.summary.actualQuantity).toBe("0"); expect(result.items).toEqual([]);
    expect(new Date(result.asOf).getTime()).not.toBeNaN();
  });
});
