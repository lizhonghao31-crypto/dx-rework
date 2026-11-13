-- Immutable library versions; no historic order or human role is rewritten.
CREATE TABLE digital_special_craft_versions (
 craft_id uuid NOT NULL,
 version integer NOT NULL CHECK(version>0),
 definition jsonb NOT NULL CHECK(jsonb_typeof(definition)='object'),
 created_by uuid NOT NULL REFERENCES app_users(id),
 recorded_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY(craft_id,version)
);
CREATE TABLE digital_special_craft_heads (
 craft_id uuid PRIMARY KEY,
 current_version integer NOT NULL CHECK(current_version>0),
 FOREIGN KEY(craft_id,current_version) REFERENCES digital_special_craft_versions(craft_id,version)
);
CREATE TRIGGER digital_special_craft_versions_immutable
 BEFORE UPDATE OR DELETE ON digital_special_craft_versions
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();
CREATE TRIGGER digital_special_craft_heads_no_delete
 BEFORE DELETE ON digital_special_craft_heads
 FOR EACH ROW EXECUTE FUNCTION guard_production_order_root_immutable();

ALTER TABLE digital_timeline_craft_steps DROP CONSTRAINT digital_timeline_craft_steps_craft_kind_check;
ALTER TABLE digital_timeline_craft_steps ADD CHECK(craft_kind IN ('embroidery','printing','special'));
ALTER TABLE digital_timeline_craft_steps DROP CONSTRAINT digital_timeline_craft_steps_sequence_check;
ALTER TABLE digital_timeline_craft_steps ADD CHECK(sequence BETWEEN 1 AND 64);
ALTER TABLE digital_timeline_craft_steps DROP CONSTRAINT digital_timeline_craft_steps_route_ref_craft_kind_key;
ALTER TABLE digital_timeline_craft_steps ADD COLUMN special_craft jsonb;
ALTER TABLE digital_timeline_craft_steps ADD COLUMN special_craft_id uuid GENERATED ALWAYS AS ((special_craft->>'id')::uuid) STORED;
ALTER TABLE digital_timeline_craft_steps ADD COLUMN special_craft_version integer GENERATED ALWAYS AS ((special_craft->>'version')::integer) STORED;
ALTER TABLE digital_timeline_craft_steps ADD CHECK((craft_kind='special')=(special_craft IS NOT NULL));
ALTER TABLE digital_timeline_craft_steps ADD FOREIGN KEY(special_craft_id,special_craft_version) REFERENCES digital_special_craft_versions(craft_id,version);
CREATE UNIQUE INDEX digital_craft_builtin_once ON digital_timeline_craft_steps(route_ref,craft_kind) WHERE craft_kind<>'special';
CREATE UNIQUE INDEX digital_craft_special_once ON digital_timeline_craft_steps(route_ref,special_craft_id) WHERE craft_kind='special';
ALTER TABLE digital_factory_routes DROP CONSTRAINT digital_factory_routes_secondary_craft_check;
ALTER TABLE digital_factory_routes ADD CHECK(secondary_craft IN ('无','印花','绣花','印绣花','特殊工艺'));
