// Same snapshot predicates as the original card actions; shared by summary and page queries.
export const RECEIVING_BOARD_FILTERS_SQL = `, board_facts AS (
 SELECT totals.*,totals.cumulative_actual_quantity-totals.document_quantity AS difference_quantity,
 abs(totals.cumulative_actual_quantity-totals.document_quantity) AS absolute_difference,
 CASE WHEN totals.cumulative_actual_quantity<totals.document_quantity THEN 0
 WHEN totals.cumulative_actual_quantity>totals.document_quantity THEN 1 ELSE 2 END AS difference_rank,
 packing.packing_quantity-totals.cumulative_actual_quantity AS packing_difference,
 packing.packing_revision_id IS NULL AND totals.cumulative_actual_quantity>0 AS missing_packing,
 EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution WHERE resolution.receiving_batch_id=action.receiving_batch_id
 AND resolution.difference_type='receiving' AND resolution.document_quantity_snapshot=totals.document_quantity
 AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
 AND resolution.difference_quantity_snapshot=totals.cumulative_actual_quantity-totals.document_quantity) AS receiving_handled,
 EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution WHERE resolution.receiving_batch_id=action.receiving_batch_id
 AND resolution.difference_type='packing' AND resolution.actual_quantity_snapshot=totals.cumulative_actual_quantity
 AND resolution.packing_revision_id=packing.packing_revision_id AND resolution.packing_quantity_snapshot=packing.packing_quantity
 AND resolution.difference_quantity_snapshot=packing.packing_quantity-totals.cumulative_actual_quantity) AS packing_handled,
 EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution JOIN scoped_batches old_batch USING(receiving_batch_id)
 WHERE old_batch.style_key=totals.style_key AND resolution.difference_type='receiving') AS receiving_history_exists,
 EXISTS(SELECT 1 FROM receiving_difference_resolutions resolution JOIN scoped_batches old_batch USING(receiving_batch_id)
 WHERE old_batch.style_key=totals.style_key AND resolution.difference_type='packing') AS packing_history_exists
 FROM style_totals totals
 JOIN LATERAL(SELECT batch.receiving_batch_id FROM batch_totals batch WHERE batch.style_key=totals.style_key
 ORDER BY batch.last_through_end_received_at DESC NULLS LAST,batch.receiving_batch_id DESC LIMIT 1) action ON true
 LEFT JOIN LATERAL(SELECT revision.packing_revision_id,revision.packing_quantity FROM receiving_packing_revisions revision
 WHERE revision.receiving_batch_id=action.receiving_batch_id ORDER BY revision.created_at DESC,revision.packing_revision_id DESC LIMIT 1) packing ON true
), board_flags AS (
 SELECT *, (difference_quantity<>0 AND NOT receiving_handled) OR (packing_difference<>0 AND NOT packing_handled) AS pending_difference,
 (receiving_history_exists AND NOT receiving_handled) OR (packing_history_exists AND NOT packing_handled) AS stale_resolution
 FROM board_facts
), filtered_totals AS (
 SELECT * FROM board_flags WHERE $4='all'
 OR ($4='multiple' AND receipt_count>1) OR ($4='normal' AND difference_quantity=0)
 OR ($4='short' AND difference_quantity<0) OR ($4='extra' AND difference_quantity>0)
 OR ($4='receiving_difference' AND difference_quantity<>0)
 OR ($4='packing_difference' AND packing_difference<>0)
 OR ($4='missing_packing' AND missing_packing)
 OR ($4='pending' AND pending_difference)
 OR ($4='handled' AND (receiving_handled OR packing_handled))
 OR ($4='stale' AND stale_resolution)
)`;
