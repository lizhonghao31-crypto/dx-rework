-- PERF02: append-only per-transaction invalidations. Native writers never lock
-- a shared model/worker row. Rollback also rolls back this registration.
CREATE TABLE digital_journey_fact_changes (
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 resource_id uuid NOT NULL,
 transaction_id bigint NOT NULL DEFAULT txid_current(),
 reason text NOT NULL DEFAULT 'native' CHECK(reason IN ('native','backfill')),
 registered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(resource_kind,resource_id,transaction_id)
);
CREATE TABLE digital_journey_fact_retries (
 resource_kind text NOT NULL CHECK(resource_kind IN ('source','order')),
 resource_id uuid NOT NULL,
 attempts integer NOT NULL CHECK(attempts>0),
 retry_after timestamptz NOT NULL,
 error_code text NOT NULL CHECK(error_code IN ('BUILD_FAILED','CLOCK_CHANGED','TIMEOUT')),
 PRIMARY KEY(resource_kind,resource_id)
);
CREATE INDEX digital_journey_fact_changes_registered ON digital_journey_fact_changes(registered_at,resource_kind,resource_id);

-- Reverse lookups used by precise invalidation; original primary keys cover
-- all forward ownership paths. No broad JSON/whole-order cache scan on a write.
CREATE INDEX journey_fact_task_predecessor ON digital_production_task_dependencies(predecessor_id,task_id);
CREATE INDEX journey_fact_task_assignee ON digital_production_task_access(assignee_id,task_id) WHERE assignee_id IS NOT NULL;
CREATE INDEX journey_fact_inherited_attachment ON digital_development_inherited_files(attachment_id,source_id);

-- Only native ID relationships; no names, style-number guesses, role snapshots
-- or user-authorized DTOs. UNION deduplicates the bounded native relationship graph.
CREATE FUNCTION digital_journey_affected(kind text, id uuid)
RETURNS TABLE(resource_kind text,resource_id uuid) LANGUAGE sql STABLE AS $fn$
 WITH RECURSIVE related(kind,id) AS (
  SELECT kind,id FROM (SELECT $1 AS kind,$2 AS id) input
  UNION
  SELECT next.kind,next.id FROM related r CROSS JOIN LATERAL (
   SELECT 'order'::text kind,o.production_order_id id FROM digital_production_orders o WHERE r.kind='source' AND o.source_id=r.id
   UNION ALL SELECT 'task',d.task_id FROM digital_production_task_dependencies d WHERE r.kind='task' AND d.predecessor_id=r.id
   UNION ALL SELECT 'source',a.source_id FROM digital_production_task_access a WHERE r.kind='task' AND a.task_id=r.id AND a.source_id IS NOT NULL
   UNION ALL SELECT 'order',a.production_order_id FROM digital_production_task_access a WHERE r.kind='task' AND a.task_id=r.id AND a.production_order_id IS NOT NULL
   -- Reuse the original (module,child_id) primary key, rather than scanning
   -- every child link by its nullable typed foreign-key columns for each write.
   UNION ALL SELECT 'order',l.production_order_id FROM digital_production_child_links l
    WHERE l.child_id=r.id AND l.module=CASE r.kind WHEN 'sourcing' THEN 'sourcing' WHEN 'production' THEN 'production'
     WHEN 'cutting' THEN 'cutting' WHEN 'receipt' THEN 'receiving' WHEN 'rework' THEN 'rework' WHEN 'pattern' THEN 'pattern_room' END
   UNION ALL SELECT 'sourcing',p.sourcing_case_id FROM sourcing_production_orders p WHERE r.kind='production' AND p.production_order_id=r.id
   UNION ALL SELECT 'sourcing',c.sourcing_case_id FROM cutting_orders c WHERE r.kind='cutting' AND c.cutting_order_id=r.id
   UNION ALL SELECT 'cutting',b.cutting_order_id FROM receiving_batches b WHERE r.kind='batch' AND b.receiving_batch_id=r.id AND b.cutting_order_id IS NOT NULL
   UNION ALL SELECT 'order',l.production_order_id FROM receiving_receipts p JOIN digital_production_child_links l ON l.module='receiving' AND l.child_id=p.receipt_id WHERE r.kind='batch' AND p.receiving_batch_id=r.id
   UNION ALL SELECT 'batch',p.receiving_batch_id FROM receiving_receipts p WHERE r.kind='receipt' AND p.receipt_id=r.id AND p.receiving_batch_id IS NOT NULL
   UNION ALL SELECT 'cutting',p.cutting_order_id FROM receiving_receipts p WHERE r.kind='receipt' AND p.receipt_id=r.id AND p.cutting_order_id IS NOT NULL
   UNION ALL SELECT 'batch',w.source_receiving_batch_id FROM rework_orders w WHERE r.kind='rework' AND w.rework_order_id=r.id AND w.source_receiving_batch_id IS NOT NULL
   UNION ALL SELECT 'source',p.source_id FROM digital_development_pattern_links p WHERE r.kind='pattern' AND p.order_id=r.id
  ) next WHERE next.id IS NOT NULL
 ) SELECT r.kind,r.id FROM related r WHERE
 (r.kind='order' AND EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.production_order_id=r.id)) OR
 (r.kind='source' AND EXISTS(SELECT 1 FROM digital_production_sources s WHERE s.source_id=r.id));
