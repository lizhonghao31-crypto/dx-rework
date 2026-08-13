-- N07–N11 responsibility settlement governance.
--
-- V2 deliberately starts on new submissions only.  Historic test snapshots
-- are not transformed: a V2 determination carries its own party multiplier
-- and supplier snapshot, then passes through the explicit owner signature.

ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check CHECK (status IN (
  'draft','pending_process_configuration','pending_ie_review','pending_task_assignment',
  'in_progress','pending_order_review','pending_quantity_adjustment_ie_review',
  'pending_responsibility_determination','pending_owner_signature',
  'pending_responsibility_action','completed','cancelled','deleted'
));

ALTER TABLE rework_responsibility_determinations
  ADD COLUMN settlement_schema_version smallint NOT NULL DEFAULT 1
  CHECK (settlement_schema_version IN (1,2));

ALTER TABLE rework_responsibility_allocations
  ADD COLUMN multiplier numeric(8,3),
  ADD COLUMN supplier_id uuid,
  ADD COLUMN supplier_version integer,
  ADD COLUMN supplier_code_snapshot text,
  ADD COLUMN supplier_name_snapshot text,
  ADD COLUMN supplier_type_snapshot text CHECK (supplier_type_snapshot IN ('factory','embroidery_washing','fabric')),
  ADD CONSTRAINT rework_responsibility_allocations_supplier_snapshot_check CHECK (
    (supplier_id IS NULL AND supplier_version IS NULL AND supplier_code_snapshot IS NULL
      AND supplier_name_snapshot IS NULL AND supplier_type_snapshot IS NULL)
    OR
    (supplier_id IS NOT NULL AND supplier_version IS NOT NULL AND supplier_code_snapshot IS NOT NULL
      AND supplier_name_snapshot IS NOT NULL AND supplier_type_snapshot IS NOT NULL)
  ),
  ADD CONSTRAINT rework_responsibility_allocations_supplier_version_fk
    FOREIGN KEY (supplier_id,supplier_version)
    REFERENCES supplier_catalog_versions(supplier_id,version);

CREATE TABLE rework_responsibility_owner_signatures (
  owner_signature_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders,
  determination_id uuid NOT NULL REFERENCES rework_responsibility_determinations,
  decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  signed_by uuid NOT NULL REFERENCES app_users,
  signed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  UNIQUE(determination_id,decision)
);
CREATE INDEX rework_responsibility_owner_signatures_order_idx
  ON rework_responsibility_owner_signatures(rework_order_id,signed_at DESC);

CREATE OR REPLACE FUNCTION guard_rework_responsibility_owner_signature()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text:=nullif(current_setting('dx_rework.responsibility_event_id',true),'');
  audit_request_id text:=nullif(current_setting('dx_rework.responsibility_request_id',true),'');
  expected_action text:=CASE NEW.decision
    WHEN 'approved' THEN 'rework.responsibility.owner_approve'
    ELSE 'rework.responsibility.owner_reject' END;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL THEN
    RAISE EXCEPTION 'owner signature requires trusted audit context' USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM rework_orders order_record
    JOIN rework_responsibility_determinations determination
      ON determination.determination_id=NEW.determination_id
     AND determination.rework_order_id=order_record.rework_order_id
     AND determination.stage='finalized'
    WHERE order_record.rework_order_id=NEW.rework_order_id
      AND order_record.status='pending_owner_signature'
  ) THEN
    RAISE EXCEPTION 'owner signature requires pending_owner_signature finalized determination'
      USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.action=expected_action
      AND event.authorization_capability='responsibility:owner_sign'
      AND event.actor_id=NEW.signed_by
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
  ) THEN
    RAISE EXCEPTION 'owner signature audit event does not match the write' USING ERRCODE='55000';
  END IF;
  IF NOT responsibility_actor_has_direct_role(
    NEW.signed_by,'responsibility:owner_sign',ARRAY['owner_group']
  ) THEN
    RAISE EXCEPTION 'owner signature requires a direct active owner or root' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rework_responsibility_owner_signature_insert
  BEFORE INSERT ON rework_responsibility_owner_signatures
  FOR EACH ROW EXECUTE FUNCTION guard_rework_responsibility_owner_signature();
CREATE TRIGGER rework_responsibility_owner_signature_no_update
  BEFORE UPDATE ON rework_responsibility_owner_signatures
  FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();
