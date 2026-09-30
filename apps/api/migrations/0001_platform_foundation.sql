CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  request_id text NOT NULL,
  actor_id uuid,
  actor_role text,
  action text NOT NULL,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  before_state jsonb,
  after_state jsonb,
  reason text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX audit_events_entity_idx
  ON audit_events (entity_type, entity_id, created_at DESC);

CREATE INDEX audit_events_actor_idx
  ON audit_events (actor_id, created_at DESC)
  WHERE actor_id IS NOT NULL;

CREATE TABLE outbox_events (
  id uuid PRIMARY KEY,
  topic text NOT NULL,
  aggregate_type text NOT NULL,
  aggregate_id text NOT NULL,
  payload jsonb NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX outbox_events_delivery_idx
  ON outbox_events (status, available_at, created_at)
  WHERE status IN ('pending', 'failed');

CREATE TABLE idempotency_keys (
  scope text NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  response_status integer,
  response_body jsonb,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, key),
  CHECK ((response_status IS NULL) = (response_body IS NULL))
);

CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);
