-- Additive provenance. Existing manual quotations and frozen budgets are untouched.
ALTER TABLE digital_quotation_documents ADD COLUMN assembly jsonb
 CHECK(assembly IS NULL OR (jsonb_typeof(assembly)='object' AND assembly->>'schemaVersion'='1'));
ALTER TABLE digital_quotation_versions ADD COLUMN assembly jsonb
 CHECK(assembly IS NULL OR (jsonb_typeof(assembly)='object' AND assembly->>'schemaVersion'='1'));
