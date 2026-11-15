-- Time evidence supplements the original feedback; feedback/review identities remain immutable.
CREATE TABLE digital_development_comment_times (
 evidence_id uuid PRIMARY KEY,
 comment_id uuid NOT NULL UNIQUE,
 source_id uuid NOT NULL,
 round_number integer NOT NULL,
 scope_ref text NOT NULL,
 comment_version integer NOT NULL,
 FOREIGN KEY(comment_id,source_id,round_number,scope_ref,comment_version)
  REFERENCES digital_development_final_comments(comment_id,source_id,round_number,scope_ref,version),
 precision text NOT NULL CHECK(precision IN ('instant','date')),
 occurred_at timestamptz,
 occurred_date date,
 note text NOT NULL CHECK(length(btrim(note)) BETWEEN 1 AND 2000),
 recorded_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL,
 CHECK((precision='instant' AND occurred_at IS NOT NULL AND occurred_date IS NULL) OR
       (precision='date' AND occurred_date IS NOT NULL AND occurred_at IS NULL)),
 CHECK(occurred_at IS NULL OR occurred_at<=recorded_at),
 CHECK(occurred_date IS NULL OR occurred_date<=(recorded_at AT TIME ZONE 'Asia/Shanghai')::date)
);
CREATE FUNCTION guard_development_comment_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM digital_development_final_comments c WHERE c.comment_id=NEW.comment_id
   AND (c.occurred_at IS NULL OR (NEW.precision='instant' AND NEW.occurred_at=c.occurred_at))) THEN
  RAISE EXCEPTION 'known original customer occurrence cannot be overridden' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER comment_time_scope BEFORE INSERT ON digital_development_comment_times
 FOR EACH ROW EXECUTE FUNCTION guard_development_comment_time();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON digital_development_comment_times
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER no_truncate BEFORE TRUNCATE ON digital_development_comment_times
 FOR EACH STATEMENT EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON digital_development_comment_times
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');
