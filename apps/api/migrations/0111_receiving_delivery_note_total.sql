-- Keep the warehouse workflow unchanged while separating the delivery-note
-- total from the immutable facts recorded for each physical receipt.

ALTER TABLE receiving_batches
  ADD COLUMN delivery_note_quantity bigint;

UPDATE receiving_batches batch
SET delivery_note_quantity=totals.document_quantity+batch.document_quantity_adjustment
FROM (
  SELECT receipt.receiving_batch_id,sum(receipt.document_quantity)::bigint AS document_quantity
  FROM receiving_receipts receipt
  GROUP BY receipt.receiving_batch_id
) totals
WHERE totals.receiving_batch_id=batch.receiving_batch_id;

ALTER TABLE receiving_batches
  ALTER COLUMN delivery_note_quantity SET NOT NULL,
  ADD CONSTRAINT receiving_batches_delivery_note_quantity_positive
    CHECK(delivery_note_quantity>0);

CREATE OR REPLACE FUNCTION guard_receiving_batch_delivery_note_quantity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
  effective_document bigint;
  audited_document bigint;
BEGIN
  IF action_name='correct' THEN
    effective_document:=NEW.document_quantity_adjustment+(
      SELECT COALESCE(sum(receipt.document_quantity),0)
      FROM receiving_receipts receipt
      WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
    );
    SELECT (event.after_state->>'documentQuantity')::bigint
    INTO audited_document
    FROM operation_events event
    WHERE event.event_id=NEW.last_operation_event_id;

    IF NEW.delivery_note_quantity IS DISTINCT FROM effective_document
       OR audited_document IS DISTINCT FROM NEW.delivery_note_quantity
    THEN
      RAISE EXCEPTION 'receiving delivery-note correction does not match root audit event'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF action_name='delete' THEN
    IF NEW.delivery_note_quantity IS DISTINCT FROM OLD.delivery_note_quantity THEN
      RAISE EXCEPTION 'receiving deletion cannot change delivery-note quantity'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'receiving delivery-note total is immutable'
    USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER receiving_batches_delivery_note_quantity_guard
  BEFORE UPDATE ON receiving_batches
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_batch_delivery_note_quantity();
