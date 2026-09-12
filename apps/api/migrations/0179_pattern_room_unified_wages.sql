-- One wage read/settlement system; immutable new sources do not reopen historical month closures.
CREATE TABLE pattern_room_wage_items (
 wage_item_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 segment_id uuid NOT NULL UNIQUE REFERENCES pattern_room_segments(segment_id),
 round_id uuid NOT NULL REFERENCES pattern_room_rounds(round_id),
 order_id uuid NOT NULL REFERENCES pattern_room_orders(order_id),
 person_id uuid NOT NULL REFERENCES business_people(person_id),
 person_name_snapshot text NOT NULL, person_type_snapshot text NOT NULL CHECK(person_type_snapshot='internal'),
 wage_type text NOT NULL CHECK(wage_type IN ('first_pattern','pattern_rework','misc')),
 order_no text NOT NULL, style_no text NOT NULL, task_name text, category_name text NOT NULL,
 round_index integer NOT NULL, segment_index integer NOT NULL,
 unit text NOT NULL, unit_price numeric(14,3), quantity integer, actual_hours numeric,
 segment_amount numeric(26,8) NOT NULL CHECK(segment_amount>=0),
 round_amount numeric(26,8) NOT NULL CHECK(round_amount>=0),
 payable_amount numeric(26,2) NOT NULL CHECK(payable_amount>0),
 completed_at timestamptz NOT NULL, period_month date NOT NULL,
 released_at timestamptz NOT NULL,
 release_basis text NOT NULL CHECK(release_basis IN ('pattern_handoff','pattern_cancel_fees','misc_complete','misc_stop')),
 cancellation boolean NOT NULL,
 CHECK(period_month=date_trunc('month',completed_at AT TIME ZONE 'Asia/Shanghai')::date)
);
CREATE INDEX pattern_room_wages_period_person ON pattern_room_wage_items(period_month,person_id,wage_item_id);
CREATE INDEX pattern_room_wages_round ON pattern_room_wage_items(round_id,wage_item_id);
CREATE TRIGGER pattern_room_wages_no_mutation BEFORE UPDATE OR DELETE ON pattern_room_wage_items
 FOR EACH ROW EXECUTE FUNCTION reject_operation_event_mutation();

CREATE FUNCTION guard_pattern_wage_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_setting('dx_rework.pattern_wage_action',true) IS DISTINCT FROM 'materialize' THEN
   RAISE EXCEPTION 'pattern wages require source materialization' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pattern_room_wages_insert_guard BEFORE INSERT ON pattern_room_wage_items
 FOR EACH ROW EXECUTE FUNCTION guard_pattern_wage_insert();

