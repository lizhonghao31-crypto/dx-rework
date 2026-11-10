-- Reuse the immutable pair established in 0281. No guessed historical pairs,
-- adopted-order updates, standard backfill or new adoption activation.
ALTER TABLE digital_timeline_standard_versions ADD COLUMN reason text NOT NULL DEFAULT '' CHECK(length(reason)<=1000);
ALTER TABLE digital_timeline_standard_versions ADD COLUMN source_standard_id uuid REFERENCES digital_timeline_standard_versions(standard_id);
ALTER TABLE digital_sla_settings_drafts ADD COLUMN set_context_json jsonb CHECK(set_context_json IS NULL OR jsonb_typeof(set_context_json)='object');
CREATE INDEX timeline_standard_pair_history_idx ON digital_timeline_standard_versions(unified_configuration_id,development_version,version DESC);
