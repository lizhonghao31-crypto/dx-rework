-- Append-only IE pre-count notes for urgent production checks before N06.
-- These reference facts never change work reports, final quantities, wages or responsibility.

CREATE TABLE rework_ie_precount_entries (
  ie_precount_entry_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  note text NULL CHECK (note IS NULL OR length(btrim(note)) BETWEEN 1 AND 200),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX rework_ie_precount_entries_order_time_idx
  ON rework_ie_precount_entries(rework_order_id,recorded_at DESC,ie_precount_entry_id DESC);

CREATE OR REPLACE FUNCTION guard_rework_ie_precount_entry()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_orders target
    JOIN rework_process_configurations configuration
      ON configuration.rework_order_id=target.rework_order_id
     AND configuration.status='approved'
    JOIN rework_process_configuration_items item
      ON item.configuration_id=configuration.configuration_id
     AND item.configuration_item_id=NEW.configuration_item_id
     AND item.execution_kind='worker'
    WHERE target.rework_order_id=NEW.rework_order_id
      AND target.status IN ('in_progress','pending_order_review')
  ) THEN
    RAISE EXCEPTION 'IE pre-count requires an active N04 or N05 worker process'
      USING ERRCODE='23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=NEW.operation_event_id
      AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NEW.request_id
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=NEW.recorded_by
      AND event.authorization_capability='process:review'
      AND event.action='rework.ie_precount.record'
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId',NEW.rework_order_id,
        'entryId',NEW.ie_precount_entry_id,
        'configurationItemId',NEW.configuration_item_id,
        'quantity',NEW.quantity
      )
  ) THEN
    RAISE EXCEPTION 'IE pre-count requires matching trusted audit event'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_ie_precount_entries_guard_insert
  BEFORE INSERT ON rework_ie_precount_entries
  FOR EACH ROW EXECUTE FUNCTION guard_rework_ie_precount_entry();
CREATE TRIGGER rework_ie_precount_entries_no_update
  BEFORE UPDATE ON rework_ie_precount_entries
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_ie_precount_entries_no_delete
  BEFORE DELETE ON rework_ie_precount_entries
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_ie_precount_entries_no_truncate
  BEFORE TRUNCATE ON rework_ie_precount_entries
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

COMMENT ON TABLE rework_ie_precount_entries IS
  'Append-only IE reference counts captured during N04/N05; excluded from final quantity, wage and responsibility calculations.';
