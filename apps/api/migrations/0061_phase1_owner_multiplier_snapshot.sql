-- Phase 1 N08: owners retain only exceptional external multipliers.
-- This is an audit snapshot, not a supplier deduction plan or a new deduction base.
CREATE TABLE rework_responsibility_owner_multiplier_adjustments (
  adjustment_id uuid PRIMARY KEY,
  owner_signature_id uuid NOT NULL REFERENCES rework_responsibility_owner_signatures(owner_signature_id),
  determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations(determination_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  responsibility_type text NOT NULL CHECK(responsibility_type IN ('processing_factory','embroidery_factory','washing_factory','fabric_supplier')),
  multiplier numeric(8,3) NOT NULL CHECK(multiplier>=1.2 AND multiplier=trunc(multiplier,3) AND multiplier<>1.2),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(owner_signature_id,configuration_item_id,responsibility_type)
);

CREATE OR REPLACE FUNCTION guard_rework_responsibility_owner_multiplier_adjustment()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1
    FROM rework_responsibility_owner_signatures signature
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE signature.owner_signature_id=NEW.owner_signature_id
      AND signature.determination_id=NEW.determination_id
      AND signature.decision='approved'
      AND signature.operation_event_id=NEW.operation_event_id
      AND signature.request_id=NEW.request_id
      AND event.event_id=current_setting('dx_rework.rework_event_id',true)::uuid
      AND event.request_id=current_setting('dx_rework.rework_request_id',true)
      AND event.action='rework.responsibility.owner_approve'
      AND event.authorization_capability='responsibility:owner_sign'
  ) THEN
    RAISE EXCEPTION 'owner multiplier adjustment requires the matching N08 approval audit event' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS(
    SELECT 1
    FROM rework_responsibility_allocations allocation
    WHERE allocation.determination_id=NEW.determination_id
      AND allocation.configuration_item_id=NEW.configuration_item_id
      AND allocation.responsibility_type=NEW.responsibility_type
      AND allocation.responsibility_type<>'own_factory'
  ) THEN
    RAISE EXCEPTION 'owner multiplier adjustment must reference a signed external responsibility' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_responsibility_owner_multiplier_adjustments_guard_insert
  BEFORE INSERT ON rework_responsibility_owner_multiplier_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_rework_responsibility_owner_multiplier_adjustment();
CREATE TRIGGER rework_responsibility_owner_multiplier_adjustments_no_update
  BEFORE UPDATE ON rework_responsibility_owner_multiplier_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_responsibility_owner_multiplier_adjustments_no_delete
  BEFORE DELETE ON rework_responsibility_owner_multiplier_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_responsibility_owner_multiplier_adjustments_no_truncate
  BEFORE TRUNCATE ON rework_responsibility_owner_multiplier_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
