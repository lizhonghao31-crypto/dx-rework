-- Allow merchandisers to correct the internal budget price before owner approval
-- without mutating the immutable node-one creation fact. The latest correction is
-- the current budget price; owner approval snapshots freeze that value permanently.

CREATE TABLE sourcing_budget_price_corrections (
  correction_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  correction_version integer NOT NULL CHECK(correction_version > 0),
  old_unit_price numeric(14,4) NOT NULL CHECK(old_unit_price > 0),
  new_unit_price numeric(14,4) NOT NULL CHECK(new_unit_price > 0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  corrected_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  corrected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(sourcing_case_id, correction_version),
  CHECK(old_unit_price IS DISTINCT FROM new_unit_price)
);

CREATE INDEX sourcing_budget_price_corrections_case_idx
  ON sourcing_budget_price_corrections(sourcing_case_id, correction_version DESC);

CREATE OR REPLACE FUNCTION guard_sourcing_budget_price_correction()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  audit_event operation_events%ROWTYPE;
  current_price numeric(14,4);
  expected_version integer;
  current_status text;
BEGIN
  SELECT * INTO source_case FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;

  IF source_case.sourcing_case_id IS NULL OR source_case.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'budget correction requires an active sourcing case' USING ERRCODE='55000';
  END IF;
  IF EXISTS (SELECT 1 FROM sourcing_approval_snapshots approval WHERE approval.sourcing_case_id=NEW.sourcing_case_id) THEN
    RAISE EXCEPTION 'approved sourcing numbers are locked' USING ERRCODE='55000';
  END IF;

  current_status := sourcing_current_status(NEW.sourcing_case_id);
  IF current_status NOT IN ('pending_ie_quote','pending_management_decision','pending_owner_approval') THEN
    RAISE EXCEPTION 'budget correction is only allowed before owner approval' USING ERRCODE='55000';
  END IF;

  SELECT correction.new_unit_price, correction.correction_version + 1
    INTO current_price, expected_version
  FROM sourcing_budget_price_corrections correction
  WHERE correction.sourcing_case_id=NEW.sourcing_case_id
  ORDER BY correction.correction_version DESC LIMIT 1;

  IF current_price IS NULL THEN current_price := source_case.daxing_unit_price; expected_version := 1; END IF;

  IF current_price IS NULL
    OR NEW.old_unit_price IS DISTINCT FROM current_price
    OR NEW.correction_version IS DISTINCT FROM expected_version THEN
    RAISE EXCEPTION 'budget correction does not continue the current price history' USING ERRCODE='55000';
  END IF;

  SELECT * INTO audit_event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF audit_event.event_id IS NULL
    OR audit_event.action<>'sourcing.budget_price.correct'
    OR audit_event.entity_type<>'sourcing_case'
    OR audit_event.entity_id<>NEW.sourcing_case_id::text
    OR audit_event.authorization_capability<>'sourcing:inquiry:create'
    OR audit_event.actor_id<>NEW.corrected_by
    OR audit_event.request_id<>NEW.request_id
    OR audit_event.reason IS DISTINCT FROM NEW.reason
    OR audit_event.after_state->>'budgetPriceCorrected' IS DISTINCT FROM 'true'
    OR (audit_event.after_state->>'correctionVersion')::integer IS DISTINCT FROM NEW.correction_version THEN
    RAISE EXCEPTION 'budget correction requires its immutable operation event' USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_budget_price_corrections_guard_creation
  BEFORE INSERT ON sourcing_budget_price_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_budget_price_correction();
CREATE TRIGGER sourcing_budget_price_corrections_no_update
  BEFORE UPDATE ON sourcing_budget_price_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_budget_price_corrections_no_delete
  BEFORE DELETE ON sourcing_budget_price_corrections
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_budget_price_corrections_no_truncate
  BEFORE TRUNCATE ON sourcing_budget_price_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
