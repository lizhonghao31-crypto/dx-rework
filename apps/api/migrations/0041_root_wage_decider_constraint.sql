-- Complete the Root wage adjustment identity bypass at the table-constraint layer.
-- Ordinary users must still be separated from their own adjustment decisions.
-- Root remains subject to all wage state, amount, version and audit constraints.

DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT c.conname
  INTO constraint_name
  FROM pg_constraint c
  WHERE c.conrelid='rework_wage_adjustments'::regclass
    AND c.contype='c'
    AND pg_get_constraintdef(c.oid)
      LIKE '%requested_by IS DISTINCT FROM decided_by%'
  ORDER BY c.conname
  LIMIT 1;

  IF constraint_name IS NULL THEN
    RAISE EXCEPTION
      'wage adjustment requester/decider separation constraint was not found'
      USING ERRCODE='55000';
  END IF;

  EXECUTE format(
    'ALTER TABLE rework_wage_adjustments DROP CONSTRAINT %I',
    constraint_name
  );
END;
$$;

ALTER TABLE rework_wage_adjustments
  ADD CONSTRAINT rework_wage_adjustments_decider_separation_check
  CHECK (
    requested_by IS DISTINCT FROM decided_by
    OR access_is_root_actor(decided_by)
  );
