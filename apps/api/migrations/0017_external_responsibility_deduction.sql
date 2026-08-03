-- PR-11: N08-B external responsibility sign-off and N10-B deduction follow-up.
-- This is deliberately a forward-only ledger.  It binds only to the current,
-- finalized PR-09 snapshot and never re-calculates responsibility amounts.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
DROP TRIGGER business_roles_no_insert ON business_roles;

INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('external_responsibility:view','查看外部责任台账','查看已授权外部责任、拟扣和扣款事实'),
  ('external_responsibility:sign','外部责任业务签收','选择供应商并提交外部责任拟扣签收'),
  ('external_responsibility:payables_confirm','外部责任应付确认','接受或退回应付扣款事项'),
  ('external_deduction:follow_up','外部扣款跟进','追加扣款跟进事实'),
  ('external_deduction:record','记录实际扣款','追加实际扣款、调整或冲销流水'),
  ('external_deduction:close','关闭外部扣款','以全额、部分或未扣结果关闭台账'),
  ('external_responsibility:request_revision','申请外部责任变更','申请责任、倍率、金额或差额处理变更'),
  ('external_responsibility:approve_revision','审核外部责任变更','生产管理审核外部责任变更申请')
ON CONFLICT DO NOTHING;

INSERT INTO business_roles(role_code,display_name,description) VALUES
  ('embroidery_washing_merchandiser','印绣花/洗水跟单','处理印绣花及洗水外部责任签收和跟进')
ON CONFLICT DO NOTHING;

INSERT INTO role_capabilities(role_code,capability) VALUES
  ('order_merchandiser','external_responsibility:view'),
  ('order_merchandiser','external_responsibility:sign'),
  ('order_merchandiser','external_deduction:follow_up'),
  ('order_merchandiser','external_responsibility:request_revision'),
  ('embroidery_washing_merchandiser','external_responsibility:view'),
  ('embroidery_washing_merchandiser','external_responsibility:sign'),
  ('embroidery_washing_merchandiser','external_deduction:follow_up'),
  ('embroidery_washing_merchandiser','external_responsibility:request_revision'),
  ('factory_payables','external_responsibility:view'),
  ('factory_payables','external_responsibility:payables_confirm'),
  ('factory_payables','external_deduction:follow_up'),
  ('factory_payables','external_deduction:record'),
  ('factory_payables','external_deduction:close'),
  ('fabric_payables','external_responsibility:view'),
  ('fabric_payables','external_responsibility:payables_confirm'),
  ('fabric_payables','external_deduction:follow_up'),
  ('fabric_payables','external_deduction:record'),
  ('fabric_payables','external_deduction:close'),
  ('embroidery_washing_payables','external_responsibility:view'),
  ('embroidery_washing_payables','external_responsibility:payables_confirm'),
  ('embroidery_washing_payables','external_deduction:follow_up'),
  ('embroidery_washing_payables','external_deduction:record'),
  ('embroidery_washing_payables','external_deduction:close'),
  ('production_management','external_responsibility:view'),
  ('production_management','external_responsibility:approve_revision'),
  ('owner_group','external_responsibility:view'),
  ('owner_group','external_responsibility:approve_revision'),
  ('tail_supervisor','external_responsibility:view'),
  ('finance_read','external_responsibility:view')
ON CONFLICT DO NOTHING;

CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER business_roles_no_insert BEFORE INSERT ON business_roles
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- PR-11 delegation is exceptional and narrow: no global stand-in for a
-- merchandiser or payables accountant, and no delegation of revision approval.
CREATE OR REPLACE FUNCTION guard_external_responsibility_delegation_scope()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.capability IN (
    'external_responsibility:sign','external_responsibility:payables_confirm',
    'external_deduction:follow_up','external_deduction:record','external_deduction:close',
    'external_responsibility:request_revision'
  ) AND (NEW.scope_type <> 'rework_order' OR NEW.scope_id IS NULL) THEN
    RAISE EXCEPTION 'external responsibility delegation requires rework-order scope'
      USING ERRCODE='23514';
  ELSIF NEW.capability='external_responsibility:approve_revision' THEN
    RAISE EXCEPTION 'external responsibility revision approval cannot be delegated'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER delegated_authorizations_external_responsibility_scope
  BEFORE INSERT ON delegated_authorizations
  FOR EACH ROW EXECUTE FUNCTION guard_external_responsibility_delegation_scope();

CREATE OR REPLACE FUNCTION external_responsibility_direct_role(
  candidate uuid, required_capability text, allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT responsibility_actor_has_direct_role(candidate,required_capability,allowed_roles)
$$;

CREATE OR REPLACE FUNCTION external_responsibility_active_delegation(
  candidate uuid, required_capability text, order_id uuid, allowed_roles text[]
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT responsibility_actor_is_active(candidate) AND EXISTS (
    SELECT 1 FROM delegated_authorizations delegation
    WHERE delegation.grantee_user_id=candidate
      AND delegation.capability=required_capability
      AND delegation.scope_type='rework_order'
      AND delegation.scope_id=order_id::text
      AND delegation.revoked_at IS NULL
      AND CURRENT_TIMESTAMP BETWEEN delegation.valid_from AND delegation.valid_until
      AND external_responsibility_direct_role(
        delegation.grantor_user_id,required_capability,allowed_roles
      )
  )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view(candidate uuid, order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_direct_role(
    candidate,'external_responsibility:view',
    ARRAY['order_merchandiser','embroidery_washing_merchandiser','factory_payables',
      'fabric_payables','embroidery_washing_payables','production_management',
      'owner_group','tail_supervisor','finance_read']
  )
  OR external_responsibility_active_delegation(
    candidate,'external_responsibility:sign',order_id,
    ARRAY['order_merchandiser','embroidery_washing_merchandiser']
  )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_sign(
  candidate uuid, order_id uuid, responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE
    WHEN responsibility_type IN ('processing_factory','fabric_supplier') THEN
      EXISTS (
        SELECT 1 FROM rework_orders order_record
        WHERE order_record.rework_order_id=order_id
          AND order_record.merchandiser_user_id=candidate
          AND external_responsibility_direct_role(
            candidate,'external_responsibility:sign',ARRAY['order_merchandiser']
          )
      ) OR external_responsibility_active_delegation(
        candidate,'external_responsibility:sign',order_id,ARRAY['order_merchandiser']
      )
    WHEN responsibility_type IN ('embroidery_factory','washing_factory') THEN
      external_responsibility_direct_role(
        candidate,'external_responsibility:sign',ARRAY['embroidery_washing_merchandiser']
      ) OR external_responsibility_active_delegation(
        candidate,'external_responsibility:sign',order_id,
        ARRAY['embroidery_washing_merchandiser']
      )
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_payables(
  candidate uuid, order_id uuid, responsibility_type text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT CASE responsibility_type
    WHEN 'processing_factory' THEN
      external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['factory_payables'])
      OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['factory_payables'])
    WHEN 'fabric_supplier' THEN
      external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['fabric_payables'])
      OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['fabric_payables'])
    WHEN 'embroidery_factory' THEN
      external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['embroidery_washing_payables'])
      OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['embroidery_washing_payables'])
    WHEN 'washing_factory' THEN
      external_responsibility_direct_role(candidate,'external_responsibility:payables_confirm',ARRAY['embroidery_washing_payables'])
      OR external_responsibility_active_delegation(candidate,'external_responsibility:payables_confirm',order_id,ARRAY['embroidery_washing_payables'])
    ELSE false
  END
