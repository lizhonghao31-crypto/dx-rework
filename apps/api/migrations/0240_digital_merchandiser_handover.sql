-- Current handling rights are separate from historical creators and approval/upload actors.
-- Only the original named primary's two native sourcing todo categories may move.
CREATE FUNCTION digital_merchandiser_todo_transfer(old_row rework_todos,new_row rework_todos)
RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE event operation_events%ROWTYPE; assignment audit_events%ROWTYPE; mother digital_production_orders%ROWTYPE;
BEGIN
  IF old_row.status NOT IN ('pending','blocked_recipient') OR new_row.status<>'pending'
     OR old_row.recipient_user_id=new_row.recipient_user_id OR old_row.todo_type<>'business_action'
     OR old_row.entity_type<>'sourcing_case' OR old_row.required_role<>'order_merchandiser'
     OR old_row.route_descriptor->>'routeName'<>'sourcing_detail'
     OR old_row.route_descriptor->>'entityId' IS DISTINCT FROM old_row.entity_id
     OR NOT ((old_row.category='sourcing_contract_return' AND old_row.required_capability='sourcing:contract:record')
         OR (old_row.category='sourcing_merchandiser_correction' AND old_row.required_capability='sourcing:inquiry:create'))
     OR old_row.dedupe_key !~ ('^sourcing:'||old_row.entity_id||':(return|correction):[0-9]+$')
     OR new_row.delegation_id IS NOT NULL OR new_row.blocked_at IS NOT NULL OR new_row.blocked_reason IS NOT NULL
     OR (to_jsonb(new_row)-ARRAY['recipient_user_id','delegation_id','status','blocked_at','blocked_reason','version','updated_at'])
        IS DISTINCT FROM (to_jsonb(old_row)-ARRAY['recipient_user_id','delegation_id','status','blocked_at','blocked_reason','version','updated_at'])
  THEN RETURN false; END IF;
  SELECT * INTO event FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.todo_request_id',true),'') AND action='todo.transfer'
    AND entity_type='rework_todo' AND entity_id=old_row.todo_id::text;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO assignment FROM audit_events WHERE id=(event.after_state->>'handoverAuditId')::uuid
    AND action='digital_primary_merchandiser_assigned' AND entity_type='digital_access'
    AND entity_id=event.after_state->>'digitalOrderId' AND actor_id=event.actor_id AND request_id=event.request_id
    AND xmin::text=(txid_current()%4294967296)::text;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT o.* INTO mother FROM digital_production_orders o
    JOIN digital_production_child_links l USING(production_order_id)
    JOIN sourcing_cases s ON s.sourcing_case_id=l.child_id
    WHERE o.production_order_id::text=assignment.entity_id AND l.module='sourcing' AND l.child_id::text=old_row.entity_id
      AND to_jsonb(s)->>'workflow_generation'='digital_production_v1';
  IF NOT FOUND OR mother.primary_merchandiser_id IS DISTINCT FROM new_row.recipient_user_id
     OR assignment.before_state->>'primary_merchandiser_id' IS DISTINCT FROM old_row.recipient_user_id::text
     OR assignment.after_state->>'merchandiserId' IS DISTINCT FROM new_row.recipient_user_id::text
     OR (assignment.after_state->>'version')::integer IS DISTINCT FROM mother.version
     OR (assignment.before_state->>'version')::integer+1 IS DISTINCT FROM mother.version
     OR event.before_state->>'recipientUserId' IS DISTINCT FROM old_row.recipient_user_id::text
     OR event.before_state->>'status' IS DISTINCT FROM old_row.status
     OR event.after_state->>'recipientUserId' IS DISTINCT FROM new_row.recipient_user_id::text
     OR event.after_state->>'status' IS DISTINCT FROM new_row.status
     OR NOT todo_user_has_direct_role(new_row.recipient_user_id,old_row.required_role,old_row.required_capability)
     OR NOT ('root_superuser'=ANY(event.actor_roles)
        OR EXISTS(SELECT 1 FROM user_role_assignments a
          JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
          JOIN app_users u ON u.id=a.user_id AND u.enabled AND NOT u.manual_access_disabled
          JOIN identity_mappings i ON i.user_id=u.id AND i.active AND i.employed
          WHERE a.user_id=event.actor_id AND a.revoked_at IS NULL
            AND a.role_code IN ('owner_group','production_management') AND a.role_code=ANY(event.actor_roles)))
  THEN RETURN false; END IF;
  RETURN true;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_todos_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed_actions text[]; current_event operation_events%ROWTYPE;
