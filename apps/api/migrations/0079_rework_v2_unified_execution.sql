-- PR-04: unify normal rework execution and tail inspection on the existing
-- work-task/work-report fact chain. Old orders are not kept operational.

ALTER TABLE rework_process_configurations
  ADD COLUMN unified_execution_required boolean NOT NULL DEFAULT true;

ALTER TABLE rework_process_configuration_items
  ADD COLUMN execution_kind text NOT NULL DEFAULT 'worker'
  CHECK (execution_kind IN ('worker','tail_inspection'));
CREATE UNIQUE INDEX rework_process_configuration_one_tail_execution_idx
  ON rework_process_configuration_items(configuration_id)
  WHERE execution_kind='tail_inspection';

-- The execution-model flags belong to the immutable configuration version.
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
       OR NEW.worker_preassignment_required IS DISTINCT FROM OLD.worker_preassignment_required
       OR NEW.unified_execution_required IS DISTINCT FROM OLD.unified_execution_required
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

-- Tail inspectors need a business-person identity only so the common task/member
-- tables can reference them. This does not grant the worker role.
CREATE OR REPLACE FUNCTION tail_inspector_business_person_id(app_user uuid)
RETURNS uuid
LANGUAGE sql
IMMUTABLE
STRICT
PARALLEL SAFE
AS $$
  SELECT md5('dx-rework:tail-inspector-person:' || app_user::text)::uuid
$$;

DROP TRIGGER business_people_guard_creation ON business_people;
DO $$
DECLARE
  root_id uuid;
  root_roles text[];
  row_record record;
  person_id uuid;
  event_id uuid;
  request_id text := 'migration-0079-tail-inspector-backfill';
  reason_text text := '0079 自动补齐既有尾查作业人员档案';
BEGIN
  SELECT root.user_id
  INTO root_id
  FROM owner_bootstrap_consumptions root
  WHERE root.singleton=true
  LIMIT 1;

  IF root_id IS NULL OR NOT access_is_root_actor(root_id) THEN
    RETURN;
  END IF;

  root_roles := access_authorized_actor_roles(root_id, 'master_data:manage');

  FOR row_record IN
    SELECT DISTINCT u.id user_id,u.display_name
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code
     AND capability.capability='tail_inspection:report'
    JOIN app_users u
      ON u.id=assignment.user_id AND u.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=u.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.role_code='tail_inspector'
      AND assignment.revoked_at IS NULL
      AND NOT EXISTS (
        SELECT 1 FROM business_people person
        WHERE person.app_user_id=u.id
      )
    ORDER BY u.id
  LOOP
    person_id := tail_inspector_business_person_id(row_record.user_id);
    event_id := md5(
      'dx-rework:tail-inspector-person-backfill-event:' || row_record.user_id::text
    )::uuid;

    INSERT INTO operation_events(
      event_id,request_id,actor_id,actor_roles,authorization_capability,
      action,entity_type,entity_id,after_state,reason
    ) VALUES (
      event_id,request_id,root_id,root_roles,'master_data:manage',
      'master_data.person.create','business_person',person_id::text,
      jsonb_build_object(
        'personType','internal',
        'appUserId',row_record.user_id,
        'displayName',row_record.display_name,
        'active',true,
        'aliases','[]'::jsonb
      ),
      reason_text
    );

    INSERT INTO business_people(
      person_id,person_type,app_user_id,display_name,created_by
    ) VALUES (
      person_id,'internal',row_record.user_id,row_record.display_name,root_id
    );
  END LOOP;
END
$$;
CREATE TRIGGER business_people_guard_creation
  BEFORE INSERT ON business_people
  FOR EACH ROW
  EXECUTE FUNCTION guard_business_person_creation();

-- Keep task-member eligibility tied to the real role for each execution kind.
CREATE OR REPLACE FUNCTION guard_work_task_member_employee_eligibility()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  person_record business_people%ROWTYPE;
  task_execution_kind text;
