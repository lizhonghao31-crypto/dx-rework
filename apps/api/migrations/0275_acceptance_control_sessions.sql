CREATE TABLE acceptance_control_sessions (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  corp_id text NOT NULL,
  authority_hash text NOT NULL CHECK (authority_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  business_token_hash text UNIQUE CHECK (business_token_hash ~ '^[0-9a-f]{64}$'),
  CHECK (expires_at > created_at),
  CHECK (expires_at <= created_at + interval '720 hours')
);
CREATE INDEX acceptance_control_sessions_expiry_idx
  ON acceptance_control_sessions(corp_id, expires_at);
