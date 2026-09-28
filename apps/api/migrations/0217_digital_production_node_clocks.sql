-- Digital production node clocks persist original SLA facts without deciding the business calendar.
-- The node row is created only when work actually becomes actionable; preassigned future work has no clock row.
CREATE TABLE production_order_node_clocks (
  node_instance_id uuid PRIMARY KEY,
  production_order_id uuid NOT NULL REFERENCES production_order_roots(production_order_id),
  node_key text NOT NULL CHECK (
    length(node_key) BETWEEN 1 AND 100
    AND node_key ~ '^[a-z0-9][a-z0-9_:-]*$'
  ),
  occurrence integer NOT NULL DEFAULT 1 CHECK (occurrence > 0),
  entered_at timestamptz NOT NULL,
  warning_at timestamptz NOT NULL,
  due_at timestamptz NOT NULL,
  deadline_policy_key text NOT NULL CHECK (
    length(deadline_policy_key) BETWEEN 1 AND 100
    AND deadline_policy_key ~ '^[a-z0-9][a-z0-9_.:-]*$'
  ),
  deadline_policy_version integer NOT NULL CHECK (deadline_policy_version > 0),
  completed_at timestamptz,
  created_by uuid NOT NULL REFERENCES app_users(id),
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(production_order_id,node_key,occurrence),
  CHECK (warning_at >= entered_at),
  CHECK (due_at >= warning_at),
  CHECK (completed_at IS NULL OR completed_at >= entered_at)
);

CREATE INDEX production_order_node_clocks_open_due_idx
  ON production_order_node_clocks(due_at,node_instance_id)
  WHERE completed_at IS NULL;

CREATE INDEX production_order_node_clocks_order_idx
  ON production_order_node_clocks(production_order_id,entered_at,node_instance_id);

CREATE FUNCTION guard_production_order_node_clock()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN
    RAISE EXCEPTION 'production node clock history is append-only' USING ERRCODE='55000';
  END IF;

  IF (to_jsonb(NEW) - 'completed_at') IS DISTINCT FROM (to_jsonb(OLD) - 'completed_at') THEN
    RAISE EXCEPTION 'production node clock deadline facts are immutable' USING ERRCODE='55000';
  END IF;

  IF OLD.completed_at IS NOT NULL
     OR NEW.completed_at IS NULL
     OR NEW.completed_at < OLD.entered_at THEN
    RAISE EXCEPTION 'production node completion may be recorded once' USING ERRCODE='55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER production_order_node_clock_guard
BEFORE UPDATE OR DELETE ON production_order_node_clocks
FOR EACH ROW EXECUTE FUNCTION guard_production_order_node_clock();

COMMENT ON TABLE production_order_node_clocks IS
  'One immutable timing snapshot per actionable digital-production node occurrence. No row exists before the node becomes actionable.';
COMMENT ON COLUMN production_order_node_clocks.due_at IS
  'Original completion deadline frozen when the node becomes actionable; reassignment or later data correction must not reset it.';
COMMENT ON COLUMN production_order_node_clocks.warning_at IS
  'Original pre-warning boundary frozen with the deadline policy snapshot.';
