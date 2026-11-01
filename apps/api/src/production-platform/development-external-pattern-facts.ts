import type { PoolClient } from "pg";
import type { TrustedActorContext } from "../tools/repositories.js";

type DB = Pick<PoolClient, "query">;
export type ExternalPatternRecord = {
  requestId: string; roundNumber: number; requestedAt: Date; requestedBy: string; note: string;
  receivedAt: Date | null; receivedBy: string | null; attachmentIds: string[] | null;
  receiptNote: string | null; taskId: string | null;actualDeparture?:string|null;intervalVersion?:number;actualDepartureQuality?:string|null;departureHistory?:Array<{version:number;departedAt:string|null;quality:string;note:string;recordedAt:string;recordedBy:string}>;
};

/** Existing two-table records are read-only compatibility data. New facts use the original event history. */
export async function externalPatternRecords(db: DB, sourceId: string): Promise<ExternalPatternRecord[]> {
  const legacy = Boolean((await db.query("SELECT to_regclass('digital_development_external_patterns') AS relation")).rows[0]?.relation);
  const records:ExternalPatternRecord[]=(await db.query(`WITH requests AS (
    SELECT event_id request_id,(payload->>'roundNumber')::integer round_number,occurred_at requested_at,
      actor_id requested_by,payload->>'note' note FROM digital_production_task_events
      WHERE resource_kind='source' AND resource_id=$1 AND event_kind='external_pattern_requested'
    ${legacy ? "UNION ALL SELECT request_id,round_number,requested_at,requested_by,note FROM digital_development_external_patterns WHERE source_id=$1" : ""}
  ), receipts AS (
    SELECT (payload->>'requestId')::uuid request_id,occurred_at received_at,actor_id received_by,
      ARRAY(SELECT jsonb_array_elements_text(payload->'attachmentIds'))::uuid[] attachment_ids,payload->>'note' note
      FROM digital_production_task_events WHERE resource_kind='source' AND resource_id=$1 AND event_kind='external_pattern_received'
    ${legacy ? "UNION ALL SELECT c.request_id,c.received_at,c.received_by,c.attachment_ids,c.note FROM digital_development_external_pattern_receipts c JOIN digital_development_external_patterns r USING(request_id) WHERE r.source_id=$1" : ""}
  ) SELECT r.request_id AS "requestId",r.round_number AS "roundNumber",r.requested_at AS "requestedAt",u.display_name AS "requestedBy",r.note,
    c.received_at AS "receivedAt",v.display_name AS "receivedBy",c.attachment_ids AS "attachmentIds",c.note AS "receiptNote",a.task_id AS "taskId"
    FROM requests r JOIN app_users u ON u.id=r.requested_by
    LEFT JOIN receipts c USING(request_id) LEFT JOIN app_users v ON v.id=c.received_by
    LEFT JOIN digital_production_tasks t ON t.route_instance_id=r.request_id AND t.node_key='development_external_pattern'
    LEFT JOIN digital_production_task_access a ON a.task_id=t.task_id AND a.source_id=$1
    ORDER BY r.round_number,r.requested_at,r.request_id`, [sourceId])).rows;
  if((await db.query("SELECT to_regclass('digital_development_external_intervals') AS relation")).rows[0]?.relation){
   const intervals=(await db.query("SELECT i.*,u.display_name AS recorded_by FROM digital_development_external_intervals i JOIN app_users u ON u.id=i.actor_id WHERE i.source_id=$1 AND i.kind='外部纸样' ORDER BY i.external_pattern_request_id,i.version DESC",[sourceId])).rows;
   for(const record of records){const history=intervals.filter(i=>i.external_pattern_request_id===record.requestId),interval=history[0];record.actualDeparture=interval?.departed_at?new Date(interval.departed_at).toISOString():null;record.intervalVersion=interval?.version??0;record.actualDepartureQuality=interval?.time_quality??null;
    record.departureHistory=history.map(i=>({version:i.version,departedAt:i.departed_at?new Date(i.departed_at).toISOString():null,quality:i.time_quality,note:i.evidence_note,recordedAt:new Date(i.recorded_at).toISOString(),recordedBy:i.recorded_by}));}
  }
  return records;
}

/** Caller holds the original lifecycle lock and checks source/role/attachment authorization. */
export async function recordExternalPatternFact(db: PoolClient, actor: TrustedActorContext, sourceId: string,
  eventId: string, kind: "external_pattern_requested" | "external_pattern_received", occurredAt: string,
  payload: { roundNumber: number; requestId: string; note: string; attachmentIds?: string[] }) {
  await db.query(`INSERT INTO digital_production_task_events(event_id,resource_kind,resource_id,event_kind,actor_id,occurred_at,time_quality,payload)
    VALUES($1,'source',$2,$3,$4,$5,'现场登记',$6)`, [eventId, sourceId, kind, actor.actorId, occurredAt, JSON.stringify(payload)]);
}
