-- Prospective only. Match the shared contract's trim and ASCII case folding.
CREATE FUNCTION normalize_sourcing_formal_style_key(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT nullif(translate(
    btrim(value,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'),
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'
  ),'')
$$;

CREATE FUNCTION sourcing_has_duplicate_formal_styles(lines jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT EXISTS (
    SELECT 1 FROM jsonb_array_elements(lines) AS entry
    CROSS JOIN LATERAL (SELECT normalize_sourcing_formal_style_key(entry->>'styleNo') AS style) AS identity
    WHERE identity.style IS NOT NULL
    GROUP BY identity.style HAVING count(*) > 1
  )
$$;

CREATE OR REPLACE FUNCTION guard_sourcing_line_duplicate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM sourcing_case_lines line
    WHERE line.sourcing_case_id=NEW.sourcing_case_id
      AND normalize_sourcing_formal_style_key(line.style_no)=normalize_sourcing_formal_style_key(NEW.style_no)
  ) THEN RAISE EXCEPTION 'duplicate formal style number in one sourcing order' USING ERRCODE='23505'; END IF;
  IF EXISTS (
    SELECT 1 FROM sourcing_case_lines line
    WHERE line.sourcing_case_id=NEW.sourcing_case_id
      AND COALESCE(normalize_sourcing_style_key(line.color),'')=COALESCE(normalize_sourcing_style_key(NEW.color),'')
      AND (normalize_sourcing_style_key(line.style_no)=ANY(ARRAY[normalize_sourcing_style_key(NEW.style_no),normalize_sourcing_style_key(NEW.alternate_style_no)])
        OR normalize_sourcing_style_key(line.alternate_style_no)=ANY(ARRAY[normalize_sourcing_style_key(NEW.style_no),normalize_sourcing_style_key(NEW.alternate_style_no)]))
  ) THEN RAISE EXCEPTION 'duplicate style identity and color in one sourcing order' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;

CREATE OR REPLACE FUNCTION guard_sourcing_revision_duplicate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF sourcing_has_duplicate_formal_styles(NEW.lines)
  THEN RAISE EXCEPTION 'duplicate formal style number in one sourcing order' USING ERRCODE='23505'; END IF;
  IF EXISTS (
    WITH revised AS (
      SELECT line.position,line.color,entry->>'styleNo' AS style_no,entry->>'alternateStyleNo' AS alternate_style_no
      FROM sourcing_case_lines_at(NEW.sourcing_case_id) line
      JOIN jsonb_array_elements(NEW.lines) entry ON (entry->>'position')::integer=line.position
    )
    SELECT 1 FROM revised a JOIN revised b ON a.position<b.position
    WHERE COALESCE(normalize_sourcing_style_key(a.color),'')=COALESCE(normalize_sourcing_style_key(b.color),'')
      AND (normalize_sourcing_style_key(a.style_no)=ANY(ARRAY[normalize_sourcing_style_key(b.style_no),normalize_sourcing_style_key(b.alternate_style_no)])
        OR normalize_sourcing_style_key(a.alternate_style_no)=ANY(ARRAY[normalize_sourcing_style_key(b.style_no),normalize_sourcing_style_key(b.alternate_style_no)]))
  ) THEN RAISE EXCEPTION 'duplicate revised style identity and color in one sourcing order' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;

-- Check the same current positions as the application after a full correction.
CREATE OR REPLACE FUNCTION guard_sourcing_style_revision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE source sourcing_cases%ROWTYPE; event operation_events%ROWTYPE; entry jsonb;
BEGIN
  SELECT * INTO source FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  SELECT * INTO event FROM operation_events WHERE event_id=NEW.operation_event_id;
  IF source.sourcing_case_id IS NULL OR source.deleted_at IS NOT NULL
    OR NEW.revision<>(SELECT COALESCE(max(revision),0)+1 FROM sourcing_style_revisions WHERE sourcing_case_id=NEW.sourcing_case_id)
    OR event.event_id IS NULL OR event.action<>'sourcing.styles.revise'
    OR event.entity_type<>'sourcing_case' OR event.entity_id<>NEW.sourcing_case_id::text
    OR event.actor_id<>NEW.changed_by OR event.request_id<>NEW.request_id
    OR event.after_state->'lines' IS DISTINCT FROM NEW.lines
    OR NOT (event.actor_roles @> ARRAY['root_superuser']::text[]
      OR (event.actor_roles @> ARRAY['production_management']::text[] AND event.authorization_capability='sourcing:decision:record')
      OR (event.actor_roles @> ARRAY['order_merchandiser']::text[] AND event.actor_id=source.created_by
        AND event.authorization_capability='sourcing:inquiry:create'))
  THEN RAISE EXCEPTION 'style revision requires current version and authorized audit' USING ERRCODE='55000'; END IF;
  IF jsonb_array_length(NEW.lines)<>(SELECT count(*) FROM sourcing_case_lines_at(NEW.sourcing_case_id))
    OR (SELECT count(DISTINCT value->>'position') FROM jsonb_array_elements(NEW.lines))<>jsonb_array_length(NEW.lines)
  THEN RAISE EXCEPTION 'style revision must cover exactly the existing lines' USING ERRCODE='55000'; END IF;
  FOR entry IN SELECT value FROM jsonb_array_elements(NEW.lines) LOOP
    IF jsonb_typeof(entry)<>'object' OR entry-ARRAY['position','styleNo','alternateStyleNo']<>'{}'::jsonb
      OR NOT EXISTS(SELECT 1 FROM sourcing_case_lines_at(NEW.sourcing_case_id) WHERE position=(entry->>'position')::integer)
      OR (nullif(btrim(entry->>'styleNo'),'') IS NULL AND nullif(btrim(entry->>'alternateStyleNo'),'') IS NULL)
      OR (entry->>'styleNo' IS NOT NULL AND length(btrim(entry->>'styleNo')) NOT BETWEEN 1 AND 100)
      OR (entry->>'alternateStyleNo' IS NOT NULL AND length(btrim(entry->>'alternateStyleNo')) NOT BETWEEN 1 AND 100)
    THEN RAISE EXCEPTION 'invalid style revision line' USING ERRCODE='55000'; END IF;
  END LOOP;
  RETURN NEW;
END; $$;

CREATE FUNCTION guard_sourcing_correction_formal_styles() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF sourcing_has_duplicate_formal_styles(NEW.lines)
  THEN RAISE EXCEPTION 'duplicate formal style number in one sourcing order' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a_sourcing_correction_duplicate BEFORE INSERT ON sourcing_case_corrections
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_correction_formal_styles();
