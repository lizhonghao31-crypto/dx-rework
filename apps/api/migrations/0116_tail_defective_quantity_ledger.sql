CREATE TABLE rework_tail_defective_quantity_entries (
  entry_id uuid PRIMARY KEY,
  rework_order_id uuid NOT NULL REFERENCES rework_orders(rework_order_id),
  quantity integer NOT NULL CHECK (quantity > 0),
  recorded_by uuid NOT NULL REFERENCES app_users(id),
  operation_event_id uuid NOT NULL UNIQUE REFERENCES operation_events(event_id),
  request_id text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX rework_tail_defective_quantity_entries_order_time_idx
  ON rework_tail_defective_quantity_entries(rework_order_id,recorded_at,entry_id);

COMMENT ON TABLE rework_tail_defective_quantity_entries IS
  'Append-only tail-stage defective quantity ledger. Receiving-stage quantities remain owned by receiving receipts.';
