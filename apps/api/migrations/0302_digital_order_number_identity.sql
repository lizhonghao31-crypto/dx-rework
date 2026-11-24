-- No historical numbering or business data backfill.
CREATE TABLE digital_order_number_settings (
  version integer PRIMARY KEY CHECK (version > 0),
  values_json jsonb NOT NULL,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_order_number_settings_immutable BEFORE UPDATE OR DELETE ON digital_order_number_settings
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

CREATE TABLE digital_order_number_series (
  prefix text PRIMARY KEY,
  components jsonb NOT NULL,
  last_number bigint NOT NULL CHECK (last_number > 0)
);

-- Store a single canonical number in the original source field. Only a draft
-- reserved for this flow can start without a number.
ALTER TABLE digital_production_sources
  ADD COLUMN workbench_generated_number boolean NOT NULL DEFAULT false,
  ADD COLUMN workbench_number_root_id uuid REFERENCES digital_production_sources(source_id),
  ALTER COLUMN design_style_no DROP NOT NULL,
  ADD CONSTRAINT digital_source_unassigned_number_only_on_reserved_draft
    CHECK (design_style_no IS NOT NULL OR (workbench_generated_number AND draft_reserved IS TRUE));

ALTER TABLE digital_design_code_registry ADD COLUMN workbench_generated_number boolean NOT NULL DEFAULT false;

-- A write-side key shared with the old identity writers. Even a transaction
-- using REPEATABLE READ cannot accept a claim based on a stale SELECT.
-- A null owner shields an old-format number without binding it to a new source.
CREATE TABLE digital_order_number_claims (
  code_key text PRIMARY KEY,
  source_id uuid UNIQUE REFERENCES digital_production_sources(source_id)
);

CREATE FUNCTION guard_digital_order_number_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF TG_TABLE_NAME='digital_order_number_claims' AND NEW IS NOT DISTINCT FROM OLD THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='digital_order_number_series'
       AND (to_jsonb(NEW)-'last_number')=(to_jsonb(OLD)-'last_number')
       AND (to_jsonb(NEW)->>'last_number')::bigint=(to_jsonb(OLD)->>'last_number')::bigint+1 THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'order number history is immutable' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER digital_order_number_series_guard BEFORE UPDATE OR DELETE ON digital_order_number_series
 FOR EACH ROW EXECUTE FUNCTION guard_digital_order_number_history();
CREATE TRIGGER digital_order_number_claim_guard BEFORE UPDATE OR DELETE ON digital_order_number_claims
 FOR EACH ROW EXECUTE FUNCTION guard_digital_order_number_history();

CREATE FUNCTION guard_digital_order_number_claim() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  claim_key text;
  claim_owner uuid;
BEGIN
  claim_key := translate(btrim(NEW.design_style_no),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz');
  IF TG_TABLE_NAME='digital_production_sources'
     AND coalesce((to_jsonb(NEW)->>'workbench_generated_number')::boolean,false)
     AND claim_key IS NOT NULL THEN
    RAISE EXCEPTION 'generated number must be bound to the reserved source' USING ERRCODE='23514';
  END IF;
  IF claim_key IS NULL OR claim_key !~ '^[a-z][a-z0-9-]*[0-9]{4}p(0[0-9]|1[0-2])-[0-9]{3,}$' THEN
    RETURN NEW;
  END IF;
  INSERT INTO digital_order_number_claims AS claims(code_key) VALUES (claim_key)
    ON CONFLICT (code_key) DO UPDATE SET source_id=claims.source_id
    RETURNING source_id INTO claim_owner;
  IF claim_owner IS NOT NULL AND
     (TG_TABLE_NAME='digital_production_sources' OR claim_owner IS DISTINCT FROM NEW.source_id) THEN
    RAISE EXCEPTION '该订单ID已绑定其他开发档案' USING ERRCODE='23505';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER digital_source_order_number_claim BEFORE INSERT ON digital_production_sources
 FOR EACH ROW EXECUTE FUNCTION guard_digital_order_number_claim();
CREATE TRIGGER digital_formal_order_number_claim BEFORE INSERT ON digital_production_orders
 FOR EACH ROW EXECUTE FUNCTION guard_digital_order_number_claim();

-- Keep the existing immutability guard with exactly one new legal transition.
CREATE FUNCTION guard_digital_source_number_binding() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.workbench_generated_number AND OLD.draft_reserved IS TRUE
     AND OLD.design_style_no IS NULL AND NEW.design_style_no IS NOT NULL
     AND (to_jsonb(OLD)-'design_style_no')=(to_jsonb(NEW)-'design_style_no')
     AND EXISTS (SELECT 1 FROM digital_design_code_registry r
       WHERE r.source_id=OLD.source_id AND r.code=NEW.design_style_no AND r.workbench_generated_number)
     AND EXISTS (SELECT 1 FROM digital_order_number_claims c
       WHERE c.source_id=OLD.source_id
         AND c.code_key=translate(NEW.design_style_no,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'production identity is immutable' USING ERRCODE='55000';
END;
$$;
DROP TRIGGER digital_source_identity_guard ON digital_production_sources;
CREATE TRIGGER digital_source_identity_guard BEFORE UPDATE OR DELETE ON digital_production_sources
 FOR EACH ROW EXECUTE FUNCTION guard_digital_source_number_binding();

DO $$ BEGIN
 IF to_regrole('dx_rework_acceptance_app') IS NOT NULL THEN
   GRANT SELECT, INSERT ON digital_order_number_settings,digital_order_number_series,digital_order_number_claims
     TO dx_rework_acceptance_app;
   GRANT UPDATE(last_number) ON digital_order_number_series TO dx_rework_acceptance_app;
   GRANT UPDATE(source_id) ON digital_order_number_claims TO dx_rework_acceptance_app;
   GRANT UPDATE(design_style_no) ON digital_production_sources TO dx_rework_acceptance_app;
 END IF;
END $$;
