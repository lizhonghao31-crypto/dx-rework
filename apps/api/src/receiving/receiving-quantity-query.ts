import type {PoolClient} from 'pg';
export type RepeatedReceivingSource = "jiashun" | "other_factory";
export type ReceiptSource = "legacy" | "initial" | "backfill" | RepeatedReceivingSource;
export type ReceivingDifferenceType = "receiving" | "packing";
export const RECEIVING_GROUP_RESOLUTION_SCOPE_SQL = `EXISTS(
 SELECT 1 FROM scoped_batches resolution_batch
 WHERE resolution_batch.receiving_batch_id=resolution.receiving_batch_id
 AND resolution_batch.group_key=totals.group_key
)`;

/** Packing is one cumulative head per native cut/legacy-style group. The
 * operation batch is only the write source, not the cumulative scope. Native
 * writes hold the group lock and use clock_timestamp after taking that lock;
 * latest revision therefore retains Root decreases instead of MAX(quantity).
 * All consumers use the same active scoped_batches from the original query.
 */
export const RECEIVING_PACKING_SCOPE_UNRESOLVED_SQL="coalesce(packing.scope_unresolved,cardinality(packing_scope.merge_event_ids)>0)";
export const RECEIVING_GROUP_PACKING_JOIN_SQL = `LEFT JOIN LATERAL (
 SELECT coalesce(array_agg(merge_event.event_id::text ORDER BY merge_event.event_id::text),ARRAY[]::text[]) AS merge_event_ids
 FROM operation_events merge_event JOIN receiving_batches target ON merge_event.entity_id=target.receiving_batch_id::text
 WHERE totals.group_key LIKE 'style:%' AND merge_event.action='receiving.batch.merge' AND merge_event.entity_type='receiving_batch'
 AND coalesce('cut:'||target.cutting_order_id::text,'style:'||upper(btrim(target.style_no)))=totals.group_key
 AND EXISTS(SELECT 1 FROM receiving_batches source JOIN receiving_packing_revisions original USING(receiving_batch_id)
  WHERE source.receiving_batch_id::text=merge_event.after_state->>'sourceReceivingBatchId'
  AND (source.cutting_order_id IS NOT NULL OR 'style:'||upper(btrim(merge_event.after_state->'source'->>'styleNo'))<>totals.group_key))
) packing_scope ON true
LEFT JOIN LATERAL (
 SELECT head.packing_revision_id,head.receiving_batch_id,head.recorded_by,head.created_at,head.operation_event_id,head.packing_quantity AS source_quantity,
  CASE WHEN quality.complete THEN head.packing_quantity ELSE NULL END AS packing_quantity,
  CASE WHEN quality.complete THEN head.after_state->'packingActualTime' ELSE NULL END AS packing_actual_time,
  CASE WHEN quality.complete THEN head.after_state->'packingAllocations' ELSE NULL END AS packing_allocations,
  NOT quality.complete AS scope_unresolved
 FROM (
  SELECT revision.*,batch.deleted_at,batch.cutting_order_id,event.after_state,
   EXISTS(SELECT 1 FROM receiving_packing_revisions next JOIN receiving_batches next_batch USING(receiving_batch_id)
    JOIN operation_events next_event ON next_event.event_id=next.operation_event_id
    WHERE next_event.before_state->>'packingRevisionId'=revision.packing_revision_id::text
    AND coalesce('cut:'||next_batch.cutting_order_id::text,'style:'||upper(btrim(next_batch.style_no)))=totals.group_key) AS superseded
  FROM receiving_packing_revisions revision JOIN receiving_batches batch USING(receiving_batch_id)
  LEFT JOIN operation_events event ON event.event_id=revision.operation_event_id
  WHERE coalesce('cut:'||batch.cutting_order_id::text,'style:'||upper(btrim(batch.style_no)))=totals.group_key
  ORDER BY superseded ASC,revision.created_at DESC,revision.packing_revision_id DESC LIMIT 1
 ) head
 CROSS JOIN LATERAL(SELECT NOT head.superseded
  AND (head.deleted_at IS NULL OR EXISTS(
   SELECT 1 FROM operation_events merge_event JOIN receiving_batches target ON target.receiving_batch_id::text=merge_event.after_state->>'targetReceivingBatchId'
   WHERE merge_event.action='receiving.batch.merge' AND merge_event.after_state->>'sourceReceivingBatchId'=head.receiving_batch_id::text
   AND coalesce('cut:'||target.cutting_order_id::text,'style:'||upper(btrim(target.style_no)))=totals.group_key
   AND (head.cutting_order_id IS NOT NULL AND target.cutting_order_id=head.cutting_order_id OR head.cutting_order_id IS NULL AND target.cutting_order_id IS NULL AND 'style:'||upper(btrim(merge_event.after_state->'source'->>'styleNo'))=totals.group_key)
   AND EXISTS(SELECT 1 FROM receiving_batches active WHERE coalesce('cut:'||active.cutting_order_id::text,'style:'||upper(btrim(active.style_no)))=totals.group_key AND active.deleted_at IS NULL)))
  AND coalesce(head.after_state->'packingScopeMergeEventIds','[]'::jsonb)?&packing_scope.merge_event_ids AS complete) quality
) packing ON true`;