BEGIN
  SELECT * INTO person_record
  FROM business_people
  WHERE person_id=NEW.person_id;

  IF person_record.person_id IS NULL OR person_record.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'work task member must reference an active business person'
      USING ERRCODE='42501';
  END IF;

  SELECT item.execution_kind
  INTO task_execution_kind
  FROM rework_work_tasks task
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=task.configuration_item_id
  WHERE task.work_task_id=NEW.work_task_id;

  IF task_execution_kind IS NULL THEN
    RAISE EXCEPTION 'work task execution kind is missing'
      USING ERRCODE='42501';
  END IF;

  IF task_execution_kind='tail_inspection' THEN
    IF person_record.person_type<>'internal' OR NOT EXISTS (
      SELECT 1
      FROM app_users u
      JOIN identity_mappings identity
        ON identity.user_id=u.id
       AND identity.provider='dingtalk'
       AND identity.active=true
       AND identity.employed=true
      JOIN access_security_policy policy
        ON policy.policy_key='primary'
       AND policy.dingtalk_corp_id=identity.corp_id
      JOIN user_role_assignments assignment
        ON assignment.user_id=u.id
       AND assignment.role_code='tail_inspector'
       AND assignment.revoked_at IS NULL
      JOIN business_roles role
        ON role.role_code=assignment.role_code
       AND role.enabled=true
      JOIN role_capabilities capability
        ON capability.role_code=assignment.role_code
       AND capability.capability='tail_inspection:report'
      WHERE u.id=person_record.app_user_id
        AND u.enabled=true
    ) THEN
      RAISE EXCEPTION 'tail inspection task member must be an active eligible tail inspector'
        USING ERRCODE='42501';
    END IF;
  ELSIF person_record.person_type='internal' AND NOT EXISTS (
    SELECT 1
    FROM app_users u
    JOIN identity_mappings identity
      ON identity.user_id=u.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    JOIN user_role_assignments assignment
      ON assignment.user_id=u.id
     AND assignment.role_code='worker'
     AND assignment.revoked_at IS NULL
    JOIN business_roles role
      ON role.role_code=assignment.role_code
     AND role.enabled=true
    WHERE u.id=person_record.app_user_id
      AND u.enabled=true
  ) THEN
    RAISE EXCEPTION 'internal work task member is no longer an active eligible worker'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$$;

-- A unified tail task still writes the normal work-report tables, but its audit
-- event must carry the tail-inspector capability rather than pretending to be a worker.
CREATE OR REPLACE FUNCTION guard_rework_work_report_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_execution_kind text;
BEGIN
  SELECT item.execution_kind
  INTO task_execution_kind
  FROM rework_work_tasks task
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=task.configuration_item_id
  WHERE task.work_task_id=NEW.work_task_id
    AND task.rework_order_id=NEW.rework_order_id
    AND task.configuration_item_id=NEW.configuration_item_id;

  IF task_execution_kind IS NULL OR NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=nullif(current_setting('dx_rework.work_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.work_request_id',true),'')
      AND event.action='rework.work_report.submit'
      AND event.authorization_capability=(
        CASE task_execution_kind
          WHEN 'tail_inspection' THEN 'tail_inspection:report'
          ELSE event.authorization_capability
        END
      )
      AND (
        task_execution_kind='tail_inspection'
        OR event.authorization_capability IN ('work:report','work:report_for_worker')
      )
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'work report requires execution-kind authorization'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_share_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  task_execution_kind text;
BEGIN
  SELECT item.execution_kind
  INTO task_execution_kind
  FROM rework_work_reports report
  JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=task.configuration_item_id
  WHERE report.work_report_id=NEW.work_report_id;

  IF task_execution_kind IS NULL OR NOT EXISTS (
    SELECT 1
    FROM rework_work_reports report
    JOIN operation_events event ON event.entity_id=report.rework_order_id::text
    WHERE report.work_report_id=NEW.work_report_id
      AND event.event_id=nullif(current_setting('dx_rework.work_event_id',true),'')::uuid
      AND event.request_id=nullif(current_setting('dx_rework.work_request_id',true),'')
      AND event.action='rework.work_report.submit'
      AND (
        (task_execution_kind='tail_inspection' AND event.authorization_capability='tail_inspection:report')
        OR (task_execution_kind='worker' AND event.authorization_capability IN ('work:report','work:report_for_worker'))
      )
  ) THEN
    RAISE EXCEPTION 'work report share requires execution-kind authorization'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

