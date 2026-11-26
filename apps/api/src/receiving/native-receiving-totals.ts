import type {PoolClient} from 'pg';
import {digitalReceivingBaseSql,RECEIVING_GROUP_RESOLUTION_SCOPE_SQL,RECEIVING_GROUP_PACKING_JOIN_SQL} from './receiving-quantity-query.js';
import {readNativeReceiptExceptions} from './native-receipt-qualification.js';

/** Original quantity, packing and difference rules, restricted to proven native cuts. */
export async function readNativeReceivingTotals(db:Pick<PoolClient,'query'>,cutIds:readonly string[],except?:readonly string[]){
 if(!cutIds.length)return [];
 const excluded=except??(await readNativeReceiptExceptions(db,{cutIds})).map(row=>row.receiptId);
 return (await db.query(`${digitalReceivingBaseSql('$5')}
   SELECT totals.*,action.receiving_batch_id,packing.packing_revision_id,packing.packing_quantity,coalesce((packing_event.after_state->'acceptanceClock'->>'now')::timestamptz,packing.created_at) AS packing_recorded_at,packing_event.after_state->'packingActualTime' AS packing_actual_time,packing.packing_allocations,
    receiving.result AS receiving_resolution,receiving.operation_event_id AS receiving_resolution_ref,receiving.occurred_at AS receiving_resolution_at,packed.result AS packing_resolution
   FROM style_totals totals JOIN LATERAL(SELECT b.receiving_batch_id FROM batch_totals b WHERE b.group_key=totals.group_key ORDER BY b.last_all_received_at DESC,b.receiving_batch_id DESC LIMIT 1) action ON true
   ${RECEIVING_GROUP_PACKING_JOIN_SQL}
   LEFT JOIN operation_events packing_event ON packing_event.event_id=packing.operation_event_id
   LEFT JOIN LATERAL(SELECT resolution.result,resolution.operation_event_id,(SELECT coalesce((event.after_state->'acceptanceClock'->>'now')::timestamptz,event.created_at) FROM operation_events event WHERE event.event_id=resolution.operation_event_id) AS occurred_at FROM receiving_difference_resolutions resolution WHERE ${RECEIVING_GROUP_RESOLUTION_SCOPE_SQL} AND resolution.difference_type='receiving' AND resolution.document_quantity_snapshot=totals.document_quantity AND resolution.actual_quantity_snapshot=totals.current_actual_quantity AND resolution.difference_quantity_snapshot=totals.current_actual_quantity-totals.document_quantity AND COALESCE((SELECT event.after_state->>'quantityRevision' FROM operation_events event WHERE event.event_id=resolution.operation_event_id)=totals.receiving_quantity_revision,totals.receiving_quantity_changed_at IS NULL OR resolution.created_at>=totals.receiving_quantity_changed_at) ORDER BY resolution.created_at DESC,resolution.resolution_id DESC LIMIT 1) receiving ON true
   LEFT JOIN LATERAL(SELECT resolution.result FROM receiving_difference_resolutions resolution WHERE ${RECEIVING_GROUP_RESOLUTION_SCOPE_SQL} AND resolution.difference_type='packing' AND resolution.actual_quantity_snapshot=totals.current_actual_quantity AND resolution.packing_revision_id=packing.packing_revision_id AND resolution.packing_quantity_snapshot=packing.packing_quantity AND resolution.difference_quantity_snapshot=packing.packing_quantity-totals.current_actual_quantity AND COALESCE((SELECT event.after_state->>'quantityRevision' FROM operation_events event WHERE event.event_id=resolution.operation_event_id)=totals.actual_quantity_revision,totals.actual_quantity_changed_at IS NULL OR resolution.created_at>=totals.actual_quantity_changed_at) ORDER BY resolution.created_at DESC,resolution.resolution_id DESC LIMIT 1) packed ON true
  `,['2000-01-01','2999-12-31','#',cutIds,[...new Set(excluded)]])).rows;
}
