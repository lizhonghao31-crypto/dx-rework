-- Restore compatibility for the retired wage-adjustment audit table.
--
-- Migration 0041 allowed Root to approve its own historical adjustment through
-- a CHECK constraint that calls access_is_root_actor(). That makes pg_restore
-- re-evaluate live authorization while COPY is loading table data, so restore
-- order/search_path can make an otherwise valid historical row unrestorable.
--
-- The wage-adjustment workflow has been retired since 0074. Its INSERT and
-- UPDATE guards reject every new mutation, while existing rows remain immutable
-- audit evidence. The cross-table CHECK therefore adds no live write protection
-- and must not be re-evaluated during disaster recovery.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'rework_wage_adjustments'::regclass
      AND trigger_row.tgname = 'wage_adjustments_guard_insert'
      AND trigger_row.tgenabled <> 'D'
      AND function_row.proname = 'guard_wage_adjustment_insert'
      AND pg_get_functiondef(function_row.oid)
        LIKE '%wage adjustment workflow is retired%'
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
    WHERE trigger_row.tgrelid = 'rework_wage_adjustments'::regclass
      AND trigger_row.tgname = 'wage_adjustments_guard_update'
      AND trigger_row.tgenabled <> 'D'
      AND function_row.proname = 'guard_wage_adjustment_update'
      AND pg_get_functiondef(function_row.oid)
        LIKE '%wage adjustment workflow is retired%'
  ) THEN
    RAISE EXCEPTION
      'wage adjustment retirement guards are not active'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

ALTER TABLE rework_wage_adjustments
  DROP CONSTRAINT IF EXISTS rework_wage_adjustments_decider_separation_check;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = 'rework_wage_adjustments'::regclass
      AND constraint_row.contype = 'c'
      AND pg_get_constraintdef(constraint_row.oid) LIKE '%access_is_root_actor%'
  ) THEN
    RAISE EXCEPTION
      'retired wage adjustments still contain a cross-table Root CHECK'
      USING ERRCODE = '55000';
  END IF;
END;
$$;
