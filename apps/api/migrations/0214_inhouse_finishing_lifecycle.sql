-- A finishing order shares the QC execution and wage source, then completes at N06.
-- The audit guard gives tail supervisors only the dedicated finishing creation path.
ALTER TABLE rework_orders ADD CONSTRAINT rework_inhouse_finishing_no_responsibility
  CHECK (rework_kind='qc_rework' OR (
    tail_inspection_required=false
    AND tail_inspection_cost_bearer IS NULL
    AND inspection_report IS NULL
    AND status NOT IN ('pending_responsibility_determination','pending_owner_signature','pending_responsibility_action')
  ));

DO $$
DECLARE original text; revised text;
BEGIN
  SELECT pg_get_functiondef('guard_rework_order_write()'::regprocedure) INTO original;
  revised:=replace(original,
    $old$expected_action:='rework.draft.create'; expected_capability:='rework:initiate';$old$,
    $new$expected_action:=CASE WHEN NEW.rework_kind='inhouse_finishing' THEN 'rework.finishing.draft.create' ELSE 'rework.draft.create' END; expected_capability:=CASE WHEN NEW.rework_kind='inhouse_finishing' THEN 'process:configure' ELSE 'rework:initiate' END;$new$);
  IF revised=original THEN RAISE EXCEPTION '0214 creation guard target missing'; END IF;
  original:=revised;
  revised:=replace(original,
    $old$ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:='rework.submit'; expected_capability:='rework:initiate';$old$,
    $new$ELSIF OLD.status='draft' AND NEW.status='pending_process_configuration' THEN expected_action:=CASE WHEN OLD.rework_kind='inhouse_finishing' THEN 'rework.finishing.submit' ELSE 'rework.submit' END; expected_capability:=CASE WHEN OLD.rework_kind='inhouse_finishing' THEN 'process:configure' ELSE 'rework:initiate' END;$new$);
  IF revised=original THEN RAISE EXCEPTION '0214 submission guard target missing'; END IF;
  original:=revised;
  revised:=replace(original,
    $old$ELSIF OLD.status='pending_final_quantity_ie_review' AND NEW.status IN ('pending_order_review','pending_responsibility_determination') THEN$old$,
    $new$ELSIF OLD.status='pending_final_quantity_ie_review' AND NEW.status='completed' AND OLD.rework_kind='inhouse_finishing' THEN expected_action:='rework.final_quantity.ie_review'; expected_capability:='process:review';
      ELSIF OLD.status='pending_final_quantity_ie_review' AND NEW.status IN ('pending_order_review','pending_responsibility_determination') THEN$new$);
  IF revised=original THEN RAISE EXCEPTION '0214 N06 guard target missing'; END IF;
  original:=revised;
  revised:=replace(original,
    $old$NEW.source_system IS DISTINCT FROM OLD.source_system OR$old$,
    $new$NEW.source_system IS DISTINCT FROM OLD.source_system OR NEW.rework_kind IS DISTINCT FROM OLD.rework_kind OR$new$);
  IF revised=original THEN RAISE EXCEPTION '0214 immutable kind guard target missing'; END IF;
  EXECUTE revised;
END $$;
