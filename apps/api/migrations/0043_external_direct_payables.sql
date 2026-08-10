-- Standard external responsibility cases now enter the payables work queue as
-- soon as the supplier is known. Business allocation remains the audited source
-- fact, while the separate normal-case business-signoff click is retired.

CREATE OR REPLACE FUNCTION guard_external_case_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch rework_external_responsibility_batches%ROWTYPE;
  supplier current_supplier_catalog%ROWTYPE;
  order_record rework_orders%ROWTYPE;
  automatic_route boolean;
BEGIN
  SELECT * INTO batch
  FROM rework_external_responsibility_batches
  WHERE batch_id=NEW.batch_id;
  SELECT * INTO supplier
  FROM current_supplier_catalog
  WHERE supplier_id=NEW.supplier_id;
  SELECT * INTO order_record
  FROM rework_orders
  WHERE rework_order_id=NEW.rework_order_id;

  IF batch.batch_id IS NULL
     OR batch.rework_order_id<>NEW.rework_order_id
     OR batch.status<>'active'
     OR supplier.supplier_id IS NULL
     OR supplier.active IS DISTINCT FROM true
     OR supplier.version<>NEW.supplier_version
     OR supplier.supplier_type<>external_responsibility_expected_supplier_type(
       NEW.responsibility_type
     )
     OR NEW.supplier_code_snapshot<>supplier.supplier_code
     OR NEW.supplier_name_snapshot<>supplier.supplier_name
     OR NEW.supplier_type_snapshot<>supplier.supplier_type
     OR NEW.case_version<>1
     OR NEW.status<>'pending_payables_confirmation'
     OR NEW.submitted_at IS NULL
     OR NEW.payables_confirmed_at IS NOT NULL
     OR NOT external_responsibility_can_sign(
       NEW.business_handler_user_id,
       NEW.rework_order_id,
       NEW.responsibility_type
     ) THEN
    RAISE EXCEPTION 'external case supplier, handler or snapshot is invalid'
      USING ERRCODE='23514';
  END IF;

  automatic_route :=
    NEW.responsibility_type='processing_factory'
    AND order_record.processing_factory_type='supplier'
    AND NEW.supplier_id=order_record.processing_factory_supplier_id
    AND NEW.business_handler_user_id IS NOT DISTINCT FROM order_record.merchandiser_user_id
    AND NEW.processing_factory_override_reason IS NULL;

  IF automatic_route THEN
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.auto_route',
      'responsibility:determine',
      NEW.rework_order_id,
      NEW.created_by
    );
    RETURN NEW;
  END IF;

  IF NEW.responsibility_type='processing_factory'
     AND order_record.processing_factory_type='supplier'
     AND NEW.supplier_id IS DISTINCT FROM order_record.processing_factory_supplier_id
     AND NEW.processing_factory_override_reason IS NULL THEN
    RAISE EXCEPTION 'processing-factory override requires a reason'
      USING ERRCODE='23514';
  END IF;
  PERFORM require_external_responsibility_event(
    'rework.external_responsibility.allocate',
    'external_responsibility:sign',
    NEW.rework_order_id,
    NEW.created_by
  );
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION guard_external_case_item_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  target_case rework_external_responsibility_cases%ROWTYPE;
  item rework_external_responsibility_items%ROWTYPE;
  order_record rework_orders%ROWTYPE;
  automatic_route boolean;
BEGIN
  SELECT * INTO target_case
  FROM rework_external_responsibility_cases
  WHERE case_id=NEW.case_id;
  SELECT * INTO item
  FROM rework_external_responsibility_items
  WHERE external_item_id=NEW.external_item_id;
  SELECT * INTO order_record
  FROM rework_orders
  WHERE rework_order_id=target_case.rework_order_id;

  IF target_case.case_id IS NULL
     OR item.external_item_id IS NULL
     OR target_case.batch_id<>item.batch_id
     OR target_case.responsibility_type<>item.responsibility_type
     OR target_case.status<>'pending_payables_confirmation'
     OR target_case.submitted_at IS NULL THEN
    RAISE EXCEPTION 'external responsibility item cannot be assigned to this case'
      USING ERRCODE='23514';
  END IF;

  automatic_route :=
    target_case.responsibility_type='processing_factory'
    AND order_record.processing_factory_type='supplier'
    AND target_case.supplier_id=order_record.processing_factory_supplier_id
    AND target_case.business_handler_user_id IS NOT DISTINCT FROM order_record.merchandiser_user_id
    AND target_case.processing_factory_override_reason IS NULL;

  IF automatic_route THEN
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.auto_route',
      'responsibility:determine',
      target_case.rework_order_id,
      target_case.created_by
    );
  ELSE
    PERFORM require_external_responsibility_event(
      'rework.external_responsibility.allocate',
      'external_responsibility:sign',
      target_case.rework_order_id,
      target_case.created_by
    );
  END IF;
  RETURN NEW;
END $$;
