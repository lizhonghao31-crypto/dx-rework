-- PR03: bind new warehouse receiving facts to stable cutting orders.
-- Historical receipts remain nullable; no fabricated cutting linkage is backfilled.

ALTER TABLE receiving_receipts
  ADD COLUMN cutting_order_id uuid REFERENCES cutting_orders(cutting_order_id);

CREATE INDEX receiving_receipts_cutting_order_idx
  ON receiving_receipts(cutting_order_id,received_at,receipt_id)
  WHERE cutting_order_id IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_receiving_cutting_link_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  candidate record;
BEGIN
  IF NEW.cutting_order_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  SELECT option_row.cutting_order_id,
         option_row.formal_style_no
  INTO candidate
  FROM current_cutting_style_options option_row
  WHERE option_row.cutting_order_id=NEW.cutting_order_id;

  IF candidate.cutting_order_id IS NULL
     OR upper(btrim(candidate.formal_style_no))<>upper(btrim(NEW.style_no))
     OR audit_event.event_id IS NULL
     OR audit_event.action<>'receiving.receipt.create'
     OR audit_event.entity_type<>'receiving_receipt'
     OR audit_event.entity_id<>NEW.receipt_id::text
     OR audit_event.authorization_capability<>'receiving:create'
     OR audit_event.after_state->>'cuttingOrderId' IS DISTINCT FROM NEW.cutting_order_id::text
     OR upper(btrim(audit_event.after_state->>'styleNo')) IS DISTINCT FROM upper(btrim(NEW.style_no))
  THEN
    RAISE EXCEPTION 'receiving cutting link requires matching completed cutting order and audit'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER receiving_receipts_cutting_link_guard
  BEFORE INSERT ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_cutting_link_insert();

CREATE OR REPLACE FUNCTION guard_receiving_cutting_link_update()
RETURNS trigger LANGUAGE plpgsql AS $cutting$
BEGIN
  IF NEW.cutting_order_id IS DISTINCT FROM OLD.cutting_order_id THEN
    RAISE EXCEPTION 'receiving cutting link is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$cutting$;

CREATE TRIGGER receiving_receipts_cutting_link_no_update
  BEFORE UPDATE ON receiving_receipts
  FOR EACH ROW EXECUTE FUNCTION guard_receiving_cutting_link_update();

CREATE OR REPLACE FUNCTION guard_sourcing_production_receipt_link()
RETURNS trigger LANGUAGE plpgsql AS $production_receipt$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM receiving_receipts receipt
    JOIN sourcing_production_shipments shipment
      ON shipment.production_order_id=NEW.production_order_id
    JOIN sourcing_production_orders production
      ON production.production_order_id=shipment.production_order_id
    JOIN operation_events event
      ON event.event_id=NEW.operation_event_id
    WHERE receipt.receipt_id=NEW.receipt_id
      AND receipt.operation_event_id=NEW.operation_event_id
      AND (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date>=shipment.shipped_on
      AND event.action='receiving.receipt.create'
      AND event.entity_type='receiving_receipt'
      AND event.entity_id=NEW.receipt_id::text
      AND (
        (
          receipt.cutting_order_id IS NULL
          AND EXISTS (
            SELECT 1
            FROM sourcing_style_aliases alias
            WHERE alias.sourcing_case_id=production.sourcing_case_id
              AND alias.position=1
              AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no))
          )
          AND event.after_state->>'productionOrderId'=NEW.production_order_id::text
        )
        OR
        (
          receipt.cutting_order_id IS NOT NULL
          AND event.after_state->>'cuttingOrderId'=receipt.cutting_order_id::text
          AND EXISTS (
            SELECT 1
            FROM cutting_orders cutting
            JOIN sourcing_style_aliases alias
              ON alias.sourcing_case_id=cutting.sourcing_case_id
             AND alias.position=cutting.sourcing_line_position
            WHERE cutting.cutting_order_id=receipt.cutting_order_id
              AND cutting.sourcing_case_id=production.sourcing_case_id
              AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no))
          )
          AND EXISTS (
            SELECT 1
            FROM sourcing_production_pilots pilot
            WHERE pilot.supplier_id=production.supplier_id
              AND pilot.enabled=true
          )
          AND NOT EXISTS (
            SELECT 1
            FROM sourcing_production_exclusions exclusion
            WHERE exclusion.production_order_id=production.production_order_id
          )
        )
      )
  ) THEN
    RAISE EXCEPTION 'receipt link must match shipped production source and actual receipt audit'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$production_receipt$;

CREATE VIEW current_receiving_cutting_links AS
SELECT receipt.receipt_id,
       receipt.receiving_batch_id,
       receipt.cutting_order_id,
       cutting.sourcing_case_id,
       cutting.sourcing_line_position,
       line.formal_style_no,
       current_record.actual_cut_count,
       COALESCE(decision.supplier_id,snapshot.supplier_id) AS supplier_id,
       COALESCE(decision.supplier_name_snapshot,snapshot.supplier_name_snapshot) AS supplier_name
FROM receiving_receipts receipt
JOIN cutting_orders cutting
  ON cutting.cutting_order_id=receipt.cutting_order_id
JOIN current_sourcing_case_lines line
  ON line.sourcing_case_id=cutting.sourcing_case_id
 AND line.position=cutting.sourcing_line_position
JOIN current_cutting_records current_record
  ON current_record.cutting_order_id=cutting.cutting_order_id
JOIN sourcing_approval_snapshots snapshot
  ON snapshot.sourcing_approval_snapshot_id=cutting.approval_snapshot_id
LEFT JOIN LATERAL (
  SELECT current_decision.supplier_id,current_decision.supplier_name_snapshot
  FROM sourcing_decisions current_decision
  WHERE current_decision.sourcing_case_id=cutting.sourcing_case_id
  ORDER BY current_decision.decision_version DESC
  LIMIT 1
) decision ON true
WHERE receipt.cutting_order_id IS NOT NULL;
