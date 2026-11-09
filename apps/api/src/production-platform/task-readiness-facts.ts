import type {PoolClient} from 'pg';

type DB=Pick<PoolClient,'query'>;
export const NATIVE_READINESS_KINDS=new Set(['development_sewing','development_sewing_transfer','bulk_cutting','bulk_cutting_external']);
export type NativeTaskReadiness={
 taskId:string;tracked:boolean;eventId:string|null;effectiveEventId:string|null;
 firstReadyAt:string|null;quality:string|null;scopeRef:string|null;basis:string[];
};

/** Only native writes enroll new tasks and capture simultaneous readiness.
 * Existing correction events keep the original R and any explicit unknown.
 * Reading or reassigning an old task cannot manufacture its first-ready time.
 */
export async function nativeTaskReadiness(db:DB,taskIds:readonly string[]):Promise<Map<string,NativeTaskReadiness>>{
 if(!taskIds.length)return new Map();
 const rows=(await db.query(`SELECT requested.task_id,tracked.event_id AS tracked_event_id,
   original.event_id,original.payload,
   coalesce(corrected.event_id,original.event_id) AS effective_event_id,
   CASE WHEN corrected.event_id IS NOT NULL THEN corrected.occurred_at ELSE original.occurred_at END AS ready_at,
   CASE WHEN corrected.event_id IS NOT NULL THEN corrected.time_quality ELSE original.time_quality END AS quality
  FROM unnest($1::uuid[]) AS requested(task_id)
  LEFT JOIN LATERAL(SELECT e.event_id FROM digital_production_task_events e
    WHERE e.task_id=requested.task_id AND e.event_kind='created'
     AND e.payload->>'readinessCaptureVersion'='1' LIMIT 1) AS tracked ON true
  LEFT JOIN LATERAL(SELECT e.event_id,e.payload,e.occurred_at,e.time_quality FROM digital_production_task_events e
    WHERE e.task_id=requested.task_id AND e.event_kind='ready'
     AND e.payload->'nativeReadiness'->>'version'='1'
    ORDER BY e.recorded_at,e.event_id LIMIT 1) AS original ON tracked.event_id IS NOT NULL
  LEFT JOIN LATERAL(SELECT e.event_id,e.occurred_at,e.time_quality FROM digital_production_task_events e
    LEFT JOIN digital_production_event_intents i USING(event_id)
    WHERE e.task_id=requested.task_id AND e.event_kind='time_corrected' AND e.corrects_event_id=original.event_id
    ORDER BY (to_jsonb(i)->>'notification_sequence')::bigint DESC NULLS LAST,e.recorded_at DESC,e.event_id DESC LIMIT 1) AS corrected ON true`,[[...taskIds]])).rows;
 return new Map(rows.map(row=>[row.task_id,{taskId:row.task_id,tracked:!!row.tracked_event_id,
  eventId:row.event_id??null,effectiveEventId:row.effective_event_id??null,
  firstReadyAt:row.ready_at&&['现场登记','已核实'].includes(row.quality)?new Date(row.ready_at).toISOString():null,
  quality:row.quality??null,scopeRef:row.payload?.nativeReadiness?.scopeRef??null,
  basis:Array.isArray(row.payload?.nativeReadiness?.basis)?row.payload.nativeReadiness.basis.filter((ref:unknown):ref is string=>typeof ref==='string'):[]} as NativeTaskReadiness]));
}
