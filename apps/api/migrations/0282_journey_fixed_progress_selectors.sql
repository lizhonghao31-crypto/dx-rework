-- Rebuildable v2 selectors add compact fixed-schedule classification frames.
-- Retain v1 writes during the coordinated rolling update; application readers
-- still require their exact calculation/schema version and current source.
-- No fact, adopted target, business event, quantity or grant is rewritten.
ALTER TABLE digital_journey_fact_models DROP CONSTRAINT journey_selection_complete;
ALTER TABLE digital_journey_fact_models ADD CONSTRAINT journey_selection_complete CHECK (
 (selection_json IS NULL AND selection_fingerprint IS NULL AND selection_integrity IS NULL AND selection_expires_at IS NULL AND selection_full_json IS NULL AND selection_full_integrity IS NULL) OR
 (selection_json IS NOT NULL AND jsonb_typeof(selection_json)='object'
  AND coalesce(selection_json->>'version' IN ('journey-selection-v1','journey-selection-v2'),false)
  AND selection_fingerprint IS NOT NULL AND selection_fingerprint ~ '^[0-9a-f]{64}$'
  AND selection_integrity IS NOT NULL AND selection_integrity ~ '^[0-9a-f]{32}$'
  AND selection_full_json IS NOT NULL AND jsonb_typeof(selection_full_json)='object'
  AND selection_full_json->>'version' IS NOT DISTINCT FROM selection_json->>'version'
  AND jsonb_typeof(selection_full_json->'frames') IS NOT DISTINCT FROM 'array' AND jsonb_array_length(selection_full_json->'frames')>0
  AND selection_full_integrity IS NOT NULL AND selection_full_integrity ~ '^[0-9a-f]{32}$')
);
