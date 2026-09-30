CREATE TABLE idempotency_records (
  scope text NOT NULL,
  actor_key text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash text NOT NULL,
  acquisition_token uuid NOT NULL,
  status text NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  status_code integer,
  response jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, actor_key, idempotency_key),
  CHECK ((status = 'completed') = (status_code IS NOT NULL AND response IS NOT NULL)),
  CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599)
);
CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);

CREATE TABLE operation_events (
  event_id uuid PRIMARY KEY,
  request_id text NOT NULL,
  actor_id uuid NOT NULL REFERENCES app_users(id),
  actor_roles text[] NOT NULL CHECK (cardinality(actor_roles) > 0 AND array_position(actor_roles, NULL) IS NULL AND NOT (actor_roles @> ARRAY[''])),
  authorization_capability text NOT NULL CHECK (authorization_capability <> ''),
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX operation_events_entity_idx ON operation_events (entity_type, entity_id, created_at DESC);
CREATE INDEX operation_events_request_idx ON operation_events (request_id);

CREATE OR REPLACE FUNCTION reject_operation_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'operation_events is append-only' USING ERRCODE = '55000';
END;
$$;
CREATE TRIGGER operation_events_no_update BEFORE UPDATE ON operation_events FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER operation_events_no_delete BEFORE DELETE ON operation_events FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();
CREATE TRIGGER operation_events_no_truncate BEFORE TRUNCATE ON operation_events FOR EACH STATEMENT EXECUTE FUNCTION reject_operation_event_mutation();

CREATE TABLE message_outbox (
  event_id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  recipient_key text NOT NULL,
  idempotency_key text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'sent', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  claimed_at timestamptz,
  claim_token uuid,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (topic, recipient_key, idempotency_key),
  CHECK (last_error IS NULL OR length(last_error) <= 500),
  CHECK ((status = 'processing') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((status = 'sent') = (sent_at IS NOT NULL)),
  CHECK (status <> 'sent' OR last_error IS NULL),
  CHECK (status <> 'failed' OR last_error IS NOT NULL)
);
CREATE INDEX message_outbox_claim_idx ON message_outbox (available_at, claimed_at, created_at)
  WHERE status IN ('pending', 'failed', 'processing');

CREATE TABLE attachments (
  attachment_id uuid PRIMARY KEY,
  object_key text NOT NULL UNIQUE,
  original_filename text NOT NULL,
  mime_type text NOT NULL CHECK (mime_type IN ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes bigint NOT NULL CHECK (size_bytes > 0),
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid NOT NULL REFERENCES app_users(id),
  entity_type text,
  entity_id text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'rejected')),
  rejection_reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ready_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK ((entity_type IS NULL) = (entity_id IS NULL)),
  CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 500),
  CHECK ((status = 'ready') = (ready_at IS NOT NULL)),
  CHECK ((status = 'rejected') = (rejection_reason IS NOT NULL)),
  CHECK (position('://' in object_key) = 0 AND object_key !~ '(^|/)\.\.(/|$)')
);
CREATE INDEX attachments_owner_idx ON attachments (uploaded_by, created_at DESC);
CREATE INDEX attachments_entity_idx ON attachments (entity_type, entity_id) WHERE entity_type IS NOT NULL;

CREATE TABLE export_jobs (
  export_job_id uuid PRIMARY KEY,
  requested_by uuid NOT NULL REFERENCES app_users(id),
  export_type text NOT NULL,
  filters jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'succeeded', 'failed')),
  result_attachment_id uuid REFERENCES attachments(attachment_id),
  idempotency_key text NOT NULL,
  claimed_at timestamptz,
  claim_token uuid,
  completed_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (requested_by, export_type, idempotency_key),
  CHECK (last_error IS NULL OR length(last_error) <= 500),
  CHECK ((status = 'succeeded') = (result_attachment_id IS NOT NULL)),
  CHECK ((status = 'running') = (claim_token IS NOT NULL AND claimed_at IS NOT NULL)),
  CHECK ((status IN ('succeeded', 'failed')) = (completed_at IS NOT NULL)),
  CHECK ((status = 'failed') = (last_error IS NOT NULL))
);
CREATE INDEX export_jobs_claim_idx ON export_jobs (claimed_at, created_at)
  WHERE status IN ('pending', 'running');
