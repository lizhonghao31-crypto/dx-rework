-- A derived arrangement/report ID need not exist in tasks or legacy todos.
CREATE TABLE todo_content_reads (
 recipient_id uuid NOT NULL REFERENCES app_users(id),
 todo_id uuid NOT NULL,
 content_token text NOT NULL CHECK(content_token ~ '^[a-f0-9]{64}$'),
 read_route jsonb NOT NULL CHECK(jsonb_typeof(read_route)='object'),
 read_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(recipient_id,todo_id,content_token)
);
CREATE TRIGGER todo_content_read_immutable BEFORE UPDATE OR DELETE ON todo_content_reads
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
