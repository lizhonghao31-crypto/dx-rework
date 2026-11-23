-- R4 storage is additive. R6 will authorize any new commercial write routes.
CREATE TABLE digital_quotation_pricing_drafts (
  quote_id uuid NOT NULL REFERENCES digital_quotation_documents(quote_id),
  actor_id uuid NOT NULL REFERENCES app_users(id),
  quote_version integer NOT NULL CHECK (quote_version > 0),
  pricing jsonb NOT NULL CHECK (jsonb_typeof(pricing) = 'object'),
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (quote_id, actor_id)
);

CREATE TABLE digital_quotation_line_reviews (
  review_id uuid PRIMARY KEY,
  quote_id uuid NOT NULL REFERENCES digital_quotation_documents(quote_id),
  round_number integer NOT NULL CHECK (round_number > 0),
  row_id uuid NOT NULL,
  field text NOT NULL CHECK (field IN ('consumption', 'unitPrice')),
  return_quote_version integer NOT NULL CHECK (return_quote_version > 0),
  return_field_version integer CHECK (return_field_version > 0),
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  return_actor uuid NOT NULL REFERENCES app_users(id),
  return_at timestamptz NOT NULL,
  recipient_id uuid NOT NULL REFERENCES app_users(id),
  resubmit_field_version integer,
  resubmit_actor uuid REFERENCES app_users(id),
  resubmit_at timestamptz,
  resolve_actor uuid REFERENCES app_users(id),
  resolve_at timestamptz,
  CHECK (num_nonnulls(resubmit_field_version, resubmit_actor, resubmit_at) IN (0, 3)),
  CHECK (resubmit_field_version IS NULL OR resubmit_field_version > coalesce(return_field_version, 0)),
  CHECK ((resolve_actor IS NULL) = (resolve_at IS NULL)),
  CHECK (resolve_at IS NULL OR resubmit_at IS NOT NULL)
);
CREATE UNIQUE INDEX digital_quotation_one_open_review_per_field
  ON digital_quotation_line_reviews(quote_id, round_number, row_id, field)
  WHERE resolve_at IS NULL;

ALTER TABLE digital_quotation_versions ADD COLUMN workbench_pricing jsonb
  CHECK (workbench_pricing IS NULL OR jsonb_typeof(workbench_pricing) = 'object');
