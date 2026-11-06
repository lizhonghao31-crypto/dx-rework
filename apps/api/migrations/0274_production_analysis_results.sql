-- Short-lived derived query results only. Never a quantity ledger or historical report archive.
CREATE TABLE digital_production_analysis_results (
 result_id uuid PRIMARY KEY,
 actor_id uuid NOT NULL REFERENCES app_users(id),
 filters_hash text NOT NULL CHECK (filters_hash ~ '^[0-9a-f]{64}$'),
 permission_hash text NOT NULL CHECK (permission_hash ~ '^[0-9a-f]{64}$'),
 rule_version text NOT NULL,
 watermark text NOT NULL CHECK (watermark ~ '^[0-9a-f]{64}$'),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload)='object' AND octet_length(payload::text)<=5242880),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 expires_at timestamptz NOT NULL,
 CHECK (expires_at>created_at AND expires_at<=created_at+interval '15 minutes')
);
CREATE INDEX digital_analysis_result_expiry ON digital_production_analysis_results(expires_at,result_id);
CREATE INDEX digital_analysis_result_actor ON digital_production_analysis_results(actor_id,created_at DESC,result_id);
-- Result values cannot be replaced under a retained identifier. Bounded expiry/capacity
-- deletion is allowed by the query service; this table is not an immutable business fact.
CREATE FUNCTION guard_digital_analysis_result_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION 'analysis result is immutable; refresh as a complete new result' USING ERRCODE='55000';
END;
$$;
CREATE TRIGGER digital_analysis_result_no_update BEFORE UPDATE ON digital_production_analysis_results
 FOR EACH ROW EXECUTE FUNCTION guard_digital_analysis_result_update();