$$;

CREATE TABLE rework_external_responsibility_batches (
  batch_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  finalized_determination_id uuid NOT NULL UNIQUE REFERENCES rework_responsibility_determinations,
  finalized_determination_version integer NOT NULL CHECK(finalized_determination_version>0),
  batch_version integer NOT NULL DEFAULT 1 CHECK(batch_version>0),
  status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','superseded')),
  source_snapshot jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(rework_order_id,finalized_determination_version)
);

CREATE TABLE rework_external_responsibility_items (
  external_item_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES rework_external_responsibility_batches,
  determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations,
  configuration_item_id uuid NOT NULL,
  responsibility_type text NOT NULL CHECK(responsibility_type IN (
    'processing_factory','embroidery_factory','washing_factory','fabric_supplier'
  )),
  process_snapshot jsonb NOT NULL,
  multiplier_snapshot numeric(8,3) NOT NULL CHECK(multiplier_snapshot>=1),
  share_bps_snapshot integer NOT NULL CHECK(share_bps_snapshot BETWEEN 1 AND 10000),
  proposed_amount numeric(18,2) NOT NULL CHECK(proposed_amount>0),
  amount_line_snapshot jsonb NOT NULL,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(batch_id,configuration_item_id,responsibility_type)
);

CREATE TABLE rework_external_responsibility_cases (
  case_id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES rework_external_responsibility_batches,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  responsibility_type text NOT NULL CHECK(responsibility_type IN (
    'processing_factory','embroidery_factory','washing_factory','fabric_supplier'
  )),
  supplier_id uuid NOT NULL,
  supplier_version integer NOT NULL,
  supplier_code_snapshot text NOT NULL,
  supplier_name_snapshot text NOT NULL,
  supplier_type_snapshot text NOT NULL CHECK(supplier_type_snapshot IN ('factory','embroidery_washing','fabric')),
  business_handler_user_id uuid NOT NULL REFERENCES app_users,
  payables_handler_role_snapshot text NOT NULL,
  proposed_deduction_amount numeric(18,2) NOT NULL CHECK(proposed_deduction_amount>0),
  case_version integer NOT NULL DEFAULT 1 CHECK(case_version>0),
  status text NOT NULL DEFAULT 'pending_business_signoff' CHECK(status IN (
    'pending_business_signoff','pending_payables_confirmation','deduction_follow_up',
    'returned','pending_responsibility_revision','closed','superseded'
  )),
  submitted_at timestamptz,
  payables_confirmed_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_users,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  FOREIGN KEY(supplier_id,supplier_version) REFERENCES supplier_catalog_versions(supplier_id,version)
);
CREATE INDEX rework_external_cases_order_status_idx
  ON rework_external_responsibility_cases(rework_order_id,status,created_at);
CREATE INDEX rework_external_cases_handler_status_idx
  ON rework_external_responsibility_cases(business_handler_user_id,status,created_at);

CREATE TABLE rework_external_responsibility_case_items (
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  external_item_id uuid NOT NULL UNIQUE REFERENCES rework_external_responsibility_items,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(case_id,external_item_id)
);

CREATE TABLE rework_external_business_signoffs (
  signoff_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  action text NOT NULL CHECK(action IN ('submitted','resubmitted')),
  submitted_by uuid NOT NULL REFERENCES app_users,
  actor_role_snapshot text[] NOT NULL CHECK(cardinality(actor_role_snapshot)>0),
  remark text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(remark IS NULL OR length(btrim(remark)) BETWEEN 1 AND 500)
);

CREATE TABLE rework_external_payables_actions (
  payables_action_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  action text NOT NULL CHECK(action IN ('accepted','returned')),
  acted_by uuid NOT NULL REFERENCES app_users,
  actor_role_snapshot text[] NOT NULL CHECK(cardinality(actor_role_snapshot)>0),
  reason text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK((action='accepted' AND reason IS NULL) OR (action='returned' AND length(btrim(reason)) BETWEEN 1 AND 500))
);

CREATE TABLE rework_external_deduction_follow_ups (
  follow_up_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  content text NOT NULL CHECK(length(btrim(content)) BETWEEN 1 AND 2000),
  supplier_feedback text,
  next_follow_up_at timestamptz,
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  created_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(supplier_feedback IS NULL OR length(btrim(supplier_feedback)) BETWEEN 1 AND 2000)
);

