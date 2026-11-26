ALTER TABLE sourcing_contract_documents
  ADD COLUMN generation_attempt_id uuid,
  ADD COLUMN generation_lease_until timestamptz,
  ADD CONSTRAINT sourcing_contract_generation_lease_pair
    CHECK ((generation_attempt_id IS NULL) = (generation_lease_until IS NULL));

CREATE INDEX sourcing_contract_generation_queue
  ON sourcing_contract_documents(prepared_at, sourcing_contract_document_id)
  WHERE status IN ('generation_pending','generating') AND cardinality(missing_fields)=0;

-- Durable inventory for private objects. Only an attachment bound to a ready
-- document is published. Failed or interrupted writes leave recoverable metadata.
CREATE TABLE sourcing_contract_generation_staging (
  generation_attempt_id uuid PRIMARY KEY,
  sourcing_contract_document_id uuid NOT NULL REFERENCES sourcing_contract_documents,
  object_key text NOT NULL UNIQUE,
  sha256 text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  staged_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  published_attachment_id uuid REFERENCES attachments,
  discarded_at timestamptz
);
