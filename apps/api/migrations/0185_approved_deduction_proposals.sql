-- New amounts are posted only by the finance director's approved request.
-- Existing immutable ledger and request facts keep their original meaning.
ALTER TABLE rework_external_deduction_special_requests
  ADD COLUMN request_mode text NOT NULL DEFAULT 'existing_ledger',
  ADD COLUMN requested_amount numeric(18,2),
  ADD COLUMN deducted_on date,
  DROP CONSTRAINT external_special_nonzero_difference,
  ADD CONSTRAINT external_special_request_mode CHECK(
    (request_mode='existing_ledger' AND requested_amount IS NULL AND deducted_on IS NULL)
    OR (request_mode='proposed_entry' AND requested_amount IS NOT NULL AND requested_amount>0 AND deducted_on IS NOT NULL AND recorded_entry_id IS NULL)),
  ADD CONSTRAINT external_special_target_difference CHECK(remaining_amount_snapshot-COALESCE(requested_amount,0)<>0);
ALTER TABLE rework_external_deduction_entries
  ADD COLUMN approval_request_id uuid UNIQUE REFERENCES rework_external_deduction_special_requests(special_request_id);

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
     OR NEW.remaining_amount_snapshot-COALESCE(NEW.requested_amount,0)=0
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

CREATE OR REPLACE FUNCTION guard_external_deduction_entry_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  reversed_entry rework_external_deduction_entries%ROWTYPE;
  prior_total numeric(18,2);
  source rework_external_deduction_special_requests%ROWTYPE;
  approval rework_external_deduction_special_decisions%ROWTYPE;
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id
  FOR UPDATE;
  IF NEW.approval_request_id IS NOT NULL THEN
    SELECT * INTO source FROM rework_external_deduction_special_requests WHERE special_request_id=NEW.approval_request_id;
    SELECT * INTO approval FROM rework_external_deduction_special_decisions WHERE special_request_id=NEW.approval_request_id;
    SELECT COALESCE(sum(amount),0) INTO prior_total FROM external_deduction_scope(NEW.case_id);
    IF target_case.status IS DISTINCT FROM 'pending_special_approval'
       OR source.request_mode IS DISTINCT FROM 'proposed_entry' OR source.case_id IS DISTINCT FROM NEW.case_id
       OR approval.decision IS DISTINCT FROM 'approved' OR approval.decided_by IS DISTINCT FROM NEW.recorded_by
       OR approval.operation_event_id IS DISTINCT FROM NEW.operation_event_id OR approval.request_id IS DISTINCT FROM NEW.request_id
       OR source.actual_deducted_amount_snapshot IS DISTINCT FROM prior_total
       OR source.proposed_amount_snapshot IS DISTINCT FROM target_case.proposed_deduction_amount
       OR NEW.amount IS DISTINCT FROM source.requested_amount OR NEW.deducted_on IS DISTINCT FROM source.deducted_on
       OR NEW.attachment_ids IS DISTINCT FROM source.attachment_ids OR NEW.entry_type<>'deduction' OR NEW.reverses_entry_id IS NOT NULL
       OR NOT external_responsibility_direct_role(NEW.recorded_by,'external_deduction:special_approve',ARRAY['finance_director']) THEN
      RAISE EXCEPTION 'deduction entry requires its matching approved proposal' USING ERRCODE='23514';
    END IF;
    PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
    PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
    PERFORM require_external_responsibility_event('rework.external_deduction.special.approved','external_deduction:special_approve',target_case.rework_order_id,NEW.recorded_by);
    RETURN NEW;
  END IF;
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
  IF (prior_total+NEW.amount>target_case.proposed_deduction_amount AND NOT (NEW.entry_type IN ('adjustment','reversal') AND NEW.amount<0))
     OR prior_total+NEW.amount<0
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

