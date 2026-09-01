-- Bind new external-sourcing orders to enabled craft master data while retaining
-- the ordered text fields as a compatibility snapshot. Historical orders are
-- deliberately not backfilled or rewritten.

CREATE TABLE sourcing_case_crafts (
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  craft_id uuid NOT NULL REFERENCES craft_catalog_items(craft_id),
  craft_version integer NOT NULL CHECK (craft_version > 0),
  craft_code_snapshot text NOT NULL
    CHECK (craft_code_snapshot ~ '^[A-Z0-9][A-Z0-9_-]{1,31}$'),
  craft_name_snapshot text NOT NULL
    CHECK (length(btrim(craft_name_snapshot)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sourcing_case_id, position),
  UNIQUE (sourcing_case_id, craft_id),
  FOREIGN KEY (craft_id, craft_version)
    REFERENCES craft_catalog_versions(craft_id, version)
);

CREATE OR REPLACE FUNCTION guard_sourcing_case_craft_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  case_creator uuid;
  current_version integer;
  current_code text;
  current_name text;
  current_active boolean;
BEGIN
  SELECT created_by INTO case_creator
  FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  SELECT item.craft_code, version.version, version.craft_name, version.active
  INTO current_code, current_version, current_name, current_active
  FROM craft_catalog_items item
  JOIN LATERAL (
    SELECT history.version, history.craft_name, history.active
    FROM craft_catalog_versions history
    WHERE history.craft_id=item.craft_id
    ORDER BY history.version DESC
    LIMIT 1
  ) version ON true
  WHERE item.craft_id=NEW.craft_id;

  IF case_creator IS NULL
     OR audit_event.event_id IS NULL
     OR audit_event.action<>'sourcing.case.create'
     OR audit_event.entity_type<>'sourcing_case'
     OR audit_event.entity_id<>NEW.sourcing_case_id::text
     OR audit_event.authorization_capability<>'sourcing:inquiry:create'
     OR audit_event.actor_id<>NEW.created_by
     OR audit_event.actor_id<>case_creator
     OR audit_event.request_id<>NEW.request_id
     OR current_active IS DISTINCT FROM true
     OR current_version<>NEW.craft_version
     OR current_code<>NEW.craft_code_snapshot
     OR current_name<>NEW.craft_name_snapshot
     OR audit_event.after_state #>> ARRAY['crafts',(NEW.position-1)::text,'craftId']
       <>NEW.craft_id::text
     OR (audit_event.after_state #>> ARRAY['crafts',(NEW.position-1)::text,'craftVersion'])::integer
       <>NEW.craft_version
     OR audit_event.after_state #>> ARRAY['crafts',(NEW.position-1)::text,'craftCode']
       <>NEW.craft_code_snapshot
     OR audit_event.after_state #>> ARRAY['crafts',(NEW.position-1)::text,'craftName']
       <>NEW.craft_name_snapshot
  THEN
    RAISE EXCEPTION 'sourcing case craft requires enabled current master data and matching audit'
      USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_case_crafts_guard_creation
  BEFORE INSERT ON sourcing_case_crafts
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_case_craft_creation();
CREATE TRIGGER sourcing_case_crafts_no_update
  BEFORE UPDATE ON sourcing_case_crafts
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_case_crafts_no_delete
  BEFORE DELETE ON sourcing_case_crafts
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_case_crafts_no_truncate
  BEFORE TRUNCATE ON sourcing_case_crafts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX sourcing_case_crafts_craft_history_idx
  ON sourcing_case_crafts(craft_id, sourcing_case_id, position);
