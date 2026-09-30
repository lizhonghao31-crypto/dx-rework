-- Explicit mappings only. No production classifications, aliases or identity changes are seeded.
CREATE TABLE sample_analysis_dimensions (
 dimension_id uuid PRIMARY KEY,
 kind text NOT NULL CHECK (kind IN ('brand','department')),
 display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 200),
 created_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(dimension_id,kind)
);
CREATE TABLE sample_analysis_aliases (
 kind text NOT NULL CHECK (kind IN ('brand','department')),
 raw_name text NOT NULL CHECK (length(raw_name) BETWEEN 1 AND 200),
 version integer NOT NULL CHECK (version>0),
 dimension_id uuid NOT NULL,
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(kind,raw_name,version),
 FOREIGN KEY(dimension_id,kind) REFERENCES sample_analysis_dimensions(dimension_id,kind)
);
CREATE TABLE sample_analysis_classifications (
 sample_id uuid NOT NULL REFERENCES sample_items(sample_id),
 version integer NOT NULL CHECK (version>0),
 classification text NOT NULL CHECK (classification IN ('formal_history','test_invalid')),
 reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
 recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(sample_id,version)
);
CREATE FUNCTION sample_analysis_classification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM sample_items WHERE sample_id=NEW.sample_id AND status='archived') THEN
  RAISE EXCEPTION 'classification requires an archived sample' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END;
$$;
CREATE TRIGGER sample_analysis_classification_guard BEFORE INSERT ON sample_analysis_classifications
 FOR EACH ROW EXECUTE FUNCTION sample_analysis_classification_guard();
CREATE TRIGGER sample_analysis_dimensions_immutable BEFORE UPDATE OR DELETE ON sample_analysis_dimensions
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_analysis_aliases_immutable BEFORE UPDATE OR DELETE ON sample_analysis_aliases
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_analysis_classifications_immutable BEFORE UPDATE OR DELETE ON sample_analysis_classifications
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_analysis_dimensions_no_truncate BEFORE TRUNCATE ON sample_analysis_dimensions
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_analysis_aliases_no_truncate BEFORE TRUNCATE ON sample_analysis_aliases
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER sample_analysis_classifications_no_truncate BEFORE TRUNCATE ON sample_analysis_classifications
 FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();
CREATE INDEX sample_analysis_purchaser_date_idx ON sample_items(purchaser_user_id,purchase_date,sample_id);
CREATE INDEX sample_analysis_category_date_idx ON sample_items(category,purchase_date,sample_id);
CREATE INDEX sample_analysis_price_idx ON sample_financial_facts(purchase_price,sample_id);