$fn$;

CREATE FUNCTION digital_journey_register_change() RETURNS trigger LANGUAGE plpgsql AS $fn$
DECLARE item jsonb; native record; affected record;
BEGIN
 IF TG_OP='UPDATE' AND OLD IS NOT DISTINCT FROM NEW THEN RETURN NEW; END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(CASE TG_OP
  WHEN 'INSERT' THEN jsonb_build_array(to_jsonb(NEW))
  WHEN 'DELETE' THEN jsonb_build_array(to_jsonb(OLD))
  ELSE jsonb_build_array(to_jsonb(OLD),to_jsonb(NEW)) END)
 LOOP
  IF TG_TABLE_NAME IN ('digital_production_sources','digital_production_orders') THEN
   INSERT INTO digital_journey_fact_changes(resource_kind,resource_id)
    VALUES(CASE TG_TABLE_NAME WHEN 'digital_production_sources' THEN 'source' ELSE 'order' END,
     (item->>CASE TG_TABLE_NAME WHEN 'digital_production_sources' THEN 'source_id' ELSE 'production_order_id' END)::uuid)
    ON CONFLICT DO NOTHING;
  END IF;
  FOR native IN EXECUTE TG_ARGV[0] USING item LOOP
   FOR affected IN SELECT * FROM digital_journey_affected(native.kind,native.id) LOOP
    INSERT INTO digital_journey_fact_changes(resource_kind,resource_id)
     VALUES(affected.resource_kind,affected.resource_id) ON CONFLICT DO NOTHING;
   END LOOP;
  END LOOP;
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END;
$fn$;

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON cutting_orders
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''cutting''::text kind,($1->>''cutting_order_id'')::uuid id UNION SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON cutting_record_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''cutting''::text kind,r2.cutting_order_id id FROM jsonb_populate_record(NULL::cutting_record_corrections,$1) r0 JOIN cutting_records r1 ON r0.cutting_record_id=r1.cutting_record_id JOIN cutting_orders r2 ON r1.cutting_order_id=r2.cutting_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON cutting_records
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''cutting''::text kind,($1->>''cutting_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_budget_documents
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_budget_versions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_cutting_completions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_dispatch
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preparation_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_bulk_preparation_facts,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preparations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preshrink_correction_ranges
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_bulk_preshrink_correction_ranges,$1) r0 JOIN digital_bulk_preshrink_corrections r1 ON r0.correction_id=r1.correction_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_preshrink_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_bulk_work_ranges
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_bulk_work_ranges,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_commercial_order_rules
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_amendments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_artifact_heads
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_artifact_inheritances
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_artifact_versions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_cycle_rounds
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_dispatch
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_documents
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_execution_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_external_intervals
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_external_pattern_receipts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,r2.source_id id FROM jsonb_populate_record(NULL::digital_development_external_pattern_receipts,$1) r0 JOIN digital_development_external_patterns r1 ON r0.request_id=r1.request_id JOIN digital_production_sources r2 ON r1.source_id=r2.source_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_external_patterns
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_final_comments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_inherited_files
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_material_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_material_verifications
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_patch_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,r2.source_id id FROM jsonb_populate_record(NULL::digital_development_patch_decisions,$1) r0 JOIN digital_development_patch_issues r1 ON r0.issue_id=r1.issue_id JOIN digital_production_sources r2 ON r1.source_id=r2.source_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_patch_issues
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_patch_native_rounds
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,r2.order_id id FROM jsonb_populate_record(NULL::digital_development_patch_native_rounds,$1) r0 JOIN pattern_room_rounds r1 ON r0.native_round_id=r1.round_id JOIN pattern_room_orders r2 ON r1.order_id=r2.order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_patch_tasks
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_development_patch_tasks,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_pattern_links
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_preparation_basis
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_revision_sources
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_round_arrangements
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_rounds
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_route_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_size_review_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_size_review_results
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r2.task_id id FROM jsonb_populate_record(NULL::digital_development_size_review_results,$1) r0 JOIN digital_development_artifact_versions r1 ON r0.artifact_set_id=r1.artifact_set_id AND r0.artifact_version=r1.version JOIN digital_production_tasks r2 ON r1.task_id=r2.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_sla_plans
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_technical_enrollments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_technical_material_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_development_urgent_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_factory_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_factory_facts,$1) r0 JOIN digital_factory_routes r1 ON r0.preparation_id=r1.preparation_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_factory_qc
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_factory_qc,$1) r0 JOIN digital_factory_routes r1 ON r0.preparation_id=r1.preparation_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_factory_routes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_factory_task_retirements
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_factory_task_retirements,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_date_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_instruction_date_decisions,$1) r0 JOIN digital_instruction_date_requests r1 ON r0.request_id=r1.request_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_date_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_deliveries
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_documents
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_preparation_bases
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_instruction_versions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_order_closures
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_po_customer_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_po_customer_decisions,$1) r0 JOIN digital_po_customer_requests r1 ON r0.request_id=r1.request_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_po_customer_request_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_po_customer_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_po_date_changes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_adoption_acknowledgements
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_instruction_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_windows
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_child_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_child_links
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_deadline_revisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_production_deadline_revisions,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_delegations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_delivery_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_production_delivery_decisions,$1) r0 JOIN digital_production_delivery_requests r1 ON r0.request_id=r1.request_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_delivery_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_orders
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_po_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_po_sizes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_production_po_sizes,$1) r0 JOIN digital_production_po_lines r1 ON r0.line_id=r1.line_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_resource_lifecycle
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_sources
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_task_access
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_task_conditions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_production_task_conditions,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_task_dependencies
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_production_task_dependencies,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_task_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid id UNION SELECT ''task''::text kind,r1.task_id id FROM jsonb_populate_record(NULL::digital_production_task_events,$1) r0 JOIN digital_production_tasks r1 ON r0.task_id=r1.task_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_tasks
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,($1->>''task_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_qc_progress_records
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_qc_progress_records,$1) r0 JOIN digital_qc_tracking_starts r1 ON r0.tracking_id=r1.tracking_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_qc_progress_uploads
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_qc_supervision_settings
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_qc_tracking_starts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_quotation_documents
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_quotation_versions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_quotation_versions,$1) r0 JOIN digital_quotation_documents r1 ON r0.quote_id=r1.quote_id JOIN digital_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_series_context_changes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_series_plans
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_series_request_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::digital_series_request_decisions,$1) r0 JOIN digital_series_plans r1 ON r0.plan_id=r1.plan_id JOIN production_order_roots r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_series_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_series_source_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_short_lead_consumptions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_short_lead_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,r2.source_id id FROM jsonb_populate_record(NULL::digital_short_lead_decisions,$1) r0 JOIN digital_short_lead_requests r1 ON r0.request_id=r1.request_id JOIN digital_production_sources r2 ON r1.source_id=r2.source_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_short_lead_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,($1->>''source_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_sla_node_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_sla_order_snapshots
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_sla_plans
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_node_times
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,r2.order_id id FROM jsonb_populate_record(NULL::pattern_room_node_times,$1) r0 JOIN pattern_room_rounds r1 ON r0.round_id=r1.round_id JOIN pattern_room_orders r2 ON r1.order_id=r2.order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_orders
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,($1->>''order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_rounds
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,($1->>''order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_segments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,r2.order_id id FROM jsonb_populate_record(NULL::pattern_room_segments,$1) r0 JOIN pattern_room_rounds r1 ON r0.round_id=r1.round_id JOIN pattern_room_orders r2 ON r1.order_id=r2.order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON pattern_room_wage_items
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''pattern''::text kind,($1->>''order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON production_order_node_clocks
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,r1.production_order_id id FROM jsonb_populate_record(NULL::production_order_node_clocks,$1) r0 JOIN production_order_roots r1 ON r0.production_order_id=r1.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON production_order_roots
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''order''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON receiving_batches
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''receiving_batch_id'')::uuid id UNION SELECT ''cutting''::text kind,($1->>''cutting_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON receiving_difference_resolutions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''receiving_batch_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON receiving_packing_revisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''receiving_batch_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON receiving_receipt_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''receiving_batch_id'')::uuid id UNION SELECT ''receipt''::text kind,($1->>''receipt_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON receiving_receipts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''receiving_batch_id'')::uuid id UNION SELECT ''cutting''::text kind,($1->>''cutting_order_id'')::uuid id UNION SELECT ''receipt''::text kind,($1->>''receipt_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_custom_process_promotions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r3.rework_order_id id FROM jsonb_populate_record(NULL::rework_custom_process_promotions,$1) r0 JOIN rework_process_configuration_items r1 ON r0.configuration_item_id=r1.configuration_item_id JOIN rework_process_configurations r2 ON r1.configuration_id=r2.configuration_id JOIN rework_orders r3 ON r2.rework_order_id=r3.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_external_business_signoffs
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_external_business_signoffs,$1) r0 JOIN rework_external_responsibility_cases r1 ON r0.case_id=r1.case_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_ie_precount_entries
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_order_reviews
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_orders
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''batch''::text kind,($1->>''source_receiving_batch_id'')::uuid id UNION SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_own_factory_approval_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_own_factory_approval_decisions,$1) r0 JOIN rework_own_factory_approvals r1 ON r0.approval_id=r1.approval_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_own_tail_responsibility_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_process_configuration_items
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_process_configuration_items,$1) r0 JOIN rework_process_configurations r1 ON r0.configuration_id=r1.configuration_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_process_configurations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_process_quantity_adjustments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_process_worker_plan_members
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_process_worker_plan_members,$1) r0 JOIN rework_process_worker_plans r1 ON r0.plan_id=r1.plan_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_process_worker_plans
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_amount_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_responsibility_amount_lines,$1) r0 JOIN rework_work_reports r1 ON r0.work_report_id=r1.work_report_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_business_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_determinations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_handler_events
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_high_multiplier_confirmations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_responsibility_high_multiplier_confirmations,$1) r0 JOIN rework_responsibility_determinations r1 ON r0.determination_id=r1.determination_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_owner_multiplier_adjustments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_responsibility_owner_multiplier_adjustments,$1) r0 JOIN rework_responsibility_determinations r1 ON r0.determination_id=r1.determination_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_owner_signatures
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_responsibility_rounding_adjustments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r3.rework_order_id id FROM jsonb_populate_record(NULL::rework_responsibility_rounding_adjustments,$1) r0 JOIN rework_responsibility_processes r1 ON r0.determination_id=r1.determination_id AND r0.configuration_item_id=r1.configuration_item_id JOIN rework_responsibility_determinations r2 ON r1.determination_id=r2.determination_id JOIN rework_orders r3 ON r2.rework_order_id=r3.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_completion_confirmations
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_completion_quantities
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_tail_completion_quantities,$1) r0 JOIN rework_tail_completion_confirmations r1 ON r0.confirmation_id=r1.confirmation_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_completion_reviews
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_tail_completion_reviews,$1) r0 JOIN rework_tail_completion_confirmations r1 ON r0.confirmation_id=r1.confirmation_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_defective_quantity_entries
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_inspection_assignments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_inspection_report_items
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_tail_inspection_report_items,$1) r0 JOIN rework_tail_inspection_reports r1 ON r0.tail_inspection_report_id=r1.tail_inspection_report_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_tail_inspection_reports
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_wage_items
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_report_member_shares
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_work_report_member_shares,$1) r0 JOIN rework_work_reports r1 ON r0.work_report_id=r1.work_report_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_report_quantity_revisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_report_rejections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_reports
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_task_members
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,r2.rework_order_id id FROM jsonb_populate_record(NULL::rework_work_task_members,$1) r0 JOIN rework_work_tasks r1 ON r0.work_task_id=r1.work_task_id JOIN rework_orders r2 ON r1.rework_order_id=r2.rework_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_work_tasks
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''rework_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_approval_snapshot_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,r2.sourcing_case_id id FROM jsonb_populate_record(NULL::sourcing_approval_snapshot_lines,$1) r0 JOIN sourcing_approval_snapshots r1 ON r0.sourcing_approval_snapshot_id=r1.sourcing_approval_snapshot_id JOIN sourcing_cases r2 ON r1.sourcing_case_id=r2.sourcing_case_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_approval_snapshots
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_budget_price_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_case_corrections
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_case_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_case_transitions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_cases
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_business_ready_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_documents
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_executions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_return_business_facts
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_return_cycles
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_contract_return_submissions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_decision_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_factory_change_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,r2.sourcing_case_id id FROM jsonb_populate_record(NULL::sourcing_factory_change_decisions,$1) r0 JOIN sourcing_factory_change_requests r1 ON r0.factory_change_request_id=r1.factory_change_request_id JOIN sourcing_cases r2 ON r1.sourcing_case_id=r2.sourcing_case_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_factory_change_requests
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_ie_quote_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_ie_quotes
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_owner_decisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_price_reapplications
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_price_reviews
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,r2.sourcing_case_id id FROM jsonb_populate_record(NULL::sourcing_price_reviews,$1) r0 JOIN sourcing_price_reapplications r1 ON r0.price_request_id=r1.price_request_id JOIN sourcing_cases r2 ON r1.sourcing_case_id=r2.sourcing_case_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_exclusions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_factory_transfer_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,r2.production_order_id id FROM jsonb_populate_record(NULL::sourcing_production_factory_transfer_lines,$1) r0 JOIN sourcing_production_factory_transfers r1 ON r0.factory_decision_id=r1.factory_decision_id JOIN sourcing_production_orders r2 ON r1.production_order_id=r2.production_order_id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_factory_transfers
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_lines
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_orders
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id UNION SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_receipt_links
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_reports
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_shipments
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_production_transitions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''production''::text kind,($1->>''production_order_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON sourcing_style_revisions
 FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''sourcing_case_id'')::uuid id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_material_versions FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_responsibilities FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_preparation_rule_adoptions FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON acceptance_sla_clock_resources FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT $1->>''resource_kind'' AS kind,($1->>''resource_id'')::uuid AS id');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON app_users FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,a.task_id id FROM digital_production_task_access a WHERE a.assignee_id=($1->>''id'')::uuid');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON identity_mappings FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,a.task_id id FROM digital_production_task_access a WHERE a.assignee_id=($1->>''user_id'')::uuid');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON user_role_assignments FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,a.task_id id FROM digital_production_task_access a WHERE a.assignee_id=($1->>''user_id'')::uuid');

