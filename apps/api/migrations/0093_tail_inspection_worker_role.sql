-- Tail inspection remains a distinct execution kind, but it no longer needs a
-- dedicated business role. All active internal workers may be selected for the
-- tail-inspection task and continue to report only tasks assigned to themselves.

DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('worker','tail_inspection:report')
ON CONFLICT DO NOTHING;

CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

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
      FROM app_users app_user
      JOIN identity_mappings identity
        ON identity.user_id=app_user.id
       AND identity.provider='dingtalk'
       AND identity.active=true
       AND identity.employed=true
      JOIN access_security_policy policy
        ON policy.policy_key='primary'
       AND policy.dingtalk_corp_id=identity.corp_id
      JOIN user_role_assignments assignment
        ON assignment.user_id=app_user.id
       AND assignment.role_code IN ('worker','tail_inspector')
       AND assignment.revoked_at IS NULL
      JOIN business_roles role
        ON role.role_code=assignment.role_code
       AND role.enabled=true
      JOIN role_capabilities capability
        ON capability.role_code=assignment.role_code
       AND capability.capability='tail_inspection:report'
      WHERE app_user.id=person_record.app_user_id
        AND app_user.enabled=true
    ) THEN
      RAISE EXCEPTION 'tail inspection task member must be an active eligible worker'
        USING ERRCODE='42501';
    END IF;
  ELSIF person_record.person_type='internal' AND NOT EXISTS (
    SELECT 1
    FROM app_users app_user
    JOIN identity_mappings identity
      ON identity.user_id=app_user.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    JOIN user_role_assignments assignment
      ON assignment.user_id=app_user.id
     AND assignment.role_code='worker'
     AND assignment.revoked_at IS NULL
    JOIN business_roles role
      ON role.role_code=assignment.role_code
     AND role.enabled=true
    WHERE app_user.id=person_record.app_user_id
      AND app_user.enabled=true
  ) THEN
    RAISE EXCEPTION 'internal work task member is no longer an active eligible worker'
      USING ERRCODE='42501';
  END IF;

  RETURN NEW;
END
$$;
