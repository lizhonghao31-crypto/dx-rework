-- External-sourcing crafts are independent from rework process configuration.
-- Existing sourcing orders keep their ordered text snapshot; this catalog is the
-- reusable master-data source for new sourcing orders.

CREATE TABLE craft_catalog_items (
  craft_id uuid PRIMARY KEY,
  craft_code text NOT NULL UNIQUE
    CHECK (craft_code ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  craft_name text NOT NULL
    CHECK (length(btrim(craft_name)) BETWEEN 1 AND 100),
  normalized_name text GENERATED ALWAYS AS (lower(btrim(craft_name))) STORED,
  external_source text,
  external_id text,
  created_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL
    CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (normalized_name),
  CHECK ((external_source IS NULL) = (external_id IS NULL)),
  CHECK (external_source IS NULL OR length(btrim(external_source)) BETWEEN 1 AND 50),
  CHECK (external_id IS NULL OR length(btrim(external_id)) BETWEEN 1 AND 200)
);

-- Seed reusable crafts from historical external-sourcing orders without changing
-- any order snapshot. One auditable creation event is retained for every craft.
WITH historical_names AS MATERIALIZED (
  SELECT DISTINCT ON (lower(btrim(item.craft_name)))
    btrim(item.craft_name) AS craft_name,
    sourcing_case.created_by
  FROM sourcing_cases sourcing_case
  CROSS JOIN LATERAL unnest(sourcing_case.process_items) item(craft_name)
  WHERE sourcing_case.process_items IS NOT NULL
  ORDER BY lower(btrim(item.craft_name)), sourcing_case.created_at, sourcing_case.sourcing_case_id
), prepared AS MATERIALIZED (
  SELECT
    gen_random_uuid() AS craft_id,
    ('CRAFT_' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 24))) AS craft_code,
    craft_name,
    created_by,
    ('migration-0133-' || substr(md5(lower(craft_name)), 1, 24)) AS request_id
  FROM historical_names
), audit_events AS (
  INSERT INTO operation_events(
    event_id, request_id, actor_id, actor_roles, authorization_capability,
    action, entity_type, entity_id, before_state, after_state, reason
  )
  SELECT
    gen_random_uuid(), prepared.request_id, prepared.created_by,
    ARRAY['migration_backfill']::text[], 'sourcing:view',
    'master_data.craft.create', 'craft_catalog', prepared.craft_id::text, NULL,
    jsonb_build_object(
      'craftId', prepared.craft_id,
      'craftCode', prepared.craft_code,
      'craftName', prepared.craft_name
    ),
    '0133外发历史工艺建档'
  FROM prepared
  RETURNING event_id, entity_id
)
INSERT INTO craft_catalog_items(
  craft_id, craft_code, craft_name, created_by, operation_event_id, request_id
)
SELECT
  prepared.craft_id, prepared.craft_code, prepared.craft_name, prepared.created_by,
  audit_events.event_id, prepared.request_id
FROM prepared
JOIN audit_events ON audit_events.entity_id=prepared.craft_id::text;

CREATE OR REPLACE FUNCTION guard_craft_catalog_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
BEGIN
  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  IF audit_event.event_id IS NULL
     OR audit_event.request_id <> NEW.request_id
     OR audit_event.actor_id <> NEW.created_by
     OR audit_event.action <> 'master_data.craft.create'
     OR audit_event.entity_type <> 'craft_catalog'
     OR audit_event.entity_id <> NEW.craft_id::text
     OR audit_event.after_state->>'craftId' <> NEW.craft_id::text
     OR audit_event.after_state->>'craftCode' <> NEW.craft_code
     OR audit_event.after_state->>'craftName' <> NEW.craft_name
  THEN
    RAISE EXCEPTION 'craft catalog creation requires matching audit event'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craft_catalog_items_guard_insert
  BEFORE INSERT ON craft_catalog_items
  FOR EACH ROW EXECUTE FUNCTION guard_craft_catalog_creation();
CREATE TRIGGER craft_catalog_items_no_update
  BEFORE UPDATE ON craft_catalog_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER craft_catalog_items_no_delete
  BEFORE DELETE ON craft_catalog_items
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER craft_catalog_items_no_truncate
  BEFORE TRUNCATE ON craft_catalog_items
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX craft_catalog_items_name_search_idx
  ON craft_catalog_items(normalized_name, craft_code);
