-- The order and approval snapshot tables are immutable. Keep mutable monitoring
-- facts separate; existing approved cases have no row and remain excluded.
-- Count every hour except Sunday 00:00-24:00 in Asia/Shanghai. A deadline
-- landing exactly at Sunday midnight moves to Monday midnight, so it never
-- becomes overdue while the clock is paused.
CREATE FUNCTION sourcing_contract_return_add_hours(start_at timestamptz, hours_to_add integer)
RETURNS timestamptz LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  clock_at timestamptz := start_at;
  next_midnight timestamptz;
  remaining_seconds numeric := hours_to_add * 3600;
  available_seconds numeric;
BEGIN
  IF hours_to_add < 0 THEN RAISE EXCEPTION 'hours_to_add must be nonnegative'; END IF;
  LOOP
    next_midnight := ((clock_at AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp
      AT TIME ZONE 'Asia/Shanghai';
    IF EXTRACT(ISODOW FROM clock_at AT TIME ZONE 'Asia/Shanghai') = 7 THEN
      clock_at := next_midnight;
      CONTINUE;
    END IF;
    IF remaining_seconds = 0 THEN RETURN clock_at; END IF;
    available_seconds := EXTRACT(EPOCH FROM next_midnight - clock_at);
    IF remaining_seconds < available_seconds THEN
      RETURN clock_at + make_interval(secs => remaining_seconds::double precision);
    END IF;
    remaining_seconds := remaining_seconds - available_seconds;
    clock_at := next_midnight;
  END LOOP;
END $$;

CREATE FUNCTION sourcing_contract_return_elapsed_seconds(start_at timestamptz, finish_at timestamptz)
RETURNS bigint LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  clock_at timestamptz := start_at;
  next_midnight timestamptz;
  segment_end timestamptz;
  counted_seconds numeric := 0;
BEGIN
  WHILE clock_at < finish_at LOOP
    next_midnight := ((clock_at AT TIME ZONE 'Asia/Shanghai')::date + 1)::timestamp
      AT TIME ZONE 'Asia/Shanghai';
    segment_end := LEAST(finish_at, next_midnight);
    IF EXTRACT(ISODOW FROM clock_at AT TIME ZONE 'Asia/Shanghai') <> 7 THEN
      counted_seconds := counted_seconds + EXTRACT(EPOCH FROM segment_end - clock_at);
    END IF;
    clock_at := segment_end;
  END LOOP;
  RETURN FLOOR(counted_seconds)::bigint;
END $$;

CREATE TABLE sourcing_contract_return_monitors (
  sourcing_case_id uuid PRIMARY KEY REFERENCES sourcing_cases(sourcing_case_id),
  contract_return_monitor_enabled boolean NOT NULL DEFAULT false,
  contract_generated_at timestamptz,
  contract_return_due_at timestamptz,
  contract_returned_at timestamptz,
  contract_return_uploaded_by uuid REFERENCES app_users(id),
  CHECK (
    (contract_generated_at IS NULL AND contract_return_due_at IS NULL AND contract_returned_at IS NULL)
    OR (contract_return_monitor_enabled AND contract_generated_at IS NOT NULL
      AND contract_return_due_at = sourcing_contract_return_add_hours(contract_generated_at,48)
      AND (contract_returned_at IS NULL OR contract_returned_at >= contract_generated_at))
  )
);

-- The first successful ready PDF determines the clock. Document revisions and downloads
-- never change it; this trigger executes in the same transaction as the ready transition.
CREATE FUNCTION start_sourcing_contract_return_clock() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'ready' AND OLD.status <> 'ready' THEN
    UPDATE sourcing_contract_return_monitors
       SET contract_generated_at = NEW.generated_at,
           contract_return_due_at = sourcing_contract_return_add_hours(NEW.generated_at,48)
     WHERE sourcing_case_id = NEW.sourcing_case_id
       AND contract_return_monitor_enabled
       AND contract_generated_at IS NULL;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER sourcing_contract_return_ready
AFTER UPDATE OF status ON sourcing_contract_documents
FOR EACH ROW EXECUTE FUNCTION start_sourcing_contract_return_clock();

CREATE INDEX sourcing_contract_return_filter_idx
  ON sourcing_contract_return_monitors(contract_return_due_at,contract_returned_at)
  WHERE contract_return_monitor_enabled;
