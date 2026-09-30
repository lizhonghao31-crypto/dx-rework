-- 1.0 prelaunch: record defective units as an immutable receiving fact.
-- Existing receipts and batches default to zero without rewriting historical rows.

ALTER TABLE receiving_receipts
  ADD COLUMN defective_quantity integer NOT NULL DEFAULT 0
    CHECK(defective_quantity>=0 AND defective_quantity<=actual_quantity);

ALTER TABLE receiving_batches
  ADD COLUMN defective_quantity_adjustment bigint NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION guard_receiving_batch_defective_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  action_name text:=nullif(current_setting('dx_rework.receiving_root_action',true),'');
  effective_defective bigint;
  effective_actual bigint;
  audited_defective bigint;
BEGIN
  IF action_name='correct' THEN
    effective_defective:=NEW.defective_quantity_adjustment+(
      SELECT COALESCE(sum(receipt.defective_quantity),0)
      FROM receiving_receipts receipt
      WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
    );
    effective_actual:=NEW.actual_quantity_adjustment+(
      SELECT COALESCE(sum(receipt.actual_quantity),0)
      FROM receiving_receipts receipt
      WHERE receipt.receiving_batch_id=NEW.receiving_batch_id
    );
    SELECT (event.after_state->>'defectiveQuantity')::bigint
    INTO audited_defective
    FROM operation_events event
    WHERE event.event_id=NEW.last_operation_event_id;

    IF effective_defective<0
       OR effective_defective>effective_actual
       OR audited_defective IS DISTINCT FROM effective_defective
    THEN
      RAISE EXCEPTION 'receiving defective correction does not match root audit event'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  IF action_name='delete' THEN
    IF NEW.defective_quantity_adjustment<>OLD.defective_quantity_adjustment THEN
      RAISE EXCEPTION 'receiving deletion cannot change defective quantity'
        USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'receiving defective history is immutable' USING ERRCODE='55000';
END;
$$;

CREATE TRIGGER receiving_batches_defective_update_guard
  BEFORE UPDATE ON receiving_batches
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_batch_defective_update();

