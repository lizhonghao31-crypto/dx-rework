-- Restore IE pricing before assignment and make N06 the only wage-materialization hand-off.
-- Historical phase-1 tail-pricing rows remain immutable audit evidence, but no
-- new order transition or runtime route can enter that retired path.

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid='rework_process_configuration_items'::regclass
      AND contype='c' AND pg_get_constraintdef(oid) ILIKE '%unit_price%'
  LOOP
    EXECUTE format('ALTER TABLE rework_process_configuration_items DROP CONSTRAINT %I',constraint_name);
  END LOOP;
END $$;
ALTER TABLE rework_process_configuration_items
  ADD CONSTRAINT rework_process_item_unit_price_required_check
  CHECK(unit_price IS NOT NULL AND unit_price>=0.001 AND unit_price=trunc(unit_price,3)) NOT VALID;

ALTER TABLE rework_process_configurations
  DROP CONSTRAINT IF EXISTS rework_process_configuration_reviewed_rejection_check;
ALTER TABLE rework_process_configurations
  ADD CONSTRAINT rework_process_configuration_reviewed_decision_check
  CHECK(status NOT IN ('approved','rejected') OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)) NOT VALID;

CREATE OR REPLACE FUNCTION guard_rework_process_configuration_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  expected_capability text;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.submitted_at IS NOT NULL
       OR NEW.reviewed_by IS NOT NULL OR NEW.reviewed_at IS NOT NULL
       OR NEW.review_reason IS NOT NULL
    THEN
      RAISE EXCEPTION 'new process configuration must start as a draft'
        USING ERRCODE='23514';
    END IF;
    expected_action := 'rework.process_configuration.save';
    expected_capability := 'process:configure';
  ELSE
    IF NEW.configuration_id IS DISTINCT FROM OLD.configuration_id
       OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
       OR NEW.configuration_version IS DISTINCT FROM OLD.configuration_version
       OR NEW.configuration_kind IS DISTINCT FROM OLD.configuration_kind
       OR NEW.change_reason IS DISTINCT FROM OLD.change_reason
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'process configuration identity and business fields are immutable'
        USING ERRCODE='55000';
    END IF;
    IF OLD.status='draft' AND NEW.status='pending_ie_review' THEN
      expected_action := 'rework.process_configuration.submit';
      expected_capability := 'process:configure';
    ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('approved','rejected') THEN
      expected_action := 'rework.process_configuration.review';
      expected_capability := 'process:review';
    ELSIF OLD.status='approved' AND NEW.status='superseded' THEN
      expected_action := 'rework.process_configuration.review';
      expected_capability := 'process:review';
    ELSIF OLD.status='draft' AND NEW.status='superseded' THEN
      expected_action := 'rework.process_configuration.save';
      expected_capability := 'process:configure';
    ELSE
      RAISE EXCEPTION 'invalid process configuration transition: % to %', OLD.status,NEW.status
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM require_rework_process_configuration_event(
    expected_action,expected_capability,NEW.rework_order_id,NEW.configuration_id
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rework_process_configuration_items_guard_final_price
  ON rework_process_configuration_items;
DROP TRIGGER IF EXISTS rework_process_configuration_items_no_update
  ON rework_process_configuration_items;
CREATE TRIGGER rework_process_configuration_items_no_update
  BEFORE UPDATE ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE rework_tail_completion_confirmations (
  confirmation_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL UNIQUE REFERENCES rework_orders(rework_order_id),
  confirmed_by uuid NOT NULL REFERENCES app_users(id),
  confirmed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$')
);
CREATE TABLE rework_tail_completion_coefficients (
  confirmation_id uuid NOT NULL REFERENCES rework_tail_completion_confirmations(confirmation_id),
  configuration_item_id uuid NOT NULL REFERENCES rework_process_configuration_items(configuration_item_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  multiplier numeric(8,3) NOT NULL CHECK(multiplier>0 AND multiplier<=10 AND multiplier=trunc(multiplier,3)),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  PRIMARY KEY(confirmation_id,configuration_item_id,person_id),
  CHECK(multiplier=1 OR reason IS NOT NULL)
);

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_confirmation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rework_orders target
    JOIN operation_events event ON event.event_id=NEW.operation_event_id
    WHERE target.rework_order_id=NEW.rework_order_id
      AND target.status='pending_order_review'
      AND event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NEW.request_id
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.whole_order.approve'
      AND event.authorization_capability='submission:audit'
      AND event.actor_id=NEW.confirmed_by
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'tail completion requires the matching N06 audit event' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_tail_completion_confirmations_guard_insert
  BEFORE INSERT ON rework_tail_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_completion_confirmation();
CREATE TRIGGER rework_tail_completion_confirmations_no_update
  BEFORE UPDATE ON rework_tail_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_confirmations_no_delete
  BEFORE DELETE ON rework_tail_completion_confirmations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_confirmations_no_truncate
  BEFORE TRUNCATE ON rework_tail_completion_confirmations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_tail_completion_coefficient()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_order_id uuid;
BEGIN
  SELECT confirmation.rework_order_id INTO target_order_id
  FROM rework_tail_completion_confirmations confirmation
  WHERE confirmation.confirmation_id=NEW.confirmation_id
    AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
    AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  FOR SHARE;
  IF target_order_id IS NULL OR NOT EXISTS(
    SELECT 1
    FROM rework_work_reports report
    JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
    JOIN rework_work_task_members member
      ON member.work_task_id=task.work_task_id AND member.person_id=NEW.person_id
    WHERE report.rework_order_id=target_order_id
      AND report.configuration_item_id=NEW.configuration_item_id
      AND report.status='submitted'
      AND member.person_type_snapshot='temporary'
      AND NOT EXISTS(
        SELECT 1 FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id
      )
  ) THEN
    RAISE EXCEPTION 'temporary coefficient must match a valid temporary-worker report' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_tail_completion_coefficients_guard_insert
  BEFORE INSERT ON rework_tail_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION guard_rework_tail_completion_coefficient();
CREATE TRIGGER rework_tail_completion_coefficients_no_update
  BEFORE UPDATE ON rework_tail_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_coefficients_no_delete
  BEFORE DELETE ON rework_tail_completion_coefficients
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_tail_completion_coefficients_no_truncate
  BEFORE TRUNCATE ON rework_tail_completion_coefficients
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION rework_n06_event_matches(target_order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1 FROM operation_events event
    WHERE event.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event.action='rework.whole_order.approve'
      AND event.authorization_capability='submission:audit'
      AND event.entity_type='rework_order'
      AND event.entity_id=target_order_id::text
      AND EXISTS(
        SELECT 1 FROM rework_tail_completion_confirmations confirmation
        WHERE confirmation.rework_order_id=target_order_id
          AND confirmation.operation_event_id=event.event_id
          AND confirmation.request_id=event.request_id
      )
  )
$$;

DROP TRIGGER IF EXISTS rework_work_reports_guard_final_amount ON rework_work_reports;
CREATE OR REPLACE FUNCTION guard_rework_work_report_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW)-'group_amount') IS DISTINCT FROM (to_jsonb(OLD)-'group_amount')
     OR OLD.group_amount<>0 OR NEW.group_amount<=0
     OR NOT rework_n06_event_matches(OLD.rework_order_id) THEN
    RAISE EXCEPTION 'work report amount can only be generated by N06 confirmation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_work_reports_guard_final_amount
  BEFORE UPDATE ON rework_work_reports
  FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_final_amount();

