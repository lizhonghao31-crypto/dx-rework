-- Compare new factory-change requests with the same effective facts used by the
-- service and decision guard. Original creation and correction history stay immutable.
CREATE OR REPLACE FUNCTION guard_sourcing_factory_change_request_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_case sourcing_cases%ROWTYPE;
  current_decision sourcing_decisions%ROWTYPE;
  expected_action text;
  expected_capability text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_case FROM sourcing_case_facts_at(NEW.sourcing_case_id);
  SELECT * INTO current_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC LIMIT 1;
  expected_action := CASE
    WHEN NEW.initiator_role='owner_group'
      OR (NEW.initiator_role='production_management' AND NOT NEW.requires_owner_approval)
      THEN 'sourcing.factory_change.effective'
    ELSE 'sourcing.factory_change.request'
  END;
  expected_capability := CASE NEW.initiator_role
    WHEN 'order_merchandiser' THEN 'sourcing:factory_change:request'
    WHEN 'production_management' THEN 'sourcing:decision:record'
    ELSE 'sourcing:owner:approve'
  END;
  IF current_decision.sourcing_decision_id IS NULL
    OR NEW.from_decision_id<>current_decision.sourcing_decision_id
    OR NEW.proposed_supplier_id=current_decision.supplier_id
    OR NEW.requires_owner_approval<>(NEW.proposed_unit_price>current_decision.unit_price)
    OR EXISTS (
      SELECT 1
      FROM sourcing_factory_change_requests existing
      WHERE existing.sourcing_case_id=NEW.sourcing_case_id
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_decisions effective
          WHERE effective.source_change_request_id=existing.factory_change_request_id
        )
        AND NOT EXISTS (
          SELECT 1 FROM sourcing_factory_change_decisions rejected
          WHERE rejected.factory_change_request_id=existing.factory_change_request_id
            AND rejected.decision='rejected'
        )
    ) THEN
    RAISE EXCEPTION 'factory change must replace the current effective decision'
      USING ERRCODE='23514';
  END IF;
  IF NEW.proposed_quantity<>source_case.order_quantity THEN
    RAISE EXCEPTION 'factory change quantity must match current effective order quantity'
      USING ERRCODE='23514', CONSTRAINT='sourcing_factory_change_request_quantity_current';
  END IF;
  PERFORM sourcing_require_active_factory(
    NEW.proposed_supplier_id,
    NEW.proposed_supplier_code_snapshot,
    NEW.proposed_supplier_name_snapshot
  );
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.requested_by,
    expected_action,expected_capability,
    NEW.sourcing_case_id,NEW.change_reason
  );
  RETURN NEW;
END;
$$;