CREATE TRIGGER journey_fact_dirty BEFORE UPDATE OF enabled ON business_roles FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,a.task_id id FROM digital_production_task_access a JOIN user_role_assignments u ON u.user_id=a.assignee_id WHERE u.role_code=$1->>''role_code'' AND u.revoked_at IS NULL');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON digital_production_deadline_policies FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,a.task_id id FROM digital_production_task_access a WHERE a.task_kind=$1->>''node_key''');

CREATE TRIGGER journey_fact_dirty BEFORE UPDATE OF version,business_now ON acceptance_sla_clock_scenarios FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT resource_kind kind,resource_id id FROM acceptance_sla_clock_resources WHERE scenario_id=($1->>''scenario_id'')::uuid');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''task''::text kind,($1->>''entity_id'')::uuid id WHERE $1->>''action''=''digital_task_reassigned'' UNION SELECT ''order'',($1->>''entity_id'')::uuid WHERE $1->>''action''=''digital_source_attached''');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT OR UPDATE OR DELETE ON rework_todos FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''sourcing''::text kind,($1->>''entity_id'')::uuid id WHERE $1->>''entity_type''=''sourcing_case'' AND $1->>''todo_type''=''business_action'' AND $1->>''category'' IN (''sourcing_ie_quote'',''sourcing_management_decision'',''sourcing_owner_approval'') AND $1->>''entity_id'' ~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''');

CREATE TRIGGER journey_fact_dirty BEFORE INSERT ON operation_events FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''rework''::text kind,($1->>''entity_id'')::uuid id WHERE $1->>''entity_type''=''rework_order'' AND $1->>''action''=''rework.work_task.assignment_confirm'' AND $1->>''entity_id'' ~ ''^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$''');

