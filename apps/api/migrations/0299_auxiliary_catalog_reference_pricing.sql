ALTER TABLE auxiliary_catalog_items
  ADD COLUMN reference_unit_price numeric(16,6),
  ADD COLUMN reference_pricing_unit text,
  ADD CONSTRAINT auxiliary_catalog_current_reference_pricing CHECK (
    (reference_unit_price IS NULL AND reference_pricing_unit IS NULL)
    OR (reference_unit_price IS NOT NULL AND reference_unit_price >= 0 AND reference_unit_price <> 'NaN'::numeric AND reference_pricing_unit IS NOT NULL
        AND length(btrim(reference_pricing_unit)) BETWEEN 1 AND 100)
  );

ALTER TABLE auxiliary_catalog_versions
  ADD COLUMN reference_unit_price numeric(16,6),
  ADD COLUMN reference_pricing_unit text,
  ADD CONSTRAINT auxiliary_catalog_historical_reference_pricing CHECK (
    (reference_unit_price IS NULL AND reference_pricing_unit IS NULL)
    OR (reference_unit_price IS NOT NULL AND reference_unit_price >= 0 AND reference_unit_price <> 'NaN'::numeric AND reference_pricing_unit IS NOT NULL
        AND length(btrim(reference_pricing_unit)) BETWEEN 1 AND 100)
  );