DROP TRIGGER IF EXISTS rework_work_report_member_shares_guard_final_amount
  ON rework_work_report_member_shares;
CREATE OR REPLACE FUNCTION guard_rework_work_report_share_final_amount()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_order_id uuid;
BEGIN
  SELECT report.rework_order_id INTO target_order_id
  FROM rework_work_reports report WHERE report.work_report_id=OLD.work_report_id;
  IF (to_jsonb(NEW)-'amount') IS DISTINCT FROM (to_jsonb(OLD)-'amount')
     OR OLD.amount<>0 OR NEW.amount<=0
     OR target_order_id IS NULL OR NOT rework_n06_event_matches(target_order_id) THEN
    RAISE EXCEPTION 'work report share can only be generated by N06 confirmation' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_work_report_member_shares_guard_final_amount
  BEFORE UPDATE ON rework_work_report_member_shares
  FOR EACH ROW EXECUTE FUNCTION guard_rework_work_report_share_final_amount();

CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rework_orders target
    WHERE target.rework_order_id=NEW.rework_order_id AND target.status='pending_order_review'
  ) THEN RAISE EXCEPTION 'order is not pending N06 tail confirmation' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved'
  ) OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every N03 IE-approved process requires a price' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(
    SELECT 1 FROM rework_tail_completion_confirmations confirmation
    WHERE confirmation.rework_order_id=NEW.rework_order_id
      AND confirmation.confirmed_by=NEW.reviewed_by
      AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'N06 completion confirmation is required' USING ERRCODE='23514'; END IF;
  IF EXISTS(
    SELECT 1 FROM rework_work_tasks task
    WHERE task.rework_order_id=NEW.rework_order_id AND task.status='active'
      AND NOT EXISTS(
        SELECT 1 FROM rework_work_reports report
        WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
          AND NOT EXISTS(
            SELECT 1 FROM rework_work_report_rejections rejection
            WHERE rejection.work_report_id=report.work_report_id
          )
      )
  ) THEN RAISE EXCEPTION 'every active task requires a valid final report' USING ERRCODE='23514'; END IF;
  IF EXISTS(
    SELECT 1 FROM rework_work_reports report
    WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(
        SELECT 1 FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id
      )
      AND report.group_amount<=0
  ) THEN RAISE EXCEPTION 'every valid report requires generated wages' USING ERRCODE='23514'; END IF;
  PERFORM require_whole_order_review_event(
    'rework.whole_order.approve','submission:audit',NEW.rework_order_id,NEW.reviewed_by
  );
  RETURN NEW;
