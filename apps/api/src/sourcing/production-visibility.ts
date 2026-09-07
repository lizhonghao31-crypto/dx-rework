// Shared by every normal production read and derived statistic. Archival is unrelated.
export const productionNotExcluded = `NOT EXISTS (
  SELECT 1 FROM sourcing_production_exclusions exclusion
  WHERE exclusion.production_order_id=production.production_order_id
)`;
