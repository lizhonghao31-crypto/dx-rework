-- Sourcing PR3: allow unified todo deep links into the sourcing order detail.
-- Business todos remain in the existing neutral todo table; no parallel task store is introduced.

DO $$
DECLARE
  route_constraint text;
BEGIN
  SELECT constraint_row.conname
    INTO route_constraint
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid='rework_todos'::regclass
    AND constraint_row.contype='c'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%routeName%'
    AND pg_get_constraintdef(constraint_row.oid) LIKE '%route_descriptor%'
  ORDER BY constraint_row.conname
  LIMIT 1;

  IF route_constraint IS NULL THEN
    RAISE EXCEPTION 'rework_todos route descriptor constraint was not found';
  END IF;

  EXECUTE format('ALTER TABLE rework_todos DROP CONSTRAINT %I', route_constraint);
END;
$$;

ALTER TABLE rework_todos
  ADD CONSTRAINT rework_todos_route_descriptor_check CHECK(
    jsonb_typeof(route_descriptor)='object'
    AND route_descriptor ? 'routeName'
    AND route_descriptor ? 'entityId'
    AND route_descriptor->>'routeName' IN (
      'rework_detail','process_configuration','whole_order_review',
      'responsibility_detail','own_factory_approval',
      'external_responsibility_detail','wage_period_detail',
      'sourcing_detail'
    )
    AND length(btrim(route_descriptor->>'entityId'))>0
  );
