-- Receipt identity comes from shipped production, factory, cutting PO and immutable receipt audit.
-- Supplier pilot controls risk supervision only; no historical receipt is rewritten.
CREATE OR REPLACE FUNCTION guard_sourcing_production_receipt_link()
RETURNS trigger LANGUAGE plpgsql AS $production_receipt$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM receiving_receipts receipt
    JOIN sourcing_production_shipments shipment
      ON shipment.production_order_id=NEW.production_order_id AND shipment.factory_decision_id IS NOT DISTINCT FROM NEW.factory_decision_id
    JOIN sourcing_production_factory_orders production
      ON production.production_order_id=shipment.production_order_id AND production.factory_decision_id IS NOT DISTINCT FROM shipment.factory_decision_id
    JOIN operation_events event
      ON event.event_id=NEW.operation_event_id
    WHERE receipt.receipt_id=NEW.receipt_id
      AND receipt.operation_event_id=NEW.operation_event_id
      AND (receipt.received_at AT TIME ZONE 'Asia/Shanghai')::date>=shipment.shipped_on
      AND event.action='receiving.receipt.create'
      AND event.entity_type='receiving_receipt'
      AND event.entity_id=NEW.receipt_id::text
      AND event.after_state->>'factoryDecisionId' IS NOT DISTINCT FROM NEW.factory_decision_id::text
      AND (
        (
          receipt.cutting_order_id IS NULL
          AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=1 AND allocation.quantity>0)
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
              AND EXISTS(SELECT 1 FROM sourcing_factory_execution_lines(production.production_order_id,production.sourcing_decision_id) allocation WHERE allocation.position=cutting.sourcing_line_position AND allocation.quantity>0)
              AND upper(btrim(alias.style_no))=upper(btrim(receipt.style_no))
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
