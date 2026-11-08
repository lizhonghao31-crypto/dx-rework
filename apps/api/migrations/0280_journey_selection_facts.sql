-- A small selector separate from the full native facts/SLA JSON. List reads
-- can select only these columns without loading every mother's complete model.
-- The existing source/applied/calculation/clock versions bind both publications.
ALTER TABLE digital_journey_fact_models
 ADD COLUMN selection_json jsonb,
 ADD COLUMN selection_fingerprint text,
 ADD COLUMN selection_integrity text,
 ADD COLUMN selection_full_json jsonb,
 ADD COLUMN selection_full_integrity text,
 ADD COLUMN selection_expires_at timestamptz,
 ADD CONSTRAINT journey_selection_complete CHECK (
  (selection_json IS NULL AND selection_fingerprint IS NULL AND selection_integrity IS NULL AND selection_expires_at IS NULL AND selection_full_json IS NULL AND selection_full_integrity IS NULL) OR
  (selection_json IS NOT NULL AND jsonb_typeof(selection_json)='object'
   AND selection_json->>'version' IS NOT DISTINCT FROM 'journey-selection-v1'
   AND selection_fingerprint IS NOT NULL AND selection_fingerprint ~ '^[0-9a-f]{64}$'
   AND selection_integrity IS NOT NULL AND selection_integrity ~ '^[0-9a-f]{32}$'
   AND selection_full_json IS NOT NULL AND jsonb_typeof(selection_full_json)='object' AND selection_full_json->>'version' IS NOT DISTINCT FROM 'journey-selection-v1'
   AND jsonb_typeof(selection_full_json->'frames') IS NOT DISTINCT FROM 'array' AND jsonb_array_length(selection_full_json->'frames')>0
   AND selection_full_integrity IS NOT NULL AND selection_full_integrity ~ '^[0-9a-f]{32}$')
 );
CREATE INDEX digital_journey_selection_expiry
 ON digital_journey_fact_models(selection_expires_at,resource_kind,resource_id)
 WHERE selection_expires_at IS NOT NULL AND clock_scenario_id IS NULL;
COMMENT ON COLUMN digital_journey_fact_models.selection_json IS
 'Rebuildable native selector, not a user DTO or cached grant; pending/expired/version-mismatched facts cannot be presented as current.';
COMMENT ON COLUMN digital_journey_fact_models.selection_full_json IS
 'Small native boolean/time frames only; a request must prove current complete source/order/field/link visibility before using them. No user authorization result is stored.';
