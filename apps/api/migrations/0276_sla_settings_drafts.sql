-- Personal unpublished drafts only. Never alters standards, orders or task clocks.
CREATE TABLE digital_sla_settings_drafts (
 actor_id uuid NOT NULL REFERENCES app_users(id),
 standard_group text NOT NULL CHECK(standard_group IN ('unified','development')),
 revision integer NOT NULL CHECK(revision > 0),
 basis_version integer NOT NULL CHECK(basis_version >= 0),
 values_json jsonb NOT NULL CHECK(jsonb_typeof(values_json) = 'object'),
 basis_values_json jsonb NOT NULL CHECK(jsonb_typeof(basis_values_json) = 'object'),
 reason text NOT NULL CHECK(length(reason) <= 1000),
 state text NOT NULL CHECK(state IN ('saved','discarded','published')),
 published_version integer CHECK(published_version > 0),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(actor_id,standard_group,revision),
 CHECK((state = 'published') = (published_version IS NOT NULL))
);
CREATE TRIGGER digital_sla_settings_draft_history
BEFORE UPDATE OR DELETE ON digital_sla_settings_drafts
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE INDEX digital_sla_settings_draft_publication_idx
 ON digital_sla_settings_drafts(actor_id,standard_group,published_version)
 WHERE state = 'published';
COMMENT ON TABLE digital_sla_settings_drafts IS
 'Actor-owned unpublished drafts and append-only discard/publication receipts; no implicit policy adoption.';
