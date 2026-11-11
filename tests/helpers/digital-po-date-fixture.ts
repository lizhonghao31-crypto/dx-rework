import { readFile } from "node:fs/promises";
import type { Pool } from "pg";
import {applyOrderMerchandiserFixture} from './order-merchandiser-fixture.js';

// Minimal digital fixtures omit sourcing. Use the real shared normalization
// function, then the real prospective migration; never substitute a date guard.
export async function applyDigitalPoDateFixture(database: Pool): Promise<void> {
  await applyOrderMerchandiserFixture(database);
  const styleMigration = await readFile(new URL("../../apps/api/migrations/0196_sourcing_style_duplicate_guards.sql", import.meta.url), "utf8");
  const normalizer = styleMigration.match(/CREATE FUNCTION normalize_sourcing_style_key[\s\S]*?\$\$;/)?.[0];
  if (!normalizer) throw new Error("Missing real sourcing PO normalizer");
  await database.query(normalizer);
  await database.query("CREATE TABLE sourcing_finance_reconciliations(sourcing_case_id uuid REFERENCES sourcing_cases,sourcing_contract_document_id uuid)");
  await database.query(await readFile(new URL("../../apps/api/migrations/0237_digital_po_identity_dates.sql", import.meta.url), "utf8"));
  await database.query(await readFile(new URL("../../apps/api/migrations/0238_digital_po_customer_requests.sql", import.meta.url), "utf8"));
  await database.query("CREATE TABLE sourcing_contract_documents(sourcing_contract_document_id uuid PRIMARY KEY,sourcing_case_id uuid,sourcing_approval_snapshot_id uuid,contract_version integer)");
  await database.query("CREATE TABLE sourcing_approval_snapshots(sourcing_approval_snapshot_id uuid PRIMARY KEY,sourcing_case_id uuid)");
  const revision=await readFile(new URL("../../apps/api/migrations/0241_contract_version_review_transfer_delivery.sql",import.meta.url),"utf8");
  for(const name of ["sourcing_authorized_transfer_po_snapshot","sourcing_po_factory_date_locked","guard_digital_po_date_change"]){
    const sql=revision.match(new RegExp("CREATE(?: OR REPLACE)? FUNCTION "+name+"[\\s\\S]*?\\$\\$;"))?.[0];
    if(!sql)throw new Error("Missing real current-version PO date guard: "+name);
    await database.query(sql);
  }
}
