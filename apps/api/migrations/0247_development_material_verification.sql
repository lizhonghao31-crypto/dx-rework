-- Clerk facts are separate from designer documents; historical checks are untouched.
CREATE TABLE digital_development_material_verifications (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>0),
 version integer NOT NULL CHECK(version>0),
 document_version integer NOT NULL CHECK(document_version>0),
 task_id uuid NOT NULL REFERENCES digital_production_tasks(task_id),
 entries jsonb NOT NULL CHECK(jsonb_typeof(entries)='array'),
 applied_entries jsonb CHECK(applied_entries IS NULL OR jsonb_typeof(applied_entries)='array'),
 draft_note text NOT NULL DEFAULT '',
 draft_result text NOT NULL DEFAULT '通过' CHECK(draft_result IN ('通过','缺项退回')),
 changed_by uuid NOT NULL REFERENCES app_users(id),
 changed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_id,round_number)
);
CREATE TRIGGER digital_development_material_verifications_no_delete
 BEFORE DELETE ON digital_development_material_verifications
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
