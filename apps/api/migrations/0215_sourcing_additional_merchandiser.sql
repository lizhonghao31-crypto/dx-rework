-- An optional second merchandiser receives order notifications and can return the contract.
-- The original creator remains the sole editor for all other order actions.
ALTER TABLE sourcing_cases
  ADD COLUMN additional_merchandiser_user_id uuid REFERENCES app_users(id),
  ADD CONSTRAINT sourcing_additional_merchandiser_distinct
    CHECK (additional_merchandiser_user_id IS NULL OR additional_merchandiser_user_id <> created_by);

CREATE INDEX sourcing_cases_additional_merchandiser_idx
  ON sourcing_cases(additional_merchandiser_user_id)
  WHERE additional_merchandiser_user_id IS NOT NULL;
