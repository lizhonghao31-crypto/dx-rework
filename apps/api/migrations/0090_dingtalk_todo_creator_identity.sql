-- Preserve the DingTalk resource owner separately from the todo executor.
-- Existing provider tasks were created under the recipient and retain that owner.

ALTER TABLE dingtalk_todo_external_bindings
  ADD COLUMN creator_union_id text;

UPDATE dingtalk_todo_external_bindings
SET creator_union_id=recipient_union_id;

ALTER TABLE dingtalk_todo_external_bindings
  ALTER COLUMN creator_union_id SET NOT NULL,
  ADD CONSTRAINT dingtalk_todo_external_bindings_creator_union_id_check
    CHECK(length(btrim(creator_union_id)) BETWEEN 1 AND 200);
