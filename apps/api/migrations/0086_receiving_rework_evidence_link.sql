-- 1.0 prelaunch: stable receiving evidence batches and receiving -> rework linkage.
-- Business users continue to identify work by style_no; UUIDs below are internal only.

CREATE TABLE receiving_batches (
  receiving_batch_id uuid PRIMARY KEY,
  style_no text NOT NULL CHECK(length(btrim(style_no)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX receiving_batches_style_time_idx
  ON receiving_batches(style_no,created_at,receiving_batch_id);

ALTER TABLE receiving_receipts
  ADD COLUMN receiving_batch_id uuid REFERENCES receiving_batches(receiving_batch_id);

-- Existing immutable receipt facts are grouped once by style for compatibility.
INSERT INTO receiving_batches(receiving_batch_id,style_no,created_by,created_at)
SELECT gen_random_uuid(), grouped.style_no, grouped.created_by, grouped.created_at
FROM (
  SELECT DISTINCT ON (style_no)
         style_no,
         first_value(received_by) OVER (
           PARTITION BY style_no ORDER BY received_at,receipt_id
         ) AS created_by,
         min(received_at) OVER (PARTITION BY style_no) AS created_at
  FROM receiving_receipts
  ORDER BY style_no,received_at,receipt_id
) grouped;

ALTER TABLE receiving_receipts DISABLE TRIGGER receiving_receipts_no_update;
UPDATE receiving_receipts receipt
SET receiving_batch_id=batch.receiving_batch_id
FROM receiving_batches batch
WHERE batch.style_no=receipt.style_no
  AND receipt.receiving_batch_id IS NULL;
ALTER TABLE receiving_receipts ENABLE TRIGGER receiving_receipts_no_update;

ALTER TABLE receiving_receipts
  ALTER COLUMN receiving_batch_id SET NOT NULL;

CREATE INDEX receiving_receipts_batch_time_idx
  ON receiving_receipts(receiving_batch_id,received_at,receipt_id);

CREATE TRIGGER receiving_batches_no_update
  BEFORE UPDATE ON receiving_batches FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_batches_no_delete
  BEFORE DELETE ON receiving_batches FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER receiving_batches_no_truncate
  BEFORE TRUNCATE ON receiving_batches FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

ALTER TABLE rework_orders
  ADD COLUMN source_receiving_batch_id uuid REFERENCES receiving_batches(receiving_batch_id);

-- Compatibility backfill links at most one legacy rework to each legacy style batch.
-- Prefer a currently active rework; otherwise a completed rework closes the legacy batch.
ALTER TABLE rework_orders DISABLE TRIGGER USER;
WITH preferred_order AS (
  SELECT DISTINCT ON (style_no)
         rework_order_id,style_no
  FROM rework_orders
  WHERE style_no IS NOT NULL AND status<>'deleted'
  ORDER BY style_no,
           CASE
             WHEN status NOT IN ('completed','cancelled','deleted') THEN 0
             WHEN status='completed' THEN 1
             ELSE 2
           END,
           updated_at DESC,rework_order_id DESC
)
UPDATE rework_orders rework
SET source_receiving_batch_id=batch.receiving_batch_id
FROM preferred_order preferred
JOIN receiving_batches batch ON batch.style_no=preferred.style_no
WHERE rework.rework_order_id=preferred.rework_order_id
  AND rework.source_receiving_batch_id IS NULL;
ALTER TABLE rework_orders ENABLE TRIGGER USER;

CREATE INDEX rework_orders_receiving_batch_idx
  ON rework_orders(source_receiving_batch_id,updated_at DESC)
  WHERE source_receiving_batch_id IS NOT NULL;

CREATE UNIQUE INDEX rework_orders_active_receiving_batch_idx
  ON rework_orders(source_receiving_batch_id)
  WHERE source_receiving_batch_id IS NOT NULL
    AND status NOT IN ('completed','cancelled','deleted');

-- A real server draft created after receiving automatically binds only to the
-- latest batch for that style, and only while that latest batch is unfinished.
-- Local browser-only drafts never touch this trigger.
CREATE OR REPLACE FUNCTION bind_rework_receiving_batch_on_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_receiving_batch_id IS NULL AND NEW.style_no IS NOT NULL THEN
    SELECT candidate.receiving_batch_id
    INTO NEW.source_receiving_batch_id
    FROM (
      SELECT batch.receiving_batch_id
      FROM receiving_batches batch
      WHERE batch.style_no=NEW.style_no
      ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
      LIMIT 1
    ) candidate
    WHERE NOT EXISTS (
      SELECT 1
      FROM rework_orders completed_order
      WHERE completed_order.source_receiving_batch_id=candidate.receiving_batch_id
        AND completed_order.status='completed'
    );
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_orders_00_bind_receiving_batch
  BEFORE INSERT ON rework_orders
  FOR EACH ROW EXECUTE FUNCTION bind_rework_receiving_batch_on_insert();

CREATE OR REPLACE FUNCTION guard_rework_receiving_batch_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source_receiving_batch_id IS DISTINCT FROM OLD.source_receiving_batch_id THEN
    RAISE EXCEPTION 'source receiving batch is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_orders_receiving_batch_no_update
  BEFORE UPDATE ON rework_orders
  FOR EACH ROW EXECUTE FUNCTION guard_rework_receiving_batch_identity();
