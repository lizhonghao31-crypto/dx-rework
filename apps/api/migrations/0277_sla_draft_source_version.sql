-- Optional provenance on new personal draft revisions only. Existing published
-- standards, draft history, order snapshots and actual events are not rewritten.
ALTER TABLE digital_sla_settings_drafts
 ADD COLUMN source_version integer REFERENCES digital_sla_configurations(version),
 ADD CONSTRAINT digital_sla_draft_source_group
 CHECK(source_version IS NULL OR standard_group='unified');
