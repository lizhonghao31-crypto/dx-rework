-- Convert the external-sourcing craft catalog into versioned, auditable master data.
-- Historical order free text imported by 0133 remains archived identity/audit data and
-- is deliberately not promoted into the current reusable craft catalog.

CREATE TABLE craft_catalog_versions (
  craft_id uuid NOT NULL REFERENCES craft_catalog_items(craft_id),
  version integer NOT NULL CHECK (version > 0),
  craft_name text NOT NULL CHECK (length(btrim(craft_name)) BETWEEN 1 AND 100),
  normalized_name text GENERATED ALWAYS AS (lower(btrim(craft_name))) STORED,
  active boolean NOT NULL,
  change_reason text NOT NULL CHECK (length(btrim(change_reason)) BETWEEN 1 AND 500),
  changed_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (craft_id, version)
);

-- Preserve crafts explicitly created through the business/API entry before this
-- migration. Rows produced by the 0133 historical migration have actor role
-- migration_backfill and intentionally receive no reusable catalog version.
INSERT INTO craft_catalog_versions(
  craft_id, version, craft_name, active, change_reason, changed_by,
  operation_event_id, request_id, created_at
)
SELECT
  item.craft_id, 1, item.craft_name, true,
  COALESCE(event.reason, '外发业务页新增工艺'), item.created_by,
  item.operation_event_id, item.request_id, item.created_at
FROM craft_catalog_items item
JOIN operation_events event ON event.event_id=item.operation_event_id
WHERE NOT ('migration_backfill'=ANY(event.actor_roles));

CREATE OR REPLACE FUNCTION guard_craft_catalog_version_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  stable_craft_code text;
  previous_version integer;
  previous_craft_name text;
  previous_active boolean;
  previous_state jsonb;
BEGIN
  SELECT craft_code INTO stable_craft_code
  FROM craft_catalog_items
  WHERE craft_id=NEW.craft_id
  FOR UPDATE;
  IF stable_craft_code IS NULL THEN
    RAISE EXCEPTION 'craft catalog item does not exist' USING ERRCODE='23503';
  END IF;

  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  SELECT version,craft_name,active
  INTO previous_version,previous_craft_name,previous_active
  FROM craft_catalog_versions
  WHERE craft_id=NEW.craft_id
  ORDER BY version DESC
  LIMIT 1;

  IF previous_version IS NULL THEN
    IF NEW.version<>1 OR audit_event.action<>'master_data.craft.create'
       OR audit_event.before_state IS NOT NULL
       OR audit_event.authorization_capability NOT IN ('master_data:manage','sourcing:inquiry:create')
    THEN
      RAISE EXCEPTION 'first craft catalog version requires authorized creation audit'
        USING ERRCODE='55000';
    END IF;
    previous_state := NULL;
  ELSE
    previous_state := jsonb_build_object(
      'craftId',NEW.craft_id,
      'craftCode',stable_craft_code,
      'version',previous_version,
      'craftName',previous_craft_name,
      'active',previous_active
    );
    IF NEW.version<>previous_version+1
       OR audit_event.action<>'master_data.craft.revise'
       OR audit_event.authorization_capability<>'master_data:manage'
       OR audit_event.before_state<>previous_state
    THEN
      RAISE EXCEPTION 'craft catalog versions must be sequential and audited'
        USING ERRCODE='55000';
    END IF;
  END IF;

  IF audit_event.event_id IS NULL
     OR audit_event.request_id<>NEW.request_id
     OR audit_event.actor_id<>NEW.changed_by
     OR audit_event.entity_type<>'craft_catalog'
     OR audit_event.entity_id<>NEW.craft_id::text
     OR audit_event.reason<>NEW.change_reason
     OR audit_event.after_state->>'craftId'<>NEW.craft_id::text
     OR audit_event.after_state->>'craftCode'<>stable_craft_code
     OR (audit_event.after_state->>'version')::integer<>NEW.version
     OR audit_event.after_state->>'craftName'<>NEW.craft_name
     OR (audit_event.after_state->>'active')::boolean<>NEW.active
  THEN
    RAISE EXCEPTION 'craft catalog version requires matching audit event'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER craft_catalog_versions_guard_creation
  BEFORE INSERT ON craft_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION guard_craft_catalog_version_creation();
CREATE TRIGGER craft_catalog_versions_no_update
  BEFORE UPDATE ON craft_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER craft_catalog_versions_no_delete
  BEFORE DELETE ON craft_catalog_versions
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER craft_catalog_versions_no_truncate
  BEFORE TRUNCATE ON craft_catalog_versions
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE VIEW current_craft_catalog AS
  SELECT DISTINCT ON (item.craft_id)
    item.craft_id,
    item.craft_code,
    version.version,
    version.craft_name,
    version.normalized_name,
    version.active,
    version.change_reason,
    version.changed_by,
    version.created_at
  FROM craft_catalog_items item
  JOIN craft_catalog_versions version ON version.craft_id=item.craft_id
  ORDER BY item.craft_id,version.version DESC;

CREATE INDEX craft_catalog_versions_name_search_idx
  ON craft_catalog_versions(normalized_name,craft_id,version DESC);
