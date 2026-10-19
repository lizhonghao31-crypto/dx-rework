import type {PoolClient} from "pg";
import {z} from "zod";
import {JOURNEY_NODES,type JourneyLogEntry,type JourneyLogPage,type OrderJourney} from "@dx-rework/contracts/digital-production-journey";
import {ApplicationError} from "../platform/errors.js";

const cursorSchema=z.object({v:z.literal(1),order:z.string(),actor:z.string(),asOf:z.iso.datetime({precision:null}),at:z.iso.datetime({precision:null}),id:z.string().regex(/^(task|assignment):[0-9a-f-]{36}$/)}).strict();
const coverage=["数字生产节点事件（按登记时间）","节点改派审计（未重复登记为节点事件的记录）"] as const;
const labels:Record<string,string>={created:"创建节点",ready:"进入办理",completed:"节点完成",reassigned:"改派节点",condition:"更新前置条件",time_corrected:"更正节点时间",priority_changed:"调整优先级",material_returned:"物料退回",cancelled:"取消节点",paused:"暂停节点",resumed:"恢复节点",blocked:"登记阻断",unblocked:"解除阻断",deadline_changed:"更新节点时效",policy_changed:"更新节点时效",system_route:"衔接办理节点",pause:"暂停流程",resume:"恢复流程",cancel:"取消流程"};
export function parseJourneyLogCursor(value:string,order:string,asOf:string,actor:string){
  try{
    const parsed=cursorSchema.parse(JSON.parse(Buffer.from(value,"base64url").toString("utf8")));
    if(parsed.order!==order||parsed.actor!==actor||Date.parse(parsed.asOf)>Date.parse(asOf)||Date.parse(parsed.at)>Date.parse(parsed.asOf))throw new Error("scope");
    return parsed;
  }catch{throw new ApplicationError("INVALID_JOURNEY_CURSOR","记录页已失效，请重新打开操作记录",400);}
}
/** Only task IDs already authorized by the Journey projection enter this query. No payload/price leakage. */
export async function readJourneyLog(db:Pick<PoolClient,"query">,order:OrderJourney,asOf:string,actor:string,cursor?:string,limit:5|20=20):Promise<JourneyLogPage>{
  const after=cursor?parseJourneyLogCursor(cursor,order.id,asOf,actor):null;
  const cutoff=after?.asOf??asOf;
  const taskIds=[...new Set(order.stages.flatMap(stage=>stage.nodes.flatMap(node=>node.records.filter(record=>record.domain==="task").map(record=>record.id))))];
  const cte=`WITH authorized_events AS (
    SELECT 'task:'||e.event_id::text id,e.recorded_at at,e.actor_id,u.display_name actor_name,e.event_kind action,t.node_key,'task_event' source
    FROM digital_production_task_events e JOIN digital_production_tasks t USING(task_id) LEFT JOIN app_users u ON u.id=e.actor_id
    WHERE e.task_id=ANY($1::uuid[]) AND e.recorded_at<=$2::timestamptz
    UNION ALL
    SELECT 'assignment:'||a.id::text,a.created_at,a.actor_id,u.display_name,'reassigned',t.node_key,'task_assignment'
    FROM audit_events a JOIN digital_production_tasks t ON t.task_id::text=a.entity_id LEFT JOIN app_users u ON u.id=a.actor_id
    WHERE a.entity_type='digital_task' AND a.action='digital_task_reassigned' AND a.entity_id=ANY($1::text[]) AND a.created_at<=$2::timestamptz
      AND NOT EXISTS(SELECT 1 FROM digital_production_task_events e WHERE e.task_id=t.task_id AND e.event_kind='reassigned' AND e.recorded_at=a.created_at AND e.actor_id=a.actor_id)
  )`;
  const args=[taskIds,cutoff,after?.at??null,after?.id??null];
  const rows=(await db.query(`${cte} SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') stamp FROM authorized_events
    WHERE ($3::timestamptz IS NULL OR (at,id)<($3::timestamptz,$4::text)) ORDER BY at DESC,id DESC LIMIT ${limit}`,args)).rows;
  const last=rows.at(-1);
  const more=last?Boolean((await db.query(`${cte} SELECT EXISTS(SELECT 1 FROM authorized_events WHERE (at,id)<($3::timestamptz,$4::text)) more`,[taskIds,cutoff,last.stamp,last.id])).rows[0]?.more):false;
  const items:JourneyLogEntry[]=rows.map(row=>({id:row.id,at:row.stamp,actor:row.actor_id?{id:row.actor_id,name:row.actor_name}:null,action:labels[row.action]??"更新节点记录",object:JOURNEY_NODES.find(node=>node.key===row.node_key)?.label??"业务节点",nodeKey:row.node_key,source:row.source}));
  return {items,asOf:cutoff,coverage,nextCursor:more&&last?Buffer.from(JSON.stringify({v:1,order:order.id,actor,asOf:cutoff,at:last.stamp,id:last.id})).toString("base64url"):null};
}