BEGIN
  IF digital_merchandiser_todo_transfer(OLD,NEW) THEN
    PERFORM todo_context_event(ARRAY['todo.transfer']);
    NEW.version:=OLD.version+1;
    NEW.updated_at:=CURRENT_TIMESTAMP;
    RETURN NEW;
  END IF;
  IF NEW.todo_id<>OLD.todo_id OR NEW.todo_type<>OLD.todo_type OR NEW.category<>OLD.category
     OR NEW.source_event_id<>OLD.source_event_id OR NEW.source_action<>OLD.source_action
     OR NEW.entity_type<>OLD.entity_type OR NEW.entity_id<>OLD.entity_id
     OR NEW.dedupe_key<>OLD.dedupe_key OR NEW.created_operation_event_id<>OLD.created_operation_event_id
     OR NEW.created_request_id<>OLD.created_request_id THEN
    RAISE EXCEPTION 'todo source facts are immutable' USING ERRCODE='55000';
  END IF;
  IF (NEW.recipient_user_id<>OLD.recipient_user_id OR NEW.required_role IS DISTINCT FROM OLD.required_role
      OR NEW.required_capability IS DISTINCT FROM OLD.required_capability
      OR NEW.delegation_id IS DISTINCT FROM OLD.delegation_id
      OR NEW.delegation_scope_id IS DISTINCT FROM OLD.delegation_scope_id)
     AND NOT (OLD.status='blocked_recipient' AND NEW.status='pending') THEN
    RAISE EXCEPTION 'todo recipient can only change through a blocked routing transfer'
      USING ERRCODE='55000';
  END IF;
  IF NEW.route_descriptor<>OLD.route_descriptor OR NEW.policy_key IS DISTINCT FROM OLD.policy_key
     OR NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    RAISE EXCEPTION 'todo route and deadline facts are immutable after creation'
      USING ERRCODE='55000';
  END IF;
  allowed_actions := CASE
    WHEN OLD.status='pending' AND NEW.status='blocked_recipient' THEN ARRAY['todo.recipient_blocked']
    WHEN OLD.status IN ('pending','blocked_recipient') AND NEW.status='completed' THEN ARRAY['todo.complete']
    WHEN OLD.status IN ('pending','blocked_recipient') AND NEW.status='cancelled' THEN ARRAY['todo.cancel']
    WHEN OLD.status='blocked_recipient' AND NEW.status='pending' THEN ARRAY['todo.transfer']
    WHEN OLD.status=NEW.status AND NEW.status='pending'
      AND (NEW.reminder_count>OLD.reminder_count OR (NEW.escalated_at IS NOT NULL AND OLD.escalated_at IS NULL)) THEN ARRAY['todo.remind','todo.escalate']
    ELSE ARRAY[]::text[]
  END;
  IF coalesce(array_length(allowed_actions,1),0)=0 THEN
    RAISE EXCEPTION 'invalid todo state transition' USING ERRCODE='23514';
  END IF;
  current_event := todo_context_event(allowed_actions);
  IF NEW.status='completed'
     AND (NEW.completed_operation_event_id<>current_event.event_id OR NEW.completed_by<>current_event.actor_id) THEN
    RAISE EXCEPTION 'todo completion audit context mismatch' USING ERRCODE='55000';
  END IF;
  IF NEW.status='cancelled' AND NEW.cancelled_operation_event_id<>current_event.event_id THEN
    RAISE EXCEPTION 'todo cancellation audit context mismatch' USING ERRCODE='55000';
  END IF;
  IF OLD.status=NEW.status AND NEW.status='pending' THEN
    IF NEW.reminder_count>OLD.reminder_count AND current_event.action<>'todo.remind' THEN
      RAISE EXCEPTION 'todo reminder count requires todo.remind action' USING ERRCODE='55000';
    END IF;
    IF NEW.escalated_at IS NOT NULL AND OLD.escalated_at IS NULL AND current_event.action<>'todo.escalate' THEN
      RAISE EXCEPTION 'todo escalation requires todo.escalate action' USING ERRCODE='55000';
    END IF;
  END IF;
  IF OLD.status='blocked_recipient' AND NEW.status='pending' AND NOT EXISTS (
    SELECT 1 FROM todo_recipient_transfers transfer
    WHERE transfer.todo_id=NEW.todo_id
      AND transfer.from_recipient_user_id=OLD.recipient_user_id
      AND transfer.to_recipient_user_id=NEW.recipient_user_id
      AND transfer.required_role=NEW.required_role
      AND transfer.required_capability=NEW.required_capability
      AND transfer.delegation_id IS NOT DISTINCT FROM NEW.delegation_id
      AND transfer.delegation_scope_id=NEW.delegation_scope_id
      AND transfer.operation_event_id=nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid
  ) THEN
    RAISE EXCEPTION 'blocked todo requires an audited routing transfer' USING ERRCODE='55000';
  END IF;
  NEW.version := OLD.version+1;
  NEW.updated_at := CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION project_todo_external_lifecycle()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id uuid;
  audit_request_id text;
