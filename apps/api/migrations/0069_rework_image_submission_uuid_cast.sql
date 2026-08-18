-- Migration 0068 introduced a database-level N01 image guard, but compared
-- attachments.entity_id (text) directly with rework_orders.rework_order_id
-- (uuid). PostgreSQL rejects that comparison before it can evaluate whether
-- the order has a ready image. Replace only the function body and keep the
-- existing trigger in place.

CREATE OR REPLACE FUNCTION guard_rework_submission_requires_image()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='draft'
     AND NEW.status='pending_process_configuration'
     AND NOT EXISTS (
       SELECT 1
       FROM attachments attachment
       WHERE attachment.entity_type='rework_order'
         AND attachment.entity_id=NEW.rework_order_id::text
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