/** Authorized native cut groups, including an uncertain deleted source. No
 * receipt is invented just to make a group exist. */
export async function readNativePackingHeads(db:Pick<PoolClient,'query'>,cutIds:readonly string[]){
 if(!cutIds.length)return [];
 return (await db.query<{group_key:string;packing_revision_id:string|null;packing_quantity:string|null;packing_actual_time:unknown;packing_allocations:unknown;packing_recorded_at:Date|null;packing_scope_unresolved:boolean}>(`
  SELECT totals.group_key,packing.packing_revision_id,packing.packing_quantity,packing.packing_actual_time,packing.packing_allocations,
   coalesce((event.after_state->'acceptanceClock'->>'now')::timestamptz,packing.created_at) AS packing_recorded_at,
   ${RECEIVING_PACKING_SCOPE_UNRESOLVED_SQL} AS packing_scope_unresolved
  FROM unnest($1::uuid[]) requested(cutting_id) CROSS JOIN LATERAL(SELECT 'cut:'||requested.cutting_id::text AS group_key) totals
  ${RECEIVING_GROUP_PACKING_JOIN_SQL}
  LEFT JOIN operation_events event ON event.event_id=packing.operation_event_id`,[cutIds])).rows;
}

export type StyleOperationSnapshot = Readonly<{
  receivingBatchId: string;
  styleNo: string;
  version: number;
  documentQuantity: number;
  actualQuantity: number;
  packingRevisionId: string | null;
  packingQuantity: number | null;
  packingScopeMergeEventIds?:readonly string[];
  packingScopeUnresolved?:boolean;
  packingSourceQuantity?:number|null;
  receivingQuantityChangedAt: string | null;
  receivingQuantityRevision: string;
  actualQuantityChangedAt: string | null;
  actualQuantityRevision: string;
}>;

