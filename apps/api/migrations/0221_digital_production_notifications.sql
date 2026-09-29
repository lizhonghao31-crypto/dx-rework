-- Prompt receipts never update business tasks, deadlines or existing todo read state.
-- A monotonic intent order disambiguates multiple lifecycle events in one transaction.
ALTER TABLE digital_production_event_intents ADD COLUMN notification_sequence bigint GENERATED ALWAYS AS IDENTITY;
CREATE INDEX digital_intent_task_sequence ON digital_production_event_intents(task_id,notification_sequence DESC);
CREATE TABLE digital_production_notification_events (
 event_id uuid PRIMARY KEY,
 source_key text NOT NULL UNIQUE,
 task_id uuid REFERENCES digital_production_tasks(task_id),
 todo_id uuid,
 event_kind text NOT NULL,
 deadline_revision_id bigint REFERENCES digital_production_deadline_revisions(revision_id),
 created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CHECK ((task_id IS NULL) <> (todo_id IS NULL))
);
CREATE TABLE digital_production_notification_receipts (
 event_id uuid NOT NULL REFERENCES digital_production_notification_events(event_id),
 source_event_id uuid NOT NULL,
 recipient_id uuid NOT NULL REFERENCES app_users(id),
 shown_at timestamptz, acknowledged_at timestamptz,
 PRIMARY KEY(event_id,recipient_id),
 UNIQUE(source_event_id,recipient_id),
 CHECK(acknowledged_at IS NULL OR shown_at IS NOT NULL)
);
CREATE INDEX digital_notification_unseen ON digital_production_notification_receipts(recipient_id,event_id) WHERE shown_at IS NULL;
CREATE TABLE digital_production_notification_projection (
 event_id uuid PRIMARY KEY REFERENCES digital_production_event_intents(event_id),
 projected_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TRIGGER digital_notification_event_history BEFORE UPDATE OR DELETE ON digital_production_notification_events FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
