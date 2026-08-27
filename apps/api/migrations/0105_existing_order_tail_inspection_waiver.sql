-- Allow an authorized owner, production manager, or Root user to waive tail inspection
-- on an existing executing order while retaining immutable audit evidence.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('tail_inspection:waive','免除现有订单尾查','在最终数量提交前将现有订单改为无需尾查并审计作废历史尾查报数')
ON CONFLICT (capability) DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','tail_inspection:waive'),
  ('production_management','tail_inspection:waive')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_work_task_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=current_setting('dx_rework.work_event_id',true)::uuid
      AND event.request_id=current_setting('dx_rework.work_request_id',true)
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND (
        (event.action='rework.work_task.assign' AND event.authorization_capability='work:assign')
        OR
        (event.action='rework.work_task.active_add' AND event.authorization_capability='work:assignment_adjust')
      )
  ) THEN
    RAISE EXCEPTION 'work task requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_task_member_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_work_tasks task
    JOIN operation_events event ON event.entity_id=task.rework_order_id::text
    WHERE task.work_task_id=NEW.work_task_id
      AND event.event_id=current_setting('dx_rework.work_event_id',true)::uuid
      AND event.request_id=current_setting('dx_rework.work_request_id',true)
      AND event.entity_type='rework_order'
      AND (
        (event.action='rework.work_task.assign' AND event.authorization_capability='work:assign')
        OR
        (event.action='rework.work_task.active_add' AND event.authorization_capability='work:assignment_adjust')
      )
  ) THEN
    RAISE EXCEPTION 'work task member requires authorized audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_task_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.work_task_id IS DISTINCT FROM OLD.work_task_id OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.configuration_item_id IS DISTINCT FROM OLD.configuration_item_id OR NEW.task_version IS DISTINCT FROM OLD.task_version
     OR NEW.assignment_mode IS DISTINCT FROM OLD.assignment_mode OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at OR OLD.status<>'active' OR NEW.status<>'superseded'
     OR NEW.superseded_at IS NULL OR NOT EXISTS (
       SELECT 1 FROM operation_events event
       WHERE event.event_id=current_setting('dx_rework.work_event_id',true)::uuid
         AND event.request_id=current_setting('dx_rework.work_request_id',true)
         AND event.entity_type='rework_order'
         AND event.entity_id=OLD.rework_order_id::text
         AND (
           (event.action IN ('rework.work_task.assign','rework.work_task.remove') AND event.authorization_capability='work:assign')
           OR
           (event.action='rework.work_task.active_remove' AND event.authorization_capability='work:assignment_adjust')
           OR
           (event.action='rework.tail_inspection.waive'
             AND event.authorization_capability='tail_inspection:waive'
             AND EXISTS(
               SELECT 1 FROM rework_process_configuration_items item
               WHERE item.configuration_item_id=OLD.configuration_item_id
                 AND item.execution_kind='tail_inspection'
             ))
         )
     )
  THEN
    RAISE EXCEPTION 'work task versions may only be superseded through assignment or audited removal'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_rejection_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_work_reports report
    JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
    LEFT JOIN rework_work_task_members member
      ON member.work_task_id=report.work_task_id AND member.person_id=NEW.rejected_person_id
    WHERE report.work_report_id=NEW.work_report_id
      AND report.rework_order_id=NEW.rework_order_id
      AND ((task.assignment_mode='collective' AND NEW.rejected_person_id IS NULL)
        OR (task.assignment_mode='individual' AND member.person_id IS NOT NULL))
  ) THEN
    RAISE EXCEPTION 'rejection target does not match report mode' USING ERRCODE='23514';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM rework_work_reports report
    JOIN rework_process_configuration_items item
      ON item.configuration_item_id=report.configuration_item_id
    JOIN operation_events event ON event.entity_id=report.rework_order_id::text
    WHERE report.work_report_id=NEW.work_report_id
      AND item.execution_kind='tail_inspection'
      AND event.event_id=NULLIF(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NULLIF(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=NEW.rejected_by
      AND event.action='rework.tail_inspection.waive'
      AND event.authorization_capability='tail_inspection:waive'
      AND event.entity_type='rework_order'
  ) THEN
    RETURN NEW;
  END IF;

  PERFORM require_whole_order_review_event(
    'rework.work_report.reject','submission:audit',NEW.rework_order_id,NEW.rejected_by
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_assignment_revoke()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL
     OR NEW.tail_inspection_assignment_id IS DISTINCT FROM OLD.tail_inspection_assignment_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.tail_inspector_user_id IS DISTINCT FROM OLD.tail_inspector_user_id
     OR NEW.assigned_by IS DISTINCT FROM OLD.assigned_by
     OR NEW.box_scope IS DISTINCT FROM OLD.box_scope
     OR NEW.assigned_at IS DISTINCT FROM OLD.assigned_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.revoked_at IS NULL OR NEW.revoked_by IS NULL
     OR length(btrim(NEW.revoke_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'tail inspection assignment is immutable except for one reasoned revocation'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NULLIF(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NULLIF(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=NEW.revoked_by
      AND (
        (event.action='rework.tail_inspection.revoke'
          AND event.authorization_capability IN ('process:configure','process:review')
          AND event.entity_type='rework_tail_inspection_assignment'
          AND event.entity_id=NEW.tail_inspection_assignment_id::text)
        OR
        (event.action='rework.tail_inspection.waive'
          AND event.authorization_capability='tail_inspection:waive'
          AND event.entity_type='rework_order'
          AND event.entity_id=NEW.rework_order_id::text)
      )
  ) THEN
    RAISE EXCEPTION 'tail inspection assignment revocation requires its matching audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_tail_inspection_report_rejection()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status<>'submitted'
     OR NEW.status<>'rejected'
     OR NEW.tail_inspection_report_id IS DISTINCT FROM OLD.tail_inspection_report_id
     OR NEW.tail_inspection_assignment_id IS DISTINCT FROM OLD.tail_inspection_assignment_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.returned_quantity IS DISTINCT FROM OLD.returned_quantity
     OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by
     OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
     OR NEW.supersedes_report_id IS DISTINCT FROM OLD.supersedes_report_id
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.rejected_at IS NULL OR NEW.rejected_by IS NULL
     OR length(btrim(NEW.rejection_reason)) NOT BETWEEN 1 AND 500
  THEN
    RAISE EXCEPTION 'tail inspection report may only be rejected once with an audited reason'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=NULLIF(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event.request_id=NULLIF(current_setting('dx_rework.rework_request_id',true),'')
      AND event.actor_id=NEW.rejected_by
      AND (
        (event.authorization_capability='submission:audit'
          AND event.action='rework.tail_inspection.reject'
          AND event.entity_type='rework_tail_inspection_assignment'
          AND event.entity_id=NEW.tail_inspection_assignment_id::text)
        OR
        (event.authorization_capability='tail_inspection:waive'
          AND event.action='rework.tail_inspection.waive'
          AND event.entity_type='rework_order'
          AND event.entity_id=NEW.rework_order_id::text)
      )
  ) THEN
    RAISE EXCEPTION 'tail inspection rejection requires the matching audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

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
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement' AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text) THEN IF OLD.status IN ('cancelled','deleted') OR (to_jsonb(NEW)-ARRAY['updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['updated_by','version','updated_at']) THEN RAISE EXCEPTION 'supplemental images may only update eligible order audit metadata' USING ERRCODE='23514'; END IF; expected_action:='rework.attachments.supplement'; expected_capability:='tools:user';
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.tail_inspection.waive' AND event.authorization_capability='tail_inspection:waive' AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text) THEN
      IF OLD.status NOT IN ('in_progress','pending_order_review')
         OR NEW.status NOT IN ('in_progress','pending_order_review')
         OR OLD.tail_inspection_required IS NOT TRUE
         OR NEW.tail_inspection_required IS NOT FALSE
         OR (to_jsonb(NEW)-ARRAY['status','tail_inspection_required','updated_by','version','updated_at'])
              IS DISTINCT FROM
            (to_jsonb(OLD)-ARRAY['status','tail_inspection_required','updated_by','version','updated_at'])
      THEN RAISE EXCEPTION 'tail inspection waiver may only retire tail inspection before final quantity submission' USING ERRCODE='23514'; END IF;
      expected_action:='rework.tail_inspection.waive'; expected_capability:='tail_inspection:waive';
    ELSE
      IF OLD.status='draft' AND NEW.status='draft' THEN expected_action:='rework.draft.update'; expected_capability:='rework:initiate';
      ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action:='rework.withdraw'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN expected_action:=CASE WHEN NEW.status='pending_process_configuration' THEN 'rework.process_configuration.save' ELSE 'rework.process_configuration.submit' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN expected_action:='rework.process_configuration.review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action:='rework.work_task.assignment_confirm'; expected_capability:='work:assign';
      ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.work_task.active_add'; alternative_capability:='work:assignment_adjust'; alternative_action_two:='rework.work_task.active_remove'; alternative_capability_two:='work:assignment_adjust';
      ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action:='rework.work_report.submit'; expected_capability:='work:report'; alternative_action:='rework.tail_inspection.submit'; alternative_capability:='tail_inspection:report';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.quantity.increase.request'; alternative_capability:='quantity:adjust'; alternative_action_two:='rework.quantity.increase.confirm'; alternative_capability_two:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN expected_action:='rework.work_report.reject'; expected_capability:='submission:audit'; alternative_action:='rework.quantity.increase.confirm'; alternative_capability:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action:='rework.quantity.increase.confirm'; expected_capability:='quantity:confirm';
      ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN expected_action:='rework.quantity.increase.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_final_quantity_ie_review' THEN expected_action:='rework.tail_completion.confirm'; expected_capability:='submission:audit';
      ELSIF OLD.status='pending_final_quantity_ie_review' AND NEW.status IN ('pending_order_review','pending_responsibility_determination') THEN expected_action:='rework.final_quantity.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine'; ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision'; ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate'; ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF; audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker','tail_inspection:report')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (expected_action<>'rework.tail_inspection.waive' OR event.after_state @> '{"tailInspectionRequired":false}'::jsonb) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- Keep the approved tail configuration item as immutable planning evidence after
-- a waiver. A no-tail order may therefore have zero current tail configuration
-- items (created no-tail) or one retired historical item (waived existing order).
CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unified_execution boolean;
  tail_required boolean;
  tail_process_count bigint;
BEGIN
  SELECT target.tail_inspection_required
  INTO tail_required
  FROM rework_orders target
  WHERE target.rework_order_id=NEW.rework_order_id
    AND target.status='pending_final_quantity_ie_review';
  IF tail_required IS NULL
  THEN RAISE EXCEPTION 'order is not pending IE final-quantity review' USING ERRCODE='23514'; END IF;

  SELECT configuration.unified_execution_required INTO unified_execution
  FROM rework_process_configurations configuration
  WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' LIMIT 1;

  IF unified_execution IS NULL OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every IE-approved process requires a price' USING ERRCODE='23514'; END IF;

  SELECT count(*) INTO tail_process_count
  FROM rework_process_configurations configuration
  JOIN rework_process_configuration_items item USING(configuration_id)
  WHERE configuration.rework_order_id=NEW.rework_order_id
    AND configuration.status='approved'
    AND item.execution_kind='tail_inspection';

  IF unified_execution AND (
    (tail_required AND tail_process_count<>1)
    OR (NOT tail_required AND tail_process_count>1)
  ) THEN RAISE EXCEPTION 'unified execution tail-inspection process does not match the order decision' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM rework_tail_completion_confirmations confirmation
    JOIN rework_tail_completion_reviews review ON review.confirmation_id=confirmation.confirmation_id AND review.decision='approved'
    WHERE confirmation.rework_order_id=NEW.rework_order_id AND confirmation.workflow_stage='pending_ie_review'
      AND review.reviewed_by=NEW.reviewed_by
      AND review.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND review.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'approved IE final-quantity review is required' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_tasks task
    WHERE task.rework_order_id=NEW.rework_order_id AND task.status='active'
      AND NOT EXISTS(SELECT 1 FROM rework_work_reports report WHERE report.work_task_id=task.work_task_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id))
  ) THEN RAISE EXCEPTION 'every active execution task requires a valid report' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_tail_inspection_assignments assignment
    WHERE assignment.rework_order_id=NEW.rework_order_id AND assignment.revoked_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM rework_tail_inspection_reports report
        WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id AND report.status='submitted')
  ) THEN RAISE EXCEPTION 'every active legacy tail inspector requires a submitted count' USING ERRCODE='23514'; END IF;

  IF unified_execution AND tail_required AND EXISTS(
    WITH tail_total AS (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      JOIN rework_process_configuration_items item ON item.configuration_item_id=report.configuration_item_id
      WHERE report.rework_order_id=NEW.rework_order_id AND item.execution_kind='tail_inspection' AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    )
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    CROSS JOIN tail_total
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(rework_work_report_effective_quantity(report.work_report_id)),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND item.execution_kind='worker'
      AND worker.quantity<>tail_total.quantity
  ) THEN RAISE EXCEPTION 'worker count must equal unified tail-inspection count' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id AND report.configuration_item_id=item.configuration_item_id AND report.status='submitted'
        AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
    ) worker ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
      FROM rework_tail_inspection_report_items report_item
      JOIN rework_tail_inspection_reports report ON report.tail_inspection_report_id=report_item.tail_inspection_report_id AND report.status='submitted'
      JOIN rework_tail_inspection_assignments assignment ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id AND assignment.revoked_at IS NULL
      WHERE report.rework_order_id=NEW.rework_order_id AND report_item.configuration_item_id=item.configuration_item_id
    ) tail_checked ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id AND configuration.status='approved' AND worker.quantity>tail_checked.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed legacy tail inspection count' USING ERRCODE='23514'; END IF;

  IF EXISTS(
    SELECT 1 FROM rework_work_reports report
    WHERE report.rework_order_id=NEW.rework_order_id AND report.status='submitted'
      AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection WHERE rejection.work_report_id=report.work_report_id)
      AND report.group_amount<=0
  ) THEN RAISE EXCEPTION 'every valid report requires generated wages' USING ERRCODE='23514'; END IF;

  PERFORM require_whole_order_review_event('rework.final_quantity.ie_review','process:review',NEW.rework_order_id,NEW.reviewed_by);
  RETURN NEW;
END;
$$;
