-- Only an approved order with its current PDF ready may be relabelled.
-- Apply prospectively; old revisions and documents remain immutable.
CREATE FUNCTION guard_sourcing_style_revision_ready_contract() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE latest sourcing_contract_documents%ROWTYPE;
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO latest FROM sourcing_contract_documents
    WHERE sourcing_case_id=NEW.sourcing_case_id ORDER BY contract_version DESC LIMIT 1;
  IF latest.sourcing_contract_document_id IS NULL OR latest.status<>'ready' OR latest.pdf_attachment_id IS NULL
    OR latest.identity_version<>NEW.revision-1
    OR NOT EXISTS (SELECT 1 FROM current_sourcing_cases source
      WHERE source.sourcing_case_id=NEW.sourcing_case_id AND source.status IN ('pending_finance_reconciliation','closed'))
  THEN
    RAISE EXCEPTION 'style revision requires owner approval and the current generated contract' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER sourcing_style_revision_ready_contract BEFORE INSERT ON sourcing_style_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_style_revision_ready_contract();
