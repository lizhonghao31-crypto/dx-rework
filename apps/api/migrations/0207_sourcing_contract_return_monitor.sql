-- The order and approval snapshot tables are immutable. Keep mutable monitoring
-- facts separate; existing approved cases have no row and remain excluded.
CREATE TABLE sourcing_contract_return_monitors (
  sourcing_case_id uuid PRIMARY KEY REFERENCES sourcing_cases(sourcing_case_id),
  contract_return_monitor_enabled boolean NOT NULL DEFAULT false,
  contract_generated_at timestamptz,
  contract_return_due_at timestamptz,
  contract_returned_at timestamptz,
  contract_return_uploaded_by uuid REFERENCES app_users(id),
  CHECK (
    (contract_generated_at IS NULL AND contract_return_due_at IS NULL AND contract_returned_at IS NULL)
    OR (contract_return_monitor_enabled AND contract_generated_at IS NOT NULL
      AND contract_return_due_at = contract_generated_at + interval '48 hours'
      AND (contract_returned_at IS NULL OR contract_returned_at >= contract_generated_at))
  )
);

-- The first successful ready PDF determines the clock. Document revisions and downloads
-- never change it; this trigger executes in the same transaction as the ready transition.
CREATE FUNCTION start_sourcing_contract_return_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ready' AND OLD.status <> 'ready' THEN
    UPDATE sourcing_contract_return_monitors
       SET contract_generated_at = NEW.generated_at,
           contract_return_due_at = NEW.generated_at + interval '48 hours'
     WHERE sourcing_case_id = NEW.sourcing_case_id
       AND contract_return_monitor_enabled
       AND contract_generated_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sourcing_contract_return_ready
AFTER UPDATE OF status ON sourcing_contract_documents
FOR EACH ROW EXECUTE FUNCTION start_sourcing_contract_return_clock();

CREATE INDEX sourcing_contract_return_filter_idx
  ON sourcing_contract_return_monitors(contract_return_due_at,contract_returned_at)
  WHERE contract_return_monitor_enabled;
