-- Additive only: historical text, orders, execution and wages are untouched.
ALTER TABLE pattern_room_orders ADD COLUMN misc_association jsonb;
ALTER TABLE pattern_room_orders ADD CONSTRAINT misc_order_stable_association_shape CHECK (
 misc_association IS NULL OR (kind='misc' AND jsonb_typeof(misc_association)='object'
 AND misc_association ?& ARRAY['kind','id','styleNo','label']
 AND jsonb_typeof(misc_association->'kind')='string' AND misc_association->>'kind' IN ('source','po') AND jsonb_typeof(misc_association->'id')='string'
 AND jsonb_typeof(misc_association->'styleNo')='string' AND jsonb_typeof(misc_association->'label')='string')
);
