import { readFile } from "node:fs/promises";
import type { Pool } from "pg";

// Minimal digital fixtures omit sourcing. Use the real shared normalization
// function, then the real prospective migration; never substitute a date guard.
export async function applyDigitalPoDateFixture(database: Pool): Promise<void> {
  const styleMigration = await readFile(new URL("../../apps/api/migrations/0196_sourcing_style_duplicate_guards.sql", import.meta.url), "utf8");
  const normalizer = styleMigration.match(/CREATE FUNCTION normalize_sourcing_style_key[\s\S]*?\$\$;/)?.[0];
  if (!normalizer) throw new Error("Missing real sourcing PO normalizer");
  await database.query(normalizer);
  await database.query("CREATE TABLE sourcing_finance_reconciliations(sourcing_case_id uuid REFERENCES sourcing_cases)");
  await database.query(await readFile(new URL("../../apps/api/migrations/0237_digital_po_identity_dates.sql", import.meta.url), "utf8"));
  await database.query(await readFile(new URL("../../apps/api/migrations/0238_digital_po_customer_requests.sql", import.meta.url), "utf8"));
}
