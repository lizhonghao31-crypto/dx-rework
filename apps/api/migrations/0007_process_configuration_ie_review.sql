ALTER TABLE rework_orders DROP CONSTRAINT rework_orders_status_check;
ALTER TABLE rework_orders ADD CONSTRAINT rework_orders_status_check
  CHECK (status IN (
    'draft',
    'pending_process_configuration',
    'pending_ie_review',
    'pending_task_assignment',
    'cancelled'
  ));

CREATE TABLE rework_process_configurations (
  configuration_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  configuration_version integer NOT NULL CHECK (configuration_version > 0),
  configuration_kind text NOT NULL CHECK (configuration_kind IN ('initial','change')),
  status text NOT NULL CHECK (status IN ('draft','pending_ie_review','approved','rejected','superseded')),
  change_reason text,
  review_reason text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at timestamptz,
  reviewed_by uuid REFERENCES app_users(id),
  reviewed_at timestamptz,
  CHECK (
    (configuration_kind='initial' AND change_reason IS NULL)
    OR
    (configuration_kind='change' AND length(btrim(change_reason)) BETWEEN 1 AND 500)
  ),
  CHECK (status<>'draft' OR submitted_at IS NULL),
  CHECK (
    status NOT IN ('approved','rejected')
    OR (reviewed_by IS NOT NULL AND reviewed_at IS NOT NULL)
  ),
  CHECK (review_reason IS NULL OR length(btrim(review_reason)) BETWEEN 1 AND 500),
  UNIQUE(rework_order_id,configuration_version)
);
CREATE UNIQUE INDEX rework_process_configurations_one_approved_idx
  ON rework_process_configurations(rework_order_id)
  WHERE status='approved';
CREATE INDEX rework_process_configurations_current_idx
  ON rework_process_configurations(rework_order_id,configuration_version DESC);

CREATE TABLE rework_process_configuration_items (
  configuration_item_id uuid PRIMARY KEY,
  configuration_id uuid NOT NULL REFERENCES rework_process_configurations(configuration_id),
  position integer NOT NULL CHECK (position > 0),
  source text NOT NULL CHECK (source IN ('catalog','custom')),
  catalog_process_id uuid REFERENCES process_catalog_items(process_id),
  catalog_process_version integer,
  custom_process_name text,
  process_name text NOT NULL CHECK (length(btrim(process_name)) BETWEEN 1 AND 100),
  pricing_unit text NOT NULL CHECK (pricing_unit IN ('piece','hour')),
  planned_quantity numeric(14,2) NOT NULL CHECK (planned_quantity > 0),
  unit_price numeric(14,3) NOT NULL CHECK (unit_price > 0),
  CHECK (
    (source='catalog'
      AND catalog_process_id IS NOT NULL
      AND catalog_process_version IS NOT NULL
      AND custom_process_name IS NULL)
    OR
    (source='custom'
      AND catalog_process_id IS NULL
      AND catalog_process_version IS NULL
      AND custom_process_name IS NOT NULL)
  ),
  CHECK (pricing_unit<>'piece' OR planned_quantity=trunc(planned_quantity)),
  UNIQUE(configuration_id,position),
  UNIQUE(configuration_id,process_name)
);

CREATE TABLE rework_custom_process_promotions (
  configuration_item_id uuid PRIMARY KEY
    REFERENCES rework_process_configuration_items(configuration_item_id),
  process_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (process_id)
    REFERENCES process_catalog_items(process_id)
    DEFERRABLE INITIALLY DEFERRED
);

CREATE OR REPLACE FUNCTION guard_rework_custom_process_promotion_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_id uuid;
  configuration_id uuid;
  configuration_status text;
