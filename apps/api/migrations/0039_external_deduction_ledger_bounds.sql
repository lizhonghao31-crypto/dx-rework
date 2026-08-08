-- PR-17 closure: keep the external deduction ledger inside its locked proposed amount.
-- Historical migrations remain immutable; this forward guard covers both service writes
-- and any future internal writer that uses the ledger tables directly.

CREATE OR REPLACE FUNCTION guard_external_deduction_entry_bounds()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  proposed_amount numeric(18,2);
  current_actual numeric(18,2);
  referenced_case_id uuid;
BEGIN
  SELECT target_case.proposed_deduction_amount
  INTO proposed_amount
  FROM rework_external_responsibility_cases target_case
  WHERE target_case.case_id=NEW.case_id
  FOR UPDATE;

  IF proposed_amount IS NULL THEN
    RAISE EXCEPTION 'external deduction case does not exist'
      USING ERRCODE='23503';
  END IF;

  IF NEW.entry_type<>'deduction' THEN
    SELECT source_entry.case_id
    INTO referenced_case_id
    FROM rework_external_deduction_entries source_entry
    WHERE source_entry.deduction_entry_id=NEW.reverses_entry_id;

    IF referenced_case_id IS DISTINCT FROM NEW.case_id THEN
      RAISE EXCEPTION 'external deduction correction must reference an entry from the same case'
        USING ERRCODE='23514';
    END IF;
  END IF;

  SELECT COALESCE(sum(entry.amount),0)
  INTO current_actual
  FROM rework_external_deduction_entries entry
  WHERE entry.case_id=NEW.case_id;

  IF current_actual+NEW.amount<0
     OR current_actual+NEW.amount>proposed_amount THEN
    RAISE EXCEPTION 'external deduction cumulative actual must stay between zero and proposed amount'
      USING ERRCODE='23514';
  END IF;

  RETURN NEW;
END $$;

CREATE TRIGGER external_deduction_entries_amount_bounds
  BEFORE INSERT ON rework_external_deduction_entries
  FOR EACH ROW EXECUTE FUNCTION guard_external_deduction_entry_bounds();
