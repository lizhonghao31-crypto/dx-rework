-- Original and backfilled receipts retain their real provenance when Root
-- appends a quantity correction. Existing events/corrections remain immutable.
ALTER TABLE receiving_receipt_corrections DROP CONSTRAINT receiving_receipt_corrections_receiving_source_check;
ALTER TABLE receiving_receipt_corrections ADD CONSTRAINT receiving_receipt_corrections_receiving_source_check
  CHECK(receiving_source IN ('legacy','initial','backfill','jiashun','other_factory'));

-- The original receiving/operation audit contract uses textual request IDs.
-- Preserve the same real HTTP correlation ID instead of inventing a UUID.
ALTER TABLE receiving_receipt_corrections ALTER COLUMN request_id TYPE text USING request_id::text;
ALTER TABLE receiving_receipt_corrections ADD CONSTRAINT receiving_receipt_corrections_request_id_check
  CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$');