BEGIN
  SELECT configuration.rework_order_id,configuration.configuration_id,configuration.status
  INTO order_id,configuration_id,configuration_status
  FROM rework_process_configuration_items item
  JOIN rework_process_configurations configuration
    ON configuration.configuration_id=item.configuration_id
  WHERE item.configuration_item_id=NEW.configuration_item_id
    AND item.source='custom'
  FOR SHARE OF configuration;
  IF order_id IS NULL OR configuration_status<>'pending_ie_review' THEN
    RAISE EXCEPTION 'only a pending IE-reviewed custom process can enter the public catalog'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_rework_process_configuration_event(
    'rework.process_configuration.review','process:review',order_id,configuration_id
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_custom_process_promotions_guard_insert
  BEFORE INSERT ON rework_custom_process_promotions
  FOR EACH ROW EXECUTE FUNCTION guard_rework_custom_process_promotion_insert();
CREATE TRIGGER rework_custom_process_promotions_no_update
  BEFORE UPDATE ON rework_custom_process_promotions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_custom_process_promotions_no_delete
  BEFORE DELETE ON rework_custom_process_promotions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_custom_process_promotions_no_truncate
  BEFORE TRUNCATE ON rework_custom_process_promotions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION require_rework_process_configuration_event(
  expected_action text,
  expected_capability text,
  order_id uuid,
  configuration_id uuid
) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.process_configuration_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.process_configuration_request_id', true), '');
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'rework process configuration requires trusted audit context'
      USING ERRCODE='55000';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.action=expected_action
      AND event.authorization_capability=expected_capability
      AND event.entity_type='rework_order'
      AND event.entity_id=order_id::text
      AND (
        event.after_state->'configuration'->>'configurationId'=configuration_id::text
        OR event.after_state->'configuration'->>'replacesConfigurationId'=configuration_id::text
      )
  ) THEN
    RAISE EXCEPTION 'rework process configuration audit event does not match the write'
      USING ERRCODE='55000';
  END IF;
END;
$$;

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
CREATE TRIGGER rework_process_configurations_guard_insert
  BEFORE INSERT ON rework_process_configurations
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_configuration_write();
CREATE TRIGGER rework_process_configurations_guard_update
  BEFORE UPDATE ON rework_process_configurations
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_configuration_write();
CREATE TRIGGER rework_process_configurations_no_delete
  BEFORE DELETE ON rework_process_configurations
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_configurations_no_truncate
  BEFORE TRUNCATE ON rework_process_configurations
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_process_configuration_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  order_id uuid;
  configuration_status text;
BEGIN
  SELECT configuration.rework_order_id,configuration.status
  INTO order_id,configuration_status
  FROM rework_process_configurations configuration
  WHERE configuration.configuration_id=NEW.configuration_id
  FOR SHARE;
  IF order_id IS NULL OR configuration_status<>'draft' THEN
    RAISE EXCEPTION 'process items can only be added to an audited draft configuration'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_rework_process_configuration_event(
    'rework.process_configuration.save','process:configure',order_id,NEW.configuration_id
  );
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_process_configuration_items_guard_insert
  BEFORE INSERT ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION guard_rework_process_configuration_item_insert();
