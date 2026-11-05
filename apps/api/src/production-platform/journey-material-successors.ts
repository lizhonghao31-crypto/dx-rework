import type {PoolClient} from 'pg';
import type {RequirementReplacement} from './journey-business-progress.js';

/** Original structured return -> supply -> resubmission facts, within visible
 * same-source tasks and the same native route/version. No inferred UUID or
 * same-kind/same-time matching; cross-round inheritance remains separate.
 */
export async function readMaterialSuccessors(db: Pick<PoolClient, 'query'>, sourceId: string, visibleIds: readonly string[]): Promise<RequirementReplacement[]> {
  return (await db.query<RequirementReplacement>(`SELECT DISTINCT old.task_id::text AS "retiredId", next.task_id::text AS "successorId"
    FROM digital_development_execution_facts requirements
    JOIN digital_production_tasks supply ON supply.task_id=requirements.task_id
    JOIN digital_production_task_access sa ON sa.task_id=supply.task_id AND sa.source_id=requirements.source_id AND sa.task_kind='development_material_supply'
    JOIN digital_development_execution_facts submitted ON submitted.source_id=requirements.source_id AND submitted.task_id=supply.task_id AND submitted.kind='补料复核'
    JOIN digital_production_tasks old ON old.task_id::text=requirements.payload->'returnRequirements'->>'checkTaskId'
      AND old.route_instance_id=supply.route_instance_id AND old.route_version=supply.route_version
    JOIN digital_production_task_access oa ON oa.task_id=old.task_id AND oa.source_id=requirements.source_id AND oa.task_kind IN ('development_materials','development_material_recheck')
    JOIN digital_production_tasks next ON next.task_id::text=submitted.payload->>'nextTaskId'
      AND next.route_instance_id=supply.route_instance_id AND next.route_version=supply.route_version
    JOIN digital_production_task_access na ON na.task_id=next.task_id AND na.source_id=requirements.source_id AND na.task_kind='development_material_recheck'
    WHERE requirements.source_id=$1 AND requirements.kind='补料复核'
      AND old.task_id=ANY($2::uuid[]) AND supply.task_id=ANY($2::uuid[]) AND next.task_id=ANY($2::uuid[])
      AND EXISTS(SELECT 1 FROM digital_production_task_events returned WHERE returned.task_id=old.task_id AND returned.resource_id=$1 AND returned.event_kind='material_returned')`, [sourceId, visibleIds])).rows;
}
