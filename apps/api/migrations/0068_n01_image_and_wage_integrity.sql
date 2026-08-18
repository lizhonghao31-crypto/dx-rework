-- N01 needs physical visual evidence before a manual rework order can enter
-- the workflow. The service verifies ownership; this database guard prevents
-- any direct status update from bypassing the existence and ready-state rule.

CREATE OR REPLACE FUNCTION guard_rework_submission_requires_image()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft'
     AND NEW.status='pending_process_configuration'
     AND NOT EXISTS (
       SELECT 1
       FROM attachments attachment
       WHERE attachment.entity_type='rework_order'
         AND attachment.entity_id=NEW.rework_order_id
         AND attachment.status='ready'
         AND attachment.mime_type IN ('image/jpeg','image/png','image/webp')
     )
  THEN
    RAISE EXCEPTION 'N01 submission requires at least one ready rework image'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER rework_orders_submission_requires_image
  BEFORE UPDATE OF status ON rework_orders
  FOR EACH ROW EXECUTE FUNCTION guard_rework_submission_requires_image();
