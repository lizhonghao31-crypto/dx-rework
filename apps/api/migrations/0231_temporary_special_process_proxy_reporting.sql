-- Main production hotfix after 0230. The digital release lane has a different
-- 0231 identity; reconcile both checksummed histories explicitly when syncing.
-- Existing assigned temporary members use their immutable task snapshot even
-- after their personnel record is deactivated. New assignments keep their
-- existing active-person eligibility guard.

CREATE FUNCTION rework_work_report_actor_authorized(
  reporting_actor uuid, reporting_capability text, target_task uuid
) RETURNS boolean LANGUAGE plpgsql STABLE AS $$
DECLARE
  execution_kind text;
  actor_roles text[];
BEGIN
  SELECT item.execution_kind INTO execution_kind
  FROM rework_work_tasks task
  JOIN rework_process_configuration_items item USING(configuration_item_id)
  JOIN rework_orders orders ON orders.rework_order_id=task.rework_order_id
  WHERE task.work_task_id=target_task AND task.status='active'
    AND orders.status='in_progress';

  IF execution_kind IS NULL
     OR NOT member_module_can_write(reporting_actor,'rework')
     OR NOT (
       (execution_kind='worker' AND reporting_capability IN ('work:report','work:report_for_worker'))
       OR (execution_kind='tail_inspection' AND reporting_capability IN ('tail_inspection:report','work:report_for_worker'))
     ) THEN
    RETURN false;
  END IF;
  IF access_is_root_actor(reporting_actor) THEN RETURN true; END IF;

  -- Revalidate current employee identity, direct role or effective global
  -- delegation. A historical audit event cannot retain revoked authority.
  actor_roles := access_authorized_actor_roles(reporting_actor,reporting_capability);
  IF reporting_capability='work:report_for_worker' THEN
    RETURN EXISTS (
      SELECT 1 FROM rework_work_task_members member
      WHERE member.work_task_id=target_task AND member.person_type_snapshot='temporary'
    );
  END IF;

  -- Ordinary employees report only their own assigned tasks. The retired
  -- standalone tail_inspector role does not regain execution authority.
  RETURN 'worker'=ANY(actor_roles) AND EXISTS (
    SELECT 1 FROM rework_work_task_members member
    JOIN business_people person USING(person_id)
    WHERE member.work_task_id=target_task AND person.app_user_id=reporting_actor
  );
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_work_report_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM rework_work_tasks task
    JOIN operation_events event
      ON event.event_id=nullif(current_setting('dx_rework.work_event_id',true),'')::uuid
    WHERE task.work_task_id=NEW.work_task_id
      AND task.rework_order_id=NEW.rework_order_id
      AND task.configuration_item_id=NEW.configuration_item_id
      AND event.request_id=nullif(current_setting('dx_rework.work_request_id',true),'')
      AND event.action='rework.work_report.submit'
      AND event.actor_id=NEW.submitted_by
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND rework_work_report_actor_authorized(event.actor_id,event.authorization_capability,task.work_task_id)
  ) THEN
    RAISE EXCEPTION 'work report requires current execution-kind authorization'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;
