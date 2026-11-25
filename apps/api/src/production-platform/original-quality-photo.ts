import type {Pool, PoolClient} from 'pg';
import type {TrustedActorContext} from '../tools/repositories.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';

type DB = Pick<Pool | PoolClient, 'query'>;
type OriginalPhoto = Readonly<{orderId:string; attachmentId:string}>;

export type OriginalQualityPhotoReference = OriginalPhoto & (
  | Readonly<{kind:'craft-return'; checkId:string; returnFactId:string; lineId:string; stepRef:string|null}>
  | Readonly<{kind:'factory-progress'; productionId:string; factoryDecisionId:string|null; recordId:string; revision:number; scopeRevision:string}>
);

/** Check an exact, already bound historical photo under the original order read
 * policy. This does not assert quality, quantity or progress. Factory progress
 * photographs are not attachments of a factory or arrival inspection event. */
export async function canReadExactOriginalQualityPhoto(db:DB, actor:TrustedActorContext, ref:OriginalQualityPhotoReference):Promise<boolean> {
  if (!await new DigitalProductionAccessPolicy(db).allowed(actor,'order',ref.orderId,'technical')) return false;

  // Call before issuing any grant. AttachmentService also admits a user's
  // own unbound uploads and will not invoke its bound callback for them.
  if (ref.kind === 'craft-return') {
    if (ref.stepRef === undefined) return false;
    return Boolean((await db.query(`SELECT 1 FROM digital_factory_qc q
      JOIN digital_factory_routes route USING(preparation_id)
      JOIN digital_factory_facts fact ON fact.fact_id=q.return_fact_id AND fact.preparation_id=q.preparation_id AND fact.kind='工艺回仓'
      JOIN digital_production_po_lines po ON po.line_id=q.line_id AND po.production_order_id=route.production_order_id
      JOIN attachments a ON a.attachment_id=ANY(q.attachment_ids) AND a.entity_type='digital_factory_qc' AND a.entity_id=q.check_id::text
      WHERE route.production_order_id=$1 AND q.check_id=$2 AND q.return_fact_id=$3 AND q.line_id=$4
        AND fact.payload->>'stepRef' IS NOT DISTINCT FROM $5::text AND a.attachment_id=$6 AND a.status='ready'`,
    [ref.orderId,ref.checkId,ref.returnFactId,ref.lineId,ref.stepRef,ref.attachmentId])).rowCount);
  }

  // Null identifies the recorded original factory only within the exact
  // native production ID. Never substitute the order's current factory.
  if (ref.kind !== 'factory-progress' || ref.factoryDecisionId === undefined) return false;
  return Boolean((await db.query(`SELECT 1 FROM digital_qc_progress_records r
    JOIN digital_qc_tracking_starts t USING(tracking_id)
    JOIN attachments a ON a.attachment_id=ANY(r.attachment_ids) AND a.entity_type='digital_qc_progress' AND a.entity_id=r.record_id::text
    WHERE t.production_order_id=$1 AND t.native_production_id=$2 AND t.factory_decision_id IS NOT DISTINCT FROM $3::uuid
      AND r.record_id=$4 AND r.revision=$5 AND r.scope_revision=$6 AND a.attachment_id=$7 AND a.status='ready'`,
  [ref.orderId,ref.productionId,ref.factoryDecisionId,ref.recordId,ref.revision,ref.scopeRevision,ref.attachmentId])).rowCount);
}
