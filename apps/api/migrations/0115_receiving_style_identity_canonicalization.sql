-- Canonicalize receiving/rework style matching without rewriting immutable legacy facts.
-- Legacy batches may contain lowercase or padded style numbers; business identity is
-- the trimmed uppercase value used by the receiving board and new receiving writes.

CREATE OR REPLACE FUNCTION bind_rework_receiving_batch_on_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_style text;
BEGIN
  IF NEW.source_receiving_batch_id IS NOT NULL THEN
    SELECT style_no
    INTO batch_style
    FROM receiving_batches
    WHERE receiving_batch_id=NEW.source_receiving_batch_id;

    IF batch_style IS NULL THEN
      RAISE EXCEPTION 'source receiving batch does not exist'
        USING ERRCODE='23503';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(upper(btrim(batch_style))));

    IF NEW.style_no IS NULL
       OR upper(btrim(NEW.style_no))<>upper(btrim(batch_style)) THEN
      RAISE EXCEPTION 'source receiving batch style mismatch'
        USING ERRCODE='23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM rework_orders completed_order
      WHERE completed_order.source_receiving_batch_id=NEW.source_receiving_batch_id
        AND completed_order.status='completed'
    ) THEN
      RAISE EXCEPTION 'source receiving batch is already completed'
        USING ERRCODE='55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM rework_orders active_order
      WHERE active_order.source_receiving_batch_id=NEW.source_receiving_batch_id
        AND active_order.status NOT IN ('completed','cancelled','deleted')
    ) THEN
      RAISE EXCEPTION 'source receiving batch already has active rework'
        USING ERRCODE='55000';
    END IF;
  ELSIF NEW.style_no IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(upper(btrim(NEW.style_no))));

    SELECT batch.receiving_batch_id
    INTO NEW.source_receiving_batch_id
    FROM receiving_batches batch
    WHERE upper(btrim(batch.style_no))=upper(btrim(NEW.style_no))
      AND NOT EXISTS (
        SELECT 1
        FROM rework_orders completed_order
        WHERE completed_order.source_receiving_batch_id=batch.receiving_batch_id
          AND completed_order.status='completed'
      )
    ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
    LIMIT 1;

    IF NEW.source_receiving_batch_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM rework_orders active_order
         WHERE active_order.source_receiving_batch_id=NEW.source_receiving_batch_id
           AND active_order.status NOT IN ('completed','cancelled','deleted')
       )
    THEN
      RAISE EXCEPTION 'source receiving batch already has active rework'
        USING ERRCODE='55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION guard_rework_receiving_batch_identity()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_style text;
BEGIN
  IF OLD.source_receiving_batch_id IS NOT NULL THEN
    IF NEW.source_receiving_batch_id IS DISTINCT FROM OLD.source_receiving_batch_id THEN
      RAISE EXCEPTION 'source receiving batch is immutable'
        USING ERRCODE='55000';
    END IF;

    SELECT style_no
    INTO batch_style
    FROM receiving_batches
    WHERE receiving_batch_id=OLD.source_receiving_batch_id;

    IF NEW.style_no IS NULL
       OR upper(btrim(NEW.style_no))<>upper(btrim(batch_style)) THEN
      RAISE EXCEPTION 'bound rework style is immutable'
        USING ERRCODE='55000';
    END IF;

    RETURN NEW;
  END IF;

  IF NEW.source_receiving_batch_id IS NOT NULL THEN
    SELECT style_no
    INTO batch_style
    FROM receiving_batches
    WHERE receiving_batch_id=NEW.source_receiving_batch_id;

    IF batch_style IS NULL THEN
      RAISE EXCEPTION 'source receiving batch does not exist'
        USING ERRCODE='23503';
    END IF;

    PERFORM pg_advisory_xact_lock(hashtext(upper(btrim(batch_style))));

    IF NEW.style_no IS NULL
       OR upper(btrim(NEW.style_no))<>upper(btrim(batch_style)) THEN
      RAISE EXCEPTION 'source receiving batch style mismatch'
        USING ERRCODE='23514';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM rework_orders completed_order
      WHERE completed_order.source_receiving_batch_id=NEW.source_receiving_batch_id
        AND completed_order.status='completed'
    ) THEN
      RAISE EXCEPTION 'source receiving batch is already completed'
        USING ERRCODE='55000';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM rework_orders active_order
      WHERE active_order.source_receiving_batch_id=NEW.source_receiving_batch_id
        AND active_order.status NOT IN ('completed','cancelled','deleted')
    ) THEN
      RAISE EXCEPTION 'source receiving batch already has active rework'
        USING ERRCODE='55000';
    END IF;
  ELSIF NEW.style_no IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtext(upper(btrim(NEW.style_no))));

    SELECT batch.receiving_batch_id
    INTO NEW.source_receiving_batch_id
    FROM receiving_batches batch
    WHERE upper(btrim(batch.style_no))=upper(btrim(NEW.style_no))
      AND NOT EXISTS (
        SELECT 1
        FROM rework_orders completed_order
        WHERE completed_order.source_receiving_batch_id=batch.receiving_batch_id
          AND completed_order.status='completed'
      )
    ORDER BY batch.created_at DESC,batch.receiving_batch_id DESC
    LIMIT 1;

    IF NEW.source_receiving_batch_id IS NOT NULL
       AND EXISTS (
         SELECT 1
         FROM rework_orders active_order
         WHERE active_order.source_receiving_batch_id=NEW.source_receiving_batch_id
           AND active_order.status NOT IN ('completed','cancelled','deleted')
       )
    THEN
      RAISE EXCEPTION 'source receiving batch already has active rework'
        USING ERRCODE='55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION lock_receiving_batch_on_rework_completion()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch_style text;
BEGIN
  IF NEW.status='completed'
     AND OLD.status IS DISTINCT FROM 'completed'
     AND NEW.source_receiving_batch_id IS NOT NULL THEN
    SELECT style_no
    INTO batch_style
    FROM receiving_batches
    WHERE receiving_batch_id=NEW.source_receiving_batch_id;

    IF batch_style IS NOT NULL THEN
      PERFORM pg_advisory_xact_lock(hashtext(upper(btrim(batch_style))));
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

