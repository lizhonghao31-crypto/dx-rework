-- PR-12: wage reconciliation, adjustments, immutable month close.

DROP TRIGGER business_roles_no_insert ON business_roles;
DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;

INSERT INTO business_roles(role_code,display_name,description) VALUES
  ('administrative_clerk','行政文员','工资行政复核及调整审批'),
  ('wage_month_close_accountant','工资月结会计','工资月结锁定')
ON CONFLICT DO NOTHING;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('wage:view','工资查看','查看工资期间和明细'),
  ('wage:tail_review','工资初核','尾部工资初核'),
  ('wage:administrative_review','工资行政复核','行政工资复核'),
  ('wage:month_close','工资月结','锁定工资月份'),
  ('wage:adjustment_request','工资调整发起','发起工资调整'),
  ('wage:adjustment_approve','工资调整审批','审批工资调整'),
  ('wage:export','工资导出','导出工资工作簿')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('tail_supervisor','wage:view'),
  ('tail_supervisor','wage:tail_review'),
  ('tail_supervisor','wage:adjustment_request'),
  ('administrative_clerk','wage:view'),
  ('administrative_clerk','wage:administrative_review'),
  ('administrative_clerk','wage:adjustment_approve'),
  ('administrative_clerk','wage:export'),
  ('wage_month_close_accountant','wage:view'),
  ('wage_month_close_accountant','wage:month_close'),
  ('wage_month_close_accountant','wage:export'),
  ('owner_group','wage:view'),
  ('production_management','wage:view'),
  ('system_admin','wage:view'),
  ('finance_read','wage:view'),
  ('finance_read','wage:export')
ON CONFLICT DO NOTHING;

CREATE TRIGGER business_roles_no_insert
  BEFORE INSERT ON business_roles FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER capability_catalog_no_insert
  BEFORE INSERT ON capability_catalog FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert
  BEFORE INSERT ON role_capabilities FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE rework_wage_periods (
  period_id uuid PRIMARY KEY,
  period_month date NOT NULL UNIQUE
    CHECK(period_month=date_trunc('month',period_month)::date),
  timezone text NOT NULL DEFAULT 'Asia/Singapore'
    CHECK(timezone='Asia/Singapore'),
  status text NOT NULL CHECK(status IN (
    'pending_tail_review','pending_admin_review','ready_to_lock','locked'
  )),
  period_version integer NOT NULL DEFAULT 1 CHECK(period_version>0),
  source_item_count integer NOT NULL DEFAULT 0 CHECK(source_item_count>=0),
  person_count integer NOT NULL DEFAULT 0 CHECK(person_count>=0),
  original_total numeric(18,2) NOT NULL DEFAULT 0,
  adjustment_total numeric(18,2) NOT NULL DEFAULT 0,
  final_total numeric(18,2) NOT NULL DEFAULT 0,
  locked_by uuid REFERENCES app_users(id),
  locked_at timestamptz,
  lock_note text CHECK(lock_note IS NULL OR length(btrim(lock_note))<=500),
  created_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  created_request_id text NOT NULL,
  locked_operation_event_id uuid REFERENCES operation_events(event_id),
  locked_request_id text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(final_total=original_total+adjustment_total),
  CHECK(
    (status='locked')=(
      locked_by IS NOT NULL AND locked_at IS NOT NULL
      AND locked_operation_event_id IS NOT NULL AND locked_request_id IS NOT NULL
    )
  )
);

CREATE TABLE rework_wage_items (
  wage_item_id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id),
  order_review_id uuid NOT NULL REFERENCES rework_order_reviews(order_review_id),
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_item_id uuid NOT NULL
    REFERENCES rework_process_configuration_items(configuration_item_id),
  work_task_id uuid NOT NULL REFERENCES rework_work_tasks(work_task_id),
  work_report_id uuid NOT NULL REFERENCES rework_work_reports(work_report_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  person_name_snapshot text NOT NULL,
  person_type_snapshot text NOT NULL
    CHECK(person_type_snapshot IN ('internal','temporary')),
  rework_no_snapshot text NOT NULL,
  style_no_snapshot text NOT NULL,
  process_name_snapshot text NOT NULL,
  pricing_unit_snapshot text NOT NULL CHECK(pricing_unit_snapshot IN ('piece','hour')),
  unit_price_snapshot numeric(14,3) NOT NULL,
  actual_quantity_snapshot numeric(14,2) NOT NULL,
  assignment_mode text NOT NULL CHECK(assignment_mode IN ('individual','collective')),
  group_amount numeric(18,8) NOT NULL CHECK(group_amount>0),
  exact_person_share numeric(18,8) NOT NULL CHECK(exact_person_share>0),
  payable_amount numeric(18,2) NOT NULL CHECK(payable_amount>=0),
  fractional_remainder numeric(18,8) NOT NULL CHECK(fractional_remainder>=0),
  remainder_rank integer NOT NULL CHECK(remainder_rank>0),
  member_count integer NOT NULL CHECK(member_count>0),
  member_snapshot jsonb NOT NULL,
  source_report_snapshot jsonb NOT NULL,
  rounding_rule text NOT NULL DEFAULT 'largest_remainder_floor_cent_person_id',
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(work_report_id,person_id)
);
CREATE INDEX rework_wage_items_period_person_idx
  ON rework_wage_items(period_id,person_id,created_at);

