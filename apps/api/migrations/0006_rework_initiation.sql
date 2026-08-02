CREATE TABLE rework_order_number_counters (
  issue_date date PRIMARY KEY,
  last_value bigint NOT NULL CHECK (last_value > 0)
);

CREATE OR REPLACE FUNCTION next_rework_order_number() RETURNS text LANGUAGE plpgsql AS $$
DECLARE
  issue_day date := CURRENT_DATE;
  next_value bigint;
  sequence_text text;
BEGIN
  INSERT INTO rework_order_number_counters(issue_date,last_value)
  VALUES(issue_day,1)
  ON CONFLICT(issue_date) DO UPDATE
  SET last_value=rework_order_number_counters.last_value+1
  RETURNING last_value INTO next_value;

  sequence_text := next_value::text;
  IF length(sequence_text) < 3 THEN
    sequence_text := lpad(sequence_text,3,'0');
  END IF;
  RETURN 'RW-' || to_char(issue_day,'YYYY-MMDD') || '-' || sequence_text;
END;
$$;

CREATE TABLE rework_orders (
  rework_order_id uuid PRIMARY KEY,
  rework_no text UNIQUE,
  status text NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','pending_process_configuration','cancelled')),
  source_system text NOT NULL DEFAULT 'manual'
    CHECK (length(btrim(source_system)) BETWEEN 1 AND 100),
  external_id text,
  external_idempotency_key text,
  erp_node_id text,
  style_no text CHECK (style_no IS NULL OR length(btrim(style_no)) BETWEEN 1 AND 100),
  order_no text CHECK (order_no IS NULL OR length(btrim(order_no)) BETWEEN 1 AND 100),
  merchandiser_user_id uuid REFERENCES app_users(id),
  processing_factory_type text
    CHECK (processing_factory_type IS NULL OR processing_factory_type IN ('own_factory','supplier')),
  processing_factory_supplier_id uuid,
  processing_factory_supplier_version integer,
  problem_part text CHECK (problem_part IS NULL OR length(btrim(problem_part)) BETWEEN 1 AND 200),
  problem_description text
    CHECK (problem_description IS NULL OR length(btrim(problem_description)) BETWEEN 1 AND 2000),
  rework_quantity integer CHECK (rework_quantity IS NULL OR rework_quantity > 0),
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at timestamptz,
  cancelled_at timestamptz,
  cancelled_by uuid REFERENCES app_users(id),
  cancel_reason text CHECK (cancel_reason IS NULL OR length(btrim(cancel_reason)) BETWEEN 1 AND 500),
  FOREIGN KEY (processing_factory_supplier_id,processing_factory_supplier_version)
    REFERENCES supplier_catalog_versions(supplier_id,version),
  CHECK (external_id IS NULL OR length(btrim(external_id)) BETWEEN 1 AND 200),
  CHECK (
    external_idempotency_key IS NULL
    OR length(btrim(external_idempotency_key)) BETWEEN 1 AND 200
  ),
  CHECK (erp_node_id IS NULL OR length(btrim(erp_node_id)) BETWEEN 1 AND 200),
  CHECK (source_system='manual' OR external_id IS NOT NULL),
  CHECK (
    (processing_factory_type IS NULL
      AND processing_factory_supplier_id IS NULL
      AND processing_factory_supplier_version IS NULL)
    OR
    (processing_factory_type='own_factory'
      AND processing_factory_supplier_id IS NULL
      AND processing_factory_supplier_version IS NULL)
    OR
    (processing_factory_type='supplier'
      AND processing_factory_supplier_id IS NOT NULL
      AND processing_factory_supplier_version IS NOT NULL)
  ),
  CHECK ((rework_no IS NULL) = (submitted_at IS NULL)),
  CHECK (
    status <> 'pending_process_configuration'
    OR (
      rework_no IS NOT NULL
      AND style_no IS NOT NULL
      AND merchandiser_user_id IS NOT NULL
      AND processing_factory_type IS NOT NULL
      AND problem_part IS NOT NULL
      AND problem_description IS NOT NULL
      AND rework_quantity IS NOT NULL
    )
  ),
  CHECK (
    (status='cancelled'
      AND cancelled_at IS NOT NULL
      AND cancelled_by IS NOT NULL
      AND cancel_reason IS NOT NULL)
    OR
    (status<>'cancelled'
      AND cancelled_at IS NULL
      AND cancelled_by IS NULL
      AND cancel_reason IS NULL)
  )
);
CREATE UNIQUE INDEX rework_orders_external_source_idx
  ON rework_orders(source_system,external_id)
  WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX rework_orders_external_idempotency_idx
  ON rework_orders(source_system,external_idempotency_key)
  WHERE external_idempotency_key IS NOT NULL;