CREATE TRIGGER rework_responsibility_owner_signature_no_delete
  BEFORE DELETE ON rework_responsibility_owner_signatures
  FOR EACH ROW EXECUTE FUNCTION reject_responsibility_mutation();

DROP TRIGGER capability_catalog_no_insert ON capability_catalog;
DROP TRIGGER role_capabilities_no_insert ON role_capabilities;
INSERT INTO capability_catalog(capability,display_name,description) VALUES
  ('responsibility:owner_sign','老板确认签字','确认或驳回生产管理提交的责任资料与责任比例')
ON CONFLICT DO NOTHING;
INSERT INTO role_capabilities(role_code,capability) VALUES
  ('owner_group','responsibility:owner_sign')
ON CONFLICT DO NOTHING;
CREATE TRIGGER capability_catalog_no_insert BEFORE INSERT ON capability_catalog
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER role_capabilities_no_insert BEFORE INSERT ON role_capabilities
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

-- Preserve every pre-existing transition and add only the N07 → N08 → N10
-- V2 path.  The audit event remains the database trust boundary.
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
      IF NEW.status<>'pending_process_configuration' OR NEW.version<>1 OR NEW.rework_no IS NULL OR NEW.submitted_at IS NULL OR NEW.created_by<>NEW.updated_by OR NEW.external_id IS NULL OR NEW.external_idempotency_key IS NULL OR NEW.erp_node_id IS NOT NULL OR NEW.style_no IS NULL OR NEW.merchandiser_user_id IS NULL OR NEW.processing_factory_type IS NULL OR NEW.problem_part IS NULL OR NEW.problem_description IS NULL OR NEW.rework_quantity IS NULL OR NEW.cancelled_at IS NOT NULL OR NEW.cancelled_by IS NOT NULL OR NEW.cancel_reason IS NOT NULL OR NEW.deleted_at IS NOT NULL OR NEW.deleted_by IS NOT NULL THEN RAISE EXCEPTION 'ERP rework orders must enter as a complete submitted order' USING ERRCODE='23514'; END IF;
      IF NEW.source_system='erp' AND NEW.created_by<>'00000000-0000-4000-8000-000000000016'::uuid THEN RAISE EXCEPTION 'ERP intake requires dedicated integration principal' USING ERRCODE='42501'; END IF;
      expected_action:='rework.submit'; expected_capability:=CASE NEW.source_system WHEN 'erp' THEN 'erp:integrate' ELSE 'erp:emergency_intake' END;
    ELSE RAISE EXCEPTION 'unsupported rework source system' USING ERRCODE='23514'; END IF;
    audit_actor_id:=NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.external_id IS DISTINCT FROM OLD.external_id OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'stable rework order identity and origin fields are immutable' USING ERRCODE='55000'; END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN RAISE EXCEPTION 'allocated rework number is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN RAISE EXCEPTION 'first submission timestamp is immutable' USING ERRCODE='55000'; END IF;
    IF OLD.status='deleted' THEN RAISE EXCEPTION 'deleted rework orders are immutable' USING ERRCODE='55000'; END IF;
    IF NEW.status='deleted' THEN
      IF NEW.deleted_at IS NULL OR NEW.deleted_by IS NULL OR (to_jsonb(NEW) - ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','deleted_at','deleted_by','updated_by','version','updated_at']) THEN RAISE EXCEPTION 'logical deletion may only update deletion metadata' USING ERRCODE='23514'; END IF;
      expected_action:='rework.delete'; expected_capability:='rework:delete';
    ELSIF EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.action='rework.attachments.supplement' AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text) THEN
      IF OLD.status IN ('completed','cancelled','deleted') OR (to_jsonb(NEW) - ARRAY['updated_by','version','updated_at']) IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['updated_by','version','updated_at']) THEN RAISE EXCEPTION 'supplemental images may only update active order audit metadata' USING ERRCODE='23514'; END IF;
      expected_action:='rework.attachments.supplement'; expected_capability:='rework:initiate';
    ELSE
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
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_owner_signature' THEN expected_action:='rework.responsibility.submit_owner_signature'; expected_capability:='responsibility:determine';
      ELSIF OLD.status='pending_responsibility_determination' AND NEW.status='pending_responsibility_action' THEN expected_action:='rework.responsibility.finalize'; expected_capability:='responsibility:determine';
      ELSIF OLD.status='pending_owner_signature' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.responsibility.owner_reject'; expected_capability:='responsibility:owner_sign';
      ELSIF OLD.status='pending_owner_signature' AND NEW.status='completed' THEN expected_action:='rework.responsibility.owner_approve'; expected_capability:='responsibility:owner_sign';
      ELSIF OLD.status='pending_responsibility_action' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.own_factory_approval.reject'; expected_capability:='own_factory:approve'; alternative_action:='rework.external_responsibility.revision.approve'; alternative_capability:='external_responsibility:approve_revision';
      ELSIF OLD.status='pending_responsibility_action' AND NEW.status='completed' THEN expected_action:='rework.responsibility.complete'; expected_capability:='external_responsibility:payables_confirm'; alternative_action:='rework.responsibility.complete'; alternative_capability:='own_factory:approve'; alternative_action_two:='rework.responsibility.complete'; alternative_capability_two:='responsibility:determine';
      ELSIF OLD.status='completed' AND NEW.status='pending_responsibility_determination' THEN expected_action:='rework.external_responsibility.revision.approve'; expected_capability:='external_responsibility:approve_revision';
      ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN expected_action:='rework.cancel'; expected_capability:='rework:initiate';
      ELSE RAISE EXCEPTION 'invalid rework order state transition: % to %',OLD.status,NEW.status USING ERRCODE='23514'; END IF;
    END IF;
    audit_actor_id:=NEW.updated_by;
  END IF;
  IF NOT EXISTS(SELECT 1 FROM operation_events event WHERE event.event_id=audit_event_id::uuid AND event.request_id=audit_request_id AND event.actor_id=audit_actor_id AND event.entity_type='rework_order' AND event.entity_id=NEW.rework_order_id::text AND ((event.action=expected_action AND (event.authorization_capability=expected_capability OR (expected_action='rework.work_report.submit' AND event.authorization_capability IN ('work:report','work:report_for_worker')))) OR (alternative_action IS NOT NULL AND event.action=alternative_action AND event.authorization_capability=alternative_capability) OR (alternative_action_two IS NOT NULL AND event.action=alternative_action_two AND event.authorization_capability=alternative_capability_two) OR (alternative_action_three IS NOT NULL AND event.action=alternative_action_three AND event.authorization_capability=alternative_capability_three)) AND event.after_state @> jsonb_build_object('reworkOrderId',NEW.rework_order_id,'reworkNo',NEW.rework_no,'status',NEW.status,'styleNo',NEW.style_no,'orderNo',NEW.order_no,'merchandiserUserId',NEW.merchandiser_user_id,'processingFactory',CASE WHEN NEW.processing_factory_type IS NULL THEN NULL WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory') ELSE jsonb_build_object('type','supplier','supplierId',NEW.processing_factory_supplier_id,'supplierVersion',NEW.processing_factory_supplier_version) END,'problemPart',NEW.problem_part,'problemDescription',NEW.problem_description,'reworkQuantity',NEW.rework_quantity,'version',NEW.version) AND (NEW.status<>'cancelled' OR (event.after_state->>'cancelReason'=NEW.cancel_reason AND NEW.cancelled_by=audit_actor_id)) AND (NEW.status<>'deleted' OR (event.after_state->>'deletedBy'=NEW.deleted_by::text AND NEW.deleted_by=audit_actor_id))) THEN RAISE EXCEPTION 'rework order audit event does not match the write' USING ERRCODE='55000'; END IF;
  RETURN NEW;
END $$;

-- N09 is generated by the server from the immutable N07 responsibility
-- submission after N08 owner approval.  V2 carries the supplier and
-- multiplier on every responsibility party, rather than asking payables to
-- choose or re-confirm them.  Keep the V1 guards below intact for historic
-- records, but admit the stricter V2 materialisation path.
CREATE OR REPLACE FUNCTION guard_external_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  allocation rework_responsibility_allocations%ROWTYPE;
  process rework_responsibility_processes%ROWTYPE;
  batch rework_external_responsibility_batches%ROWTYPE;
  determination rework_responsibility_determinations%ROWTYPE;
BEGIN
  SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
  SELECT * INTO determination FROM rework_responsibility_determinations
    WHERE determination_id=NEW.determination_id;
  SELECT * INTO allocation FROM rework_responsibility_allocations WHERE determination_id=NEW.determination_id
    AND configuration_item_id=NEW.configuration_item_id AND responsibility_type=NEW.responsibility_type;
  SELECT * INTO process FROM rework_responsibility_processes WHERE determination_id=NEW.determination_id
    AND configuration_item_id=NEW.configuration_item_id;
  IF batch.batch_id IS NULL OR determination.determination_id IS NULL
     OR NEW.determination_id<>batch.finalized_determination_id
     OR allocation.determination_id IS NULL OR process.determination_id IS NULL
     OR NEW.proposed_amount<>allocation.rounded_amount
     OR NEW.multiplier_snapshot<>COALESCE(allocation.multiplier,process.multiplier)
     OR NEW.share_bps_snapshot<>allocation.share_bps
     OR NEW.operation_event_id<>batch.operation_event_id
     OR NEW.request_id<>batch.request_id THEN
    RAISE EXCEPTION 'external item snapshot does not match finalized responsibility'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch rework_external_responsibility_batches%ROWTYPE;
  supplier current_supplier_catalog%ROWTYPE;
  supplier_version supplier_catalog_versions%ROWTYPE;
  supplier_item supplier_catalog_items%ROWTYPE;
  order_record rework_orders%ROWTYPE;
  determination rework_responsibility_determinations%ROWTYPE;
  event_action text;
  automatic_route boolean;
BEGIN
  SELECT * INTO batch FROM rework_external_responsibility_batches WHERE batch_id=NEW.batch_id;
  SELECT * INTO determination FROM rework_responsibility_determinations
    WHERE determination_id=batch.finalized_determination_id;
  SELECT * INTO supplier FROM current_supplier_catalog WHERE supplier_id=NEW.supplier_id;
  SELECT * INTO order_record FROM rework_orders WHERE rework_order_id=NEW.rework_order_id;
  SELECT action INTO event_action FROM operation_events WHERE event_id=NEW.operation_event_id;

  IF determination.settlement_schema_version=2 THEN
    SELECT * INTO supplier_version FROM supplier_catalog_versions
      WHERE supplier_id=NEW.supplier_id AND version=NEW.supplier_version;
    SELECT * INTO supplier_item FROM supplier_catalog_items
      WHERE supplier_id=NEW.supplier_id;
    IF batch.batch_id IS NULL OR batch.rework_order_id<>NEW.rework_order_id
       OR batch.status<>'active' OR supplier_version.supplier_id IS NULL
       OR supplier_item.supplier_id IS NULL
       OR supplier_item.supplier_type<>external_responsibility_expected_supplier_type(NEW.responsibility_type)
       OR NEW.supplier_code_snapshot<>supplier_item.supplier_code
       OR NEW.supplier_name_snapshot<>supplier_version.supplier_name
       OR NEW.supplier_type_snapshot<>supplier_item.supplier_type
       OR NEW.case_version<>1 THEN
      RAISE EXCEPTION 'V2 supplier ledger snapshot is invalid' USING ERRCODE='23514';
    END IF;
    IF NEW.status<>'deduction_follow_up' OR NEW.submitted_at IS NULL
       OR NEW.payables_confirmed_at IS NULL
       OR NEW.business_handler_user_id<>determination.created_by
       OR NEW.operation_event_id<>determination.operation_event_id
       OR NEW.request_id<>determination.request_id THEN
      RAISE EXCEPTION 'V2 supplier ledger must be server-created from N07 facts'
        USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.responsibility.submit_owner_signature','responsibility:determine',
      NEW.rework_order_id,NEW.created_by
    );
    RETURN NEW;
  END IF;

  IF batch.batch_id IS NULL OR determination.determination_id IS NULL
     OR batch.rework_order_id<>NEW.rework_order_id OR batch.status<>'active'
     OR supplier.supplier_id IS NULL OR supplier.active IS DISTINCT FROM true
     OR supplier.version<>NEW.supplier_version
     OR supplier.supplier_type<>external_responsibility_expected_supplier_type(NEW.responsibility_type)
     OR NEW.supplier_code_snapshot<>supplier.supplier_code
     OR NEW.supplier_name_snapshot<>supplier.supplier_name
     OR NEW.supplier_type_snapshot<>supplier.supplier_type
     OR NEW.case_version<>1 THEN
    RAISE EXCEPTION 'external case supplier or snapshot is invalid' USING ERRCODE='23514';
  END IF;

  IF NEW.status<>'pending_payables_confirmation'
     OR NEW.submitted_at IS NULL OR NEW.payables_confirmed_at IS NOT NULL
     OR NOT external_responsibility_can_sign(
       NEW.business_handler_user_id,NEW.rework_order_id,NEW.responsibility_type
     ) THEN
    RAISE EXCEPTION 'external case supplier, handler or snapshot is invalid'
      USING ERRCODE='23514';
  END IF;

  automatic_route := event_action='rework.external_responsibility.auto_route';
  IF automatic_route THEN
    IF NEW.responsibility_type<>'processing_factory'
       OR order_record.processing_factory_type IS DISTINCT FROM 'supplier'
       OR NEW.supplier_id<>order_record.processing_factory_supplier_id
       OR NEW.business_handler_user_id IS DISTINCT FROM order_record.merchandiser_user_id
       OR NEW.processing_factory_override_reason IS NOT NULL THEN
      RAISE EXCEPTION 'automatic processing-factory route is not valid'
        USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.auto_route','responsibility:determine',
      NEW.rework_order_id,NEW.created_by
    );
    RETURN NEW;
  END IF;
  IF NEW.responsibility_type='processing_factory'
     AND order_record.processing_factory_type='supplier'
     AND NEW.supplier_id IS DISTINCT FROM order_record.processing_factory_supplier_id
     AND NEW.processing_factory_override_reason IS NULL THEN
    RAISE EXCEPTION 'processing-factory override requires a reason'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event(
    'rework.external_responsibility.allocate','external_responsibility:sign',
    NEW.rework_order_id,NEW.created_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  item rework_external_responsibility_items%ROWTYPE;
  order_record rework_orders%ROWTYPE;
  determination rework_responsibility_determinations%ROWTYPE;
  event_action text;
  automatic_route boolean;
BEGIN
  SELECT * INTO target_case FROM rework_external_responsibility_cases WHERE case_id=NEW.case_id;
  SELECT * INTO item FROM rework_external_responsibility_items WHERE external_item_id=NEW.external_item_id;
  SELECT * INTO determination FROM rework_responsibility_determinations WHERE determination_id=item.determination_id;
  SELECT * INTO order_record FROM rework_orders WHERE rework_order_id=target_case.rework_order_id;
  SELECT action INTO event_action FROM operation_events WHERE event_id=target_case.operation_event_id;
  IF target_case.case_id IS NULL OR item.external_item_id IS NULL
     OR determination.determination_id IS NULL
     OR target_case.batch_id<>item.batch_id
     OR target_case.responsibility_type<>item.responsibility_type THEN
    RAISE EXCEPTION 'external responsibility item cannot be assigned to this case'
      USING ERRCODE='23514';
  END IF;
  IF determination.settlement_schema_version=2 THEN
    IF target_case.status<>'deduction_follow_up'
       OR NEW.operation_event_id<>item.operation_event_id
       OR NEW.request_id<>item.request_id THEN
      RAISE EXCEPTION 'V2 supplier ledger item must be server-created' USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.responsibility.submit_owner_signature','responsibility:determine',
      target_case.rework_order_id,target_case.created_by
    );
    RETURN NEW;
  END IF;
  IF target_case.status<>'pending_payables_confirmation' OR target_case.submitted_at IS NULL THEN
    RAISE EXCEPTION 'external responsibility item cannot be assigned to this case'
      USING ERRCODE='23514';
  END IF;
  automatic_route := event_action='rework.external_responsibility.auto_route';
  IF automatic_route THEN
    IF target_case.responsibility_type<>'processing_factory'
       OR order_record.processing_factory_type IS DISTINCT FROM 'supplier'
       OR target_case.supplier_id<>order_record.processing_factory_supplier_id
       OR target_case.business_handler_user_id IS DISTINCT FROM order_record.merchandiser_user_id
       OR target_case.processing_factory_override_reason IS NOT NULL THEN
      RAISE EXCEPTION 'automatic processing-factory route is not valid'
        USING ERRCODE='23514';
    END IF;
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.auto_route','responsibility:determine',
      target_case.rework_order_id,target_case.created_by
    );
  ELSE
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.allocate','external_responsibility:sign',
      target_case.rework_order_id,target_case.created_by
    );
  END IF;
  RETURN NEW;
END $$;
