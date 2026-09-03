-- Keep each historical receipt immutable while allowing Root to append a
-- separately-audited correction for the specific receipt that was entered wrong.

CREATE TABLE receiving_receipt_corrections (
  correction_id uuid PRIMARY KEY,
  receipt_id uuid NOT NULL REFERENCES receiving_receipts(receipt_id),
  receiving_batch_id uuid NOT NULL REFERENCES receiving_batches(receiving_batch_id),
  receiving_source text NOT NULL
    CHECK(receiving_source IN ('jiashun','other_factory')),
  document_quantity bigint NOT NULL CHECK(document_quantity>0),
  actual_quantity bigint NOT NULL CHECK(actual_quantity>=0),
  defective_quantity bigint NOT NULL CHECK(defective_quantity>=0 AND defective_quantity<=actual_quantity),
  corrected_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX receiving_receipt_corrections_latest_idx
  ON receiving_receipt_corrections(receipt_id,created_at DESC,correction_id DESC);

CREATE FUNCTION guard_receiving_receipt_correction_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'receiving receipt corrections are immutable' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER receiving_receipt_corrections_no_update
  BEFORE UPDATE ON receiving_receipt_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_receipt_correction_immutable();

CREATE TRIGGER receiving_receipt_corrections_no_delete
  BEFORE DELETE ON receiving_receipt_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_receipt_correction_immutable();
