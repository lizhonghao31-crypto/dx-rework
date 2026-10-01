-- P09: scoped online budget drafts, immutable published versions and preparation.
-- Existing sourcing cases, prices, approvals and historical orders are untouched.
ALTER TABLE sourcing_cases ADD COLUMN workflow_generation text NOT NULL DEFAULT 'legacy'
 CHECK(workflow_generation IN ('legacy','digital_production_v1'));
-- The adapter creates the case and its explicit mother link in one transaction.
-- A marked case can never commit as an orphan or change back to the old flow.
CREATE FUNCTION guard_budget_sourcing_generation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.workflow_generation IS DISTINCT FROM NEW.workflow_generation THEN
   RAISE EXCEPTION 'sourcing workflow generation is immutable' USING ERRCODE='23514';
 END IF;
 IF NEW.workflow_generation='digital_production_v1' AND NOT EXISTS(
   SELECT 1 FROM digital_production_child_links WHERE module='sourcing' AND child_id=NEW.sourcing_case_id
 ) THEN
   RAISE EXCEPTION 'digital sourcing requires an explicit mother link' USING ERRCODE='23514';
 END IF;
 RETURN NULL;
END;
$$;
CREATE CONSTRAINT TRIGGER budget_sourcing_generation_guard AFTER INSERT OR UPDATE ON sourcing_cases
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION guard_budget_sourcing_generation();
CREATE TABLE digital_budget_documents (
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL CHECK(version>0),
 status text NOT NULL CHECK(status IN ('draft','published')),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 published_at timestamptz
);
CREATE TABLE digital_budget_versions (
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 version integer NOT NULL CHECK(version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 totals jsonb NOT NULL CHECK(jsonb_typeof(totals)='object'),
 published_by uuid NOT NULL REFERENCES app_users(id),
 published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(production_order_id,version)
);
CREATE TRIGGER digital_budget_versions_immutable BEFORE UPDATE OR DELETE ON digital_budget_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TABLE digital_budget_preparations (
 production_order_id uuid PRIMARY KEY REFERENCES digital_production_orders(production_order_id),
 budget_version integer NOT NULL,
 task_id uuid UNIQUE REFERENCES digital_production_tasks(task_id),
 FOREIGN KEY(production_order_id,budget_version) REFERENCES digital_budget_versions(production_order_id,version)
);
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
 VALUES('sourcing_preparation',1,'跟单核实并发起外发',NULL,0.8);
CREATE TABLE digital_budget_attachment_bindings (
 attachment_id uuid PRIMARY KEY REFERENCES attachments(attachment_id),
 production_order_id uuid NOT NULL REFERENCES digital_production_orders(production_order_id),
 bound_by uuid NOT NULL REFERENCES app_users(id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_budget_attachment_bindings_immutable BEFORE UPDATE OR DELETE ON digital_budget_attachment_bindings
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
-- Disposable copies preserve the original budget evidence and the existing
-- sourcing attachment ownership/immutability guards. Abandoned unbound copies
-- can be removed by the existing attachment cleanup job.
CREATE TABLE digital_budget_image_copies (
 production_order_id uuid NOT NULL,
 budget_version integer NOT NULL,
 source_attachment_id uuid NOT NULL REFERENCES attachments(attachment_id),
 actor_id uuid NOT NULL REFERENCES app_users(id),
 attachment_id uuid NOT NULL UNIQUE REFERENCES attachments(attachment_id) ON DELETE CASCADE,
 PRIMARY KEY(production_order_id,budget_version,source_attachment_id,actor_id),
 FOREIGN KEY(production_order_id,budget_version) REFERENCES digital_budget_versions(production_order_id,version)
);