CREATE INDEX rework_orders_creator_status_idx
  ON rework_orders(created_by,status,updated_at DESC);
CREATE INDEX rework_orders_style_status_idx
  ON rework_orders(style_no,status,updated_at DESC)
  WHERE style_no IS NOT NULL;

CREATE OR REPLACE FUNCTION guard_rework_order_write() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  expected_action text;
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
    ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN
      expected_action := 'rework.submit';
    ELSIF OLD.status='pending_process_configuration' AND NEW.status='draft' THEN
      expected_action := 'rework.withdraw';
    ELSIF OLD.status IN ('draft','pending_process_configuration') AND NEW.status='cancelled' THEN
      expected_action := 'rework.cancel';
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
      AND event.authorization_capability='rework:initiate'
      AND event.action=expected_action
      AND event.entity_type='rework_order'
      AND event.entity_id=NEW.rework_order_id::text
      AND event.after_state->>'status'=NEW.status
      AND (event.after_state->>'version')::integer=NEW.version
  ) THEN
    RAISE EXCEPTION 'rework order audit event does not match the write'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER rework_orders_guard_insert
  BEFORE INSERT ON rework_orders FOR EACH ROW EXECUTE FUNCTION guard_rework_order_write();
CREATE TRIGGER rework_orders_guard_update
  BEFORE UPDATE ON rework_orders FOR EACH ROW EXECUTE FUNCTION guard_rework_order_write();
CREATE TRIGGER rework_orders_no_delete
  BEFORE DELETE ON rework_orders FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER rework_orders_no_truncate
  BEFORE TRUNCATE ON rework_orders FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE OR REPLACE FUNCTION guard_rework_attachment_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  order_id uuid;
  order_creator uuid;
  order_status text;
BEGIN
  IF OLD.entity_type='rework_order'
     AND (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
  THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'bound rework evidence is immutable'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF (OLD.entity_type,OLD.entity_id) IS NOT DISTINCT FROM (NEW.entity_type,NEW.entity_id)
     OR (OLD.entity_type IS DISTINCT FROM 'rework_order'
         AND NEW.entity_type IS DISTINCT FROM 'rework_order')
  THEN
    RETURN NEW;
  END IF;

  IF audit_event_id IS NULL OR audit_request_id IS NULL THEN
    RAISE EXCEPTION 'rework attachment binding requires trusted audit context'
      USING ERRCODE = '55000';
  END IF;
  IF NOT (
    (OLD.entity_type IS NULL AND OLD.entity_id IS NULL
      AND NEW.entity_type='rework_order' AND NEW.entity_id IS NOT NULL)
    OR
    (OLD.entity_type='rework_order' AND OLD.entity_id IS NOT NULL
      AND NEW.entity_type IS NULL AND NEW.entity_id IS NULL)
  ) THEN
    RAISE EXCEPTION 'rework attachments cannot be moved directly between entities'
      USING ERRCODE = '23514';
  END IF;

  order_id := COALESCE(NEW.entity_id,OLD.entity_id)::uuid;
  SELECT created_by,status INTO order_creator,order_status
  FROM rework_orders
  WHERE rework_order_id=order_id;
  IF order_creator IS NULL OR order_status<>'draft' THEN
    RAISE EXCEPTION 'attachments can only be changed on an owned draft'
      USING ERRCODE = '23514';
  END IF;
  IF NEW.status<>'ready' OR NEW.uploaded_by<>order_creator THEN
    RAISE EXCEPTION 'only the creator ready attachment can be bound to a draft'
      USING ERRCODE = '42501';
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
        (NEW.entity_type='rework_order'
          AND event.after_state->'attachmentIds' ? NEW.attachment_id::text)
        OR
        (OLD.entity_type='rework_order'
          AND NOT (event.after_state->'attachmentIds' ? OLD.attachment_id::text))
      )
  ) THEN
    RAISE EXCEPTION 'rework attachment audit event does not match the binding'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER attachments_rework_binding_guard
  BEFORE UPDATE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_rework_attachment_binding();

CREATE OR REPLACE FUNCTION guard_rework_attachment_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM attachments WHERE entity_type='rework_order') THEN
      RAISE EXCEPTION 'bound rework evidence cannot be truncated'
        USING ERRCODE = '55000';
    END IF;
    RETURN NULL;
  END IF;
  IF OLD.entity_type='rework_order' THEN
    RAISE EXCEPTION 'bound rework evidence cannot be deleted'
      USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;
CREATE TRIGGER attachments_rework_no_delete
  BEFORE DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION guard_rework_attachment_delete();
CREATE TRIGGER attachments_rework_no_truncate
  BEFORE TRUNCATE ON attachments FOR EACH STATEMENT EXECUTE FUNCTION guard_rework_attachment_delete();
