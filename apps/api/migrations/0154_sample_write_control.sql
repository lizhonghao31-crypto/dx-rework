-- Sample writes stay closed until migration reconciliation and cutover explicitly activate them.
CREATE TABLE sample_write_control (
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 enabled boolean NOT NULL DEFAULT false,
 changed_by uuid REFERENCES app_users(id), changed_at timestamptz,
 reason text,
 CHECK (NOT enabled OR (changed_by IS NOT NULL AND changed_at IS NOT NULL AND reason IS NOT NULL AND length(btrim(reason))>0))
);
INSERT INTO sample_write_control(singleton,enabled) VALUES(true,false);