CREATE FUNCTION materialize_pattern_round_wages(target_round uuid) RETURNS void LANGUAGE plpgsql AS $$
DECLARE r pattern_room_rounds%ROWTYPE; o pattern_room_orders%ROWTYPE; basis text; total numeric; expected numeric; prior_action text; first_release_at timestamptz; cancelled_for_release boolean;
BEGIN
 SELECT * INTO STRICT r FROM pattern_room_rounds WHERE round_id=target_round FOR UPDATE;
 SELECT * INTO STRICT o FROM pattern_room_orders WHERE order_id=r.order_id;
 SELECT min(wage_eligible_at) INTO first_release_at FROM pattern_room_segments WHERE round_id=target_round;
 IF first_release_at IS NULL THEN RETURN; END IF;
 -- A later cancellation must not relabel wages already released, including migration backfills.
 cancelled_for_release:=r.cancelled_at IS NOT NULL AND r.cancelled_at<=first_release_at;
 IF o.kind='pattern' AND r.handed_over_at IS NOT NULL AND r.completed_at IS NOT NULL THEN
   basis:='pattern_handoff'; expected:=r.agreed_amount;
 ELSIF o.kind='pattern' AND r.cancelled_at IS NOT NULL AND r.fee_confirmed_at IS NOT NULL THEN
   basis:='pattern_cancel_fees'; expected:=r.cancelled_amount;
 ELSIF o.kind='misc' AND r.hours_confirmed_at IS NOT NULL AND r.actual_hours IS NOT NULL
   AND (r.completed_at IS NOT NULL OR r.stopped_at IS NOT NULL) THEN
   basis:=CASE WHEN cancelled_for_release OR r.completed_at IS NULL THEN 'misc_stop' ELSE 'misc_complete' END;
   expected:=r.agreed_amount;
 ELSE RAISE EXCEPTION 'pattern wage release basis is incomplete' USING ERRCODE='23514';
 END IF;
 SELECT sum(amount) INTO total FROM pattern_room_segments WHERE round_id=target_round;
 IF total IS DISTINCT FROM expected OR expected IS NULL OR EXISTS(
   SELECT 1 FROM pattern_room_segments WHERE round_id=target_round AND
    (ended_at IS NULL OR amount IS NULL OR (amount>0 AND wage_eligible_at IS NULL))) THEN
   RAISE EXCEPTION 'pattern wage sources do not balance' USING ERRCODE='23514';
 END IF;
 -- Preserve the established 0062 rule: round the group to cents, truncate each exact share,
 -- distribute the remaining cents by remainder then real person ID. Segment ID breaks repeat-worker ties.
 prior_action:=current_setting('dx_rework.pattern_wage_action',true);
 PERFORM set_config('dx_rework.pattern_wage_action','materialize',true);
 WITH shares AS (
  SELECT s.*,row_number() OVER(ORDER BY amount-trunc(amount,2) DESC,person_id,segment_id) remainder_rank,
   round(expected,2)-sum(trunc(amount,2)) OVER() cents_left
  FROM pattern_room_segments s WHERE round_id=target_round
 ), allocated AS (
  SELECT shares.*,trunc(amount,2)+CASE WHEN remainder_rank<=round(cents_left*100)::integer THEN 0.01 ELSE 0 END payable
  FROM shares
 ) INSERT INTO pattern_room_wage_items(segment_id,round_id,order_id,person_id,person_name_snapshot,person_type_snapshot,
   wage_type,order_no,style_no,task_name,category_name,round_index,segment_index,unit,unit_price,quantity,actual_hours,
   segment_amount,round_amount,payable_amount,completed_at,period_month,released_at,release_basis,cancellation)
 SELECT segment_id,r.round_id,o.order_id,person_id,worker_name,person_type,
   CASE WHEN o.kind='misc' THEN 'misc' WHEN r.round_type='rework' THEN 'pattern_rework' ELSE 'first_pattern' END,
   o.order_no,o.style_no,o.task_name,r.category_name,r.round_index,segment_index,r.unit,r.unit_price,r.quantity,actual_hours,
   amount,expected,payable,COALESCE(worker_completed_at,ended_at),
   date_trunc('month',COALESCE(worker_completed_at,ended_at) AT TIME ZONE 'Asia/Shanghai')::date,
   wage_eligible_at,basis,(basis='pattern_cancel_fees' OR (o.kind='misc' AND cancelled_for_release))
 FROM allocated WHERE payable>0 AND wage_eligible_at IS NOT NULL
 ON CONFLICT(segment_id) DO NOTHING;
 PERFORM set_config('dx_rework.pattern_wage_action',COALESCE(prior_action,''),true);
 IF (SELECT COALESCE(sum(payable_amount),0) FROM pattern_room_wage_items WHERE round_id=target_round) IS DISTINCT FROM round(expected,2) THEN
   RAISE EXCEPTION 'pattern wage allocation does not equal rounded round amount' USING ERRCODE='23514';
 END IF;
END $$;

-- Statement transition tables materialize each round once, including a release of more than 500 segments.
CREATE FUNCTION release_pattern_wage_sources() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_round uuid;
BEGIN
 FOR target_round IN SELECT DISTINCT n.round_id FROM new_segments n JOIN old_segments o USING(segment_id)
   WHERE o.wage_eligible_at IS NULL AND n.wage_eligible_at IS NOT NULL
 LOOP PERFORM materialize_pattern_round_wages(target_round); END LOOP;
 RETURN NULL;
