-- PR-11 bounded Codex review closure: action-scoped payables delegation,
-- order-scoped supplier selection support, and immutable processing-factory
-- override reasons.

ALTER TABLE rework_external_responsibility_cases
  ADD COLUMN processing_factory_override_reason text;

ALTER TABLE rework_external_responsibility_cases
  ADD CONSTRAINT rework_external_cases_override_reason_check
  CHECK (
    processing_factory_override_reason IS NULL
    OR (
      responsibility_type='processing_factory'
      AND length(btrim(processing_factory_override_reason)) BETWEEN 1 AND 500
    )
  );

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid,
  order_id uuid,
  responsibility_type text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE responsibility_type
    WHEN 'processing_factory' THEN
      external_responsibility_direct_role(
        candidate,required_capability,ARRAY['factory_payables']
      )
      OR external_responsibility_active_delegation(
        candidate,required_capability,order_id,ARRAY['factory_payables']
      )
    WHEN 'fabric_supplier' THEN
      external_responsibility_direct_role(
        candidate,required_capability,ARRAY['fabric_payables']
      )
      OR external_responsibility_active_delegation(
        candidate,required_capability,order_id,ARRAY['fabric_payables']
      )
    WHEN 'embroidery_factory' THEN
      external_responsibility_direct_role(
        candidate,required_capability,ARRAY['embroidery_washing_payables']
      )
      OR external_responsibility_active_delegation(
        candidate,required_capability,order_id,
        ARRAY['embroidery_washing_payables']
      )
    WHEN 'washing_factory' THEN
      external_responsibility_direct_role(
        candidate,required_capability,ARRAY['embroidery_washing_payables']
      )
      OR external_responsibility_active_delegation(
        candidate,required_capability,order_id,
        ARRAY['embroidery_washing_payables']
      )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid,
  order_id uuid,
  responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_can_payables(
           candidate,order_id,responsibility_type,
           'external_responsibility:payables_confirm'
         )
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type,
           'external_deduction:follow_up'
         )
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type,
           'external_deduction:record'
         )
      OR external_responsibility_can_payables(
           candidate,order_id,responsibility_type,
           'external_deduction:close'
         )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view_case(
  candidate uuid,
  order_id uuid,
  responsibility_type_value text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_can_view_all(candidate)
    OR external_responsibility_can_sign(
      candidate,order_id,responsibility_type_value
    )
    OR external_responsibility_can_payables(
      candidate,order_id,responsibility_type_value
    )
$$;

CREATE OR REPLACE FUNCTION guard_external_case_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch rework_external_responsibility_batches%ROWTYPE;
  supplier current_supplier_catalog%ROWTYPE;
  order_record rework_orders%ROWTYPE;
BEGIN
  SELECT * INTO batch
  FROM rework_external_responsibility_batches
  WHERE batch_id=NEW.batch_id;
  SELECT * INTO supplier
  FROM current_supplier_catalog
  WHERE supplier_id=NEW.supplier_id;
  SELECT * INTO order_record
  FROM rework_orders
  WHERE rework_order_id=NEW.rework_order_id;

  IF batch.batch_id IS NULL
     OR batch.rework_order_id<>NEW.rework_order_id
     OR batch.status<>'active'
     OR supplier.supplier_id IS NULL
     OR supplier.active IS DISTINCT FROM true
     OR supplier.version<>NEW.supplier_version
     OR supplier.supplier_type<>
        external_responsibility_expected_supplier_type(
          NEW.responsibility_type
        )
     OR NEW.supplier_code_snapshot<>supplier.supplier_code
     OR NEW.supplier_name_snapshot<>supplier.supplier_name
     OR NEW.supplier_type_snapshot<>supplier.supplier_type
     OR NEW.status NOT IN ('pending_business_signoff','returned')
     OR NEW.case_version<>1
     OR NOT external_responsibility_can_sign(
       NEW.business_handler_user_id,
       NEW.rework_order_id,
       NEW.responsibility_type
     )
     OR (
       NEW.responsibility_type='processing_factory'
       AND order_record.processing_factory_type='supplier'
       AND NEW.supplier_id<>order_record.processing_factory_supplier_id
       AND NEW.processing_factory_override_reason IS NULL
     ) THEN
    RAISE EXCEPTION 'external case supplier, handler or snapshot is invalid'
      USING ERRCODE='23514';
  END IF;

  PERFORM require_external_responsibility_event(
    'rework.external_responsibility.allocate',
    'external_responsibility:sign',
    NEW.rework_order_id,
    NEW.created_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_override_reason()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.processing_factory_override_reason IS DISTINCT FROM
     OLD.processing_factory_override_reason THEN
    RAISE EXCEPTION 'processing factory override reason is immutable'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER external_case_override_reason_immutable
  BEFORE UPDATE ON rework_external_responsibility_cases
  FOR EACH ROW EXECUTE FUNCTION guard_external_case_override_reason();

CREATE OR REPLACE FUNCTION guard_external_payables_action_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  expected_action text;
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL
     OR target_case.status<>'pending_payables_confirmation'
     OR NOT external_responsibility_can_payables(
       NEW.acted_by,
       target_case.rework_order_id,
       target_case.responsibility_type,
       'external_responsibility:payables_confirm'
     ) THEN
    RAISE EXCEPTION 'payables actor is not authorized for external case'
      USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(
    NEW.attachment_ids
  );
  PERFORM external_responsibility_require_bound_attachments(
    NEW.attachment_ids,NEW.case_id
  );
  expected_action:=CASE NEW.action
    WHEN 'accepted' THEN 'rework.external_responsibility.payables_accept'
    ELSE 'rework.external_responsibility.payables_return'
  END;
  PERFORM require_external_responsibility_event(
    expected_action,
    'external_responsibility:payables_confirm',
    target_case.rework_order_id,
    NEW.acted_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_follow_up_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL
     OR target_case.status<>'deduction_follow_up'
     OR NOT (
       external_responsibility_can_sign(
         NEW.created_by,
         target_case.rework_order_id,
         target_case.responsibility_type
       )
       OR external_responsibility_can_payables(
         NEW.created_by,
         target_case.rework_order_id,
         target_case.responsibility_type,
         'external_deduction:follow_up'
       )
     ) THEN
    RAISE EXCEPTION 'follow-up actor is not authorized'
      USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(
    NEW.attachment_ids
  );
  PERFORM external_responsibility_require_bound_attachments(
    NEW.attachment_ids,NEW.case_id
  );
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.follow_up',
    'external_deduction:follow_up',
    target_case.rework_order_id,
    NEW.created_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_deduction_entry_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
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
  FROM rework_external_deduction_entries
  WHERE case_id=NEW.case_id;
  IF prior_total+NEW.amount<0
     OR prior_total+NEW.amount>target_case.proposed_deduction_amount
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
END $$;

CREATE OR REPLACE FUNCTION guard_external_closure_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  actual numeric(18,2);
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id
  FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual
  FROM rework_external_deduction_entries
  WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL
     OR target_case.status<>'deduction_follow_up'
     OR NEW.proposed_amount<>target_case.proposed_deduction_amount
     OR NEW.actual_deducted_amount<>actual
     OR NOT external_responsibility_can_payables(
       NEW.closed_by,
       target_case.rework_order_id,
       target_case.responsibility_type,
       'external_deduction:close'
     ) THEN
    RAISE EXCEPTION 'deduction closure does not match accepted case ledger'
      USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(
    NEW.evidence_attachment_ids
  );
  PERFORM external_responsibility_require_bound_attachments(
    NEW.evidence_attachment_ids,NEW.case_id
  );
  PERFORM require_external_responsibility_event(
    'rework.external_deduction.close',
    'external_deduction:close',
    target_case.rework_order_id,
    NEW.closed_by
  );
  RETURN NEW;
END $$;
