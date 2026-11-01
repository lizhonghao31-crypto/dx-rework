-- New creation metadata only. Historical years, promises and actual times are not inferred.
ALTER TABLE digital_production_orders ADD COLUMN sales_year integer
  CHECK (sales_year IS NULL OR sales_year BETWEEN 1000 AND 9999);
ALTER TABLE digital_production_orders ADD COLUMN sales_series text
  CHECK (sales_series IS NULL OR sales_series ~ '^P(0[1-9]|1[0-2])$');
ALTER TABLE digital_production_orders ADD COLUMN requires_color_matching boolean;

-- New root identities have an independent database uniqueness guarantee. Existing
-- source rows remain untouched, including any historical duplicates/aliases.
CREATE TABLE digital_design_code_registry (
  code_key text PRIMARY KEY CHECK (length(code_key) BETWEEN 1 AND 100),
  source_id uuid NOT NULL UNIQUE REFERENCES digital_production_sources(source_id),
  code text NOT NULL CHECK (length(btrim(code)) BETWEEN 1 AND 100),
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (code_key=translate(btrim(code),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'))
);
