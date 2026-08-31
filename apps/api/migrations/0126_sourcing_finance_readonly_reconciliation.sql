CREATE OR REPLACE FUNCTION guard_sourcing_reconciliation_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_decision sourcing_decisions%ROWTYPE;
  source_supplier record;
  previous_version integer;
  expected_action text;
BEGIN
  PERFORM 1 FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO source_decision
  FROM sourcing_decisions
  WHERE sourcing_case_id=NEW.sourcing_case_id
  ORDER BY decision_version DESC
  LIMIT 1;
  SELECT supplier_id,supplier_code,supplier_name INTO source_supplier
  FROM current_supplier_catalog
  WHERE supplier_id=source_decision.supplier_id
    AND supplier_type='factory';
  SELECT COALESCE(max(reconciliation_version),0) INTO previous_version
  FROM sourcing_finance_reconciliations
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  IF sourcing_current_status(NEW.sourcing_case_id)<>'pending_finance_reconciliation'
    OR source_decision.sourcing_decision_id IS NULL
    OR NEW.sourcing_decision_id<>source_decision.sourcing_decision_id
    OR NEW.reconciliation_version<>previous_version+1 THEN
    RAISE EXCEPTION 'finance reconciliation must bind the current approved sourcing decision'
      USING ERRCODE='23514';
  END IF;
  IF source_supplier.supplier_id IS NULL
    OR NEW.actual_supplier_id<>source_decision.supplier_id
    OR NEW.actual_supplier_code_snapshot<>source_supplier.supplier_code
    OR NEW.actual_supplier_name_snapshot<>source_supplier.supplier_name
    OR NEW.actual_unit_price<>source_decision.unit_price
    OR NEW.actual_quantity<>source_decision.quantity
    OR NEW.actual_total_amount<>source_decision.total_amount THEN
    RAISE EXCEPTION 'finance reconciliation facts must be copied from the approved sourcing decision'
      USING ERRCODE='23514';
  END IF;
  IF (NEW.result='match' AND (cardinality(NEW.difference_fields)<>0 OR NEW.difference_reason IS NOT NULL))
    OR (NEW.result='difference' AND (
      cardinality(NEW.difference_fields)=0
      OR NOT (NEW.difference_fields <@ ARRAY['supplier','unit_price','quantity','total_amount']::text[])
      OR NEW.difference_reason IS NULL
    )) THEN
    RAISE EXCEPTION 'finance reconciliation declaration is invalid'
      USING ERRCODE='23514';
  END IF;

  expected_action := CASE NEW.result
    WHEN 'match' THEN 'sourcing.finance.matched'
    ELSE 'sourcing.finance.difference'
  END;
  PERFORM sourcing_require_operation_event(
    NEW.operation_event_id,NEW.request_id,NEW.reconciled_by,
    expected_action,'sourcing:finance:reconcile',
    NEW.sourcing_case_id,NEW.difference_reason
  );
  RETURN NEW;
END;
$$;