CREATE TABLE rework_external_deduction_entries (
  deduction_entry_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  entry_type text NOT NULL CHECK(entry_type IN ('deduction','adjustment','reversal')),
  amount numeric(18,2) NOT NULL CHECK(amount<>0),
  deducted_on date NOT NULL,
  reference_no text,
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  reverses_entry_id uuid UNIQUE REFERENCES rework_external_deduction_entries,
  recorded_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(reference_no IS NULL OR length(btrim(reference_no)) BETWEEN 1 AND 200)
);

CREATE TABLE rework_external_deduction_closures (
  closure_id uuid PRIMARY KEY,
  case_id uuid NOT NULL UNIQUE REFERENCES rework_external_responsibility_cases,
  result text NOT NULL CHECK(result IN ('full','partial','not_deducted')),
  proposed_amount numeric(18,2) NOT NULL CHECK(proposed_amount>0),
  actual_deducted_amount numeric(18,2) NOT NULL CHECK(actual_deducted_amount>=0),
  remaining_amount numeric(18,2) NOT NULL CHECK(remaining_amount>=0),
  reason text,
  evidence_attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  remaining_difference_disposition text,
  closed_by uuid NOT NULL REFERENCES app_users,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  closed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(remaining_amount=proposed_amount-actual_deducted_amount),
  CHECK((result='full' AND actual_deducted_amount=proposed_amount AND remaining_amount=0 AND reason IS NULL AND remaining_difference_disposition IS NULL)
    OR (result='partial' AND actual_deducted_amount>0 AND actual_deducted_amount<proposed_amount AND length(btrim(reason)) BETWEEN 1 AND 500 AND cardinality(evidence_attachment_ids)>0 AND remaining_difference_disposition IS NOT NULL AND length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500)
    OR (result='not_deducted' AND actual_deducted_amount=0 AND remaining_amount=proposed_amount AND length(btrim(reason)) BETWEEN 1 AND 500 AND cardinality(evidence_attachment_ids)>0 AND remaining_difference_disposition IS NOT NULL AND length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500)),
  CHECK(remaining_difference_disposition IS NULL OR length(btrim(remaining_difference_disposition)) BETWEEN 1 AND 500)
);

CREATE TABLE rework_external_responsibility_revision_requests (
  revision_request_id uuid PRIMARY KEY,
  case_id uuid NOT NULL REFERENCES rework_external_responsibility_cases,
  source_case_status text NOT NULL CHECK(source_case_status IN (
    'pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed'
  )),
  finalized_determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations,
  finalized_determination_version integer NOT NULL,
  requested_change jsonb NOT NULL,
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 2000),
  attachment_ids uuid[] NOT NULL DEFAULT '{}'::uuid[],
  requested_by uuid NOT NULL REFERENCES app_users,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','rejected')),
  revision_version integer NOT NULL DEFAULT 1 CHECK(revision_version>0),
  decided_by uuid REFERENCES app_users,
  decision_reason text,
  decision_operation_event_id uuid REFERENCES operation_events(event_id),
  decision_request_id text CHECK(decision_request_id IS NULL OR decision_request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  decided_at timestamptz,
  CHECK((status='pending')=(decided_by IS NULL AND decision_reason IS NULL AND decision_operation_event_id IS NULL AND decision_request_id IS NULL AND decided_at IS NULL)),
  CHECK((status IN ('approved','rejected'))=(decided_by IS NOT NULL AND decision_operation_event_id IS NOT NULL AND decision_request_id IS NOT NULL AND decided_at IS NOT NULL)),
  CHECK(decision_reason IS NULL OR length(btrim(decision_reason)) BETWEEN 1 AND 2000)
);