CREATE TRIGGER rework_process_configuration_items_no_update
  BEFORE UPDATE ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_configuration_items_no_delete
  BEFORE DELETE ON rework_process_configuration_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_process_configuration_items_no_truncate
  BEFORE TRUNCATE ON rework_process_configuration_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
  expected_capability text;
  audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'rework order write requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'draft'
       OR NEW.version<>1
       OR NEW.rework_no IS NOT NULL
       OR NEW.submitted_at IS NOT NULL
       OR NEW.created_by<>NEW.updated_by
       OR NEW.source_system<>'manual'
       OR NEW.external_id IS NOT NULL
       OR NEW.external_idempotency_key IS NOT NULL
       OR NEW.erp_node_id IS NOT NULL
    THEN
      RAISE EXCEPTION 'new manual rework orders must start as an unsubmitted draft'
        USING ERRCODE = '23514';
    END IF;
    expected_action := 'rework.draft.create';
    expected_capability := 'rework:initiate';
    audit_actor_id := NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.source_system IS DISTINCT FROM OLD.source_system
       OR NEW.external_id IS DISTINCT FROM OLD.external_id
       OR NEW.external_idempotency_key IS DISTINCT FROM OLD.external_idempotency_key
       OR NEW.erp_node_id IS DISTINCT FROM OLD.erp_node_id
       OR NEW.version<>OLD.version+1
    THEN
      RAISE EXCEPTION 'stable rework order identity and origin fields are immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.rework_no IS NOT NULL AND NEW.rework_no IS DISTINCT FROM OLD.rework_no THEN
      RAISE EXCEPTION 'allocated rework number is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.submitted_at IS NOT NULL AND NEW.submitted_at IS DISTINCT FROM OLD.submitted_at THEN
      RAISE EXCEPTION 'first submission timestamp is immutable'
        USING ERRCODE = '55000';
    END IF;
    IF OLD.status='draft' AND NEW.status='draft' THEN
      expected_action := 'rework.draft.update';
      expected_capability := 'rework:initiate';
    ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN
      expected_action := 'rework.submit';
      expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN
      expected_action := 'rework.withdraw';
      expected_capability := 'rework:initiate';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_ie_review' THEN
      expected_action := 'rework.process_configuration.submit';
      expected_capability := 'process:configure';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='pending_process_configuration' THEN
      expected_action := 'rework.process_configuration.save';
      expected_capability := 'process:configure';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_process_configuration' THEN
      expected_action := 'rework.process_configuration.review';
      expected_capability := 'process:review';
    ELSIF OLD.status='pending_ie_review' AND NEW.status='pending_task_assignment' THEN
      expected_action := 'rework.process_configuration.review';
      expected_capability := 'process:review';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_ie_review' THEN
      expected_action := 'rework.process_configuration.submit';
      expected_capability := 'process:configure';
    ELSIF OLD.status='pending_task_assignment' AND NEW.status='pending_task_assignment' THEN
      expected_action := 'rework.process_configuration.save';
      expected_capability := 'process:configure';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN
      expected_action := 'rework.cancel';
      expected_capability := 'rework:initiate';
    ELSE
      RAISE EXCEPTION 'invalid rework order state transition: % to %', OLD.status, NEW.status
        USING ERRCODE = '23514';
    END IF;
    audit_actor_id := NEW.updated_by;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM operation_events event
    WHERE event.event_id=audit_event_id::uuid
      AND event.request_id=audit_request_id
      AND event.actor_id=audit_actor_id
      AND event.authorization_capability=expected_capability
      AND event.action=expected_action
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId', NEW.rework_order_id,
        'reworkNo', NEW.rework_no,
        'status', NEW.status,
        'styleNo', NEW.style_no,
        'orderNo', NEW.order_no,
        'merchandiserUserId', NEW.merchandiser_user_id,
        'processingFactory', CASE
          WHEN NEW.processing_factory_type IS NULL THEN NULL
          WHEN NEW.processing_factory_type='own_factory' THEN jsonb_build_object('type','own_factory')
          ELSE jsonb_build_object(
            'type','supplier',
            'supplierId',NEW.processing_factory_supplier_id,
            'supplierVersion',NEW.processing_factory_supplier_version
          )
        END,
        'problemPart', NEW.problem_part,
        'problemDescription', NEW.problem_description,
        'reworkQuantity', NEW.rework_quantity,
        'version', NEW.version
      )
      AND (
        NEW.status<>'cancelled'
        OR (
          event.after_state->>'cancelReason'=NEW.cancel_reason
          AND NEW.cancelled_by=audit_actor_id
        )
      )
  ) THEN
    RAISE EXCEPTION 'rework order audit event does not match the write'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_process_catalog_version_creation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  promotion_event_id text := nullif(current_setting('dx_rework.process_promotion_event_id', true), '');
  promotion_request_id text := nullif(current_setting('dx_rework.process_promotion_request_id', true), '');
  audit_event_id text := nullif(current_setting('dx_rework.process_version_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.process_version_request_id', true), '');
  audit_actor_roles text[];
  previous_version integer;
  previous_process_name text;
  previous_pricing_unit text;
  previous_active boolean;
  stable_process_code text;
  previous_state jsonb;
  audit_action text;
