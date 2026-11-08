-- Internal derived facts only. No business ledger, user DTO or authorization cache.
-- PERF01 deliberately does not switch any normal GET to these rows.
CREATE TABLE digital_journey_fact_models (
 resource_kind text NOT NULL CHECK (resource_kind IN ('source','order')),
 resource_id uuid NOT NULL,
 source_id uuid REFERENCES digital_production_sources(source_id) ON DELETE CASCADE,
 production_order_id uuid REFERENCES digital_production_orders(production_order_id) ON DELETE CASCADE,
 source_version bigint NOT NULL DEFAULT 1 CHECK (source_version>0),
 applied_source_version bigint CHECK (applied_source_version>0 AND applied_source_version<=source_version),
 calculation_version text,
 source_fingerprint text CHECK (source_fingerprint ~ '^[0-9a-f]{64}$'),
 payload jsonb CHECK (jsonb_typeof(payload)='object' AND payload->>'schemaVersion'='1' AND octet_length(payload::text)<=2097152),
 clock_scenario_id uuid,
 clock_revision bigint NOT NULL DEFAULT 0 CHECK (clock_revision>=0),
 observed_at timestamptz,
 built_at timestamptz,
 PRIMARY KEY(resource_kind,resource_id),
 CHECK ((resource_kind='order' AND production_order_id IS NOT NULL AND production_order_id=resource_id) OR
        (resource_kind='source' AND source_id IS NOT NULL AND source_id=resource_id AND production_order_id IS NULL)),
 CHECK ((clock_scenario_id IS NULL AND clock_revision=0) OR (clock_scenario_id IS NOT NULL AND clock_revision>0)),
 CHECK ((applied_source_version IS NULL AND payload IS NULL AND calculation_version IS NULL AND source_fingerprint IS NULL AND built_at IS NULL AND observed_at IS NULL) OR
        (applied_source_version IS NOT NULL AND payload IS NOT NULL AND calculation_version IS NOT NULL AND source_fingerprint IS NOT NULL AND built_at IS NOT NULL AND observed_at IS NOT NULL))
);
COMMENT ON TABLE digital_journey_fact_models IS 'Rebuildable single-mother facts. Live reader authorization and current-time evaluation are always separate.';
