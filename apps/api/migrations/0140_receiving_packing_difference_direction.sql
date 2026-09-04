-- Correct the packing difference direction for all newly recorded resolutions.
-- Existing immutable resolution snapshots remain readable even when recorded under 0139.

ALTER TABLE receiving_difference_resolutions
  DROP CONSTRAINT receiving_difference_resolutions_check;

ALTER TABLE receiving_difference_resolutions
  ADD CONSTRAINT receiving_difference_resolutions_quantity_direction_check CHECK(
    (difference_type='receiving' AND packing_revision_id IS NULL AND packing_quantity_snapshot IS NULL
      AND difference_quantity_snapshot=actual_quantity_snapshot-document_quantity_snapshot)
    OR
    (difference_type='packing' AND packing_revision_id IS NOT NULL AND packing_quantity_snapshot IS NOT NULL
      AND difference_quantity_snapshot=packing_quantity_snapshot-actual_quantity_snapshot)
  ) NOT VALID;
