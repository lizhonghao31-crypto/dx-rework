-- Append each submission; the latest revision is displayed while earlier evidence remains.
ALTER TABLE sourcing_contract_return_monitors
  ADD COLUMN contract_return_latest_uploaded_by uuid REFERENCES app_users(id);

CREATE TABLE sourcing_contract_return_submissions (
  submission_id uuid PRIMARY KEY,
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_contract_return_monitors(sourcing_case_id),
  revision integer NOT NULL CHECK(revision > 0),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  submitted_at timestamptz NOT NULL,
  UNIQUE(sourcing_case_id,revision),
  UNIQUE(sourcing_case_id,request_id)
);

CREATE TABLE sourcing_contract_return_attachments (
  submission_id uuid NOT NULL REFERENCES sourcing_contract_return_submissions(submission_id),
  attachment_id uuid NOT NULL UNIQUE REFERENCES attachments(attachment_id),
  position integer NOT NULL CHECK(position > 0),
  PRIMARY KEY(submission_id,position)
);

-- A request key is consumed even when the current files are identical and no
-- new revision is necessary. This prevents reusing that key with other files.
CREATE TABLE sourcing_contract_return_requests (
  sourcing_case_id uuid NOT NULL REFERENCES sourcing_contract_return_monitors(sourcing_case_id),
  request_id text NOT NULL CHECK(request_id ~ '^[A-Za-z0-9._:-]{1,200}$'),
  submitted_by uuid NOT NULL REFERENCES app_users(id),
  attachment_ids uuid[] NOT NULL CHECK(cardinality(attachment_ids) BETWEEN 1 AND 10),
  PRIMARY KEY(sourcing_case_id,request_id)
);

CREATE INDEX sourcing_contract_return_submissions_latest_idx
  ON sourcing_contract_return_submissions(sourcing_case_id,revision DESC);

CREATE FUNCTION guard_bound_sourcing_contract_return_attachment() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.entity_type='sourcing_contract_return' AND (
    NEW.entity_type IS DISTINCT FROM OLD.entity_type
    OR NEW.entity_id IS DISTINCT FROM OLD.entity_id
    OR NEW.object_key IS DISTINCT FROM OLD.object_key
    OR NEW.uploaded_by IS DISTINCT FROM OLD.uploaded_by
    OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
    OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
    OR NEW.sha256 IS DISTINCT FROM OLD.sha256
    OR NEW.status IS DISTINCT FROM OLD.status
  ) THEN
    RAISE EXCEPTION 'bound contract return evidence is immutable' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sourcing_contract_return_attachment_guard
BEFORE UPDATE ON attachments
FOR EACH ROW EXECUTE FUNCTION guard_bound_sourcing_contract_return_attachment();
