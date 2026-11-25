import type { PoolClient } from 'pg';
import { DIGITAL_SLA_PARAMETERS, validateDigitalSlaSnapshot, type DigitalSlaSnapshot } from '@dx-rework/contracts/digital-sla';
export type SlaApplication = {
    eventId: string;
    snapshotId: string;
    configurationId?: string;
    keys: string[];
    excluded: string[];
    taskWindows?: string[];
    snapshot: DigitalSlaSnapshot;
    recordedAt?: string;
    previousEvaluations?: unknown;
};
type SlaApplicationRow={order_id?:string;event_id:string;snapshot_id:string;configuration_id?:string;application_recorded_at:Date|string;rule_version:string;parameters_json:unknown;
    payload:{previousEvaluations?:unknown;parameterKeys:string[];completedWindows:string[];taskWindows?:string[]}};
function applicationFromRow(r:SlaApplicationRow):SlaApplication {
    return {eventId:r.event_id,snapshotId:r.snapshot_id,...(r.configuration_id?{configurationId:r.configuration_id}:{}),
        recordedAt:new Date(r.application_recorded_at).toISOString(),previousEvaluations:r.payload.previousEvaluations,
        keys:r.payload.parameterKeys,excluded:r.payload.completedWindows,...(r.payload.taskWindows?{taskWindows:r.payload.taskWindows}:{}),
        snapshot:validateDigitalSlaSnapshot({ruleVersion:r.rule_version,parameters:r.parameters_json})};
}
/** Explicit application references live in the original append-only business event stream. */
export async function slaApplications(db: Pick<PoolClient, 'query'>, orderId: string): Promise<SlaApplication[]> {
    const rows = (await db.query(`SELECT e.event_id,e.payload,e.recorded_at AS application_recorded_at,s.* FROM digital_production_task_events e
 JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=e.payload->>'snapshotId' AND s.production_order_id=e.resource_id
 WHERE e.resource_kind='order' AND e.resource_id=$1 AND e.event_kind='sla_standard_applied'
 ORDER BY s.revision`, [orderId])).rows;
    return rows.map(applicationFromRow);
}
/** Same ordered application facts in one read for an already authorized cohort. */
export async function slaApplicationsByOrder(db:Pick<PoolClient,'query'>,orderIds:readonly string[]){
    const result=new Map<string,SlaApplication[]>();
    if(!orderIds.length)return result;
    const rows=(await db.query<SlaApplicationRow&{order_id:string}>(`SELECT e.resource_id AS order_id,e.event_id,e.payload,e.recorded_at AS application_recorded_at,
      s.snapshot_id,s.configuration_id,s.rule_version,s.parameters_json FROM digital_production_task_events e
      JOIN digital_sla_order_snapshots s ON s.snapshot_id::text=e.payload->>'snapshotId' AND s.production_order_id=e.resource_id
      WHERE e.resource_kind='order' AND e.resource_id=ANY($1::uuid[]) AND e.event_kind='sla_standard_applied'
      ORDER BY e.resource_id,s.revision`,[orderIds])).rows;
    for(const row of rows){
        const value=applicationFromRow(row),list=result.get(row.order_id);
        if(list)list.push(value);else result.set(row.order_id,[value]);
    }
    return result;
}
/** Never changes a business start or completion. Completed-at-application windows keep their old assessment. */
export function appliedSlaWindow(base: DigitalSlaSnapshot, key: string, windowKey: string, applications: SlaApplication[]) {
    const snapshot = structuredClone(base);
    let applicationId: string | null = null, snapshotId: string | null = null, configurationId: string | undefined;
    for (const application of applications) {
        if (application.excluded.includes(windowKey))
            continue;
        const parents = DIGITAL_SLA_PARAMETERS.find(p => p.key === key)?.includedIn ?? [];
        if (!application.keys.some(k => k === key || k === 'warning_ratio' || parents.includes(k)))
            continue;
        for (const selected of application.keys) {
            // Existing legitimate customer/order exceptions outrank a newly applied global standard.
            if (snapshot.parameters[selected]?.source !== 'global')
                continue;
            const value = application.snapshot.parameters[selected];
            if (!value)
                continue;
            snapshot.parameters[selected] = structuredClone(value);
            applicationId = application.eventId;
            snapshotId = application.snapshotId;
            configurationId = application.configurationId;
        }
    }
    return { snapshot, applicationId, snapshotId, configurationId };
}
