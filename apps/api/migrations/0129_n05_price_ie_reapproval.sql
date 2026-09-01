-- N05/N06 price re-approval: snapshot the tail supervisor's proposal and
-- promote it to the canonical process price only after the same IE decision
-- that approves final quantities. Existing pending confirmations remain on
-- their original N03-approved prices.
ALTER TABLE rework_tail_completion_confirmations
  ADD COLUMN price_snapshot_required boolean NOT NULL DEFAULT false;

CREATE TABLE rework_tail_completion_prices (
  confirmation_id uuid NOT NULL REFERENCES rework_tail_completion_confirmations(confirmation_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  original_unit_price numeric(14,3) NOT NULL
    CHECK(original_unit_price>=0.001 AND original_unit_price=trunc(original_unit_price,3)),
  proposed_unit_price numeric(14,3) NOT NULL
    CHECK(proposed_unit_price>=0.001 AND proposed_unit_price=trunc(proposed_unit_price,3)),
  PRIMARY KEY(confirmation_id,configuration_item_id)
);

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT NEW.price_snapshot_required
     OR NEW.workflow_stage<>'pending_ie_review'
     OR NEW.confirmation_version<>COALESCE((
       SELECT max(existing.confirmation_version)+1
       FROM rework_tail_completion_confirmations existing
       WHERE existing.rework_order_id=NEW.rework_order_id
     ),1)
     OR EXISTS(
       SELECT 1 FROM rework_tail_completion_confirmations existing
       WHERE existing.rework_order_id=NEW.rework_order_id
         AND existing.workflow_stage='pending_ie_review'
         AND NOT EXISTS(
           SELECT 1 FROM rework_tail_completion_reviews review
           WHERE review.confirmation_id=existing.confirmation_id
         )
     )
     OR NOT EXISTS(
       SELECT 1 FROM rework_orders target
       JOIN operation_events event ON event.event_id=NEW.operation_event_id
       WHERE target.rework_order_id=NEW.rework_order_id
         AND target.status='pending_order_review'
         AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND event.request_id=NEW.request_id
         AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.action='rework.tail_completion.confirm'
         AND event.authorization_capability='submission:audit'
         AND event.actor_id=NEW.confirmed_by
         AND event.entity_type='rework_order'
         AND event.entity_id=NEW.rework_order_id::text
     )
  THEN RAISE EXCEPTION 'final quantity and price confirmation requires matching N05 audit and version'
    USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_price_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM rework_tail_completion_confirmations confirmation
    JOIN rework_process_configurations configuration
      ON configuration.rework_order_id=confirmation.rework_order_id
     AND configuration.status='approved'
    JOIN rework_process_configuration_items item
      ON item.configuration_id=configuration.configuration_id
     AND item.configuration_item_id=NEW.configuration_item_id
    JOIN operation_events event
      ON event.event_id=confirmation.operation_event_id
     AND event.request_id=confirmation.request_id
    WHERE confirmation.confirmation_id=NEW.confirmation_id
      AND confirmation.price_snapshot_required
      AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.tail_completion.confirm'
      AND event.authorization_capability='submission:audit'
      AND item.unit_price=NEW.original_unit_price
  ) THEN RAISE EXCEPTION 'final price must snapshot the current approved process under the N05 event'
    USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_tail_completion_prices_guard_insert
  BEFORE INSERT ON rework_tail_completion_prices
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_completion_price_insert();
CREATE TRIGGER rework_tail_completion_prices_no_update
  BEFORE UPDATE ON rework_tail_completion_prices
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_prices_no_delete
  BEFORE DELETE ON rework_tail_completion_prices
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_prices_no_truncate
  BEFORE TRUNCATE ON rework_tail_completion_prices
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

DROP TRIGGER IF EXISTS rework_process_configuration_items_no_update
  ON rework_process_configuration_items;
CREATE OR REPLACE FUNCTION guard_rework_process_configuration_item_ie_reprice()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'unit_price') IS DISTINCT FROM (to_jsonb(OLD)-'unit_price')
     OR NEW.unit_price IS NOT DISTINCT FROM OLD.unit_price
     OR NOT EXISTS(
       SELECT 1
       FROM rework_tail_completion_prices price
       JOIN rework_tail_completion_confirmations confirmation
         ON confirmation.confirmation_id=price.confirmation_id
        AND confirmation.price_snapshot_required
       JOIN rework_tail_completion_reviews review
         ON review.confirmation_id=confirmation.confirmation_id
        AND review.decision='approved'
       JOIN operation_events event
         ON event.event_id=review.operation_event_id
        AND event.request_id=review.request_id
       WHERE price.configuration_item_id=OLD.configuration_item_id
         AND price.original_unit_price=OLD.unit_price
         AND price.proposed_unit_price=NEW.unit_price
         AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
         AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
         AND event.action='rework.final_quantity.ie_review'
         AND event.authorization_capability='process:review'
     )
  THEN RAISE EXCEPTION 'process price can only change to the IE-approved N05 proposal'
    USING ERRCODE='55000'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_process_configuration_items_guard_ie_reprice
  BEFORE UPDATE ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_configuration_item_ie_reprice();

CREATE OR REPLACE FUNCTION guard_rework_order_review_price_snapshot()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_confirmation_id uuid;
  snapshot_required boolean;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM operation_events event
    WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.final_quantity.ie_review'
      AND event.authorization_capability='process:review'
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN RETURN NEW; END IF;

  SELECT confirmation.confirmation_id,confirmation.price_snapshot_required
  INTO target_confirmation_id,snapshot_required
  FROM rework_tail_completion_confirmations confirmation
  JOIN rework_tail_completion_reviews review
    ON review.confirmation_id=confirmation.confirmation_id
   AND review.decision='approved'
  WHERE confirmation.rework_order_id=NEW.rework_order_id
    AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'');

  IF target_confirmation_id IS NULL THEN
    RAISE EXCEPTION 'order review lacks the approved N06 confirmation'
      USING ERRCODE='55000';
  END IF;

  IF snapshot_required AND (
    EXISTS(
      SELECT 1
      FROM rework_process_configurations configuration
      JOIN rework_process_configuration_items item USING(configuration_id)
      LEFT JOIN rework_tail_completion_prices price
        ON price.confirmation_id=target_confirmation_id
       AND price.configuration_item_id=item.configuration_item_id
      WHERE configuration.rework_order_id=NEW.rework_order_id
        AND configuration.status='approved'
        AND item.execution_kind='worker'
        AND (price.configuration_item_id IS NULL OR item.unit_price<>price.proposed_unit_price)
    )
    OR EXISTS(
      SELECT 1
      FROM rework_tail_completion_prices price
      WHERE price.confirmation_id=target_confirmation_id
        AND NOT EXISTS(
          SELECT 1
          FROM rework_process_configurations configuration
          JOIN rework_process_configuration_items item USING(configuration_id)
          WHERE configuration.rework_order_id=NEW.rework_order_id
            AND configuration.status='approved'
            AND item.execution_kind='worker'
            AND item.configuration_item_id=price.configuration_item_id
        )
    )
  ) THEN RAISE EXCEPTION 'IE-approved final prices must exactly cover the active process configuration'
    USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_order_reviews_guard_price_snapshot
  BEFORE INSERT ON rework_order_reviews
  FOR EACH ROW EXECUTE FUNCTION guard_rework_order_review_price_snapshot();
