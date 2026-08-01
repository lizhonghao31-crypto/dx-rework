ALTER TABLE identity_mappings
  ADD CONSTRAINT identity_mappings_corp_union_unique UNIQUE(provider, corp_id, union_id);
