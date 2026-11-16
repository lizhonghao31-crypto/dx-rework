-- Original and backfilled receipts retain their real provenance when Root
-- appends a quantity correction. Existing events/corrections remain immutable.
ALTER TABLE receiving_receipt_corrections DROP CONSTRAINT receiving_receipt_corrections_receiving_source_check;
ALTER TABLE receiving_receipt_corrections ADD CONSTRAINT receiving_receipt_corrections_receiving_source_check
  CHECK(receiving_source IN ('legacy','initial','backfill','jiashun','other_factory'));