END $$;

-- N07 no longer models percentage sharing. The wire shape still stores the
-- selected party as a 10000-bps immutable snapshot for historical report
-- compatibility, while the database rejects a second party for every V2 process.
CREATE OR REPLACE FUNCTION guard_responsibility_single_party()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE schema_version smallint;
BEGIN
  SELECT determination.settlement_schema_version INTO schema_version
  FROM rework_responsibility_determinations determination
  WHERE determination.determination_id=NEW.determination_id;
  IF schema_version=2 THEN
    IF NEW.share_bps<>10000 OR EXISTS(
      SELECT 1 FROM rework_responsibility_allocations existing
      WHERE existing.determination_id=NEW.determination_id
        AND existing.configuration_item_id=NEW.configuration_item_id
    ) THEN
      RAISE EXCEPTION 'V2 process requires exactly one 100 percent responsible party' USING ERRCODE='23514';
    END IF;
    IF NEW.responsibility_type='own_factory' AND (
      NEW.multiplier IS DISTINCT FROM 1.000 OR NEW.supplier_id IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'own-factory responsibility cannot carry an external multiplier or supplier' USING ERRCODE='23514';
    END IF;
    IF NEW.responsibility_type<>'own_factory' AND (
      NEW.multiplier IS NULL OR NEW.multiplier<1.200 OR NEW.supplier_id IS NULL
    ) THEN
      RAISE EXCEPTION 'external responsibility requires a supplier and multiplier of at least 1.2' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS responsibility_single_party_insert
  ON rework_responsibility_allocations;
CREATE TRIGGER responsibility_single_party_insert
  BEFORE INSERT ON rework_responsibility_allocations
  FOR EACH ROW EXECUTE FUNCTION guard_responsibility_single_party();

CREATE OR REPLACE FUNCTION guard_rework_order_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_event_id text:=nullif(current_setting('dx_rework.rework_event_id',true),''); audit_request_id text:=nullif(current_setting('dx_rework.rework_request_id',true),''); expected_action text; expected_capability text; alternative_action text:=NULL; alternative_capability text:=NULL; alternative_action_two text:=NULL; alternative_capability_two text:=NULL; alternative_action_three text:=NULL; alternative_capability_three text:=NULL; audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.source_system='manual' THEN IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NOT NULL OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF; expected_action:='rework.draft.create'; expected_capability:='rework:initiate';
    ELSIF NEW.source_system IN ('erp','erp_emergency') THEN IF NEW.status<>'pending_process_configuration' OR NEW.version<>1 OR NEW.rework_no IS NULL OR NEW.submitted_at IS NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NULL OR NEW.external_idempotency_key IS NULL OR NEW.erp_node_id IS NOT NULL OR NEW.style_no IS NULL OR NEW.merchandiser_user_id IS NULL OR NEW.processing_factory_type IS NULL OR NEW.problem_part IS NULL OR NEW.problem_description IS NULL OR NEW.rework_quantity IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN RAISE EXCEPTION 'ERP rework orders must enter as a complete submitted order' USING ERRCODE='23514'; END IF; IF NEW.source_system='erp' AND NEW.created_by<>'00000000-0000-4000-8000-000000000016'::uuid THEN RAISE EXCEPTION 'ERP intake requires dedicated integration principal' USING ERRCODE='42501'; END IF; expected_action:='rework.submit'; expected_capability:=CASE NEW.source_system WHEN 'erp' THEN 'erp:integrate' ELSE 'erp:emergency_intake' END;
    ELSE RAISE EXCEPTION 'unsupported rework source system' USING ERRCODE='23514'; END IF; audit_actor_id:=NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF; IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF; IF OLD.status='deleted' THEN RAISE EXCEPTION 'deleted rework orders are immutable' USING ERRCODE='55000'; END IF;
    IF NEW.status='deleted' THEN IF NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL OR (to_jsonb(NEW)-ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) THEN RAISE EXCEPTION 'logical deletion may only update deletion metadata' USING ERRCODE='23514'; END IF; expected_action:='rework.delete'; expected_capability:='rework:delete';
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement' AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text) THEN IF OLD.status IN ('completed','cancelled','deleted') OR (to_jsonb(NEW)-ARRAY['updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_by','version','updated_at']) THEN RAISE EXCEPTION 'supplemental images may only update active order audit metadata' USING ERRCODE='23514'; END IF; expected_action:='rework.attachments.supplement'; expected_capability:='rework:initiate';
    ELSE
      IF OLD.status='draft' AND NEW.status='draft' THEN expected_action:='rework.draft.update'; expected_capability:='rework:initiate';
      ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action:='rework.withdraw'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN expected_action:=CASE WHEN NEW.status='pending_process_configuration' THEN 'rework.process_configuration.save' ELSE 'rework.process_configuration.submit' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN expected_action:='rework.process_configuration.review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action:='rework.work_task.assignment_confirm'; expected_capability:='work:assign';
      ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust';
      ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action:='rework.work_report.submit'; expected_capability:='work:report'; alternative_action:='rework.quantity.decrease'; alternative_capability:='quantity:adjust';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.quantity.increase.request'; alternative_capability:='quantity:adjust'; alternative_action_two:='rework.quantity.increase.confirm'; alternative_capability_two:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN expected_action:='rework.work_report.reject'; expected_capability:='submission:audit'; alternative_action:='rework.quantity.increase.confirm'; alternative_capability:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action:='rework.quantity.increase.confirm'; expected_capability:='quantity:confirm';
      ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN expected_action:='rework.quantity.increase.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.whole_order.approve'; expected_capability:='submission:audit';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine'; ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision'; ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate'; ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF; audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
