// Shared by every normal production read and derived statistic. Archival is unrelated.
export const productionNotExcluded = `NOT EXISTS (
  SELECT 1 FROM sourcing_production_exclusions exclusion
  WHERE exclusion.production_order_id=production.production_order_id
)`;

// New workflow ownership follows the current mother-order assignment. Legacy ownership stays unchanged.
export const productionMerchandiserId = `(CASE WHEN source_case.workflow_generation='digital_production_v1' THEN (
 SELECT mother.primary_merchandiser_id FROM digital_production_child_links link
 JOIN digital_production_orders mother ON mother.production_order_id=link.production_order_id
 WHERE link.module='production' AND link.child_id=production.production_order_id
) ELSE source_case.created_by END)`;
