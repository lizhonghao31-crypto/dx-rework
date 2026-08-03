-- PR-11 review closure: tighten delegated order ownership, restore the
-- embroidery/washing merchandiser's required tools, version every ledger fact,
-- and link approved revision requests to the executable N07 draft they seed.

DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('embroidery_washing_merchandiser','tools:user'),
  ('embroidery_washing_merchandiser','supplier_catalog:read')
ON CONFLICT DO NOTHING;
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION external_responsibility_can_sign(
  candidate uuid, order_id uuid, responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN responsibility_type IN ('processing_factory','fabric_supplier') THEN
      EXISTS (
        SELECT 1
        FROM rework_orders order_record
        WHERE order_record.rework_order_id=order_id
          AND order_record.merchandiser_user_id=candidate
          AND external_responsibility_direct_role(
            candidate,'external_responsibility:sign',ARRAY['order_merchandiser']
          )
      )
      OR (
        responsibility_actor_is_active(candidate)
        AND EXISTS (
          SELECT 1
          FROM delegated_authorizations delegation
          JOIN rework_orders order_record
            ON order_record.rework_order_id=order_id
           AND order_record.merchandiser_user_id=delegation.grantor_user_id
          WHERE delegation.grantee_user_id=candidate
            AND delegation.capability='external_responsibility:sign'
            AND delegation.scope_type='rework_order'
            AND delegation.scope_id=order_id::text
            AND delegation.revoked_at IS NULL
            AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
            AND external_responsibility_direct_role(
              delegation.grantor_user_id,
              'external_responsibility:sign',
              ARRAY['order_merchandiser']
            )
        )
      )
    WHEN responsibility_type IN ('embroidery_factory','washing_factory') THEN
      external_responsibility_direct_role(
        candidate,'external_responsibility:sign',ARRAY['embroidery_washing_merchandiser']
      )
      OR external_responsibility_active_delegation(
        candidate,'external_responsibility:sign',order_id,
        ARRAY['embroidery_washing_merchandiser']
      )
    ELSE false
  END
$$;

ALTER TABLE rework_external_responsibility_revision_requests
  ADD COLUMN seeded_determination_id uuid
  REFERENCES rework_responsibility_determinations(determination_id);

CREATE OR REPLACE FUNCTION guard_external_revision_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE;
BEGIN
  IF NEW.revision_request_id IS DISTINCT FROM OLD.revision_request_id
     OR NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.source_case_status IS DISTINCT FROM OLD.source_case_status
     OR NEW.finalized_determination_id IS DISTINCT FROM OLD.finalized_determination_id
     OR NEW.finalized_determination_version IS DISTINCT FROM OLD.finalized_determination_version
     OR NEW.requested_change IS DISTINCT FROM OLD.requested_change
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.attachment_ids IS DISTINCT FROM OLD.attachment_ids
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.status<>'pending'
     OR NEW.status NOT IN ('approved','rejected')
     OR NEW.revision_version<>OLD.revision_version+1 THEN
    RAISE EXCEPTION 'external revision history is immutable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL
     OR NOT external_responsibility_direct_role(
       NEW.decided_by,
       'external_responsibility:approve_revision',
       ARRAY['production_management','owner_group']
     ) THEN
    RAISE EXCEPTION 'external revision decision actor is not authorized'
      USING ERRCODE='42501';
  END IF;
  IF (NEW.status='approved' AND NEW.seeded_determination_id IS NULL)
     OR (NEW.status='rejected' AND NEW.seeded_determination_id IS NOT NULL) THEN
    RAISE EXCEPTION 'approved external revision must bind its seeded N07 draft'
      USING ERRCODE='23514';
  END IF;
  IF NEW.seeded_determination_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
       FROM rework_responsibility_determinations seed
       WHERE seed.determination_id=NEW.seeded_determination_id
         AND seed.rework_order_id=target_case.rework_order_id
         AND seed.stage='draft'
         AND seed.replaces_determination_id=NEW.finalized_determination_id
     ) THEN
    RAISE EXCEPTION 'external revision seed must be the direct N07 draft successor'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event(
    CASE NEW.status
      WHEN 'approved' THEN 'rework.external_responsibility.revision.approve'
      ELSE 'rework.external_responsibility.revision.reject'
    END,
    'external_responsibility:approve_revision',
    target_case.rework_order_id,
    NEW.decided_by
  );
  IF NEW.decision_operation_event_id IS DISTINCT FROM
       nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
     OR NEW.decision_request_id IS DISTINCT FROM
       nullif(current_setting('dx_rework.external_responsibility_request_id',true),'') THEN
    RAISE EXCEPTION 'external revision decision requires matching event context'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  decision rework_external_payables_actions%ROWTYPE;
  closure rework_external_deduction_closures%ROWTYPE;
  revision rework_external_responsibility_revision_requests%ROWTYPE;
  signoff rework_external_business_signoffs%ROWTYPE;
  batch rework_external_responsibility_batches%ROWTYPE;
  current_action text;
  current_capability text;
  current_actor uuid;
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id
     OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.responsibility_type IS DISTINCT FROM OLD.responsibility_type
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id
     OR NEW.supplier_version IS DISTINCT FROM OLD.supplier_version
     OR NEW.supplier_code_snapshot IS DISTINCT FROM OLD.supplier_code_snapshot
     OR NEW.supplier_name_snapshot IS DISTINCT FROM OLD.supplier_name_snapshot
     OR NEW.supplier_type_snapshot IS DISTINCT FROM OLD.supplier_type_snapshot
     OR NEW.business_handler_user_id IS DISTINCT FROM OLD.business_handler_user_id
     OR NEW.payables_handler_role_snapshot IS DISTINCT FROM OLD.payables_handler_role_snapshot
     OR NEW.proposed_deduction_amount IS DISTINCT FROM OLD.proposed_deduction_amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.case_version<>OLD.case_version+1 THEN
    RAISE EXCEPTION 'external deduction case source facts are immutable'
      USING ERRCODE='55000';
  END IF;
  IF OLD.status='superseded' THEN
    RAISE EXCEPTION 'superseded case is immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.status='deduction_follow_up'
     AND NEW.status='deduction_follow_up' THEN
    SELECT action,authorization_capability,actor_id
    INTO current_action,current_capability,current_actor
    FROM operation_events
    WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid
      AND request_id=nullif(
        current_setting('dx_rework.external_responsibility_request_id',true),''
      );
    IF (current_action,current_capability) NOT IN (
      ('rework.external_deduction.follow_up','external_deduction:follow_up'),
      ('rework.external_deduction.record','external_deduction:record')
    ) THEN
      RAISE EXCEPTION 'ledger case version requires a matching append-only action'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      current_action,current_capability,NEW.rework_order_id,current_actor
    );
  ELSIF NEW.status='pending_payables_confirmation'
     AND OLD.status IN ('pending_business_signoff','returned') THEN
    SELECT * INTO signoff
    FROM rework_external_business_signoffs
    WHERE case_id=NEW.case_id
    ORDER BY created_at DESC LIMIT 1;
    IF signoff.signoff_id IS NULL THEN
      RAISE EXCEPTION 'case submission requires append-only signoff'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.submit',
      'external_responsibility:sign',
      NEW.rework_order_id,
      signoff.submitted_by
    );
  ELSIF NEW.status IN ('deduction_follow_up','returned')
     AND OLD.status='pending_payables_confirmation' THEN
    SELECT * INTO decision
    FROM rework_external_payables_actions
    WHERE case_id=NEW.case_id
    ORDER BY created_at DESC LIMIT 1;
    expected_action:=CASE NEW.status
      WHEN 'deduction_follow_up' THEN 'rework.external_responsibility.payables_accept'
      ELSE 'rework.external_responsibility.payables_return'
    END;
    IF decision.payables_action_id IS NULL
       OR decision.action<>(CASE NEW.status
         WHEN 'deduction_follow_up' THEN 'accepted'
         ELSE 'returned'
       END) THEN
      RAISE EXCEPTION 'payables transition requires matching append-only action'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      expected_action,
      'external_responsibility:payables_confirm',
      NEW.rework_order_id,
      decision.acted_by
    );
  ELSIF NEW.status='closed' AND OLD.status='deduction_follow_up' THEN
    SELECT * INTO closure
    FROM rework_external_deduction_closures
    WHERE case_id=NEW.case_id;
    IF closure.closure_id IS NULL THEN
      RAISE EXCEPTION 'case closure requires append-only closure record'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_deduction.close',
      'external_deduction:close',
      NEW.rework_order_id,
      closure.closed_by
    );
  ELSIF NEW.status='pending_responsibility_revision'
     AND OLD.status IN (
       'pending_business_signoff','returned','pending_payables_confirmation',
       'deduction_follow_up','closed'
     ) THEN
    SELECT * INTO revision
    FROM rework_external_responsibility_revision_requests
    WHERE case_id=NEW.case_id AND status='pending'
    ORDER BY created_at DESC LIMIT 1;
    IF revision.revision_request_id IS NULL THEN
      RAISE EXCEPTION 'case revision requires append-only request record'
        USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.revision.request',
      'external_responsibility:request_revision',
      NEW.rework_order_id,
      revision.requested_by
    );
  ELSIF NEW.status='superseded'
     AND OLD.status IN (
       'pending_business_signoff','returned','pending_payables_confirmation',
       'deduction_follow_up','pending_responsibility_revision'
     ) THEN
    SELECT * INTO batch
    FROM rework_external_responsibility_batches
    WHERE batch_id=NEW.batch_id;
    IF NOT external_responsibility_superseded_by_finalization(
      batch.finalized_determination_id,NEW.rework_order_id
    ) THEN
      SELECT actor_id INTO current_actor
      FROM operation_events
      WHERE event_id=nullif(
        current_setting('dx_rework.external_responsibility_event_id',true),''
      )::uuid;
      PERFORM require_external_responsibility_event(
        'rework.external_responsibility.revision.approve',
        'external_responsibility:approve_revision',
        NEW.rework_order_id,
        current_actor
      );
    END IF;
  ELSIF OLD.status='pending_responsibility_revision'
     AND NEW.status IN (
       'pending_business_signoff','returned','pending_payables_confirmation',
       'deduction_follow_up','closed'
     ) THEN
    SELECT actor_id INTO current_actor
    FROM operation_events
    WHERE event_id=nullif(
      current_setting('dx_rework.external_responsibility_event_id',true),''
    )::uuid;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.revision.reject',
      'external_responsibility:approve_revision',
      NEW.rework_order_id,
      current_actor
    );
  ELSE
    RAISE EXCEPTION 'invalid external deduction case transition'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION bump_external_case_version_from_ledger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE rework_external_responsibility_cases
  SET case_version=case_version+1
  WHERE case_id=NEW.case_id AND status='deduction_follow_up';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ledger fact requires an active deduction-follow-up case'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER external_followups_bump_case_version
  AFTER INSERT ON rework_external_deduction_follow_ups
  FOR EACH ROW EXECUTE FUNCTION bump_external_case_version_from_ledger();
CREATE TRIGGER external_deductions_bump_case_version
  AFTER INSERT ON rework_external_deduction_entries
  FOR EACH ROW EXECUTE FUNCTION bump_external_case_version_from_ledger();
