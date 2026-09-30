CREATE TABLE digital_development_rounds (
 source_id uuid NOT NULL REFERENCES digital_production_sources(source_id),
 round_number integer NOT NULL CHECK(round_number>=2),
 based_on_round integer NOT NULL CHECK(based_on_round>=1),
 document_version integer NOT NULL CHECK(document_version>0),
 document jsonb NOT NULL,
 origin text NOT NULL CHECK(origin IN ('客户新增要求','未达原要求','内部发现')),
 customer_comment text NOT NULL,
 internal_problem text NOT NULL,
 explanation text NOT NULL,
 categories text[] NOT NULL CHECK(cardinality(categories)>0),
 affected_nodes text[] NOT NULL CHECK(cardinality(affected_nodes)>0),
 output_kind text NOT NULL CHECK(output_kind IN ('整件样板','工艺布片')),
 route_nodes text[] NOT NULL CHECK(cardinality(route_nodes)>0),
 inherited jsonb NOT NULL,
 return_task_id uuid REFERENCES digital_production_tasks(task_id),
 route_id uuid NOT NULL UNIQUE,
 created_by uuid NOT NULL REFERENCES app_users(id),
 published_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(source_id,round_number),
 UNIQUE(source_id,document_version),
 CHECK(round_number=based_on_round+1),
 CHECK((origin='内部发现' AND length(btrim(internal_problem))>0 AND customer_comment='') OR (origin<>'内部发现' AND length(btrim(customer_comment))>0 AND internal_problem=''))
);
CREATE TRIGGER digital_development_round_immutable BEFORE UPDATE OR DELETE ON digital_development_rounds
FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TABLE digital_development_round_drafts (
 source_id uuid PRIMARY KEY REFERENCES digital_production_sources(source_id),
 version integer NOT NULL CHECK(version>0),
 based_on_round integer NOT NULL CHECK(based_on_round>=1),
 payload jsonb NOT NULL,
 updated_by uuid NOT NULL REFERENCES app_users(id),
 updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE digital_development_material_events ADD COLUMN route_version integer NOT NULL DEFAULT 1 CHECK(route_version>0);
CREATE VIEW digital_development_current_documents AS
SELECT d.source_id,COALESCE(r.document_version,d.version) AS version,d.status,
 COALESCE(r.document,d.document) AS document,COALESCE(r.published_at,d.published_at) AS published_at,
 d.task_id,d.updated_by,d.updated_at,COALESCE(r.round_number,1) AS round_number
FROM digital_development_documents d LEFT JOIN LATERAL(
 SELECT * FROM digital_development_rounds WHERE source_id=d.source_id ORDER BY round_number DESC LIMIT 1
)r ON true;

ALTER TABLE digital_development_notices ADD COLUMN round_number integer NOT NULL DEFAULT 1 CHECK(round_number>0);