CREATE TABLE rework_wage_review_actions (
  review_action_id uuid PRIMARY KEY,
  period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id),
  period_version_snapshot integer NOT NULL CHECK(period_version_snapshot>0),
  stage text NOT NULL CHECK(stage IN ('tail','administrative')),
  decision text NOT NULL CHECK(decision IN ('approved','returned')),
  reason text CHECK(reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500),
  acted_by uuid NOT NULL REFERENCES app_users(id),
  actor_role_snapshot text NOT NULL,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL,
  acted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (stage='tail' AND decision='approved'
      AND actor_role_snapshot='tail_supervisor' AND reason IS NULL)
    OR
    (stage='administrative' AND actor_role_snapshot='administrative_clerk'
      AND (decision='approved' OR (decision='returned' AND reason IS NOT NULL)))
  )
);
CREATE INDEX rework_wage_review_actions_period_idx
  ON rework_wage_review_actions(period_id,acted_at);

CREATE TABLE rework_wage_adjustments (
  adjustment_id uuid PRIMARY KEY,
  original_wage_item_id uuid NOT NULL REFERENCES rework_wage_items(wage_item_id),
  target_period_id uuid NOT NULL REFERENCES rework_wage_periods(period_id),
  target_period_version_snapshot integer NOT NULL CHECK(target_period_version_snapshot>0),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  adjustment_amount numeric(18,2) NOT NULL CHECK(adjustment_amount<>0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  attachment_ids uuid[] NOT NULL DEFAULT '{}'
    CHECK(array_position(attachment_ids,NULL) IS NULL),
  status text NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','approved','rejected')),
  requested_by uuid NOT NULL REFERENCES app_users(id),
  requested_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_by uuid REFERENCES app_users(id),
  decided_at timestamptz,
  decision_reason text CHECK(
    decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 500
  ),
  request_operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_operation_request_id text NOT NULL,
  decision_operation_event_id uuid REFERENCES operation_events(event_id),
  decision_operation_request_id text,
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  CHECK(requested_by IS DISTINCT FROM decided_by),
  CHECK(
    (status='pending')=(
      decided_by IS NULL AND decided_at IS NULL
      AND decision_operation_event_id IS NULL
      AND decision_operation_request_id IS NULL
    )
  ),
  CHECK(status<>'rejected' OR decision_reason IS NOT NULL)
);
CREATE INDEX rework_wage_adjustments_target_idx
  ON rework_wage_adjustments(target_period_id,person_id,status,requested_at);

CREATE TABLE rework_wage_month_closures (
  closure_id uuid PRIMARY KEY,
  period_id uuid NOT NULL UNIQUE REFERENCES rework_wage_periods(period_id),
  period_version_snapshot integer NOT NULL CHECK(period_version_snapshot>0),
  item_count integer NOT NULL CHECK(item_count>=0),
  person_count integer NOT NULL CHECK(person_count>=0),
  original_total numeric(18,2) NOT NULL,
  adjustment_total numeric(18,2) NOT NULL,
  final_total numeric(18,2) NOT NULL,
  locked_by uuid NOT NULL REFERENCES app_users(id),
  locked_at timestamptz NOT NULL,
  lock_note text CHECK(lock_note IS NULL OR length(btrim(lock_note))<=500),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  operation_request_id text NOT NULL,
  CHECK(final_total=original_total+adjustment_total)
);

CREATE TABLE rework_wage_month_close_lines (
  closure_line_id uuid PRIMARY KEY,
  closure_id uuid NOT NULL REFERENCES rework_wage_month_closures(closure_id),
  line_type text NOT NULL CHECK(line_type IN ('wage_item','adjustment')),
  wage_item_id uuid REFERENCES rework_wage_items(wage_item_id),
  adjustment_id uuid REFERENCES rework_wage_adjustments(adjustment_id),
  person_id uuid NOT NULL REFERENCES business_people(person_id),
  person_name_snapshot text NOT NULL,
  person_type_snapshot text NOT NULL,
  rework_no_snapshot text NOT NULL,
  style_no_snapshot text NOT NULL,
  process_name_snapshot text NOT NULL,
  quantity_snapshot numeric(14,2) NOT NULL,
  unit_snapshot text NOT NULL,
  unit_price_snapshot numeric(14,3) NOT NULL,
  assignment_mode text NOT NULL,
  member_snapshot jsonb NOT NULL,
  original_amount numeric(18,2) NOT NULL,
  adjustment_amount numeric(18,2) NOT NULL,
  final_amount numeric(18,2) NOT NULL,
  CHECK(final_amount=original_amount+adjustment_amount),
  CHECK(
    (line_type='wage_item' AND wage_item_id IS NOT NULL AND adjustment_id IS NULL)
    OR
    (line_type='adjustment' AND wage_item_id IS NULL AND adjustment_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX rework_wage_close_item_line_idx
  ON rework_wage_month_close_lines(closure_id,wage_item_id)
  WHERE wage_item_id IS NOT NULL;
CREATE UNIQUE INDEX rework_wage_close_adjustment_line_idx
  ON rework_wage_month_close_lines(closure_id,adjustment_id)
  WHERE adjustment_id IS NOT NULL;

CREATE OR REPLACE FUNCTION wage_has_direct_role(
  requested_actor_id uuid,
  required_role text,
  required_capability text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS(
    SELECT 1
    FROM user_role_assignments assignment
    JOIN business_roles role
      ON role.role_code=assignment.role_code AND role.enabled=true
    JOIN role_capabilities capability
      ON capability.role_code=assignment.role_code
    JOIN app_users target_user
      ON target_user.id=assignment.user_id AND target_user.enabled=true
    JOIN identity_mappings identity
      ON identity.user_id=target_user.id
     AND identity.provider='dingtalk'
     AND identity.active=true
     AND identity.employed=true
    JOIN access_security_policy policy
      ON policy.policy_key='primary'
     AND policy.dingtalk_corp_id=identity.corp_id
    WHERE assignment.user_id=requested_actor_id
      AND assignment.role_code=required_role
      AND assignment.revoked_at IS NULL
      AND capability.capability=required_capability
  );
$$;

CREATE OR REPLACE FUNCTION require_wage_event(
  expected_action text,
  expected_capability text,
  expected_role text,
  expected_entity_type text,
  expected_entity_id text,
  expected_actor uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.wage_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.wage_request_id',true),'');
  IF event_record.event_id IS NULL
     OR event_record.actor_id<>expected_actor
     OR event_record.action<>expected_action
     OR event_record.authorization_capability<>expected_capability
     OR event_record.entity_type<>expected_entity_type
     OR event_record.entity_id<>expected_entity_id
     OR NOT wage_has_direct_role(expected_actor,expected_role,expected_capability) THEN
    RAISE EXCEPTION 'wage write requires matching direct-role event'
      USING ERRCODE='42501';
  END IF;
  RETURN event_record;
END;
$$;

CREATE OR REPLACE FUNCTION require_wage_materialization_event(
  target_review_id uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
  target_order_id uuid;
BEGIN
  SELECT rework_order_id INTO target_order_id
  FROM rework_order_reviews
  WHERE order_review_id=target_review_id;
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=nullif(
      current_setting('dx_rework.whole_order_review_event_id',true),''
    )::uuid
    AND request_id=nullif(
      current_setting('dx_rework.whole_order_review_request_id',true),''
    );
  IF target_order_id IS NULL
     OR event_record.event_id IS NULL
     OR event_record.action<>'rework.whole_order.approve'
     OR event_record.authorization_capability<>'submission:audit'
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>target_order_id::text THEN
    RAISE EXCEPTION 'wage materialization requires whole-order review event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END;
$$;

CREATE OR REPLACE FUNCTION reject_wage_immutable_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'wage history is immutable' USING ERRCODE='55000';
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_period_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  event_record operation_events%ROWTYPE;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'')<>'materialize'
     OR NEW.status<>'pending_tail_review'
     OR NEW.period_version<>1
     OR NEW.source_item_count<>0
     OR NEW.person_count<>0
     OR NEW.original_total<>0
     OR NEW.adjustment_total<>0
     OR NEW.final_total<>0
     OR NEW.locked_by IS NOT NULL
     OR NEW.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'wage period must be created by materialization'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO event_record
  FROM operation_events
  WHERE event_id=NEW.created_operation_event_id
    AND request_id=NEW.created_request_id
    AND action='rework.whole_order.approve'
    AND authorization_capability='submission:audit';
  IF event_record.event_id IS NULL THEN
    RAISE EXCEPTION 'wage period creation lacks reviewed source event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_record record;
BEGIN
  IF nullif(current_setting('dx_rework.wage_system_action',true),'')<>'materialize'
     OR NOT EXISTS(
       SELECT 1 FROM operation_events event
       WHERE event.event_id=NEW.operation_event_id
         AND event.request_id=NEW.operation_request_id
         AND event.action='rework.whole_order.approve'
         AND event.authorization_capability='submission:audit'
     ) THEN
    RAISE EXCEPTION 'wage item must be materialized from reviewed work'
      USING ERRCODE='55000';
  END IF;
  SELECT
    report.rework_order_id,
    report.configuration_item_id,
    report.work_task_id,
    report.group_amount,
    share.amount,
    member.display_name_snapshot,
    member.person_type_snapshot,
    task.assignment_mode,
    item.process_name,
    item.pricing_unit,
    item.unit_price,
    target_order.rework_no,
    target_order.style_no
  INTO source_record
  FROM rework_work_reports report
  JOIN rework_work_report_member_shares share
    ON share.work_report_id=report.work_report_id
   AND share.person_id=NEW.person_id
  JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
  JOIN rework_work_task_members member
    ON member.work_task_id=task.work_task_id
   AND member.person_id=NEW.person_id
  JOIN rework_process_configuration_items item
    ON item.configuration_item_id=report.configuration_item_id
  JOIN rework_orders target_order
    ON target_order.rework_order_id=report.rework_order_id
  WHERE report.work_report_id=NEW.work_report_id
    AND report.status='submitted'
    AND NOT EXISTS(
      SELECT 1 FROM rework_work_report_rejections rejection
      WHERE rejection.work_report_id=report.work_report_id
    );
  IF source_record.rework_order_id IS NULL
     OR NEW.rework_order_id<>source_record.rework_order_id
     OR NEW.configuration_item_id<>source_record.configuration_item_id
     OR NEW.work_task_id<>source_record.work_task_id
     OR NEW.group_amount<>source_record.group_amount
     OR NEW.exact_person_share<>source_record.amount
     OR NEW.person_name_snapshot<>source_record.display_name_snapshot
     OR NEW.person_type_snapshot<>source_record.person_type_snapshot
     OR NEW.assignment_mode<>source_record.assignment_mode
     OR NEW.process_name_snapshot<>source_record.process_name
     OR NEW.pricing_unit_snapshot<>source_record.pricing_unit
     OR NEW.unit_price_snapshot<>source_record.unit_price
     OR NEW.rework_no_snapshot<>source_record.rework_no
     OR NEW.style_no_snapshot<>source_record.style_no THEN
    RAISE EXCEPTION 'wage item snapshot does not match reviewed source'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_review_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period_record rework_wage_periods%ROWTYPE;
  expected_action text;
  expected_role text;
  expected_capability text;
BEGIN
  SELECT * INTO period_record
  FROM rework_wage_periods
  WHERE period_id=NEW.period_id;
  IF NEW.period_version_snapshot<>period_record.period_version THEN
    RAISE EXCEPTION 'wage review version is stale' USING ERRCODE='40001';
  END IF;
  IF NEW.stage='tail' THEN
    expected_action:='wage.tail_approve';
    expected_role:='tail_supervisor';
    expected_capability:='wage:tail_review';
    IF period_record.status<>'pending_tail_review' THEN
      RAISE EXCEPTION 'tail review is not currently allowed' USING ERRCODE='23514';
    END IF;
  ELSE
    expected_action:=CASE NEW.decision
      WHEN 'approved' THEN 'wage.administrative_approve'
      ELSE 'wage.administrative_return'
    END;
    expected_role:='administrative_clerk';
    expected_capability:='wage:administrative_review';
    IF period_record.status<>'pending_admin_review' THEN
      RAISE EXCEPTION 'administrative review is not currently allowed'
        USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM require_wage_event(
    expected_action,expected_capability,expected_role,
    'wage_period',NEW.period_id::text,NEW.acted_by
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_adjustment_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  source_item rework_wage_items%ROWTYPE;
  target_period rework_wage_periods%ROWTYPE;
BEGIN
  PERFORM require_wage_event(
    'wage.adjustment.request','wage:adjustment_request','tail_supervisor',
    'wage_adjustment',NEW.adjustment_id::text,NEW.requested_by
  );
  SELECT * INTO source_item
  FROM rework_wage_items WHERE wage_item_id=NEW.original_wage_item_id;
  SELECT * INTO target_period
  FROM rework_wage_periods WHERE period_id=NEW.target_period_id;
  IF source_item.wage_item_id IS NULL
     OR target_period.period_id IS NULL
     OR target_period.status='locked'
     OR NEW.person_id<>source_item.person_id
     OR NEW.target_period_version_snapshot<>target_period.period_version
     OR (source_item.period_id=target_period.period_id AND target_period.status='locked')
     OR (
       source_item.period_id<>target_period.period_id
       AND (
         NOT EXISTS(
           SELECT 1 FROM rework_wage_periods source_period
           WHERE source_period.period_id=source_item.period_id
             AND source_period.status='locked'
             AND target_period.period_month>source_period.period_month
         )
       )
     ) THEN
    RAISE EXCEPTION 'invalid wage adjustment source or target period'
      USING ERRCODE='23514';
  END IF;
  IF cardinality(NEW.attachment_ids)<>cardinality(
       ARRAY(SELECT DISTINCT value FROM unnest(NEW.attachment_ids) value)
     ) OR EXISTS(
       SELECT 1 FROM unnest(NEW.attachment_ids) attachment_id
       LEFT JOIN attachments attachment
         ON attachment.attachment_id=attachment_id
       WHERE attachment.attachment_id IS NULL
          OR attachment.status<>'ready'
          OR attachment.uploaded_by<>NEW.requested_by
          OR attachment.entity_type IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'wage adjustment attachments must be ready and unbound'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_adjustment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expected_action text;
  period_status text;
  person_total numeric(18,2);
BEGIN
  IF NEW.adjustment_id IS DISTINCT FROM OLD.adjustment_id
     OR NEW.original_wage_item_id IS DISTINCT FROM OLD.original_wage_item_id
     OR NEW.target_period_id IS DISTINCT FROM OLD.target_period_id
     OR NEW.target_period_version_snapshot
        IS DISTINCT FROM OLD.target_period_version_snapshot
     OR NEW.person_id IS DISTINCT FROM OLD.person_id
     OR NEW.adjustment_amount IS DISTINCT FROM OLD.adjustment_amount
     OR NEW.reason IS DISTINCT FROM OLD.reason
     OR NEW.attachment_ids IS DISTINCT FROM OLD.attachment_ids
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.request_operation_event_id IS DISTINCT FROM OLD.request_operation_event_id
     OR NEW.request_operation_request_id
        IS DISTINCT FROM OLD.request_operation_request_id
     OR OLD.status<>'pending'
     OR NEW.status NOT IN ('approved','rejected')
     OR NEW.version<>OLD.version+1
     OR NEW.decided_by IS NULL
     OR NEW.decided_at IS NULL THEN
    RAISE EXCEPTION 'wage adjustment history is immutable except one decision'
      USING ERRCODE='55000';
  END IF;
  expected_action:=CASE NEW.status
    WHEN 'approved' THEN 'wage.adjustment.approve'
    ELSE 'wage.adjustment.reject'
  END;
  PERFORM require_wage_event(
    expected_action,'wage:adjustment_approve','administrative_clerk',
    'wage_adjustment',NEW.adjustment_id::text,NEW.decided_by
  );
  IF NEW.decided_by=OLD.requested_by THEN
    RAISE EXCEPTION 'adjustment requester cannot decide own request'
      USING ERRCODE='42501';
  END IF;
  SELECT status INTO period_status
  FROM rework_wage_periods WHERE period_id=NEW.target_period_id;
  IF period_status='locked' THEN
    RAISE EXCEPTION 'locked wage period cannot accept adjustment decision'
      USING ERRCODE='23514';
  END IF;
  IF NEW.status='approved' THEN
    SELECT
      COALESCE((
        SELECT sum(item.payable_amount)
        FROM rework_wage_items item
        WHERE item.period_id=NEW.target_period_id
          AND item.person_id=NEW.person_id
      ),0)
      + COALESCE((
        SELECT sum(adjustment.adjustment_amount)
        FROM rework_wage_adjustments adjustment
        WHERE adjustment.target_period_id=NEW.target_period_id
          AND adjustment.person_id=NEW.person_id
          AND adjustment.status='approved'
          AND adjustment.adjustment_id<>NEW.adjustment_id
      ),0)
      + NEW.adjustment_amount
    INTO person_total;
    IF person_total<0 THEN
      RAISE EXCEPTION 'approved adjustment would make wage negative'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_attachment_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_adjustment rework_wage_adjustments%ROWTYPE;
BEGIN
  IF OLD.entity_type='wage_adjustment'
     AND (OLD.entity_type,OLD.entity_id)
       IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id) THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound wage evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF (OLD.entity_type,OLD.entity_id)
       IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'wage_adjustment'
       AND NEW.entity_type IS DISTINCT FROM 'wage_adjustment') THEN
    RETURN NEW;
  END IF;
  IF NOT (
    OLD.entity_type IS NULL AND OLD.entity_id IS NULL
    AND NEW.entity_type='wage_adjustment' AND NEW.entity_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'wage evidence cannot be moved or unbound'
      USING ERRCODE='55000';
  END IF;
  SELECT * INTO target_adjustment
  FROM rework_wage_adjustments
  WHERE adjustment_id=NEW.entity_id::uuid;
  IF target_adjustment.adjustment_id IS NULL
     OR NEW.status<>'ready'
     OR NEW.uploaded_by<>target_adjustment.requested_by
     OR NEW.attachment_id<>ALL(target_adjustment.attachment_ids) THEN
    RAISE EXCEPTION 'attachment is not authorized for wage adjustment'
      USING ERRCODE='42501';
  END IF;
  PERFORM require_wage_event(
    'wage.adjustment.request','wage:adjustment_request','tail_supervisor',
    'wage_adjustment',NEW.entity_id,target_adjustment.requested_by
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_attachment_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS(SELECT 1 FROM attachments WHERE entity_type='wage_adjustment') THEN
      RAISE EXCEPTION 'bound wage evidence cannot be truncated' USING ERRCODE='55000';
    END IF;
    RETURN NULL;
  END IF;
  IF OLD.entity_type='wage_adjustment' THEN
    RAISE EXCEPTION 'bound wage evidence cannot be deleted' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_closure_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  period_record rework_wage_periods%ROWTYPE;
BEGIN
  SELECT * INTO period_record
  FROM rework_wage_periods WHERE period_id=NEW.period_id;
  PERFORM require_wage_event(
    'wage.month_close','wage:month_close','wage_month_close_accountant',
    'wage_period',NEW.period_id::text,NEW.locked_by
  );
  IF period_record.status<>'ready_to_lock'
     OR NEW.period_version_snapshot<>period_record.period_version
     OR NEW.item_count<>period_record.source_item_count
     OR NEW.person_count<>period_record.person_count
     OR NEW.original_total<>period_record.original_total
     OR NEW.adjustment_total<>period_record.adjustment_total
     OR NEW.final_total<>period_record.final_total
     OR NEW.locked_at<(
       period_record.period_month+interval '1 month'
     ) AT TIME ZONE 'Asia/Singapore' THEN
    RAISE EXCEPTION 'wage closure does not match ready period or month boundary'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_close_line_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  closure_record rework_wage_month_closures%ROWTYPE;
  source_item rework_wage_items%ROWTYPE;
  source_adjustment rework_wage_adjustments%ROWTYPE;
BEGIN
  SELECT * INTO closure_record
  FROM rework_wage_month_closures WHERE closure_id=NEW.closure_id;
  IF closure_record.closure_id IS NULL THEN
    RAISE EXCEPTION 'wage closure is missing' USING ERRCODE='23514';
  END IF;
  IF NEW.line_type='wage_item' THEN
    SELECT * INTO source_item
    FROM rework_wage_items WHERE wage_item_id=NEW.wage_item_id;
    IF source_item.wage_item_id IS NULL
       OR source_item.period_id<>closure_record.period_id
       OR NEW.person_id<>source_item.person_id
       OR NEW.original_amount<>source_item.payable_amount
       OR NEW.adjustment_amount<>0
       OR NEW.final_amount<>source_item.payable_amount THEN
      RAISE EXCEPTION 'wage closure item line does not match source'
        USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO source_adjustment
    FROM rework_wage_adjustments
    WHERE adjustment_id=NEW.adjustment_id AND status='approved';
    SELECT * INTO source_item
    FROM rework_wage_items
    WHERE wage_item_id=source_adjustment.original_wage_item_id;
    IF source_adjustment.adjustment_id IS NULL
       OR source_adjustment.target_period_id<>closure_record.period_id
       OR NEW.person_id<>source_adjustment.person_id
       OR NEW.original_amount<>0
       OR NEW.adjustment_amount<>source_adjustment.adjustment_amount
       OR NEW.final_amount<>source_adjustment.adjustment_amount THEN
      RAISE EXCEPTION 'wage closure adjustment line does not match source'
        USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION validate_wage_closure(target_closure_id uuid)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  closure_record rework_wage_month_closures%ROWTYPE;
  wage_count bigint;
  adjustment_count bigint;
  line_total numeric(18,2);
  minimum_person_total numeric(18,2);
BEGIN
  SELECT * INTO closure_record
  FROM rework_wage_month_closures WHERE closure_id=target_closure_id;
  IF closure_record.closure_id IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO wage_count FROM rework_wage_month_close_lines
    WHERE closure_id=target_closure_id AND line_type='wage_item';
  SELECT count(*) INTO adjustment_count FROM rework_wage_month_close_lines
    WHERE closure_id=target_closure_id AND line_type='adjustment';
  SELECT COALESCE(sum(final_amount),0) INTO line_total
    FROM rework_wage_month_close_lines WHERE closure_id=target_closure_id;
  SELECT min(person_total) INTO minimum_person_total FROM (
    SELECT person_id,sum(final_amount) person_total
    FROM rework_wage_month_close_lines
    WHERE closure_id=target_closure_id GROUP BY person_id
  ) totals;
  IF wage_count<>(SELECT count(*) FROM rework_wage_items
       WHERE period_id=closure_record.period_id)
     OR adjustment_count<>(SELECT count(*) FROM rework_wage_adjustments
       WHERE target_period_id=closure_record.period_id AND status='approved')
     OR line_total<>closure_record.final_total
     OR COALESCE(minimum_person_total,0)<0 THEN
    RAISE EXCEPTION 'wage closure lines are incomplete or inconsistent'
      USING ERRCODE='23514';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION validate_wage_closure_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM validate_wage_closure(NEW.closure_id);
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_wage_period_update()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  system_action text:=nullif(current_setting('dx_rework.wage_system_action',true),'');
  event_record operation_events%ROWTYPE;
  expected_item_count integer;
  expected_people integer;
  expected_original numeric(18,2);
  expected_adjustment numeric(18,2);
BEGIN
  IF NEW.period_id IS DISTINCT FROM OLD.period_id
     OR NEW.period_month IS DISTINCT FROM OLD.period_month
     OR NEW.timezone IS DISTINCT FROM OLD.timezone
     OR NEW.created_operation_event_id IS DISTINCT FROM OLD.created_operation_event_id
     OR NEW.created_request_id IS DISTINCT FROM OLD.created_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.period_version<>OLD.period_version+1 THEN
    RAISE EXCEPTION 'stable wage period facts are immutable' USING ERRCODE='55000';
  END IF;
  SELECT count(*)::integer,count(DISTINCT person_id)::integer,
         COALESCE(sum(payable_amount),0)
  INTO expected_item_count,expected_people,expected_original
  FROM rework_wage_items WHERE period_id=NEW.period_id;
  SELECT COALESCE(sum(adjustment_amount),0) INTO expected_adjustment
  FROM rework_wage_adjustments
  WHERE target_period_id=NEW.period_id AND status='approved';
  IF NEW.source_item_count<>expected_item_count
     OR NEW.person_count<>expected_people
     OR NEW.original_total<>expected_original
     OR NEW.adjustment_total<>expected_adjustment
     OR NEW.final_total<>expected_original+expected_adjustment THEN
    RAISE EXCEPTION 'wage period totals do not match immutable facts'
      USING ERRCODE='23514';
  END IF;
  IF system_action='materialize' THEN
    IF OLD.status='locked' OR NEW.status<>'pending_tail_review' THEN
      RAISE EXCEPTION 'invalid wage materialization update' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.wage_event_id',true),'')::uuid;
  IF event_record.action='wage.tail_approve' THEN
    PERFORM require_wage_event('wage.tail_approve','wage:tail_review',
      'tail_supervisor','wage_period',NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_tail_review' OR NEW.status<>'pending_admin_review' THEN
      RAISE EXCEPTION 'invalid tail review transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.administrative_approve' THEN
    PERFORM require_wage_event('wage.administrative_approve',
      'wage:administrative_review','administrative_clerk','wage_period',
      NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_admin_review' OR NEW.status<>'ready_to_lock' THEN
      RAISE EXCEPTION 'invalid administrative review transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.administrative_return' THEN
    PERFORM require_wage_event('wage.administrative_return',
      'wage:administrative_review','administrative_clerk','wage_period',
      NEW.period_id::text,event_record.actor_id);
    IF OLD.status<>'pending_admin_review' OR NEW.status<>'pending_tail_review' THEN
      RAISE EXCEPTION 'invalid administrative return transition' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.adjustment.approve' THEN
    PERFORM require_wage_event('wage.adjustment.approve','wage:adjustment_approve',
      'administrative_clerk','wage_adjustment',event_record.entity_id,
      event_record.actor_id);
    IF OLD.status='locked' OR NEW.status<>'pending_tail_review' THEN
      RAISE EXCEPTION 'approved adjustment must restart review' USING ERRCODE='23514';
    END IF;
  ELSIF event_record.action='wage.month_close' THEN
    PERFORM require_wage_event('wage.month_close','wage:month_close',
      'wage_month_close_accountant','wage_period',NEW.period_id::text,
      event_record.actor_id);
    IF OLD.status<>'ready_to_lock' OR NEW.status<>'locked'
       OR NEW.locked_by<>event_record.actor_id
       OR NEW.locked_operation_event_id<>event_record.event_id
       OR NOT EXISTS(SELECT 1 FROM rework_wage_month_closures closure
         WHERE closure.period_id=NEW.period_id
           AND closure.operation_event_id=event_record.event_id) THEN
      RAISE EXCEPTION 'invalid wage month-close transition' USING ERRCODE='23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'wage period update requires recognized action'
      USING ERRCODE='55000';
  END IF;
  IF event_record.action<>'wage.month_close'
     AND (NEW.locked_by,NEW.locked_at,NEW.lock_note,
          NEW.locked_operation_event_id,NEW.locked_request_id)
       IS DISTINCT FROM
         (OLD.locked_by,OLD.locked_at,OLD.lock_note,
          OLD.locked_operation_event_id,OLD.locked_request_id) THEN
    RAISE EXCEPTION 'lock facts may only change during month close'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER wage_periods_guard_insert BEFORE INSERT ON rework_wage_periods
  FOR EACH ROW EXECUTE FUNCTION guard_wage_period_insert();
CREATE TRIGGER wage_periods_guard_update BEFORE UPDATE ON rework_wage_periods
  FOR EACH ROW EXECUTE FUNCTION guard_wage_period_update();
CREATE TRIGGER wage_periods_no_delete BEFORE DELETE ON rework_wage_periods
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_periods_no_truncate BEFORE TRUNCATE ON rework_wage_periods
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_items_guard_insert BEFORE INSERT ON rework_wage_items
  FOR EACH ROW EXECUTE FUNCTION guard_wage_item_insert();
CREATE TRIGGER wage_items_no_update BEFORE UPDATE ON rework_wage_items
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_items_no_delete BEFORE DELETE ON rework_wage_items
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_items_no_truncate BEFORE TRUNCATE ON rework_wage_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_reviews_guard_insert BEFORE INSERT ON rework_wage_review_actions
  FOR EACH ROW EXECUTE FUNCTION guard_wage_review_insert();
CREATE TRIGGER wage_reviews_no_update BEFORE UPDATE ON rework_wage_review_actions
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_reviews_no_delete BEFORE DELETE ON rework_wage_review_actions
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_reviews_no_truncate BEFORE TRUNCATE ON rework_wage_review_actions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_adjustments_guard_insert BEFORE INSERT ON rework_wage_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_wage_adjustment_insert();
CREATE TRIGGER wage_adjustments_guard_update BEFORE UPDATE ON rework_wage_adjustments
  FOR EACH ROW EXECUTE FUNCTION guard_wage_adjustment_update();
CREATE TRIGGER wage_adjustments_no_delete BEFORE DELETE ON rework_wage_adjustments
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_adjustments_no_truncate BEFORE TRUNCATE ON rework_wage_adjustments
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER attachments_wage_binding_guard BEFORE UPDATE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_wage_attachment_update();
CREATE TRIGGER attachments_wage_no_delete BEFORE DELETE ON attachments
  FOR EACH ROW EXECUTE FUNCTION guard_wage_attachment_delete();
CREATE TRIGGER attachments_wage_no_truncate BEFORE TRUNCATE ON attachments
  FOR EACH STATEMENT EXECUTE FUNCTION guard_wage_attachment_delete();
CREATE TRIGGER wage_closures_guard_insert BEFORE INSERT ON rework_wage_month_closures
  FOR EACH ROW EXECUTE FUNCTION guard_wage_closure_insert();
CREATE TRIGGER wage_closures_no_update BEFORE UPDATE ON rework_wage_month_closures
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_closures_no_delete BEFORE DELETE ON rework_wage_month_closures
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_closures_no_truncate BEFORE TRUNCATE ON rework_wage_month_closures
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_lines_guard_insert BEFORE INSERT ON rework_wage_month_close_lines
  FOR EACH ROW EXECUTE FUNCTION guard_wage_close_line_insert();
CREATE TRIGGER wage_lines_no_update BEFORE UPDATE ON rework_wage_month_close_lines
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_lines_no_delete BEFORE DELETE ON rework_wage_month_close_lines
  FOR EACH ROW EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE TRIGGER wage_lines_no_truncate BEFORE TRUNCATE ON rework_wage_month_close_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_wage_immutable_mutation();
CREATE CONSTRAINT TRIGGER wage_closure_complete_on_closure
  AFTER INSERT ON rework_wage_month_closures DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_wage_closure_trigger();
CREATE CONSTRAINT TRIGGER wage_closure_complete_on_line
  AFTER INSERT ON rework_wage_month_close_lines DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_wage_closure_trigger();

CREATE OR REPLACE FUNCTION materialize_rework_wages_from_order_review(
  p_order_review_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  review_record rework_order_reviews%ROWTYPE;
  target_period_id uuid;
  report_record record;
  inserted_count integer:=0;
  affected_count integer:=0;
  allocated_total numeric(18,2);
  source_event operation_events%ROWTYPE;
BEGIN
  SELECT * INTO STRICT review_record
  FROM rework_order_reviews WHERE order_review_id=p_order_review_id;
  source_event:=require_wage_materialization_event(p_order_review_id);
  PERFORM set_config('dx_rework.wage_system_action','materialize',true);
  INSERT INTO rework_wage_periods(
    period_id,period_month,status,created_operation_event_id,created_request_id
  ) VALUES(
    gen_random_uuid(),
    date_trunc('month',review_record.reviewed_at AT TIME ZONE 'Asia/Singapore')::date,
    'pending_tail_review',source_event.event_id,source_event.request_id
  ) ON CONFLICT(period_month) DO NOTHING;
  SELECT period_id INTO target_period_id
  FROM rework_wage_periods
  WHERE period_month=date_trunc(
    'month',review_record.reviewed_at AT TIME ZONE 'Asia/Singapore'
  )::date FOR UPDATE;
  IF (SELECT status FROM rework_wage_periods WHERE period_id=target_period_id)='locked' THEN
    RAISE EXCEPTION 'cannot add wage source to locked period' USING ERRCODE='23514';
  END IF;
  FOR report_record IN
    SELECT report.work_report_id
    FROM rework_work_reports report
    WHERE report.rework_order_id=review_record.rework_order_id
      AND report.status='submitted'
      AND NOT EXISTS(SELECT 1 FROM rework_work_report_rejections rejection
        WHERE rejection.work_report_id=report.work_report_id)
  LOOP
    WITH shares AS (
      SELECT
        share.person_id,share.amount,
        member.display_name_snapshot,member.person_type_snapshot,
        row_number() OVER(ORDER BY
          (share.amount-trunc(share.amount,2)) DESC,share.person_id
        )::integer remainder_rank,
        count(*) OVER()::integer member_count,
        jsonb_agg(jsonb_build_object(
          'personId',share.person_id,
          'displayName',member.display_name_snapshot,
          'personType',member.person_type_snapshot
        ) ORDER BY share.person_id) OVER() member_snapshot,
        round(report.group_amount,2)-sum(trunc(share.amount,2)) OVER() cents_left,
        report.*,task.assignment_mode,item.process_name,item.pricing_unit,
        item.unit_price,target_order.rework_no,target_order.style_no
      FROM rework_work_report_member_shares share
      JOIN rework_work_reports report ON report.work_report_id=share.work_report_id
      JOIN rework_work_tasks task ON task.work_task_id=report.work_task_id
      JOIN rework_work_task_members member
        ON member.work_task_id=task.work_task_id AND member.person_id=share.person_id
      JOIN rework_process_configuration_items item
        ON item.configuration_item_id=report.configuration_item_id
      JOIN rework_orders target_order
        ON target_order.rework_order_id=report.rework_order_id
      WHERE share.work_report_id=report_record.work_report_id
    )
    INSERT INTO rework_wage_items(
      wage_item_id,period_id,order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      person_name_snapshot,person_type_snapshot,rework_no_snapshot,
      style_no_snapshot,process_name_snapshot,pricing_unit_snapshot,
      unit_price_snapshot,actual_quantity_snapshot,assignment_mode,
      group_amount,exact_person_share,payable_amount,fractional_remainder,
      remainder_rank,member_count,member_snapshot,source_report_snapshot,
      operation_event_id,operation_request_id
    )
    SELECT
      gen_random_uuid(),target_period_id,p_order_review_id,rework_order_id,
      configuration_item_id,work_task_id,work_report_id,person_id,
      display_name_snapshot,person_type_snapshot,rework_no,style_no,
      process_name,pricing_unit,unit_price,actual_quantity,assignment_mode,
      group_amount,amount,
      trunc(amount,2)+CASE WHEN remainder_rank<=round(cents_left*100)::integer
        THEN 0.01 ELSE 0 END,
      amount-trunc(amount,2),remainder_rank,member_count,member_snapshot,
      jsonb_build_object(
        'workReportId',work_report_id,'workTaskId',work_task_id,
        'configurationItemId',configuration_item_id,
        'actualQuantity',actual_quantity,'completedAt',completed_at,
        'submittedBy',submitted_by,'groupAmount',group_amount
      ),source_event.event_id,source_event.request_id
    FROM shares
    ON CONFLICT(work_report_id,person_id) DO NOTHING;
    GET DIAGNOSTICS affected_count=ROW_COUNT;
    inserted_count:=inserted_count+affected_count;
    SELECT sum(payable_amount) INTO allocated_total
    FROM rework_wage_items WHERE work_report_id=report_record.work_report_id;
    IF allocated_total<>(SELECT round(group_amount,2)
      FROM rework_work_reports WHERE work_report_id=report_record.work_report_id) THEN
      RAISE EXCEPTION 'wage allocation does not equal rounded group amount'
        USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF inserted_count>0 THEN
    UPDATE rework_wage_periods SET
      source_item_count=(SELECT count(*) FROM rework_wage_items
        WHERE period_id=target_period_id),
      person_count=(SELECT count(DISTINCT person_id) FROM rework_wage_items
        WHERE period_id=target_period_id),
      original_total=(SELECT COALESCE(sum(payable_amount),0)
        FROM rework_wage_items WHERE period_id=target_period_id),
      adjustment_total=(SELECT COALESCE(sum(adjustment_amount),0)
        FROM rework_wage_adjustments
        WHERE target_period_id=target_period_id AND status='approved'),
      final_total=(SELECT COALESCE(sum(payable_amount),0)
        FROM rework_wage_items WHERE period_id=target_period_id)
        +(SELECT COALESCE(sum(adjustment_amount),0)
          FROM rework_wage_adjustments
          WHERE target_period_id=target_period_id AND status='approved'),
      status='pending_tail_review',period_version=period_version+1,
      updated_at=CURRENT_TIMESTAMP
    WHERE period_id=target_period_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION trigger_materialize_rework_wages()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM materialize_rework_wages_from_order_review(NEW.order_review_id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_order_reviews_materialize_wages
  AFTER INSERT ON rework_order_reviews FOR EACH ROW
  EXECUTE FUNCTION trigger_materialize_rework_wages();
