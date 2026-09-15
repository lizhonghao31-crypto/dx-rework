-- Actual deductions remain immutable facts. A newly over-deducted ledger can
-- commit only alongside its exact, pending finance-director request.
ALTER TABLE rework_external_deduction_special_requests
  ADD COLUMN recorded_entry_id uuid UNIQUE REFERENCES rework_external_deduction_entries(deduction_entry_id),
  DROP CONSTRAINT rework_external_deduction_speci_remaining_amount_snapshot_check,
  ADD CONSTRAINT external_special_nonzero_difference CHECK(remaining_amount_snapshot<>0);
ALTER TABLE rework_external_deduction_closures
  DROP CONSTRAINT rework_external_deduction_closures_remaining_amount_check,
  DROP CONSTRAINT rework_external_closure_result_v2_check,
  DROP CONSTRAINT rework_external_closure_fact_v2_check,
  ADD CONSTRAINT rework_external_closure_result_v3_check CHECK(result IN ('full','partial','not_deducted','over_deducted')),
  ADD CONSTRAINT rework_external_closure_fact_v3_check CHECK(
    (result='full' AND actual_deducted_amount=proposed_amount AND remaining_amount=0
      AND reason IS NULL AND remaining_difference_disposition IS NULL AND special_request_id IS NULL)
    OR (result IN ('partial','not_deducted','over_deducted')
      AND reason IS NOT NULL AND length(btrim(reason)) BETWEEN 1 AND 500
      AND remaining_difference_disposition IS NOT NULL
      AND length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500
      AND (special_request_id IS NOT NULL OR cardinality(evidence_attachment_ids)>0)
      AND ((result='partial' AND actual_deducted_amount>0 AND actual_deducted_amount<proposed_amount)
        OR (result='not_deducted' AND actual_deducted_amount=0 AND remaining_amount=proposed_amount)
        OR (result='over_deducted' AND actual_deducted_amount>proposed_amount AND remaining_amount<0 AND special_request_id IS NOT NULL)))
  );

CREATE OR REPLACE FUNCTION guard_external_deduction_entry_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  reversed_entry rework_external_deduction_entries%ROWTYPE;
  prior_total numeric(18,2);
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id
  FOR UPDATE;
  IF target_case.case_id IS NULL
     OR target_case.status<>'deduction_follow_up'
     OR NOT external_responsibility_can_payables(
       NEW.recorded_by,
       target_case.rework_order_id,
       target_case.responsibility_type,
       'external_deduction:record'
     ) THEN
    RAISE EXCEPTION
      'deduction entry requires accepted case and matching payables role'
      USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(
    NEW.attachment_ids
  );
  PERFORM external_responsibility_require_bound_attachments(
    NEW.attachment_ids,NEW.case_id
  );
  IF NEW.entry_type IN ('adjustment','reversal') THEN
    SELECT * INTO reversed_entry
    FROM rework_external_deduction_entries
    WHERE deduction_entry_id=NEW.reverses_entry_id;
    IF reversed_entry.deduction_entry_id IS NULL
       OR reversed_entry.case_id<>NEW.case_id
       OR (
         NEW.entry_type='reversal'
         AND NEW.amount<>-reversed_entry.amount
       ) THEN
      RAISE EXCEPTION
        'deduction adjustment or reversal must reference its own case ledger entry'
        USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT COALESCE(sum(amount),0) INTO prior_total
  FROM external_deduction_scope(NEW.case_id);
  IF prior_total+NEW.amount<0
     OR (NEW.entry_type='deduction' AND NEW.amount<=0)
     OR (
       NEW.entry_type IN ('adjustment','reversal')
       AND NEW.reverses_entry_id IS NULL
     ) THEN
    RAISE EXCEPTION 'deduction entry would make actual amount invalid'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.record',
    'external_deduction:record',
    target_case.rework_order_id,
    NEW.recorded_by
  );
  RETURN NEW;
END $function$;

CREATE OR REPLACE FUNCTION guard_external_special_request_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  actual numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual
  FROM external_deduction_scope(NEW.case_id);
  IF target_case.case_id IS NULL OR target_case.status<>'deduction_follow_up'
     OR NOT external_responsibility_can_payables(
       NEW.requested_by,target_case.rework_order_id,target_case.responsibility_type
     )
     OR NEW.proposed_amount_snapshot<>target_case.proposed_deduction_amount
     OR NEW.actual_deducted_amount_snapshot<>actual
     OR NEW.remaining_amount_snapshot<>target_case.proposed_deduction_amount-actual
     OR NEW.remaining_amount_snapshot=0
     OR NEW.request_version<>(
       SELECT COALESCE(max(existing.request_version),0)+1
       FROM rework_external_deduction_special_requests existing
       WHERE existing.case_id=NEW.case_id
     ) THEN
    RAISE EXCEPTION 'special approval request does not match the current deduction exception'
      USING ERRCODE='23514';
  END IF;
  IF NEW.recorded_entry_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM rework_external_deduction_entries entry
    WHERE entry.deduction_entry_id=NEW.recorded_entry_id AND entry.case_id=NEW.case_id
      AND entry.recorded_by=NEW.requested_by AND entry.request_id=NEW.request_id
  ) THEN
    RAISE EXCEPTION 'special approval must reference its own recorded deduction' USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.special.request','external_deduction:close',
    target_case.rework_order_id,NEW.requested_by
  );
  RETURN NEW;
END $function$;

CREATE FUNCTION guard_external_over_deduction_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; actual numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual FROM external_deduction_scope(NEW.case_id);
  IF actual>target_case.proposed_deduction_amount AND NOT EXISTS (
    SELECT 1 FROM rework_external_deduction_special_requests request
    WHERE request.recorded_entry_id=NEW.deduction_entry_id AND request.case_id=NEW.case_id
      AND request.actual_deducted_amount_snapshot=actual
      AND request.proposed_amount_snapshot=target_case.proposed_deduction_amount
      AND request.requested_by=NEW.recorded_by AND request.request_id=NEW.request_id
      AND target_case.status='pending_special_approval'
      AND NOT EXISTS (SELECT 1 FROM rework_external_deduction_special_decisions decision WHERE decision.special_request_id=request.special_request_id)
  ) THEN
    RAISE EXCEPTION 'over deduction requires its atomic pending special request' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER external_over_deduction_requires_special_request
  AFTER INSERT ON rework_external_deduction_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_external_over_deduction_commit();