END $$;
CREATE TRIGGER pattern_room_release_wages AFTER UPDATE ON pattern_room_segments
 REFERENCING OLD TABLE AS old_segments NEW TABLE AS new_segments
 FOR EACH STATEMENT EXECUTE FUNCTION release_pattern_wage_sources();
DO $$ DECLARE target_round uuid; BEGIN
 FOR target_round IN SELECT DISTINCT round_id FROM pattern_room_segments WHERE wage_eligible_at IS NOT NULL
 LOOP PERFORM materialize_pattern_round_wages(target_round); END LOOP;
END $$;

CREATE FUNCTION guard_released_pattern_segment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' THEN
  IF EXISTS(SELECT 1 FROM pattern_room_segments WHERE round_id=NEW.round_id AND wage_eligible_at IS NOT NULL) THEN
   RAISE EXCEPTION 'released round cannot acquire new labor' USING ERRCODE='55000';
  END IF;
  RETURN NEW;
 END IF;
 IF OLD.wage_eligible_at IS NOT NULL OR EXISTS(SELECT 1 FROM pattern_room_wage_items WHERE round_id=OLD.round_id) THEN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'released labor is immutable' USING ERRCODE='55000'; END IF;
  IF (NEW.segment_id,NEW.round_id,NEW.segment_index,NEW.person_id,NEW.worker_user_id,NEW.worker_name,NEW.person_type,
      NEW.amount,NEW.actual_hours,NEW.started_at,NEW.ended_at,NEW.worker_completed_at,NEW.wage_eligible_at)
   IS DISTINCT FROM (OLD.segment_id,OLD.round_id,OLD.segment_index,OLD.person_id,OLD.worker_user_id,OLD.worker_name,OLD.person_type,
      OLD.amount,OLD.actual_hours,OLD.started_at,OLD.ended_at,OLD.worker_completed_at,OLD.wage_eligible_at) THEN
   RAISE EXCEPTION 'released labor is immutable' USING ERRCODE='55000';
  END IF;
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pattern_room_released_segment_guard BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_segments
 FOR EACH ROW EXECUTE FUNCTION guard_released_pattern_segment();
CREATE FUNCTION guard_released_pattern_round() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM pattern_room_segments WHERE round_id=OLD.round_id AND wage_eligible_at IS NOT NULL)
  AND (NEW.round_id,NEW.order_id,NEW.round_type,NEW.round_index,NEW.category_id,NEW.price_version,NEW.category_name,
       NEW.unit,NEW.unit_price,NEW.quantity,NEW.agreed_amount,NEW.actual_hours,NEW.completed_at)
   IS DISTINCT FROM (OLD.round_id,OLD.order_id,OLD.round_type,OLD.round_index,OLD.category_id,OLD.price_version,OLD.category_name,
       OLD.unit,OLD.unit_price,OLD.quantity,OLD.agreed_amount,OLD.actual_hours,OLD.completed_at) THEN
  RAISE EXCEPTION 'released round pricing and completion are immutable' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER pattern_room_released_round_guard BEFORE UPDATE ON pattern_room_rounds
 FOR EACH ROW EXECUTE FUNCTION guard_released_pattern_round();

ALTER TABLE rework_wage_settlement_marks ADD COLUMN pattern_wage_item_id uuid REFERENCES pattern_room_wage_items(wage_item_id);
ALTER TABLE rework_wage_settlement_marks DROP CONSTRAINT rework_wage_settlement_marks_check;
ALTER TABLE rework_wage_settlement_marks DROP CONSTRAINT rework_wage_settlement_marks_check1;
ALTER TABLE rework_wage_settlement_marks ADD CONSTRAINT wage_settlement_exactly_one_source CHECK(
 (wage_item_id IS NOT NULL)::int+(closure_line_id IS NOT NULL)::int+(pattern_wage_item_id IS NOT NULL)::int=1);
ALTER TABLE rework_wage_settlement_marks ADD CONSTRAINT wage_settlement_source_identity CHECK(
 line_id=COALESCE(wage_item_id,closure_line_id,pattern_wage_item_id));