// Shared native aggregation; the digital adapter changes only the exact-ID scope.
const receivingBoardBaseSql = (scope: string, except?:'$5'|'$13') => `WITH scoped_groups AS (${scope}), scoped_batches AS (
         SELECT batch.receiving_batch_id,
                scope.group_key,
                scope.style_key,
                batch.cutting_order_id
         FROM receiving_batches batch
         JOIN scoped_groups scope
           ON scope.group_key=COALESCE('cut:'||batch.cutting_order_id::text,
             'style:'||upper(btrim(batch.style_no)))
         WHERE batch.deleted_at IS NULL
       ), correction_adjustments AS (
         SELECT event.entity_id::uuid AS receiving_batch_id,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at<($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS prior_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    AND event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS period_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS through_end_actual_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'actualQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'actualQuantity')::bigint
                      -(event.before_state->>'actualQuantity')::bigint
                  END
                ),0)::bigint AS all_actual_adjustment,
                COALESCE(sum(
                  (event.after_state->>'documentQuantity')::bigint
                    -(event.before_state->>'documentQuantity')::bigint
                ) FILTER (
                  WHERE event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS through_end_document_adjustment,
                COALESCE(sum(
                  (event.after_state->>'documentQuantity')::bigint
                    -(event.before_state->>'documentQuantity')::bigint
                ),0)::bigint AS all_document_adjustment,
                COALESCE(sum(
                  CASE WHEN event.action='receiving.batch.merge'
                    THEN (event.after_state->>'defectiveQuantityAdjustment')::bigint
                    ELSE (event.after_state->>'defectiveQuantity')::bigint
                      -(event.before_state->>'defectiveQuantity')::bigint
                  END
                ) FILTER (
                  WHERE event.created_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    AND event.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ),0)::bigint AS period_defective_adjustment
         FROM operation_events event
         JOIN scoped_batches scope ON scope.receiving_batch_id=event.entity_id::uuid
         WHERE event.action IN ('receiving.batch.correct','receiving.batch.merge')
           AND event.entity_type='receiving_batch'
           ${except?`AND NOT EXISTS(SELECT 1 FROM receiving_receipts audit_row WHERE audit_row.receiving_batch_id=scope.receiving_batch_id
            AND audit_row.receipt_id=ANY(${except}::uuid[]))`:''}
         GROUP BY event.entity_id
       ), batch_totals AS (
         SELECT r.receiving_batch_id,
                scope.group_key,
                scope.style_key,
                scope.cutting_order_id,
                (
                  CASE WHEN $3::text<>'' THEN batch.delivery_note_quantity
                    ELSE batch.delivery_note_quantity
                      -COALESCE(adjustments.all_document_adjustment,0)
                      +COALESCE(adjustments.through_end_document_adjustment,0)
                  END
                  -COALESCE(sum(COALESCE(receipt_correction.document_quantity,r.document_quantity)) FILTER (
                    WHERE COALESCE(receipt_correction.receiving_source,r.receiving_source)='other_factory'
                      AND r.receipt_id<>(SELECT base.receipt_id
                        FROM receiving_receipts base
                        WHERE base.receiving_batch_id=r.receiving_batch_id
                        ORDER BY base.received_at,base.receipt_id
                        LIMIT 1)
                  ),0)
                )::bigint AS base_document_quantity,
                COALESCE(sum(COALESCE(receipt_correction.document_quantity,r.document_quantity)) FILTER (
                  WHERE COALESCE(receipt_correction.receiving_source,r.receiving_source)='other_factory'
                    AND r.receipt_id<>(SELECT base.receipt_id
                      FROM receiving_receipts base
                      WHERE base.receiving_batch_id=r.receiving_batch_id
                      ORDER BY base.received_at,base.receipt_id
                      LIMIT 1)
                    AND (
                      $3::text<>''
                      OR r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                    )
                ),0)::bigint AS other_factory_document_increment,
                min(r.received_at) AS first_received_at,
                max(r.received_at) AS last_all_received_at,
                max(r.received_at) FILTER (
                  WHERE $3::text<>''
                     OR r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ) AS last_through_end_received_at,
                CASE WHEN $3::text<>'' THEN 0
                  ELSE (
                    COALESCE(sum(r.actual_quantity) FILTER (
                      WHERE r.received_at<($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                    ),0)
                    +COALESCE(adjustments.prior_actual_adjustment,0)
                    +batch.actual_quantity_adjustment-COALESCE(adjustments.all_actual_adjustment,0)
                  )
                END::bigint AS prior_actual_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.actual_quantity)+batch.actual_quantity_adjustment
                ELSE
                  COALESCE(sum(r.actual_quantity) FILTER (
                    WHERE r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                      AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)+COALESCE(adjustments.period_actual_adjustment,0)
                END::bigint AS actual_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.defective_quantity)+batch.defective_quantity_adjustment
                ELSE
                  COALESCE(sum(r.defective_quantity) FILTER (
                    WHERE r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                      AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)+COALESCE(adjustments.period_defective_adjustment,0)
                END::bigint AS defective_quantity,
                (sum(r.actual_quantity)+batch.actual_quantity_adjustment)::bigint AS current_actual_quantity,
                (sum(r.defective_quantity)+batch.defective_quantity_adjustment)::bigint AS current_defective_quantity,
                CASE WHEN $3::text<>'' THEN
                  sum(r.actual_quantity)+batch.actual_quantity_adjustment
                ELSE
                  COALESCE(sum(r.actual_quantity) FILTER (
                    WHERE r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                  ),0)
                  +COALESCE(adjustments.through_end_actual_adjustment,0)
                  +batch.actual_quantity_adjustment-COALESCE(adjustments.all_actual_adjustment,0)
                END::bigint AS cumulative_actual_quantity,
                (count(*) FILTER (
                  WHERE $3::text<>''
                     OR r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                ))::bigint AS receipt_count,
                max(r.received_at) FILTER (
                  WHERE $3::text<>''
                     OR (
                       r.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                       AND r.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
                     )
                ) AS last_received_at,
                batch.version
         FROM receiving_receipts r
         JOIN scoped_batches scope
           ON scope.receiving_batch_id=r.receiving_batch_id
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=r.receiving_batch_id
          AND batch.deleted_at IS NULL
         LEFT JOIN LATERAL (
           SELECT correction.receiving_source,correction.document_quantity
           FROM receiving_receipt_corrections correction
           WHERE correction.receipt_id=r.receipt_id
             AND (
               $3::text<>''
               OR correction.created_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
             )
           ORDER BY correction.created_at DESC,correction.correction_id DESC
           LIMIT 1
         ) receipt_correction ON true
         LEFT JOIN correction_adjustments adjustments
           ON adjustments.receiving_batch_id=r.receiving_batch_id
         ${except?`WHERE r.receipt_id<>ALL(${except}::uuid[])`:''}
         GROUP BY r.receiving_batch_id,batch.receiving_batch_id,
                  scope.group_key,scope.style_key,scope.cutting_order_id,
                  adjustments.prior_actual_adjustment,adjustments.period_actual_adjustment,
                  adjustments.through_end_actual_adjustment,adjustments.all_actual_adjustment,
                  adjustments.through_end_document_adjustment,adjustments.all_document_adjustment,
                  adjustments.period_defective_adjustment
       ), quantity_changes AS (
         SELECT scope.group_key,event.event_id::text AS change_id,event.created_at AS changed_at,
           CASE WHEN receipt.actual_quantity<>0 THEN event.created_at END AS actual_changed_at
         FROM receiving_receipts receipt JOIN scoped_batches scope USING(receiving_batch_id)
         JOIN operation_events event ON event.event_id=receipt.operation_event_id
         WHERE receipt.actual_quantity<>0 OR (receipt.document_quantity<>0 AND (
           receipt.receiving_source='other_factory' OR receipt.receipt_id=(SELECT first.receipt_id
             FROM receiving_receipts first WHERE first.receiving_batch_id=receipt.receiving_batch_id ORDER BY first.received_at,first.receipt_id LIMIT 1)))
         UNION ALL
         SELECT scope.group_key,event.event_id::text,event.created_at,CASE WHEN event.action='receiving.batch.merge'
           OR event.after_state->'actualQuantity' IS DISTINCT FROM event.before_state->'actualQuantity' THEN event.created_at END
         FROM operation_events event JOIN scoped_batches scope ON scope.receiving_batch_id=event.entity_id::uuid
         WHERE event.entity_type='receiving_batch' AND event.action IN ('receiving.batch.correct','receiving.batch.merge')
           AND (event.action='receiving.batch.merge'
             OR event.after_state->'actualQuantity' IS DISTINCT FROM event.before_state->'actualQuantity'
             OR event.after_state->'documentQuantity' IS DISTINCT FROM event.before_state->'documentQuantity')
         UNION ALL
         SELECT scope.group_key,event.event_id::text,event.created_at,
           CASE WHEN (event.before_state->>'actualQuantity')::bigint<>0 THEN event.created_at END
         FROM receiving_batches tombstone JOIN scoped_groups scope
           ON scope.group_key=COALESCE('cut:'||tombstone.cutting_order_id::text,'style:'||upper(btrim(tombstone.style_no)))
         JOIN operation_events event ON event.entity_id=tombstone.receiving_batch_id::text
           AND event.entity_type='receiving_batch' AND event.action='receiving.batch.delete'
         WHERE tombstone.deleted_at IS NOT NULL
       ), style_totals AS (
         SELECT totals.group_key,totals.style_key,
                (
                  (array_agg(
                    totals.base_document_quantity
                    ORDER BY totals.first_received_at,totals.receiving_batch_id
                  ))[1]
                  +sum(totals.other_factory_document_increment)
                )::bigint AS document_quantity,
                sum(totals.prior_actual_quantity)::bigint AS prior_actual_quantity,
                sum(totals.actual_quantity)::bigint AS actual_quantity,
                sum(totals.defective_quantity)::bigint AS defective_quantity,
                sum(totals.current_actual_quantity)::bigint AS current_actual_quantity,
                sum(totals.current_defective_quantity)::bigint AS current_defective_quantity,
                sum(totals.cumulative_actual_quantity)::bigint AS cumulative_actual_quantity,
                sum(totals.receipt_count)::bigint AS receipt_count,
                count(*)::bigint AS batch_count,
                max(totals.last_received_at) AS last_received_at,
                (SELECT max(change.changed_at) FROM quantity_changes change WHERE change.group_key=totals.group_key
                  AND ($3<>'' OR change.changed_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) AS receiving_quantity_changed_at,
                (SELECT max(change.actual_changed_at) FROM quantity_changes change WHERE change.group_key=totals.group_key
                  AND ($3<>'' OR change.changed_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) AS actual_quantity_changed_at,
                (SELECT md5(COALESCE(string_agg(change.change_id,',' ORDER BY change.change_id),'')) FROM quantity_changes change
                  WHERE change.group_key=totals.group_key AND ($3<>'' OR change.changed_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) AS receiving_quantity_revision,
                (SELECT md5(COALESCE(string_agg(change.change_id,',' ORDER BY change.change_id),'')) FROM quantity_changes change
                  WHERE change.group_key=totals.group_key AND change.actual_changed_at IS NOT NULL
                    AND ($3<>'' OR change.changed_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) AS actual_quantity_revision
         FROM batch_totals totals
         GROUP BY totals.group_key,totals.style_key
       )`;
