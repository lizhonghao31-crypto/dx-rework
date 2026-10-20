-- Same production round, append-only corrections. Frozen 0222/0225 snapshots remain intact.
CREATE TABLE digital_development_amendment_drafts (
 task_id uuid PRIMARY KEY REFERENCES digital_production_tasks(task_id),
 source_id uuid NOT NULL REFERENCES digital_development_documents(source_id),
 round_number integer NOT NULL CHECK(round_number>0),
 version integer NOT NULL CHECK(version>0),
 base_document_version integer NOT NULL CHECK(base_document_version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 reason text NOT NULL,
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE digital_development_amendments (
 amendment_id uuid PRIMARY KEY,
 source_id uuid NOT NULL REFERENCES digital_development_documents(source_id),
 round_number integer NOT NULL CHECK(round_number>0),
 document_version integer NOT NULL CHECK(document_version>0),
 base_document_version integer NOT NULL CHECK(base_document_version>0),
 task_id uuid NOT NULL UNIQUE REFERENCES digital_production_tasks(task_id),
 draft_version integer NOT NULL CHECK(draft_version>0),
 document jsonb NOT NULL CHECK(jsonb_typeof(document)='object'),
 reason text NOT NULL CHECK(length(btrim(reason))>0),
 changes jsonb NOT NULL CHECK(jsonb_typeof(changes)='array'),
 published_by uuid NOT NULL REFERENCES app_users(id),
 published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 UNIQUE(source_id,document_version),
 CHECK(document_version>base_document_version)
);
CREATE INDEX digital_development_amendment_round ON digital_development_amendments(source_id,round_number,document_version DESC);
CREATE TRIGGER digital_development_amendment_immutable BEFORE UPDATE OR DELETE ON digital_development_amendments
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE VIEW digital_development_effective_documents AS
SELECT d.source_id,COALESCE(a.document_version,d.version) AS version,d.status,COALESCE(a.document,d.document) AS document,
 d.published_at,d.task_id,COALESCE(a.published_by,d.updated_by) AS updated_by,COALESCE(a.published_at,d.updated_at) AS updated_at
FROM digital_development_documents d LEFT JOIN LATERAL(
 SELECT * FROM digital_development_amendments WHERE source_id=d.source_id AND round_number=1 ORDER BY document_version DESC LIMIT 1
)a ON true;
CREATE VIEW digital_development_effective_rounds AS
SELECT r.source_id,r.round_number,r.based_on_round,COALESCE(a.document_version,r.document_version) AS document_version,
 COALESCE(a.document,r.document) AS document,r.origin,r.customer_comment,r.internal_problem,r.explanation,r.categories,
 r.affected_nodes,r.output_kind,r.route_nodes,r.inherited,r.return_task_id,r.route_id,r.created_by,r.published_at
FROM digital_development_rounds r LEFT JOIN LATERAL(
 SELECT * FROM digital_development_amendments WHERE source_id=r.source_id AND round_number=r.round_number ORDER BY document_version DESC LIMIT 1
)a ON true;
CREATE VIEW digital_development_amended_current_documents AS
SELECT d.source_id,COALESCE(r.document_version,d.version) AS version,d.status,
 COALESCE(r.document,d.document) AS document,COALESCE(r.published_at,d.published_at) AS published_at,
 d.task_id,d.updated_by,d.updated_at,COALESCE(r.round_number,1) AS round_number
FROM digital_development_effective_documents d LEFT JOIN LATERAL(
 SELECT * FROM digital_development_effective_rounds WHERE source_id=d.source_id ORDER BY round_number DESC LIMIT 1
)r ON true;

ALTER TABLE digital_development_material_verifications ADD COLUMN draft_return_issues jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(draft_return_issues)='array');

-- Rename the existing role task; no new node, approval or deadline rule.
INSERT INTO digital_production_deadline_policies(node_key,version,label,sla_seconds,warning_ratio)
 SELECT node_key,version+1,CASE WHEN node_key='development_material_supply' THEN '开发资料补正 / 补料' ELSE '开发资料与材料复核' END,sla_seconds,warning_ratio
 FROM (SELECT DISTINCT ON(node_key) * FROM digital_production_deadline_policies
 WHERE node_key IN ('development_material_supply','development_material_recheck') ORDER BY node_key,version DESC)p;

DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dx_rework_acceptance_app') THEN
  GRANT SELECT ON digital_development_effective_documents,digital_development_effective_rounds,digital_development_amended_current_documents TO dx_rework_acceptance_app;
 END IF;
END $$;