BEGIN
  IF OLD.recipient_user_id IS DISTINCT FROM NEW.recipient_user_id
     AND ((OLD.status='blocked_recipient' AND NEW.status='pending') OR digital_merchandiser_todo_transfer(OLD,NEW))
     AND EXISTS(
       SELECT 1 FROM dingtalk_todo_external_bindings binding
       WHERE binding.todo_id=OLD.todo_id
         AND binding.recipient_user_id=OLD.recipient_user_id
         AND binding.provider_state IN ('creating','active','unknown_response')
     ) THEN
    audit_event_id := nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid;
    audit_request_id := nullif(current_setting('dx_rework.todo_request_id',true),'');
    IF audit_event_id IS NULL OR audit_request_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM operation_events event
      WHERE event.event_id=audit_event_id AND event.request_id=audit_request_id
        AND event.action='todo.transfer'
        AND event.entity_type='rework_todo'
        AND event.entity_id=NEW.todo_id::text
    ) THEN
      RAISE EXCEPTION 'todo external transfer projection requires trusted audit context'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      OLD,'complete',OLD.recipient_user_id,audit_event_id,audit_request_id,
      'transfer-close:'||audit_event_id::text
    );
  END IF;

  IF OLD.status IN ('pending','blocked_recipient')
     AND NEW.status IN ('completed','cancelled')
     AND EXISTS(
       SELECT 1 FROM dingtalk_todo_external_bindings binding
       WHERE binding.todo_id=OLD.todo_id
         AND binding.recipient_user_id=OLD.recipient_user_id
         AND binding.provider_state IN ('creating','active','unknown_response')
     ) THEN
    audit_event_id := CASE NEW.status
      WHEN 'completed' THEN NEW.completed_operation_event_id
      ELSE NEW.cancelled_operation_event_id
    END;
    SELECT event.request_id INTO audit_request_id
    FROM operation_events event
    WHERE event.event_id=audit_event_id
      AND event.action=CASE NEW.status WHEN 'completed' THEN 'todo.complete' ELSE 'todo.cancel' END
      AND event.entity_type='rework_todo'
      AND event.entity_id=NEW.todo_id::text;
    IF audit_request_id IS NULL THEN
      RAISE EXCEPTION 'todo external terminal projection requires matching audit event'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      NEW,'complete',OLD.recipient_user_id,audit_event_id,audit_request_id,
      'terminal:'||NEW.status||':'||audit_event_id::text
    );
  END IF;

  IF OLD.escalated_at IS NULL AND NEW.escalated_at IS NOT NULL
     AND NEW.status='pending'
     AND EXISTS(
       SELECT 1 FROM dingtalk_todo_external_bindings binding
       WHERE binding.todo_id=NEW.todo_id
         AND binding.recipient_user_id=NEW.recipient_user_id
         AND binding.provider_state IN ('creating','active','unknown_response')
     ) THEN
    audit_event_id := nullif(current_setting('dx_rework.todo_event_id',true),'')::uuid;
    audit_request_id := nullif(current_setting('dx_rework.todo_request_id',true),'');
    IF audit_event_id IS NULL OR audit_request_id IS NULL OR NOT EXISTS(
      SELECT 1 FROM operation_events event
      WHERE event.event_id=audit_event_id AND event.request_id=audit_request_id
        AND event.action='todo.escalate'
        AND event.entity_type='rework_todo'
        AND event.entity_id=NEW.todo_id::text
    ) THEN
      RAISE EXCEPTION 'todo external escalation projection requires trusted audit context'
        USING ERRCODE='55000';
    END IF;
    PERFORM enqueue_todo_external_delivery(
      NEW,'escalation',NEW.recipient_user_id,audit_event_id,audit_request_id,
      'escalation:'||audit_event_id::text
    );
  END IF;
  RETURN NEW;
END;
$$;

