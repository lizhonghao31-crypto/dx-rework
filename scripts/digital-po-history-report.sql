-- Operator read-only inventory. Never selects a guessed canonical PO or backfills a date.
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
WITH orders AS (SELECT * FROM digital_production_orders),
lines AS (SELECT * FROM digital_production_po_lines),
links AS (SELECT * FROM digital_production_child_links)
SELECT 'po_alias_conflict' AS category,l.production_order_id,l.line_id,
 jsonb_build_object('poNumber',l.po_number,'formalStyleNo',l.formal_style_no) AS evidence
FROM lines l WHERE NULLIF(btrim(l.po_number),'') IS NOT NULL AND NULLIF(btrim(l.formal_style_no),'') IS NOT NULL
 AND normalize_sourcing_style_key(l.po_number)<>normalize_sourcing_style_key(l.formal_style_no)
UNION ALL
SELECT 'duplicate_formal_po',production_order_id,NULL::uuid,
 jsonb_build_object('normalizedCandidates',key,'lineIds',jsonb_agg(line_id ORDER BY line_id))
FROM (SELECT DISTINCT l.production_order_id,l.line_id,k.key FROM lines l
 CROSS JOIN LATERAL unnest(ARRAY[normalize_sourcing_style_key(l.po_number),normalize_sourcing_style_key(l.formal_style_no)]) k(key)
 WHERE NULLIF(k.key,'') IS NOT NULL) candidates GROUP BY production_order_id,key HAVING count(*)>1
UNION ALL
SELECT 'duplicate_color',production_order_id,NULL::uuid,
 jsonb_build_object('normalizedColor',lower(btrim(color)),'lineIds',jsonb_agg(line_id ORDER BY line_id))
FROM lines GROUP BY production_order_id,lower(btrim(color)) HAVING count(*)>1
UNION ALL
SELECT 'customer_date_unregistered',l.production_order_id,l.line_id,
 jsonb_build_object('legacyMotherDate',o.contract_delivery_date,'legacyLineDate',l.delivery_date,
 'effectiveDate',l.customer_warehouse_arrival_date,'source',l.customer_date_source,'requiresVerification',true)
FROM lines l JOIN orders o USING(production_order_id) WHERE l.customer_date_version=0
UNION ALL
SELECT 'factory_date_unregistered_or_manual_contract',l.production_order_id,l.line_id,
 jsonb_build_object('effectiveDate',l.factory_delivery_date,'source',l.factory_date_source,'requiresVerification',true,
 'legacyContracts',COALESCE((SELECT jsonb_agg(jsonb_build_object('contractDocumentId',d.sourcing_contract_document_id,
 'snapshotDeliveryDate',d.approval_snapshot->'deliveryDate','manualDeliveryDate',override.content->'deliveryDate',
 'manualOperationEventId',override.operation_event_id))
 FROM links link JOIN sourcing_contract_documents d ON d.sourcing_case_id=link.child_id
 LEFT JOIN sourcing_contract_content_overrides override ON override.sourcing_contract_document_id=d.sourcing_contract_document_id
 WHERE link.production_order_id=l.production_order_id AND link.module='sourcing'),'[]'::jsonb))
FROM lines l WHERE l.factory_date_version=0 OR EXISTS(SELECT 1 FROM links link
 JOIN sourcing_contract_documents d ON d.sourcing_case_id=link.child_id
 JOIN sourcing_contract_content_overrides override ON override.sourcing_contract_document_id=d.sourcing_contract_document_id
 JOIN operation_events event ON event.event_id=override.operation_event_id
 WHERE link.production_order_id=l.production_order_id AND link.module='sourcing'
 AND event.after_state->>'mode'='manual_content')
UNION ALL
SELECT 'existing_workflow_footprint',o.production_order_id,NULL::uuid,
 jsonb_build_object('approvalSnapshotIds',COALESCE((SELECT jsonb_agg(a.sourcing_approval_snapshot_id) FROM links link
 JOIN sourcing_approval_snapshots a ON a.sourcing_case_id=link.child_id WHERE link.production_order_id=o.production_order_id AND link.module='sourcing'),'[]'::jsonb),
 'contractDocumentIds',COALESCE((SELECT jsonb_agg(d.sourcing_contract_document_id) FROM links link JOIN sourcing_contract_documents d ON d.sourcing_case_id=link.child_id
 WHERE link.production_order_id=o.production_order_id AND link.module='sourcing'),'[]'::jsonb),
 'financeRecords',COALESCE((SELECT jsonb_agg(to_jsonb(f)) FROM links link JOIN sourcing_finance_reconciliations f ON f.sourcing_case_id=link.child_id
 WHERE link.production_order_id=o.production_order_id AND link.module='sourcing'),'[]'::jsonb),
 'bulkDispatched',EXISTS(SELECT 1 FROM digital_bulk_dispatch b WHERE b.production_order_id=o.production_order_id),
 'cutCompleted',EXISTS(SELECT 1 FROM digital_bulk_cutting_completions b WHERE b.production_order_id=o.production_order_id),
 'receivingChildIds',COALESCE((SELECT jsonb_agg(link.child_id) FROM links link WHERE link.production_order_id=o.production_order_id AND link.module='receiving'),'[]'::jsonb))
FROM orders o WHERE EXISTS(SELECT 1 FROM links link WHERE link.production_order_id=o.production_order_id)
UNION ALL
SELECT 'missing_child_line_mapping',link.production_order_id,NULL::uuid,
 jsonb_build_object('module',link.module,'childId',link.child_id,'unmappedSourcingPositions',
 COALESCE((SELECT jsonb_agg(child.position ORDER BY child.position) FROM sourcing_case_lines child
 WHERE link.module='sourcing' AND child.sourcing_case_id=link.child_id AND NOT EXISTS(SELECT 1 FROM digital_production_child_lines mapping
 WHERE mapping.module=link.module AND mapping.child_id=link.child_id AND mapping.child_line_key=child.position::text)),'[]'::jsonb))
FROM links link WHERE NOT EXISTS(SELECT 1 FROM digital_production_child_lines mapping
 WHERE mapping.module=link.module AND mapping.child_id=link.child_id)
 OR (link.module='sourcing' AND EXISTS(SELECT 1 FROM sourcing_case_lines child WHERE child.sourcing_case_id=link.child_id
 AND NOT EXISTS(SELECT 1 FROM digital_production_child_lines mapping WHERE mapping.module=link.module AND mapping.child_id=link.child_id AND mapping.child_line_key=child.position::text)))
UNION ALL
SELECT 'order_without_source',production_order_id,NULL::uuid,
 jsonb_build_object('createdAt',created_at,'createdBy',created_by,'requiresVerification',true) FROM orders WHERE source_id IS NULL
UNION ALL
SELECT 'active_legacy_digital_delegation',d.production_order_id,NULL::uuid,
 jsonb_build_object('delegationId',d.delegation_id,'sourceId',d.source_id,'taskId',d.task_id,'purpose',d.purpose,'expiresAt',d.expires_at)
FROM digital_production_delegations d WHERE d.revoked_at IS NULL AND d.expires_at>CURRENT_TIMESTAMP
ORDER BY category,production_order_id,line_id;
ROLLBACK;