CREATE INDEX journey_fact_material_evidence ON digital_preparation_material_versions USING gin ((body->'evidenceIds'));

CREATE TRIGGER journey_fact_dirty BEFORE UPDATE OF status OR DELETE ON attachments FOR EACH ROW EXECUTE FUNCTION digital_journey_register_change('SELECT ''source''::text kind,b.source_id id FROM digital_development_attachment_bindings b WHERE b.attachment_id=($1->>''attachment_id'')::uuid UNION SELECT ''source'',b.source_id FROM digital_development_inherited_files b WHERE b.attachment_id=($1->>''attachment_id'')::uuid UNION SELECT ''order'',b.production_order_id FROM digital_instruction_attachment_bindings b WHERE b.attachment_id=($1->>''attachment_id'')::uuid UNION SELECT ''order'',b.production_order_id FROM digital_budget_attachment_bindings b WHERE b.attachment_id=($1->>''attachment_id'')::uuid UNION SELECT b.resource_kind,b.resource_id FROM digital_preparation_material_versions b WHERE (b.body->''evidenceIds'') ? ($1->>''attachment_id'')');

-- Initial registration is separate from construction. Migration does not build
-- a single payload; bounded runtime processing resumes these durable rows.
INSERT INTO digital_journey_fact_changes(resource_kind,resource_id,reason)
 SELECT 'order',production_order_id,'backfill' FROM digital_production_orders
 UNION ALL SELECT 'source',s.source_id,'backfill' FROM digital_production_sources s
 WHERE NOT EXISTS(SELECT 1 FROM digital_production_orders o WHERE o.source_id=s.source_id)
 ON CONFLICT DO NOTHING;