export const RECEIVING_BOARD_BASE_SQL = receivingBoardBaseSql(`
         SELECT DISTINCT
                COALESCE('cut:'||batch.cutting_order_id::text,
                  'style:'||upper(btrim(batch.style_no))) AS group_key,
                upper(btrim(batch.style_no)) AS style_key
         FROM receiving_receipts receipt
         JOIN receiving_batches batch
           ON batch.receiving_batch_id=receipt.receiving_batch_id
          AND batch.deleted_at IS NULL
         WHERE (
           $3::text<>''
           AND strpos(upper(btrim(batch.style_no)),$3)>0
         ) OR (
           $3::text=''
           AND receipt.received_at>=($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')
           AND receipt.received_at<(($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai')
         )
`);
export const RECEIVING_BATCH_BOARD_BASE_SQL = receivingBoardBaseSql(`
 SELECT COALESCE('cut:'||batch.cutting_order_id::text,'style:'||upper(btrim(batch.style_no))) AS group_key,
 upper(btrim(batch.style_no)) AS style_key FROM receiving_batches batch
 WHERE batch.receiving_batch_id=$3::text::uuid AND batch.deleted_at IS NULL
`);
export const digitalReceivingBaseSql = (except?:'$5'|'$13')=>receivingBoardBaseSql(`
 SELECT DISTINCT 'cut:'||batch.cutting_order_id::text AS group_key,
                 'cut:'||batch.cutting_order_id::text AS style_key
 FROM receiving_batches batch JOIN receiving_receipts receipt USING(receiving_batch_id)
 WHERE batch.deleted_at IS NULL AND batch.cutting_order_id=ANY($4::uuid[])
 `,except);
export const DIGITAL_RECEIVING_BASE_SQL=digitalReceivingBaseSql();