-- Legacy sourcing keeps its original creator. Digital commands use only the canonical mother principal.
CREATE FUNCTION digital_sourcing_current_merchandiser(case_id uuid,historical_creator uuid)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN source.workflow_generation='digital_production_v1' THEN mother.primary_merchandiser_id ELSE historical_creator END
  FROM sourcing_cases source
  LEFT JOIN digital_production_child_links link ON link.module='sourcing' AND link.child_id=source.sourcing_case_id
  LEFT JOIN digital_production_orders mother ON mother.production_order_id=link.production_order_id
  WHERE source.sourcing_case_id=case_id;
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_case_correction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; e operation_events%ROWTYPE;
BEGIN
 SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
 SELECT * INTO e FROM operation_events WHERE event_id=NEW.operation_event_id;
 IF source.deleted_at IS NOT NULL OR sourcing_current_status(NEW.sourcing_case_id)<>'pending_merchandiser_correction'
 OR EXISTS(SELECT 1 FROM sourcing_approval_snapshots WHERE sourcing_case_id=NEW.sourcing_case_id)
 OR NEW.correction_version<>(SELECT count(*)+1 FROM sourcing_case_corrections WHERE sourcing_case_id=NEW.sourcing_case_id)
 OR NEW.order_quantity<>(SELECT sum((value->>'quantity')::integer) FROM jsonb_array_elements(NEW.lines))
 OR EXISTS(SELECT 1 FROM jsonb_array_elements(NEW.lines) line WHERE (line->>'quantity')::integer IS NULL OR (line->>'quantity')::integer<1 OR NULLIF(btrim(line->>'color'),'') IS NULL OR (NULLIF(btrim(line->>'styleNo'),'') IS NULL AND NULLIF(btrim(line->>'alternateStyleNo'),'') IS NULL))
 OR e.after_state->>'gender' IS DISTINCT FROM NEW.gender
 OR e.after_state->>'styleName' IS DISTINCT FROM NEW.style_name_snapshot
 OR e.after_state->'attachmentIds' IS DISTINCT FROM to_jsonb(NEW.attachment_ids)
 OR NOT EXISTS(SELECT 1 FROM sourcing_style_catalog WHERE style_id=NEW.style_id AND normalized_name=lower(btrim(NEW.style_name_snapshot)))
 OR e.actor_id IS DISTINCT FROM NEW.corrected_by
 OR NOT(e.actor_roles @> ARRAY['root_superuser']::text[] OR (e.actor_roles @> ARRAY['order_merchandiser']::text[] AND digital_sourcing_current_merchandiser(NEW.sourcing_case_id,source.created_by)=NEW.corrected_by))
 OR e.after_state->'lineItems' IS DISTINCT FROM NEW.lines
 OR e.after_state->>'deliveryDate' IS DISTINCT FROM NEW.delivery_date::text
 OR e.after_state->>'estimatedCutPieceSendDate' IS DISTINCT FROM NEW.estimated_cut_piece_send_date::text
 THEN RAISE EXCEPTION 'invalid sourcing correction fact' USING ERRCODE='55000'; END IF;
 PERFORM sourcing_require_operation_event(NEW.operation_event_id,NEW.request_id,NEW.corrected_by,
 'sourcing.case.correct','sourcing:inquiry:create',NEW.sourcing_case_id,NEW.reason);
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_sourcing_style_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; event operation_events%ROWTYPE; entry jsonb;
BEGIN
  SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF source.sourcing_case_id IS NULL OR source.deleted_at IS NOT NULL
    OR NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM sourcing_style_revisions WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR event.event_id IS NULL OR event.action<>'sourcing.styles.revise'
    OR event.entity_type<>'sourcing_case' OR event.entity_id<>NEW.sourcing_case_id::text
    OR event.actor_id<>NEW.changed_by OR event.request_id<>NEW.request_id
    OR event.after_state->'lines' IS DISTINCT FROM NEW.lines
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[]
      OR (event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record')
      OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=digital_sourcing_current_merchandiser(NEW.sourcing_case_id,source.created_by)
        AND event.authorization_capability='sourcing:inquiry:create')
      OR (source.workflow_generation='digital_production_v1' AND event.authorization_capability='digital_production:numbers:correct' AND EXISTS(
        SELECT 1 FROM digital_production_child_links l JOIN digital_production_orders o USING(production_order_id)
        WHERE l.module='sourcing' AND l.child_id=NEW.sourcing_case_id AND (
          event.actor_roles && ARRAY['owner_group','production_management']::text[]
          OR (event.actor_roles @> ARRAY['sample_designer']::text[] AND o.created_by=event.actor_id)
          OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND o.primary_merchandiser_id=event.actor_id)
        )
      )))
  THEN RAISE EXCEPTION 'style revision requires current version and authorized audit' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(NEW.lines)<>(SELECT count(*) FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(NEW.lines))<>jsonb_array_length(NEW.lines)
  THEN RAISE EXCEPTION 'style revision must cover exactly the existing lines' USING ERRCODE='55000'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(entry)<>'object' OR entry-ARRAY['position','styleNo','alternateStyleNo']<>'{}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM sourcing_case_lines WHERE sourcing_case_id=NEW.sourcing_case_id AND position=(entry->>'position')::integer)
      OR (nullif(btrim(entry->>'styleNo'),'') IS NULL AND nullif(btrim(entry->>'alternateStyleNo'),'') IS NULL)
      OR (entry->>'styleNo' IS NOT NULL AND length(btrim(entry->>'styleNo')) NOT BETWEEN 1 AND 100)
      OR (entry->>'alternateStyleNo' IS NOT NULL AND length(btrim(entry->>'alternateStyleNo')) NOT BETWEEN 1 AND 100)
    THEN RAISE EXCEPTION 'invalid style revision line' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN NEW;
END; $$;
