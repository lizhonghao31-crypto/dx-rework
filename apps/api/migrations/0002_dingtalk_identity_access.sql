CREATE TABLE app_users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE identity_mappings (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES app_users(id),
  provider text NOT NULL CHECK (provider = 'dingtalk'),
  corp_id text NOT NULL,
  provider_user_id text NOT NULL,
  union_id text NOT NULL,
  active boolean NOT NULL,
  employed boolean NOT NULL,
  first_verified_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at timestamptz NOT NULL,
  UNIQUE(provider, corp_id, provider_user_id)
);
CREATE INDEX identity_mappings_union_idx ON identity_mappings(provider, union_id);

CREATE TABLE user_capabilities (
  user_id uuid NOT NULL REFERENCES app_users(id),
  capability text NOT NULL,
  granted_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(user_id, capability)
);

CREATE TABLE auth_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES app_users(id),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX auth_sessions_active_idx ON auth_sessions(token_hash, expires_at) WHERE revoked_at IS NULL;

CREATE TABLE auth_qr_challenges (
  state_hash text PRIMARY KEY,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE auth_consumed_codes (
  code_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