-- N05 consumes one execution fact model for new configurations. Legacy orders
-- continue to reconcile the historical tail-inspection tables.
CREATE OR REPLACE FUNCTION guard_rework_order_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  unified_execution boolean;
BEGIN
  IF NOT EXISTS(
    SELECT 1 FROM rework_orders target
    WHERE target.rework_order_id=NEW.rework_order_id AND target.status='pending_order_review'
  ) THEN RAISE EXCEPTION 'order is not pending whole-order confirmation' USING ERRCODE='23514'; END IF;

  SELECT configuration.unified_execution_required
  INTO unified_execution
  FROM rework_process_configurations configuration
  WHERE configuration.rework_order_id=NEW.rework_order_id
    AND configuration.status='approved'
  LIMIT 1;

  IF unified_execution IS NULL OR EXISTS(
    SELECT 1 FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item USING(configuration_id)
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved' AND item.unit_price IS NULL
  ) THEN RAISE EXCEPTION 'every IE-approved process requires a price' USING ERRCODE='23514'; END IF;

  IF unified_execution AND (
    (SELECT count(*) FROM rework_process_configurations configuration
      JOIN rework_process_configuration_items item USING(configuration_id)
      WHERE configuration.rework_order_id=NEW.rework_order_id
        AND configuration.status='approved'
        AND item.execution_kind='tail_inspection') <> 1
  ) THEN RAISE EXCEPTION 'unified execution requires exactly one tail-inspection process' USING ERRCODE='23514'; END IF;

  IF NOT EXISTS(
    SELECT 1 FROM rework_tail_completion_confirmations confirmation
    WHERE confirmation.rework_order_id=NEW.rework_order_id
      AND confirmation.confirmed_by=NEW.reviewed_by
      AND confirmation.operation_event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND confirmation.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
  ) THEN RAISE EXCEPTION 'whole-order completion confirmation is required' USING ERRCODE='23514'; END IF;

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
  ) THEN RAISE EXCEPTION 'every active execution task requires a valid report' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1 FROM rework_tail_inspection_assignments assignment
    WHERE assignment.rework_order_id=NEW.rework_order_id AND assignment.revoked_at IS NULL
      AND NOT EXISTS(
        SELECT 1 FROM rework_tail_inspection_reports report
        WHERE report.tail_inspection_assignment_id=assignment.tail_inspection_assignment_id
          AND report.status='submitted'
      )
  ) THEN RAISE EXCEPTION 'every active legacy tail inspector requires a submitted count' USING ERRCODE='23514'; END IF;

  IF unified_execution AND EXISTS(
    WITH tail_total AS (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      JOIN rework_process_configuration_items item
        ON item.configuration_item_id=report.configuration_item_id
      WHERE report.rework_order_id=NEW.rework_order_id
        AND item.execution_kind='tail_inspection'
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    )
    SELECT 1
    FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    CROSS JOIN tail_total
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    ) worker ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved'
      AND item.execution_kind='worker'
      AND worker.quantity>tail_total.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed unified tail-inspection count' USING ERRCODE='23514'; END IF;

  IF NOT unified_execution AND EXISTS(
    SELECT 1
    FROM rework_process_configurations configuration
    JOIN rework_process_configuration_items item ON item.configuration_id=configuration.configuration_id
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report.actual_quantity),0) AS quantity
      FROM rework_work_reports report
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report.configuration_item_id=item.configuration_item_id
        AND report.status='submitted'
        AND NOT EXISTS(
          SELECT 1 FROM rework_work_report_rejections rejection
          WHERE rejection.work_report_id=report.work_report_id
        )
    ) worker ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(sum(report_item.inspected_quantity),0) AS quantity
      FROM rework_tail_inspection_report_items report_item
      JOIN rework_tail_inspection_reports report
        ON report.tail_inspection_report_id=report_item.tail_inspection_report_id
       AND report.status='submitted'
      JOIN rework_tail_inspection_assignments assignment
        ON assignment.tail_inspection_assignment_id=report.tail_inspection_assignment_id
       AND assignment.revoked_at IS NULL
      WHERE report.rework_order_id=NEW.rework_order_id
        AND report_item.configuration_item_id=item.configuration_item_id
    ) tail_checked ON true
    WHERE configuration.rework_order_id=NEW.rework_order_id
      AND configuration.status='approved'
      AND worker.quantity>tail_checked.quantity
  ) THEN RAISE EXCEPTION 'worker count cannot exceed legacy tail inspection count' USING ERRCODE='23514'; END IF;

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
END;
$$;

-- The final order-state guard already permits historical tail submissions as an
-- alternative transition. Extend the unified work-report path with the real tail
-- capability while preserving every other state transition exactly.
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
      ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action:='rework.work_report.submit'; expected_capability:='work:report'; alternative_action:='rework.tail_inspection.submit'; alternative_capability:='tail_inspection:report';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.quantity.increase.request'; alternative_capability:='quantity:adjust'; alternative_action_two:='rework.quantity.increase.confirm'; alternative_capability_two:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN expected_action:='rework.work_report.reject'; expected_capability:='submission:audit'; alternative_action:='rework.quantity.increase.confirm'; alternative_capability:='quantity:confirm';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action:='rework.quantity.increase.confirm'; expected_capability:='quantity:confirm';
      ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN expected_action:='rework.quantity.increase.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.whole_order.approve'; expected_capability:='submission:audit';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision'; ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine'; ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision'; ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate'; ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF; audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker','tail_inspection:report')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