CREATE OR REPLACE FUNCTION external_responsibility_can_view_all(candidate uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_direct_role(
    candidate,'external_responsibility:view',
    ARRAY['production_management','owner_group','tail_supervisor','finance_read']
  )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view_case(
  candidate uuid, order_id uuid, responsibility_type_value text
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_can_view_all(candidate)
    OR external_responsibility_can_sign(candidate,order_id,responsibility_type_value)
    OR external_responsibility_can_payables(candidate,order_id,responsibility_type_value)
$$;

CREATE OR REPLACE FUNCTION external_responsibility_can_view(candidate uuid, order_id uuid)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT external_responsibility_can_view_all(candidate)
    OR EXISTS (
      SELECT 1 FROM rework_external_responsibility_cases target_case
      WHERE target_case.rework_order_id=order_id
        AND external_responsibility_can_view_case(
          candidate,target_case.rework_order_id,target_case.responsibility_type
        )
    )
    OR EXISTS (
      SELECT 1 FROM rework_external_responsibility_batches batch
      JOIN rework_external_responsibility_items item ON item.batch_id=batch.batch_id
      WHERE batch.rework_order_id=order_id AND batch.status='active'
        AND external_responsibility_can_sign(candidate,order_id,item.responsibility_type)
    )
$$;

CREATE OR REPLACE FUNCTION external_responsibility_expected_supplier_type(type_value text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE type_value
    WHEN 'processing_factory' THEN 'factory'
    WHEN 'fabric_supplier' THEN 'fabric'
    WHEN 'embroidery_factory' THEN 'embroidery_washing'
    WHEN 'washing_factory' THEN 'embroidery_washing'
  END
$$;

-- A new finalized PR-09 leaf can supersede an earlier N08-B batch after an
-- N08-A rejection or an approved N08-B revision.  The trusted finalization
-- event and direct version link are both required; an arbitrary current
-- finalized version is never sufficient.
CREATE OR REPLACE FUNCTION external_responsibility_superseded_by_finalization(
  previous_determination_id uuid, order_id uuid
) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1
    FROM operation_events event_record
    JOIN rework_responsibility_determinations successor
      ON successor.rework_order_id=order_id
     AND successor.replaces_determination_id=previous_determination_id
     AND successor.stage='finalized'
    WHERE event_record.event_id=nullif(current_setting('dx_rework.rework_event_id',true),'')::uuid
      AND event_record.request_id=nullif(current_setting('dx_rework.rework_request_id',true),'')
      AND event_record.action='rework.responsibility.finalize'
      AND event_record.authorization_capability='responsibility:determine'
      AND event_record.entity_type='rework_order'
      AND event_record.entity_id=order_id::text
  )
$$;

CREATE OR REPLACE FUNCTION require_external_responsibility_event(
  expected_action text, expected_capability text, order_id uuid, persisted_actor uuid
) RETURNS operation_events LANGUAGE plpgsql AS $$
DECLARE event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.external_responsibility_request_id',true),'');
  IF event_record.event_id IS NULL
     OR event_record.actor_id<>persisted_actor
     OR event_record.action<>expected_action
     OR event_record.authorization_capability<>expected_capability
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>order_id::text THEN
    RAISE EXCEPTION 'external responsibility write requires matching trusted event'
      USING ERRCODE='55000';
  END IF;
  RETURN event_record;
END $$;

CREATE OR REPLACE FUNCTION external_responsibility_require_ready_attachments(ids uuid[])
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(ids)=0 THEN RETURN; END IF;
  IF cardinality(ids)<>cardinality(ARRAY(SELECT DISTINCT candidate.attachment_id FROM unnest(ids) AS candidate(attachment_id)))
     OR EXISTS (
       SELECT 1 FROM unnest(ids) AS candidate(attachment_id)
       LEFT JOIN attachments attachment ON attachment.attachment_id=candidate.attachment_id
       WHERE attachment.attachment_id IS NULL OR attachment.status<>'ready'
     ) THEN
    RAISE EXCEPTION 'external responsibility evidence must be unique ready attachments'
      USING ERRCODE='23514';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION external_responsibility_require_bound_attachments(
  ids uuid[], target_case_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF cardinality(ids)=0 THEN RETURN; END IF;
  IF EXISTS (
    SELECT 1 FROM unnest(ids) AS candidate(attachment_id)
    LEFT JOIN attachments attachment ON attachment.attachment_id=candidate.attachment_id
    WHERE attachment.attachment_id IS NULL
       OR attachment.status<>'ready'
       OR attachment.entity_type<>'external_responsibility_case'
       OR attachment.entity_id<>target_case_id::text
  ) THEN
    RAISE EXCEPTION 'external responsibility evidence must be bound to its case'
      USING ERRCODE='23514';
  END IF;
END $$;

-- The original rework attachment guard deliberately ignores non-rework entities.
-- PR-11 adds a second, narrower guard rather than weakening that draft-only rule.
CREATE OR REPLACE FUNCTION guard_external_responsibility_attachment_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; event_record operation_events%ROWTYPE;
BEGIN
  IF OLD.entity_type='external_responsibility_case' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound external responsibility evidence is immutable' USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.entity_type IS DISTINCT FROM 'external_responsibility_case' THEN
    RETURN NEW;
  END IF;
  IF OLD.entity_type IS NOT NULL OR OLD.entity_id IS NOT NULL OR NEW.entity_id IS NULL THEN
    RAISE EXCEPTION 'external responsibility evidence can only be bound once' USING ERRCODE='23514';
  END IF;
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.entity_id::uuid;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
    AND request_id=nullif(current_setting('dx_rework.external_responsibility_request_id',true),'');
  IF target_case.case_id IS NULL OR NEW.status<>'ready' OR event_record.event_id IS NULL
     OR NEW.uploaded_by<>event_record.actor_id OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>target_case.rework_order_id::text
     OR event_record.action NOT IN (
       'rework.external_responsibility.submit','rework.external_responsibility.payables_return',
       'rework.external_deduction.follow_up','rework.external_deduction.record',
       'rework.external_deduction.close','rework.external_responsibility.revision.request'
     ) THEN
    RAISE EXCEPTION 'external responsibility evidence binding requires its trusted case action' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_responsibility_attachment_delete()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM attachments WHERE entity_type='external_responsibility_case') THEN
      RAISE EXCEPTION 'bound external responsibility evidence cannot be truncated' USING ERRCODE='55000';
    END IF;
    RETURN NULL;
  END IF;
  IF OLD.entity_type='external_responsibility_case' THEN
    RAISE EXCEPTION 'bound external responsibility evidence cannot be deleted' USING ERRCODE='55000';
  END IF;
  RETURN OLD;
END $$;

CREATE TRIGGER external_responsibility_attachment_binding
  BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_external_responsibility_attachment_binding();
CREATE TRIGGER external_responsibility_attachment_no_delete
  BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_external_responsibility_attachment_delete();
CREATE TRIGGER external_responsibility_attachment_no_truncate
  BEFORE TRUNCATE ON attachments FOR EACH STATEMENT EXECUTE FUNCTION guard_external_responsibility_attachment_delete();

CREATE OR REPLACE FUNCTION guard_external_batch_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE determination rework_responsibility_determinations%ROWTYPE;
BEGIN
  SELECT * INTO determination FROM rework_responsibility_determinations
  WHERE determination_id=NEW.finalized_determination_id;
  IF determination.determination_id IS NULL OR determination.rework_order_id<>NEW.rework_order_id
     OR determination.stage<>'finalized' OR determination.determination_version<>NEW.finalized_determination_version
     OR EXISTS(SELECT 1 FROM rework_responsibility_determinations successor WHERE successor.replaces_determination_id=determination.determination_id)
     OR NEW.batch_version<>1 OR NEW.status<>'active' THEN
    RAISE EXCEPTION 'external batch must bind the current finalized responsibility version' USING ERRCODE='23514';
  END IF;
  IF NEW.operation_event_id<>determination.operation_event_id OR NEW.request_id<>determination.request_id
     OR NEW.created_by<>determination.created_by THEN
    RAISE EXCEPTION 'external batch must inherit finalized determination audit context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_batch_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE approved_revision rework_external_responsibility_revision_requests%ROWTYPE;
BEGIN
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
     OR NEW.finalized_determination_id IS DISTINCT FROM OLD.finalized_determination_id
     OR NEW.finalized_determination_version IS DISTINCT FROM OLD.finalized_determination_version
     OR NEW.source_snapshot IS DISTINCT FROM OLD.source_snapshot
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.batch_version<>OLD.batch_version+1 THEN
    RAISE EXCEPTION 'external batch source history is immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='active' AND NEW.status='active' THEN
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.allocate','external_responsibility:sign',NEW.rework_order_id,
      (SELECT actor_id FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid)
    );
    RETURN NEW;
  END IF;
  IF OLD.status<>'active' OR NEW.status<>'superseded' THEN
    RAISE EXCEPTION 'invalid external responsibility batch transition' USING ERRCODE='23514';
  END IF;
  IF external_responsibility_superseded_by_finalization(OLD.finalized_determination_id,NEW.rework_order_id) THEN
    RETURN NEW;
  END IF;
  SELECT revision.* INTO approved_revision
  FROM rework_external_responsibility_revision_requests revision
  JOIN rework_external_responsibility_cases target_case ON target_case.case_id=revision.case_id
  WHERE target_case.batch_id=NEW.batch_id AND revision.status='approved'
  ORDER BY revision.decided_at DESC LIMIT 1;
  IF approved_revision.revision_request_id IS NULL THEN
    RAISE EXCEPTION 'external batch can be superseded only with an approved case revision' USING ERRCODE='55000';
  END IF;
  PERFORM require_external_responsibility_event(
    'rework.external_responsibility.revision.approve','external_responsibility:approve_revision',
    NEW.rework_order_id,
    (SELECT actor_id FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid)
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allocation rework_responsibility_allocations%ROWTYPE; process rework_responsibility_processes%ROWTYPE; batch rework_external_responsibility_batches%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
  SELECT * INTO allocation FROM rework_responsibility_allocations WHERE determination_id=NEW.determination_id
    AND configuration_item_id=NEW.configuration_item_id AND responsibility_type=NEW.responsibility_type;
  SELECT * INTO process FROM rework_responsibility_processes WHERE determination_id=NEW.determination_id AND configuration_item_id=NEW.configuration_item_id;
  IF batch.batch_id IS NULL OR NEW.determination_id<>batch.finalized_determination_id
     OR allocation.determination_id IS NULL OR process.determination_id IS NULL
     OR NEW.proposed_amount<>allocation.rounded_amount OR NEW.multiplier_snapshot<>process.multiplier
     OR NEW.share_bps_snapshot<>allocation.share_bps OR NEW.operation_event_id<>batch.operation_event_id
     OR NEW.request_id<>batch.request_id THEN
    RAISE EXCEPTION 'external item snapshot does not match finalized responsibility' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch rework_external_responsibility_batches%ROWTYPE; supplier current_supplier_catalog%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
  SELECT * INTO supplier FROM current_supplier_catalog WHERE supplier_id=NEW.supplier_id;
  IF batch.batch_id IS NULL OR batch.rework_order_id<>NEW.rework_order_id OR batch.status<>'active'
     OR supplier.supplier_id IS NULL OR supplier.active IS DISTINCT FROM true
     OR supplier.version<>NEW.supplier_version OR supplier.supplier_type<>external_responsibility_expected_supplier_type(NEW.responsibility_type)
     OR NEW.supplier_code_snapshot<>supplier.supplier_code OR NEW.supplier_name_snapshot<>supplier.supplier_name
     OR NEW.supplier_type_snapshot<>supplier.supplier_type OR NEW.status NOT IN ('pending_business_signoff','returned')
     OR NEW.case_version<>1 OR NOT external_responsibility_can_sign(NEW.business_handler_user_id,NEW.rework_order_id,NEW.responsibility_type) THEN
    RAISE EXCEPTION 'external case supplier, handler or snapshot is invalid' USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event('rework.external_responsibility.allocate','external_responsibility:sign',NEW.rework_order_id,NEW.created_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_item_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; item rework_external_responsibility_items%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  SELECT * INTO item FROM rework_external_responsibility_items WHERE external_item_id=NEW.external_item_id;
  IF target_case.case_id IS NULL OR item.external_item_id IS NULL OR target_case.batch_id<>item.batch_id
     OR target_case.responsibility_type<>item.responsibility_type OR target_case.status NOT IN ('pending_business_signoff','returned') THEN
    RAISE EXCEPTION 'external responsibility item cannot be assigned to this case' USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event('rework.external_responsibility.allocate','external_responsibility:sign',target_case.rework_order_id,target_case.created_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_deferred() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_total numeric(18,2); covered_count bigint;
BEGIN
  SELECT COALESCE(sum(item.proposed_amount),0),count(*) INTO expected_total,covered_count
  FROM rework_external_responsibility_case_items mapping
  JOIN rework_external_responsibility_items item ON item.external_item_id=mapping.external_item_id
  WHERE mapping.case_id=NEW.case_id;
  IF covered_count=0 OR NEW.proposed_deduction_amount<>expected_total THEN
    RAISE EXCEPTION 'case proposed amount must equal its server-side external items' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER rework_external_case_exact_amount
  AFTER INSERT ON rework_external_responsibility_cases DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION guard_external_case_deferred();

CREATE OR REPLACE FUNCTION guard_external_case_update() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE expected_action text; expected_capability text; decision rework_external_payables_actions%ROWTYPE; closure rework_external_deduction_closures%ROWTYPE; revision rework_external_responsibility_revision_requests%ROWTYPE; signoff rework_external_business_signoffs%ROWTYPE; batch rework_external_responsibility_batches%ROWTYPE;
BEGIN
  IF NEW.case_id IS DISTINCT FROM OLD.case_id OR NEW.batch_id IS DISTINCT FROM OLD.batch_id
     OR NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.responsibility_type IS DISTINCT FROM OLD.responsibility_type
     OR NEW.supplier_id IS DISTINCT FROM OLD.supplier_id OR NEW.supplier_version IS DISTINCT FROM OLD.supplier_version
     OR NEW.supplier_code_snapshot IS DISTINCT FROM OLD.supplier_code_snapshot OR NEW.supplier_name_snapshot IS DISTINCT FROM OLD.supplier_name_snapshot
     OR NEW.supplier_type_snapshot IS DISTINCT FROM OLD.supplier_type_snapshot OR NEW.business_handler_user_id IS DISTINCT FROM OLD.business_handler_user_id
     OR NEW.payables_handler_role_snapshot IS DISTINCT FROM OLD.payables_handler_role_snapshot OR NEW.proposed_deduction_amount IS DISTINCT FROM OLD.proposed_deduction_amount
     OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.operation_event_id IS DISTINCT FROM OLD.operation_event_id OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.case_version<>OLD.case_version+1 THEN
    RAISE EXCEPTION 'external deduction case source facts are immutable' USING ERRCODE='55000';
  END IF;
  IF OLD.status='superseded' THEN RAISE EXCEPTION 'superseded case is immutable' USING ERRCODE='55000'; END IF;
  IF NEW.status='pending_payables_confirmation' AND OLD.status IN ('pending_business_signoff','returned') THEN
    SELECT * INTO signoff FROM rework_external_business_signoffs WHERE case_id=NEW.case_id ORDER BY created_at DESC LIMIT 1;
    IF signoff.signoff_id IS NULL THEN RAISE EXCEPTION 'case submission requires append-only signoff' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_responsibility.submit','external_responsibility:sign',NEW.rework_order_id,signoff.submitted_by);
  ELSIF NEW.status IN ('deduction_follow_up','returned') AND OLD.status='pending_payables_confirmation' THEN
    SELECT * INTO decision FROM rework_external_payables_actions WHERE case_id=NEW.case_id ORDER BY created_at DESC LIMIT 1;
    expected_action:=CASE NEW.status WHEN 'deduction_follow_up' THEN 'rework.external_responsibility.payables_accept' ELSE 'rework.external_responsibility.payables_return' END;
    IF decision.payables_action_id IS NULL OR decision.action<>CASE NEW.status WHEN 'deduction_follow_up' THEN 'accepted' ELSE 'returned' END THEN
      RAISE EXCEPTION 'payables transition requires matching append-only action' USING ERRCODE='55000';
    END IF;
    PERFORM require_external_responsibility_event(expected_action,'external_responsibility:payables_confirm',NEW.rework_order_id,decision.acted_by);
  ELSIF NEW.status='closed' AND OLD.status='deduction_follow_up' THEN
    SELECT * INTO closure FROM rework_external_deduction_closures WHERE case_id=NEW.case_id;
    IF closure.closure_id IS NULL THEN RAISE EXCEPTION 'case closure requires append-only closure record' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_deduction.close','external_deduction:close',NEW.rework_order_id,closure.closed_by);
  ELSIF NEW.status='pending_responsibility_revision' AND OLD.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed') THEN
    SELECT * INTO revision FROM rework_external_responsibility_revision_requests WHERE case_id=NEW.case_id AND status='pending' ORDER BY created_at DESC LIMIT 1;
    IF revision.revision_request_id IS NULL THEN RAISE EXCEPTION 'case revision requires append-only request record' USING ERRCODE='55000'; END IF;
    PERFORM require_external_responsibility_event('rework.external_responsibility.revision.request','external_responsibility:request_revision',NEW.rework_order_id,revision.requested_by);
  ELSIF NEW.status='superseded' AND OLD.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','pending_responsibility_revision') THEN
    SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
    IF NOT external_responsibility_superseded_by_finalization(batch.finalized_determination_id,NEW.rework_order_id) THEN
      PERFORM require_external_responsibility_event(
        'rework.external_responsibility.revision.approve','external_responsibility:approve_revision',NEW.rework_order_id,
        (SELECT actor_id FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid)
      );
    END IF;
  ELSIF OLD.status='pending_responsibility_revision'
     AND NEW.status IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed') THEN
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.revision.reject','external_responsibility:approve_revision',NEW.rework_order_id,
      (SELECT actor_id FROM operation_events WHERE event_id=nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid)
    );
  ELSE
    RAISE EXCEPTION 'invalid external deduction case transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_business_signoff_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR target_case.status NOT IN ('pending_business_signoff','returned')
     OR NOT external_responsibility_can_sign(NEW.submitted_by,target_case.rework_order_id,target_case.responsibility_type) THEN
    RAISE EXCEPTION 'business signoff actor is not authorized for external case' USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event('rework.external_responsibility.submit','external_responsibility:sign',target_case.rework_order_id,NEW.submitted_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_payables_action_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; expected_action text;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR target_case.status<>'pending_payables_confirmation'
     OR NOT external_responsibility_can_payables(NEW.acted_by,target_case.rework_order_id,target_case.responsibility_type) THEN
    RAISE EXCEPTION 'payables actor is not authorized for external case' USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  expected_action:=CASE NEW.action WHEN 'accepted' THEN 'rework.external_responsibility.payables_accept' ELSE 'rework.external_responsibility.payables_return' END;
  PERFORM require_external_responsibility_event(expected_action,'external_responsibility:payables_confirm',target_case.rework_order_id,NEW.acted_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_follow_up_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR target_case.status<>'deduction_follow_up'
     OR NOT (external_responsibility_can_sign(NEW.created_by,target_case.rework_order_id,target_case.responsibility_type)
       OR external_responsibility_can_payables(NEW.created_by,target_case.rework_order_id,target_case.responsibility_type)) THEN
    RAISE EXCEPTION 'follow-up actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event('rework.external_deduction.follow_up','external_deduction:follow_up',target_case.rework_order_id,NEW.created_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_deduction_entry_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; reversed_entry rework_external_deduction_entries%ROWTYPE; prior_total numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id FOR UPDATE;
  IF target_case.case_id IS NULL OR target_case.status<>'deduction_follow_up'
     OR NOT external_responsibility_can_payables(NEW.recorded_by,target_case.rework_order_id,target_case.responsibility_type) THEN
    RAISE EXCEPTION 'deduction entry requires accepted case and matching payables role' USING ERRCODE='42501';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  IF NEW.entry_type IN ('adjustment','reversal') THEN
    SELECT * INTO reversed_entry FROM rework_external_deduction_entries WHERE deduction_entry_id=NEW.reverses_entry_id;
    IF reversed_entry.deduction_entry_id IS NULL OR reversed_entry.case_id<>NEW.case_id
       OR (NEW.entry_type='reversal' AND NEW.amount<>-reversed_entry.amount) THEN
      RAISE EXCEPTION 'deduction adjustment or reversal must reference its own case ledger entry' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT COALESCE(sum(amount),0) INTO prior_total FROM rework_external_deduction_entries WHERE case_id=NEW.case_id;
  IF prior_total+NEW.amount<0 OR prior_total+NEW.amount>target_case.proposed_deduction_amount
     OR (NEW.entry_type='deduction' AND NEW.amount<=0)
     OR (NEW.entry_type IN ('adjustment','reversal') AND NEW.reverses_entry_id IS NULL) THEN
    RAISE EXCEPTION 'deduction entry would make actual amount invalid' USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event('rework.external_deduction.record','external_deduction:record',target_case.rework_order_id,NEW.recorded_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_closure_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; actual numeric(18,2);
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO actual FROM rework_external_deduction_entries WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR target_case.status<>'deduction_follow_up'
     OR NEW.proposed_amount<>target_case.proposed_deduction_amount OR NEW.actual_deducted_amount<>actual
     OR NOT external_responsibility_can_payables(NEW.closed_by,target_case.rework_order_id,target_case.responsibility_type) THEN
    RAISE EXCEPTION 'deduction closure does not match accepted case ledger' USING ERRCODE='23514';
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.evidence_attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.evidence_attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event('rework.external_deduction.close','external_deduction:close',target_case.rework_order_id,NEW.closed_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_revision_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_case rework_external_responsibility_cases%ROWTYPE; determination rework_responsibility_determinations%ROWTYPE; closure rework_external_deduction_closures%ROWTYPE;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  SELECT * INTO determination FROM rework_responsibility_determinations WHERE determination_id=NEW.finalized_determination_id;
  IF target_case.case_id IS NULL OR target_case.status NOT IN ('pending_business_signoff','returned','pending_payables_confirmation','deduction_follow_up','closed')
     OR determination.determination_id IS NULL OR determination.stage<>'finalized'
     OR determination.determination_version<>NEW.finalized_determination_version
     OR NEW.revision_version<>1
     OR NOT external_responsibility_can_sign(NEW.requested_by,target_case.rework_order_id,target_case.responsibility_type) THEN
    RAISE EXCEPTION 'external revision request is not authorized or is stale' USING ERRCODE='42501';
  END IF;
  IF target_case.status='closed' THEN
    SELECT * INTO closure FROM rework_external_deduction_closures WHERE case_id=NEW.case_id;
    IF closure.closure_id IS NULL OR closure.result='full' OR closure.remaining_amount<=0 THEN
      RAISE EXCEPTION 'only a closed case with an unresolved deduction difference can request revision' USING ERRCODE='23514';
    END IF;
  END IF;
  PERFORM external_responsibility_require_ready_attachments(NEW.attachment_ids);
  PERFORM external_responsibility_require_bound_attachments(NEW.attachment_ids,NEW.case_id);
  PERFORM require_external_responsibility_event('rework.external_responsibility.revision.request','external_responsibility:request_revision',target_case.rework_order_id,NEW.requested_by);
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_revision_update() RETURNS trigger LANGUAGE plpgsql AS $$
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
     OR OLD.status<>'pending' OR NEW.status NOT IN ('approved','rejected')
     OR NEW.revision_version<>OLD.revision_version+1 THEN
    RAISE EXCEPTION 'external revision history is immutable' USING ERRCODE='55000';
  END IF;
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  IF target_case.case_id IS NULL OR NOT external_responsibility_direct_role(NEW.decided_by,'external_responsibility:approve_revision',ARRAY['production_management','owner_group']) THEN
    RAISE EXCEPTION 'external revision decision actor is not authorized' USING ERRCODE='42501';
  END IF;
  PERFORM require_external_responsibility_event(
    CASE NEW.status WHEN 'approved' THEN 'rework.external_responsibility.revision.approve' ELSE 'rework.external_responsibility.revision.reject' END,
    'external_responsibility:approve_revision',target_case.rework_order_id,NEW.decided_by
  );
  IF NEW.decision_operation_event_id IS DISTINCT FROM nullif(current_setting('dx_rework.external_responsibility_event_id',true),'')::uuid
     OR NEW.decision_request_id IS DISTINCT FROM nullif(current_setting('dx_rework.external_responsibility_request_id',true),'') THEN
    RAISE EXCEPTION 'external revision decision requires matching event context' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION reject_external_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'external responsibility history is append-only' USING ERRCODE='55000'; END $$;

CREATE TRIGGER external_batch_insert BEFORE INSERT ON rework_external_responsibility_batches FOR EACH ROW EXECUTE FUNCTION guard_external_batch_insert();
CREATE TRIGGER external_batch_update BEFORE UPDATE ON rework_external_responsibility_batches FOR EACH ROW EXECUTE FUNCTION guard_external_batch_update();
CREATE TRIGGER external_items_insert BEFORE INSERT ON rework_external_responsibility_items FOR EACH ROW EXECUTE FUNCTION guard_external_item_insert();
CREATE TRIGGER external_cases_insert BEFORE INSERT ON rework_external_responsibility_cases FOR EACH ROW EXECUTE FUNCTION guard_external_case_insert();
CREATE TRIGGER external_cases_update BEFORE UPDATE ON rework_external_responsibility_cases FOR EACH ROW EXECUTE FUNCTION guard_external_case_update();
CREATE TRIGGER external_case_items_insert BEFORE INSERT ON rework_external_responsibility_case_items FOR EACH ROW EXECUTE FUNCTION guard_external_case_item_insert();
CREATE TRIGGER external_signoffs_insert BEFORE INSERT ON rework_external_business_signoffs FOR EACH ROW EXECUTE FUNCTION guard_external_business_signoff_insert();
CREATE TRIGGER external_payables_insert BEFORE INSERT ON rework_external_payables_actions FOR EACH ROW EXECUTE FUNCTION guard_external_payables_action_insert();
CREATE TRIGGER external_followups_insert BEFORE INSERT ON rework_external_deduction_follow_ups FOR EACH ROW EXECUTE FUNCTION guard_external_follow_up_insert();
CREATE TRIGGER external_deductions_insert BEFORE INSERT ON rework_external_deduction_entries FOR EACH ROW EXECUTE FUNCTION guard_external_deduction_entry_insert();
CREATE TRIGGER external_closures_insert BEFORE INSERT ON rework_external_deduction_closures FOR EACH ROW EXECUTE FUNCTION guard_external_closure_insert();
CREATE TRIGGER external_revisions_insert BEFORE INSERT ON rework_external_responsibility_revision_requests FOR EACH ROW EXECUTE FUNCTION guard_external_revision_insert();
CREATE TRIGGER external_revisions_update BEFORE UPDATE ON rework_external_responsibility_revision_requests FOR EACH ROW EXECUTE FUNCTION guard_external_revision_update();

DO $$ DECLARE target text; BEGIN
  FOREACH target IN ARRAY ARRAY[
    'rework_external_responsibility_items',
    'rework_external_responsibility_case_items','rework_external_business_signoffs',
    'rework_external_payables_actions','rework_external_deduction_follow_ups',
    'rework_external_deduction_entries','rework_external_deduction_closures'
  ] LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation()',target || '_immutable',target);
    EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %I FOR EACH STATEMENT EXECUTE FUNCTION reject_external_history_mutation()',target || '_no_truncate',target);
  END LOOP;
END $$;
CREATE TRIGGER external_cases_no_delete BEFORE DELETE ON rework_external_responsibility_cases FOR EACH ROW EXECUTE FUNCTION reject_external_history_mutation();
CREATE TRIGGER external_cases_no_truncate BEFORE TRUNCATE ON rework_external_responsibility_cases FOR EACH STATEMENT EXECUTE FUNCTION reject_external_history_mutation();

ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','pending_quantity_adjustment_ie_review',
  'pending_responsibility_determination','pending_responsibility_action','completed','cancelled'
));

-- This is the PR-10 order guard with only N09 completion and controlled
-- responsibility reopen added.  All older lifecycle transitions remain exact.
CREATE OR REPLACE FUNCTION guard_rework_order_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_event_id text:=nullif(current_setting('dx_rework.rework_event_id',true),''); audit_request_id text:=nullif(current_setting('dx_rework.rework_request_id',true),''); expected_action text; expected_capability text; alternative_action text:=NULL; alternative_capability text:=NULL; alternative_action_two text:=NULL; alternative_capability_two text:=NULL; alternative_action_three text:=NULL; alternative_capability_three text:=NULL; audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.created_by<>NEW.updated_by OR NEW.source_system<>'manual' OR NEW.external_id IS NOT NULL OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF;
    expected_action:='rework.draft.create'; expected_capability:='rework:initiate'; audit_actor_id:=NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.status='draft' AND NEW.status='draft' THEN expected_action:='rework.draft.update'; expected_capability:='rework:initiate';
    ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN expected_action:='rework.withdraw'; expected_capability:='rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status IN ('pending_ie_review','pending_process_configuration') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
    ELSIF OLD.status='pending_ie_review' AND NEW.status IN ('pending_process_configuration','pending_task_assignment') THEN expected_action:='rework.process_configuration.review'; expected_capability:='process:review';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status IN ('pending_ie_review','pending_task_assignment') THEN expected_action:=CASE WHEN NEW.status='pending_ie_review' THEN 'rework.process_configuration.submit' ELSE 'rework.process_configuration.save' END; expected_capability:='process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='in_progress' THEN expected_action:='rework.work_task.assign'; expected_capability:='work:assign';
    ELSIF OLD.status='in_progress' AND NEW.status='in_progress' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust';
    ELSIF OLD.status='in_progress' AND NEW.status='pending_order_review' THEN expected_action:='rework.work_report.submit'; expected_capability:='work:report'; alternative_action:='rework.quantity.decrease'; alternative_capability:='quantity:adjust';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_order_review' THEN expected_action:='rework.quantity.decrease'; expected_capability:='quantity:adjust'; alternative_action:='rework.quantity.increase.request'; alternative_capability:='quantity:adjust'; alternative_action_two:='rework.quantity.increase.confirm'; alternative_capability_two:='quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='in_progress' THEN expected_action:='rework.work_report.reject'; expected_capability:='submission:audit'; alternative_action:='rework.quantity.increase.confirm'; alternative_capability:='quantity:confirm';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_quantity_adjustment_ie_review' THEN expected_action:='rework.quantity.increase.confirm'; expected_capability:='quantity:confirm';
    ELSIF OLD.status='pending_quantity_adjustment_ie_review' AND NEW.status IN ('in_progress','pending_order_review') THEN expected_action:='rework.quantity.increase.ie_review'; expected_capability:='process:review';
    ELSIF OLD.status='pending_order_review' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.whole_order.approve'; expected_capability:='submission:audit';
    ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.draft'; expected_capability:='responsibility:determine'; alternative_action:='rework.responsibility.transfer'; alternative_capability:='responsibility:determine'; alternative_action_two:='rework.responsibility.takeover'; alternative_capability_two:='responsibility:takeover'; alternative_action_three:='rework.responsibility.high_multiplier.confirm'; alternative_capability_three:='responsibility:confirm_high_multiplier';
    ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine';
    ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision';
    ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine';
    ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate';
    ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;
