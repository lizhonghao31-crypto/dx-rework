-- SSP-03: persist immutable multi-style/color pricing facts for sourcing node one.
-- Existing single-style cases remain readable as one legacy line and intentionally
-- do not invent a color, external price, or internal Daxing price.

ALTER TABLE sourcing_cases
  ADD COLUMN daxing_unit_price numeric(14,4)
    CHECK (daxing_unit_price IS NULL OR daxing_unit_price > 0);

CREATE TABLE sourcing_case_lines (
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_cases(sourcing_case_id),
  position integer NOT NULL CHECK (position BETWEEN 1 AND 20),
  style_no text NOT NULL CHECK (length(btrim(style_no)) BETWEEN 1 AND 100),
  alternate_style_no text
    CHECK (alternate_style_no IS NULL OR length(btrim(alternate_style_no)) BETWEEN 1 AND 100),
  color text CHECK (color IS NULL OR length(btrim(color)) BETWEEN 1 AND 100),
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 10000000),
  external_unit_price numeric(14,4)
    CHECK (external_unit_price IS NULL OR external_unit_price > 0),
  legacy_source boolean NOT NULL DEFAULT false,
  created_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL REFERENCES operation_events(event_id),
  request_id text NOT NULL CHECK (request_id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (sourcing_case_id, position),
  CHECK (
    legacy_source
    OR (color IS NOT NULL AND external_unit_price IS NOT NULL)
  )
);

INSERT INTO sourcing_case_lines(
  sourcing_case_id,position,style_no,alternate_style_no,color,quantity,
  external_unit_price,legacy_source,created_by,operation_event_id,request_id,created_at
)
SELECT
  sourcing_case_id,1,style_no,NULL,NULL,order_quantity,
  NULL,true,created_by,operation_event_id,request_id,created_at
FROM sourcing_cases;

CREATE OR REPLACE FUNCTION guard_sourcing_case_line_creation()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  audit_event operation_events%ROWTYPE;
  source_case sourcing_cases%ROWTYPE;
BEGIN
  SELECT * INTO source_case
  FROM sourcing_cases
  WHERE sourcing_case_id=NEW.sourcing_case_id;

  SELECT * INTO audit_event
  FROM operation_events
  WHERE event_id=NEW.operation_event_id;

  IF source_case.sourcing_case_id IS NULL
     OR audit_event.event_id IS NULL
     OR audit_event.action<>'sourcing.case.create'
     OR audit_event.entity_type<>'sourcing_case'
     OR audit_event.entity_id<>NEW.sourcing_case_id::text
     OR audit_event.authorization_capability<>'sourcing:inquiry:create'
     OR audit_event.actor_id<>NEW.created_by
     OR audit_event.actor_id<>source_case.created_by
     OR audit_event.request_id<>NEW.request_id
  THEN
    RAISE EXCEPTION 'sourcing case line requires matching case creation audit'
      USING ERRCODE='55000';
  END IF;

  IF NOT NEW.legacy_source AND (
       audit_event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'styleNo']
         IS DISTINCT FROM NEW.style_no
       OR nullif(audit_event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'alternateStyleNo'],'')
         IS DISTINCT FROM NEW.alternate_style_no
       OR audit_event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'color']
         IS DISTINCT FROM NEW.color
       OR (audit_event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'quantity'])::integer
         IS DISTINCT FROM NEW.quantity
       OR (audit_event.after_state #>> ARRAY['lineItems',(NEW.position-1)::text,'externalUnitPrice'])::numeric
         IS DISTINCT FROM NEW.external_unit_price
       OR (audit_event.after_state ->> 'daxingUnitPrice')::numeric
         IS DISTINCT FROM source_case.daxing_unit_price
     )
  THEN
    RAISE EXCEPTION 'sourcing case line does not match audited multi-style pricing facts'
      USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER sourcing_case_lines_guard_creation
  BEFORE INSERT ON sourcing_case_lines
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_case_line_creation();
CREATE TRIGGER sourcing_case_lines_no_update
  BEFORE UPDATE ON sourcing_case_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_case_lines_no_delete
  BEFORE DELETE ON sourcing_case_lines
  FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sourcing_case_lines_no_truncate
  BEFORE TRUNCATE ON sourcing_case_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE INDEX sourcing_case_lines_style_history_idx
  ON sourcing_case_lines(style_no, sourcing_case_id, position);
