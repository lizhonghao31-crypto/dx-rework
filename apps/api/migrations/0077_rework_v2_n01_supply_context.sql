-- Rework 2.0 N01: keep the core rework order small while storing optional
-- upstream supplier/merchandiser context in its own audited draft-scoped fact.
CREATE TABLE rework_order_supply_context (
  rework_order_id uuid PRIMARY KEY REFERENCES rework_orders(rework_order_id),
  washing_supplier_id uuid,
  washing_supplier_version integer,
  embroidery_supplier_id uuid,
  embroidery_supplier_version integer,
  fabric_supplier_id uuid,
  fabric_supplier_version integer,
  embroidery_merchandiser_user_id uuid REFERENCES app_users(id),
  created_by uuid NOT NULL REFERENCES app_users(id),
  updated_by uuid NOT NULL REFERENCES app_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (washing_supplier_id,washing_supplier_version)
    REFERENCES supplier_catalog_versions(supplier_id,version),
  FOREIGN KEY (embroidery_supplier_id,embroidery_supplier_version)
    REFERENCES supplier_catalog_versions(supplier_id,version),
  FOREIGN KEY (fabric_supplier_id,fabric_supplier_version)
    REFERENCES supplier_catalog_versions(supplier_id,version),
  CHECK ((washing_supplier_id IS NULL) = (washing_supplier_version IS NULL)),
  CHECK ((embroidery_supplier_id IS NULL) = (embroidery_supplier_version IS NULL)),
  CHECK ((fabric_supplier_id IS NULL) = (fabric_supplier_version IS NULL))
);

COMMENT ON TABLE rework_order_supply_context IS
  'Optional N01 supplier relationships and embroidery merchandiser snapshot; editable only while the rework order remains draft.';

CREATE OR REPLACE FUNCTION guard_rework_order_supply_context_write()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event_id text := nullif(current_setting('dx_rework.rework_event_id', true), '');
  audit_request_id text := nullif(current_setting('dx_rework.rework_request_id', true), '');
  order_status text;
  audit_actor_id uuid;
BEGIN
  IF audit_event_id IS NULL OR audit_request_id IS NULL
     OR audit_request_id !~ '^[A-Za-z0-9._:-]{1,128}$'
  THEN
    RAISE EXCEPTION 'rework supply context write requires trusted audit context'
      USING ERRCODE='55000';
  END IF;

  SELECT status INTO order_status
  FROM rework_orders
  WHERE rework_order_id=NEW.rework_order_id;

  IF order_status IS NULL THEN
    RAISE EXCEPTION 'rework order does not exist for supply context'
      USING ERRCODE='23503';
  END IF;
  IF order_status <> 'draft' THEN
    RAISE EXCEPTION 'rework supply context is editable only while the order is draft'
      USING ERRCODE='23514';
  END IF;

  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 OR NEW.created_by<>NEW.updated_by THEN
      RAISE EXCEPTION 'new rework supply context must start at version one'
        USING ERRCODE='23514';
    END IF;
    audit_actor_id := NEW.created_by;
  ELSE
    IF NEW.rework_order_id IS DISTINCT FROM OLD.rework_order_id
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR NEW.version<>OLD.version+1
    THEN
      RAISE EXCEPTION 'stable rework supply context identity is immutable'
        USING ERRCODE='55000';
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
      AND event.action='rework.supply_context.save'
      AND event.entity_type='rework_order_supply_context'
      AND event.entity_id=NEW.rework_order_id::text
      AND event.after_state @> jsonb_build_object(
        'reworkOrderId',NEW.rework_order_id,
        'washingSupplier',CASE
          WHEN NEW.washing_supplier_id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'supplierId',NEW.washing_supplier_id,
            'supplierVersion',NEW.washing_supplier_version
          )
        END,
        'embroiderySupplier',CASE
          WHEN NEW.embroidery_supplier_id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'supplierId',NEW.embroidery_supplier_id,
            'supplierVersion',NEW.embroidery_supplier_version
          )
        END,
        'fabricSupplier',CASE
          WHEN NEW.fabric_supplier_id IS NULL THEN NULL
          ELSE jsonb_build_object(
            'supplierId',NEW.fabric_supplier_id,
            'supplierVersion',NEW.fabric_supplier_version
          )
        END,
        'embroideryMerchandiserUserId',NEW.embroidery_merchandiser_user_id,
        'version',NEW.version
      )
  ) THEN
    RAISE EXCEPTION 'rework supply context audit event does not match the write'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_order_supply_context_guard_insert
  BEFORE INSERT ON rework_order_supply_context
  FOR EACH ROW EXECUTE FUNCTION guard_rework_order_supply_context_write();

CREATE TRIGGER rework_order_supply_context_guard_update
  BEFORE UPDATE ON rework_order_supply_context
  FOR EACH ROW EXECUTE FUNCTION guard_rework_order_supply_context_write();

CREATE TRIGGER rework_order_supply_context_no_delete
  BEFORE DELETE ON rework_order_supply_context
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TRIGGER rework_order_supply_context_no_truncate
  BEFORE TRUNCATE ON rework_order_supply_context
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

-- N01 v2 intentionally retires the previous eight-field gate.  Manual
-- submission now requires only the three ownership/routing facts; image
-- evidence remains independently mandatory through the 0068/0069 guard.
ALTER TABLE rework_orders
  DROP CONSTRAINT rework_orders_n01_submission_complete_check;

ALTER TABLE rework_orders
  ADD CONSTRAINT rework_orders_n01_v2_submission_complete_check CHECK (
    status <> 'pending_process_configuration'
    OR (
      source_system='manual'
      AND rework_no IS NOT NULL
      AND style_no IS NOT NULL
      AND merchandiser_user_id IS NOT NULL
      AND processing_factory_type IS NOT NULL
    )
    OR (
      source_system<>'manual'
      AND rework_no IS NOT NULL
      AND style_no IS NOT NULL
      AND merchandiser_user_id IS NOT NULL
      AND processing_factory_type IS NOT NULL
      AND problem_part IS NOT NULL
      AND problem_description IS NOT NULL
      AND rework_quantity IS NOT NULL
    )
  ) NOT VALID;