BEGIN
  IF promotion_event_id IS NOT NULL THEN
    IF promotion_request_id IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM rework_custom_process_promotions promotion
         JOIN rework_process_configuration_items item
           ON item.configuration_item_id=promotion.configuration_item_id
         JOIN rework_process_configurations configuration
           ON configuration.configuration_id=item.configuration_id
         JOIN operation_events event
           ON event.event_id=promotion_event_id::uuid
          AND event.request_id=promotion_request_id
          AND event.action='rework.process_configuration.review'
          AND event.authorization_capability='process:review'
          AND event.entity_type='rework_order'
          AND event.entity_id=configuration.rework_order_id::text
         WHERE promotion.process_id=NEW.process_id
           AND configuration.status='pending_ie_review'
           AND item.source='custom'
       )
       OR NEW.version<>1
    THEN
      RAISE EXCEPTION 'custom process catalog promotion requires approved IE audit context'
        USING ERRCODE='55000';
    END IF;
    RETURN NEW;
  END IF;

  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'process catalog version creation requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  audit_actor_roles := access_authorized_actor_roles(NEW.changed_by, 'master_data:manage');
  SELECT i.process_code INTO stable_process_code
  FROM process_catalog_items i WHERE i.process_id=NEW.process_id FOR UPDATE;
  IF stable_process_code IS NULL THEN
    RAISE EXCEPTION 'process catalog item does not exist' USING ERRCODE = '23503';
  END IF;
  SELECT v.version,v.process_name,v.pricing_unit,v.active
  INTO previous_version,previous_process_name,previous_pricing_unit,previous_active
  FROM process_catalog_versions v WHERE v.process_id=NEW.process_id
  ORDER BY v.version DESC LIMIT 1;
  IF previous_version IS NULL THEN
    IF NEW.version<>1 THEN
      RAISE EXCEPTION 'first process catalog version must be 1' USING ERRCODE='23514';
    END IF;
    previous_state := NULL;
    audit_action := 'master_data.process.create';
  ELSE
    IF NEW.version<>previous_version+1 THEN
      RAISE EXCEPTION 'process catalog versions must be sequential' USING ERRCODE='23514';
    END IF;
    previous_state := jsonb_build_object(
      'processCode',stable_process_code,'version',previous_version,
      'processName',previous_process_name,'pricingUnit',previous_pricing_unit,
      'active',previous_active
    );
    audit_action := 'master_data.process.revise';
  END IF;
  INSERT INTO operation_events(
    event_id,request_id,actor_id,actor_roles,authorization_capability,
    action,entity_type,entity_id,before_state,after_state,reason
  ) VALUES (
    audit_event_id::uuid,audit_request_id,NEW.changed_by,audit_actor_roles,'master_data:manage',
    audit_action,'process_catalog',NEW.process_id::text,previous_state,
    jsonb_build_object(
      'processCode',stable_process_code,'version',NEW.version,
      'processName',NEW.process_name,'pricingUnit',NEW.pricing_unit,'active',NEW.active
    ),NEW.change_reason
  );
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION require_process_catalog_initial_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  promotion_event_id text := nullif(current_setting('dx_rework.process_promotion_event_id', true), '');
  promotion_request_id text := nullif(current_setting('dx_rework.process_promotion_request_id', true), '');
BEGIN
  IF promotion_event_id IS NOT NULL AND promotion_request_id IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM rework_custom_process_promotions promotion
       JOIN rework_process_configuration_items item
         ON item.configuration_item_id=promotion.configuration_item_id
       JOIN rework_process_configurations configuration
         ON configuration.configuration_id=item.configuration_id
       JOIN operation_events event
         ON event.event_id=promotion_event_id::uuid
        AND event.request_id=promotion_request_id
        AND event.action='rework.process_configuration.review'
        AND event.authorization_capability='process:review'
        AND event.entity_type='rework_order'
        AND event.entity_id=configuration.rework_order_id::text
       JOIN process_catalog_versions version
         ON version.process_id=promotion.process_id AND version.version=1
       WHERE promotion.process_id=NEW.process_id
         AND item.source='custom'
         AND configuration.status='approved'
     )
  THEN
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM process_catalog_versions v
    JOIN operation_events e
      ON e.action='master_data.process.create'
      AND e.entity_type='process_catalog'
      AND e.entity_id=NEW.process_id::text
      AND e.actor_id=v.changed_by
      AND e.authorization_capability='master_data:manage'
      AND e.reason=v.change_reason
    WHERE v.process_id=NEW.process_id AND v.version=1
      AND e.after_state->>'processCode'=NEW.process_code
      AND (e.after_state->>'version')::integer=1
      AND e.after_state->>'processName'=v.process_name
      AND e.after_state->>'pricingUnit'=v.pricing_unit
      AND (e.after_state->>'active')::boolean=v.active
  ) THEN
    RAISE EXCEPTION 'process catalog item requires an authorized audited initial version in the same transaction'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
