-- Prospective guards: never rewrite historical rows or their identity revisions.
CREATE FUNCTION normalize_sourcing_style_key(value text) RETURNS text LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT translate(btrim(value),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')
$$;

CREATE FUNCTION guard_sourcing_line_duplicate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM sourcing_case_lines line
    WHERE line.sourcing_case_id=NEW.sourcing_case_id
      AND COALESCE(normalize_sourcing_style_key(line.color),'')=COALESCE(normalize_sourcing_style_key(NEW.color),'')
      AND (normalize_sourcing_style_key(line.style_no)=ANY(ARRAY[normalize_sourcing_style_key(NEW.style_no),normalize_sourcing_style_key(NEW.alternate_style_no)])
        OR normalize_sourcing_style_key(line.alternate_style_no)=ANY(ARRAY[normalize_sourcing_style_key(NEW.style_no),normalize_sourcing_style_key(NEW.alternate_style_no)]))
  ) THEN RAISE EXCEPTION 'duplicate style identity and color in one sourcing order' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a_sourcing_line_duplicate BEFORE INSERT ON sourcing_case_lines
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_line_duplicate();

CREATE FUNCTION guard_sourcing_revision_duplicate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM sourcing_cases WHERE sourcing_case_id=NEW.sourcing_case_id FOR UPDATE;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.lines) a
    CROSS JOIN jsonb_array_elements(NEW.lines) b
    JOIN sourcing_case_lines la ON la.sourcing_case_id=NEW.sourcing_case_id AND la.position=(a->>'position')::integer
    JOIN sourcing_case_lines lb ON lb.sourcing_case_id=NEW.sourcing_case_id AND lb.position=(b->>'position')::integer
    WHERE (a->>'position')::integer<(b->>'position')::integer
      AND COALESCE(normalize_sourcing_style_key(la.color),'')=COALESCE(normalize_sourcing_style_key(lb.color),'')
      AND (normalize_sourcing_style_key(a->>'styleNo')=ANY(ARRAY[normalize_sourcing_style_key(b->>'styleNo'),normalize_sourcing_style_key(b->>'alternateStyleNo')])
        OR normalize_sourcing_style_key(a->>'alternateStyleNo')=ANY(ARRAY[normalize_sourcing_style_key(b->>'styleNo'),normalize_sourcing_style_key(b->>'alternateStyleNo')]))
  ) THEN RAISE EXCEPTION 'duplicate revised style identity and color in one sourcing order' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END; $$;
CREATE TRIGGER a_sourcing_revision_duplicate BEFORE INSERT ON sourcing_style_revisions
  FOR EACH ROW EXECUTE FUNCTION guard_sourcing_revision_duplicate();
