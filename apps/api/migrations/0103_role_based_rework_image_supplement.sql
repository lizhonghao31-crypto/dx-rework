-- Keep post-creation rework evidence append-only while allowing the approved
-- business roles to add images throughout the workflow, including completion.
-- Authorization is recorded as tools:user after the API has checked the role
-- allowlist. Cancelled and logically deleted orders remain terminal.

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
    ELSE
      IF OLD.status='draft' AND NEW.status='draft' THEN expected_action:='rework.draft.update'; expected_capability:='rework:initiate';
      ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action:='rework.withdraw'; expected_capability:='rework:initiate';
      ELSIF OLD.status='pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN expected_action:=CASE WHEN NEW.status='pending_process_configuration' THEN 'rework.process_configuration.save' ELSE 'rework.process_configuration.submit' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN expected_action:='rework.process_configuration.review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
      ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action:='rework.work_task.assignment_confirm'; expected_capability:='work:assign';
      ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust';
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
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker','tail_inspection:report')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_rework_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  order_id uuid;
  order_creator uuid;
  order_status text;
  order_updated_by uuid;
  order_version integer;
BEGIN
  IF OLD.entity_type='rework_order'
     AND (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
  THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound rework evidence is immutable' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'rework_order' AND NEW.entity_type IS DISTINCT FROM 'rework_order')
  THEN
    RETURN NEW;
  END IF;

  IF audit_event_id IS NULL OR audit_request_id IS NULL THEN
    RAISE EXCEPTION 'rework attachment binding requires trusted audit context' USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.entity_type IS NULL AND OLD.entity_id IS NULL AND NEW.entity_type='rework_order' AND NEW.entity_id IS NOT NULL)
    OR (OLD.entity_type='rework_order' AND OLD.entity_id IS NOT NULL AND NEW.entity_type IS NULL AND NEW.entity_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'rework attachments cannot be moved directly between entities' USING ERRCODE = '23514';
  END IF;

  order_id := COALESCE(NEW.entity_id,OLD.entity_id)::uuid;
  SELECT created_by,status,updated_by,version
  INTO order_creator,order_status,order_updated_by,order_version
  FROM rework_orders
  WHERE rework_order_id=order_id;
  IF order_creator IS NULL THEN
    RAISE EXCEPTION 'rework order does not exist for attachment binding' USING ERRCODE = '23514';
  END IF;

  IF OLD.entity_type IS NULL
     AND NEW.entity_type='rework_order'
     AND NEW.status='ready'
     AND order_status NOT IN ('cancelled','deleted')
     AND NEW.uploaded_by=order_updated_by
     AND EXISTS (
       SELECT 1
       FROM operation_events event
       WHERE event.event_id=audit_event_id::uuid
         AND event.request_id=audit_request_id
         AND event.actor_id=order_updated_by
         AND event.authorization_capability='tools:user'
         AND event.action='rework.attachments.supplement'
         AND event.entity_type='rework_order'
         AND event.entity_id=order_id::text
         AND event.after_state->>'status'=order_status
         AND event.after_state->>'version'=order_version::text
         AND event.after_state->'attachmentIds' ? NEW.attachment_id::text
     )
  THEN
    RETURN NEW;
  END IF;

  IF order_status<>'draft' THEN
    RAISE EXCEPTION 'attachments can only be changed on an owned draft or through audited supplement' USING ERRCODE = '23514';
  END IF;
  IF NEW.status<>'ready' OR NEW.uploaded_by<>order_creator THEN
    RAISE EXCEPTION 'only the creator ready attachment can be bound to a draft' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.actor_id=order_creator
      AND event.authorization_capability='rework:initiate'
      AND event.action IN ('rework.draft.create','rework.draft.update')
      AND event.entity_type='rework_order'
      AND event.entity_id=order_id::text
      AND event.after_state->>'status'='draft'
      AND (
        (NEW.entity_type='rework_order' AND event.after_state->'attachmentIds' ? NEW.attachment_id::text)
        OR (OLD.entity_type='rework_order' AND NOT (event.after_state->'attachmentIds' ? OLD.attachment_id::text))
      )
  ) THEN
    RAISE EXCEPTION 'rework attachment audit event does not match the binding' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
