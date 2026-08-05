-- PR-16: minimum ERP integration contract. Production ERP connectivity remains disabled.

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('erp:integrate','ERP专用接入','仅供不可登录的ERP服务身份写入和关联来源'),
  ('erp:emergency_intake','ERP应急录入','系统管理员在ERP不可用时按原因和幂等键应急录入'),
  ('erp:result:read','ERP结果读取','读取ERP接入返工单的只读结果契约')
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('system_admin','erp:emergency_intake'),
  ('system_admin','erp:result:read')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- This principal has no DingTalk identity and no human role assignment, so it
-- cannot create a session or impersonate an employee.
INSERT INTO app_users(id,display_name,enabled)
VALUES('00000000-0000-4000-8000-000000000016','ERP Integration Service',true)
ON CONFLICT(id) DO NOTHING;

CREATE TABLE erp_integration_principals (
  principal_key text PRIMARY KEY CHECK(principal_key='erp'),
  principal_id uuid NOT NULL UNIQUE REFERENCES app_users(id),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO erp_integration_principals(principal_key,principal_id)
VALUES('erp','00000000-0000-4000-8000-000000000016');
CREATE TRIGGER erp_integration_principals_no_update
  BEFORE UPDATE ON erp_integration_principals FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_integration_principals_no_delete
  BEFORE DELETE ON erp_integration_principals FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_integration_principals_no_truncate
  BEFORE TRUNCATE ON erp_integration_principals FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE erp_rework_intakes (
  rework_order_id uuid PRIMARY KEY REFERENCES rework_orders(rework_order_id),
  contract_version text NOT NULL CHECK(contract_version='1'),
  intake_mode text NOT NULL CHECK(intake_mode IN ('erp','emergency')),
  source_snapshot jsonb NOT NULL,
  received_by uuid NOT NULL REFERENCES app_users(id),
  emergency_reason text,
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK(
    (intake_mode='erp' AND emergency_reason IS NULL)
    OR
    (intake_mode='emergency' AND length(btrim(emergency_reason)) BETWEEN 1 AND 500)
  )
);

CREATE TABLE erp_rework_links (
  link_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL UNIQUE REFERENCES erp_rework_intakes(rework_order_id),
  source_system text NOT NULL CHECK(source_system='erp'),
  external_id text NOT NULL CHECK(length(btrim(external_id)) BETWEEN 1 AND 200),
  external_idempotency_key text NOT NULL CHECK(
    length(btrim(external_idempotency_key)) BETWEEN 1 AND 200
    AND external_idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  erp_node_id text NOT NULL CHECK(length(btrim(erp_node_id)) BETWEEN 1 AND 200),
  linked_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source_system,external_id),
  UNIQUE(source_system,external_idempotency_key)
);

CREATE OR REPLACE FUNCTION guard_erp_rework_intake_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_record rework_orders%ROWTYPE; event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO order_record FROM rework_orders
  WHERE rework_order_id=NEW.rework_order_id;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=NEW.operation_event_id AND request_id=NEW.request_id;
  IF order_record.rework_order_id IS NULL
     OR event_record.event_id IS NULL
     OR event_record.actor_id<>NEW.received_by
     OR event_record.action<>'rework.submit'
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>NEW.rework_order_id::text
     OR NEW.source_snapshot->>'contractVersion'<>'1'
     OR NEW.source_snapshot->'payload'->>'styleNo'<>order_record.style_no
     OR COALESCE(NEW.source_snapshot->'payload'->>'orderNo','')<>
        COALESCE(order_record.order_no,'')
     OR NEW.source_snapshot->'payload'->>'merchandiserUserId'<>
        order_record.merchandiser_user_id::text
     OR NEW.source_snapshot->'payload'->>'problemPart'<>order_record.problem_part
     OR NEW.source_snapshot->'payload'->>'problemDescription'<>
        order_record.problem_description
     OR (NEW.source_snapshot->'payload'->>'reworkQuantity')::integer<>
        order_record.rework_quantity THEN
    RAISE EXCEPTION 'ERP intake snapshot does not match the audited rework order'
      USING ERRCODE='55000';
  END IF;
  IF NEW.intake_mode='erp' THEN
    IF order_record.source_system<>'erp'
       OR NEW.received_by<>'00000000-0000-4000-8000-000000000016'::uuid
       OR event_record.authorization_capability<>'erp:integrate'
       OR NEW.source_snapshot->'source'->>'sourceSystem'<>'erp'
       OR NEW.source_snapshot->'source'->>'externalId'<>order_record.external_id
       OR NEW.source_snapshot->'source'->>'externalIdempotencyKey'<>
          order_record.external_idempotency_key
       OR COALESCE(NEW.source_snapshot->'source'->>'erpNodeId','')<>
          COALESCE(order_record.erp_node_id,'') THEN
      RAISE EXCEPTION 'ERP intake requires the dedicated integration principal and source'
        USING ERRCODE='42501';
    END IF;
  ELSE
    IF order_record.source_system<>'erp_emergency'
       OR event_record.authorization_capability<>'erp:emergency_intake'
       OR NOT (event_record.actor_roles @> ARRAY['system_admin'])
       OR event_record.reason IS DISTINCT FROM NEW.emergency_reason
       OR NEW.source_snapshot->>'reason' IS DISTINCT FROM NEW.emergency_reason THEN
      RAISE EXCEPTION 'emergency ERP intake requires an authorized administrator reason'
        USING ERRCODE='42501';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erp_rework_intakes_guard_insert
  BEFORE INSERT ON erp_rework_intakes FOR EACH ROW
  EXECUTE FUNCTION guard_erp_rework_intake_insert();
CREATE TRIGGER erp_rework_intakes_no_update
  BEFORE UPDATE ON erp_rework_intakes FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_rework_intakes_no_delete
  BEFORE DELETE ON erp_rework_intakes FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_rework_intakes_no_truncate
  BEFORE TRUNCATE ON erp_rework_intakes FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_erp_rework_link_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE intake_record erp_rework_intakes%ROWTYPE; event_record operation_events%ROWTYPE;
BEGIN
  SELECT * INTO intake_record FROM erp_rework_intakes
  WHERE rework_order_id=NEW.rework_order_id;
  SELECT * INTO event_record FROM operation_events
  WHERE event_id=NEW.operation_event_id AND request_id=NEW.request_id;
  IF intake_record.rework_order_id IS NULL
     OR intake_record.intake_mode<>'emergency'
     OR NEW.linked_by<>'00000000-0000-4000-8000-000000000016'::uuid
     OR event_record.event_id IS NULL
     OR event_record.actor_id<>NEW.linked_by
     OR event_record.actor_roles IS DISTINCT FROM ARRAY['integration_service']::text[]
     OR event_record.authorization_capability<>'erp:integrate'
     OR event_record.action<>'rework.erp.link'
     OR event_record.entity_type<>'rework_order'
     OR event_record.entity_id<>NEW.rework_order_id::text THEN
    RAISE EXCEPTION 'ERP linkage requires the dedicated integration principal'
      USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER erp_rework_links_guard_insert
  BEFORE INSERT ON erp_rework_links FOR EACH ROW
  EXECUTE FUNCTION guard_erp_rework_link_insert();
CREATE TRIGGER erp_rework_links_no_update
  BEFORE UPDATE ON erp_rework_links FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_rework_links_no_delete
  BEFORE DELETE ON erp_rework_links FOR EACH ROW
  EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER erp_rework_links_no_truncate
  BEFORE TRUNCATE ON erp_rework_links FOR EACH STATEMENT
  EXECUTE FUNCTION reject_operation_event_mutation();

-- Preserve the complete lifecycle guard from PR-11 and add only the two
-- controlled insert modes. Existing update transitions remain unchanged.
CREATE OR REPLACE FUNCTION guard_rework_order_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE audit_event_id text:=nullif(current_setting('dx_rework.rework_event_id',true),''); audit_request_id text:=nullif(current_setting('dx_rework.rework_request_id',true),''); expected_action text; expected_capability text; alternative_action text:=NULL; alternative_capability text:=NULL; alternative_action_two text:=NULL; alternative_capability_two text:=NULL; alternative_action_three text:=NULL; alternative_capability_three text:=NULL; audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$' THEN RAISE EXCEPTION 'rework order write requires trusted audit context' USING ERRCODE='55000'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.source_system='manual' THEN
      IF NEW.status<>'draft' OR NEW.version<>1 OR NEW.rework_no IS NOT NULL OR NEW.submitted_at IS NOT NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NOT NULL OR NEW.external_idempotency_key IS NOT NULL OR NEW.erp_node_id IS NOT NULL THEN RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft' USING ERRCODE='23514'; END IF;
      expected_action:='rework.draft.create'; expected_capability:='rework:initiate';
    ELSIF NEW.source_system IN ('erp','erp_emergency') THEN
      IF NEW.status<>'pending_process_configuration' OR NEW.version<>1 OR NEW.rework_no IS NULL OR NEW.submitted_at IS NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NULL OR NEW.external_idempotency_key IS NULL OR NEW.style_no IS NULL OR NEW.merchandiser_user_id IS NULL OR NEW.processing_factory_type IS NULL OR NEW.problem_part IS NULL OR NEW.problem_description IS NULL OR NEW.rework_quantity IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL THEN RAISE EXCEPTION 'ERP rework orders must enter as a complete submitted order' USING ERRCODE='23514'; END IF;
      IF NEW.source_system='erp' AND NEW.created_by<>'00000000-0000-4000-8000-000000000016'::uuid THEN RAISE EXCEPTION 'ERP intake requires dedicated integration principal' USING ERRCODE='42501'; END IF;
      expected_action:='rework.submit';
      expected_capability:=CASE NEW.source_system WHEN 'erp' THEN 'erp:integrate' ELSE 'erp:emergency_intake' END;
    ELSE
      RAISE EXCEPTION 'unsupported rework source system' USING ERRCODE='23514';
    END IF;
    audit_actor_id:=NEW.created_by;
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