CREATE OR REPLACE FUNCTION guard_external_closure_insert()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  actual numeric(18,2);
  source rework_external_deduction_special_requests%ROWTYPE;
  special_decision rework_external_deduction_special_decisions%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual
  FROM external_deduction_scope(NEW.case_id);
  IF target_case.case_id IS NULL
     OR NEW.proposed_amount<>target_case.proposed_deduction_amount
     OR NEW.actual_deducted_amount<>actual THEN
    RAISE EXCEPTION 'deduction closure does not match the current ledger'
      USING ERRCODE='23514';
  END IF;
  IF target_case.status='deduction_follow_up' THEN
    IF NEW.result<>'full' OR NEW.special_request_id IS NOT NULL
       OR NOT external_responsibility_can_payables(
         NEW.closed_by,target_case.rework_order_id,target_case.responsibility_type
       ) THEN
      RAISE EXCEPTION 'only an exactly matched deduction may close without special approval'
        USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.close','external_deduction:close',
      target_case.rework_order_id,NEW.closed_by
    );
  ELSIF target_case.status='pending_special_approval' THEN
    SELECT * INTO source FROM rework_external_deduction_special_requests
    WHERE special_request_id=NEW.special_request_id AND case_id=NEW.case_id;
    SELECT * INTO special_decision FROM rework_external_deduction_special_decisions
    WHERE special_request_id=NEW.special_request_id AND decision='approved';
    IF source.special_request_id IS NULL OR special_decision.special_decision_id IS NULL
       OR NEW.closed_by<>special_decision.decided_by
       OR (NEW.proposed_amount,NEW.actual_deducted_amount,NEW.remaining_amount)
          IS DISTINCT FROM
          (source.proposed_amount_snapshot,source.actual_deducted_amount_snapshot+COALESCE(source.requested_amount,0),source.remaining_amount_snapshot-COALESCE(source.requested_amount,0)) THEN
      RAISE EXCEPTION 'special closure requires the matching approved immutable request'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.special.approved',
      'external_deduction:special_approve',target_case.rework_order_id,NEW.closed_by
    );
  ELSE
    RAISE EXCEPTION 'deduction closure is not allowed from the current case state'
      USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.evidence_attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.evidence_attachment_ids,NEW.case_id);
  RETURN NEW;
END $function$;

-- Approval inserts remain within the pending case; the closing transition
-- below increments its version once after all approved financial facts exist.
CREATE OR REPLACE FUNCTION bump_external_case_version_from_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='rework_external_deduction_entries' THEN
    IF NEW.approval_request_id IS NOT NULL THEN RETURN NEW; END IF;
  END IF;
  UPDATE rework_external_responsibility_cases SET case_version=case_version+1
  WHERE case_id=NEW.case_id AND status='deduction_follow_up';
  IF NOT FOUND THEN RAISE EXCEPTION 'ledger fact requires an active deduction-follow-up case' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_over_deduction_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; actual numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual FROM external_deduction_scope(NEW.case_id);
  IF NEW.approval_request_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM rework_external_deduction_special_requests request
      JOIN rework_external_deduction_special_decisions decision USING(special_request_id)
      JOIN rework_external_deduction_closures closure USING(special_request_id)
      WHERE request.special_request_id=NEW.approval_request_id AND request.case_id=NEW.case_id
        AND decision.decision='approved' AND closure.case_id=NEW.case_id AND target_case.status='closed'
        AND closure.actual_deducted_amount=actual
    ) THEN RAISE EXCEPTION 'approved proposal requires atomic posting and closure' USING ERRCODE='23514'; END IF;
  ELSIF actual>target_case.proposed_deduction_amount AND NOT (NEW.entry_type IN ('adjustment','reversal') AND NEW.amount<0) THEN
    RAISE EXCEPTION 'ordinary over deduction is forbidden; submit a special request' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION guard_external_proposal_decision_commit()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source rework_external_deduction_special_requests%ROWTYPE;
BEGIN
  SELECT * INTO source FROM rework_external_deduction_special_requests WHERE special_request_id=NEW.special_request_id;
  IF source.request_mode='proposed_entry' AND NEW.decision='approved' AND NOT EXISTS (
    SELECT 1 FROM rework_external_deduction_entries entry
    JOIN rework_external_deduction_closures closure ON closure.special_request_id=entry.approval_request_id
    JOIN rework_external_responsibility_cases target ON target.case_id=source.case_id
    WHERE entry.approval_request_id=source.special_request_id AND entry.case_id=source.case_id
      AND closure.case_id=source.case_id AND target.status='closed'
      AND entry.operation_event_id=NEW.operation_event_id AND entry.recorded_by=NEW.decided_by
  ) THEN RAISE EXCEPTION 'approved proposal requires its unique posted entry and closure' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER external_proposal_decision_requires_posting
  AFTER INSERT ON rework_external_deduction_special_decisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_external_proposal_decision_commit();
