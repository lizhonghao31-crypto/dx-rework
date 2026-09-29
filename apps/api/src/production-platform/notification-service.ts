import { isRootActor } from "../access/business-authority.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TodoResponse, TodoRouteDescriptor } from "@dx-rework/contracts";
import type { DigitalNotification } from "@dx-rework/contracts/digital-production-notifications";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { digitalTodoOrder } from "./notification-policy.js";

type Database = Pick<Pool | PoolClient, "query">;
const iso = (value: Date | string) => new Date(value).toISOString();
const ACTIVE = "t.state IN ('pending','ready','blocked') AND coalesce(l.state,'active')='active'";
const TASKS = `SELECT t.*,a.assignee_id,a.required_role,a.task_kind,a.production_order_id,a.source_id,
  coalesce(o.created_by,s.created_by) AS designer_id,o.primary_merchandiser_id,
  p.label,d.revision_id,d.warning_at,d.due_at,coalesce(l.state,'active') AS lifecycle
  FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id)
  LEFT JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN digital_production_sources s ON s.source_id=a.source_id
  LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind=CASE WHEN a.production_order_id IS NULL THEN 'source' ELSE 'order' END AND l.resource_id=coalesce(a.production_order_id,a.source_id)
  JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1)p ON true
  LEFT JOIN LATERAL(SELECT * FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)d ON true`;
type Task = {task_id:string;state:string;assignee_id:string|null;required_role:string;task_kind:string;production_order_id:string|null;source_id:string|null;designer_id:string;primary_merchandiser_id:string|null;label:string;revision_id:string|null;warning_at:Date|null;due_at:Date|null;lifecycle:string;created_at:Date};
const labels: Record<string,string> = {ready:"待办理",reassigned:"已改派给你",unblocked:"已解除阻断",blocked:"办理遇到阻断",completed:"已完成",warning:"即将超时",overdue:"已超时",created:"待分配主办"};

export class DigitalProductionNotificationService {
  constructor(private readonly database: Pool) {}
  private async transaction<T>(action:(client:PoolClient)=>Promise<T>):Promise<T> {
    const client=await this.database.connect();
    try { await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('digital-production-task-lifecycle-v1',0))");
      const result=await action(client);await client.query("COMMIT");return result;
    } catch(error){await client.query("ROLLBACK");throw error;}finally{client.release();}
  }
  private async people(database:Database):Promise<TrustedActorContext[]> {
    return (await database.query(`SELECT u.id,array_agg(DISTINCT r.role_code) AS roles FROM app_users u
      JOIN user_role_assignments a ON a.user_id=u.id AND a.revoked_at IS NULL
      JOIN business_roles r ON r.role_code=a.role_code AND r.enabled
      WHERE u.enabled AND coalesce((to_jsonb(u)->>'manual_access_disabled')::boolean,false)=false
      AND EXISTS(SELECT 1 FROM identity_mappings i WHERE i.user_id=u.id AND i.active AND i.employed)
      GROUP BY u.id`)).rows.map(row=>({actorId:row.id,actorRoles:row.roles,authorizationCapability:"todo:view",requestId:"digital-notification"}));
  }
  private async currentTaskEvent(database:Database,task:Task,eventId:string,kind:string):Promise<boolean> {
    if(kind==="completed")return task.state==="completed";
    if(!["pending","ready","blocked"].includes(task.state))return false;
    if(kind==="blocked"&&task.state!=="blocked")return false;
    if(["ready","unblocked"].includes(kind)&&task.state!=="ready")return false;
    if(["ready","reassigned","blocked","unblocked"].includes(kind)) {
      const latest=(await database.query(`SELECT event_id FROM digital_production_event_intents WHERE task_id=$1
        AND event_kind IN ('ready','reassigned','blocked','unblocked') ORDER BY notification_sequence DESC LIMIT 1`,[task.task_id])).rows[0];
      return latest?.event_id===eventId;
    }
    return true;
  }
  private async recipients(database:Database,task:Task,kind:string,people:TrustedActorContext[]):Promise<TrustedActorContext[]> {
    const policy=new DigitalProductionAccessPolicy(database);
    const assignee=people.find(p=>p.actorId===task.assignee_id&&p.actorRoles.includes(task.required_role));
    const development=task.task_kind.startsWith("development_");
    const technical=development||["bulk_pattern","bulk_cutting","process_logistics"].includes(task.task_kind);
    const missing=!assignee;
    const risk=["warning","overdue","blocked"].includes(kind);
    const delegates = ["ready","reassigned","unblocked"].includes(kind) ? (await database.query("SELECT delegate_id FROM digital_production_delegations WHERE task_id=$1 AND purpose='execute' AND revoked_at IS NULL AND expires_at>CURRENT_TIMESTAMP",[task.task_id])).rows.map(row=>row.delegate_id as string) : [];
    const result:TrustedActorContext[]=[];
    for(const person of people){
      const designer=person.actorId===task.designer_id&&person.actorRoles.includes("sample_designer");
      const tech=person.actorRoles.includes("pattern_room_supervisor");
      const director=person.actorRoles.includes("production_management");
      const primary=person.actorId===task.primary_merchandiser_id&&person.actorRoles.includes("order_merchandiser");
      let receive=false;
      if(kind==="completed") receive=designer&&["development_pattern","development_printing","development_embroidery","development_print_embroidery"].includes(task.task_kind);
      else if(missing) receive=development ? tech||person.actorRoles.includes("development_clerk") : director||(technical&&tech);
      else {
        receive=person.actorId===assignee.actorId;
        if(!receive&&delegates.includes(person.actorId)) receive=await policy.allowed(person,"task",task.task_id,"execute");
        if(risk) receive=receive||(development ? designer||(tech&&task.task_kind!=="development_washing") : primary||director||(technical&&tech));
      }
      if(receive&&await policy.allowed(person,"task",task.task_id,"technical")) result.push(person);
    }
    if(missing&&kind!=="completed"&&!result.length) for(const person of people) {
      if(person.actorRoles.some(role=>["production_management","owner_group"].includes(role))&&await policy.allowed(person,"task",task.task_id,"technical"))result.push(person);
    }
    return result;
  }
  private async notice(database:Database,input:{key:string;taskId?:string;todoId?:string;kind:string;revision?:string|null;eventId?:string;sourceEventId?:string},recipients:readonly string[]) {
    const row=(await database.query(`INSERT INTO digital_production_notification_events(event_id,source_key,task_id,todo_id,event_kind,deadline_revision_id)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(source_key) DO NOTHING RETURNING event_id`,[input.eventId??randomUUID(),input.key,input.taskId??null,input.todoId??null,input.kind,input.revision??null])).rows[0];
    const eventId=row?.event_id??(await database.query("SELECT event_id FROM digital_production_notification_events WHERE source_key=$1",[input.key])).rows[0].event_id;
    for(const person of new Set(recipients)) await database.query("INSERT INTO digital_production_notification_receipts(event_id,recipient_id,source_event_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[eventId,person,input.sourceEventId??eventId]);
  }
  // Runs on the server even with no open page and with external todo delivery off.
  async runOnce():Promise<void> {
    await this.transaction(async client=>{
      const people=await this.people(client);
      const intents=(await client.query(`SELECT i.* FROM digital_production_event_intents i
        WHERE NOT EXISTS(SELECT 1 FROM digital_production_notification_projection p WHERE p.event_id=i.event_id)
        ORDER BY i.created_at,i.event_id LIMIT 200`)).rows;
      for(const intent of intents){
        const task=intent.task_id?(await client.query<Task>(`${TASKS} WHERE t.task_id=$1`,[intent.task_id])).rows[0]:undefined;
        if(task&&people.some(p=>p.actorId===task.assignee_id&&p.actorRoles.includes(task.required_role))&&labels[intent.event_kind]&&task.lifecycle==="active"&&
          await this.currentTaskEvent(client,task,intent.event_id,intent.event_kind)&&
          (intent.event_kind!=="created"||(task.state==="pending"&&!task.assignee_id))){
          await this.notice(client,{key:`event:${intent.event_id}`,eventId:intent.event_id,taskId:task.task_id,kind:intent.event_kind},(await this.recipients(client,task,intent.event_kind,people)).map(p=>p.actorId));
        }
        await client.query("INSERT INTO digital_production_notification_projection(event_id) VALUES($1) ON CONFLICT DO NOTHING",[intent.event_id]);
      }
      const tasks=(await client.query<Task>(`${TASKS} WHERE ${ACTIVE}`)).rows;
      for(const task of tasks){
        // Repair an unassigned/disabled operator as an upstream routing task; never broadcast to all craftspeople.
        if(!people.some(p=>p.actorId===task.assignee_id&&p.actorRoles.includes(task.required_role)))
          await this.notice(client,{key:`missing:${task.task_id}:${task.assignee_id??'none'}`,taskId:task.task_id,kind:"created"},(await this.recipients(client,task,"created",people)).map(p=>p.actorId));
        if(task.state==="pending"||!task.due_at)continue;
        const now=Date.now(),kind=new Date(task.due_at).getTime()<=now?"overdue":task.warning_at&&new Date(task.warning_at).getTime()<=now?"warning":null;
        if(kind)await this.notice(client,{key:`deadline:${task.task_id}:${task.revision_id}:${kind}`,taskId:task.task_id,kind,revision:task.revision_id},(await this.recipients(client,task,kind,people)).map(p=>p.actorId));
      }
      await this.projectChildren(client);
    });
  }
  private async projectChildren(client:PoolClient) {
    if(!(await client.query("SELECT to_regclass('rework_todos') AS relation")).rows[0]?.relation)return;
    const rows=(await client.query(`SELECT t.* FROM rework_todos t JOIN digital_production_child_links l ON
      l.child_id=coalesce(nullif(t.route_descriptor->>'reworkOrderId',''),t.route_descriptor->>'entityId')::uuid
      AND l.module=CASE t.route_descriptor->>'routeName' WHEN 'sourcing_detail' THEN 'sourcing' WHEN 'production_detail' THEN 'production' WHEN 'pattern_room_order' THEN 'pattern_room' ELSE 'rework' END
      WHERE t.status IN ('pending','blocked_recipient')`)).rows;
    for(const row of rows){
      const kind=row.todo_type==="information"?"information":"ready";
      await this.notice(client,{key:`child:${row.source_event_id}:${row.todo_id}`,todoId:row.todo_id,kind,sourceEventId:row.source_event_id},[row.recipient_user_id]);
      if(row.todo_type!=="information"&&row.due_at&&new Date(row.due_at).getTime()<=Date.now())
        await this.notice(client,{key:`child-overdue:${row.todo_id}:${iso(row.due_at)}`,todoId:row.todo_id,kind:"overdue"},[row.recipient_user_id]);
    }
  }
  async todos(actor:TrustedActorContext):Promise<TodoResponse[]> {
    const people=await this.people(this.database);
    if(!people.some(p=>p.actorId===actor.actorId))return [];
    const tasks=(await this.database.query<Task>(`${TASKS} WHERE ${ACTIVE} ORDER BY d.due_at NULLS LAST,t.created_at,t.task_id`)).rows;
    const result:TodoResponse[]=[];
    for(const task of tasks){
      const missing=!people.some(p=>p.actorId===task.assignee_id&&p.actorRoles.includes(task.required_role));
      if(task.state==="pending"&&!missing)continue;
      if(!(await this.recipients(this.database,task,"ready",people)).some(p=>p.actorId===actor.actorId))continue;
      result.push({todoId:task.task_id,todoType:missing?"recipient_routing_exception":"business_action",category:missing?"digital_assignment":"digital_task",sourceEventId:task.task_id,sourceAction:"digital_task",entityType:"digital_task",entityId:task.task_id,recipientUserId:actor.actorId,requiredRole:task.required_role,requiredCapability:null,route:{routeName:"digital_production_task",entityId:task.task_id,todoId:task.task_id},policyKey:null,dueAt:task.due_at?iso(task.due_at):null,reminderCount:0,status:missing?"blocked_recipient":"pending",blockedReason:missing?"主办缺失或已失效，请重新分配":null,orderContext:{reworkNo:null,orderNo:null,styleNo:task.label,supplierName:null,status:task.state,updatedAt:iso(task.created_at)},unread:true,version:1,createdAt:iso(task.created_at),updatedAt:iso(task.created_at)});
    }
    return result;
  }
  private async render(database:Database,actor:TrustedActorContext,event:{event_id:string;task_id:string|null;todo_id:string|null;event_kind:string;deadline_revision_id:string|null;created_at:Date},people:TrustedActorContext[]):Promise<DigitalNotification|null> {
    if(!people.some(p=>p.actorId===actor.actorId))return null;
    let title:string,actionable:boolean,route:TodoRouteDescriptor;
    if(event.task_id){
      const task=(await database.query<Task>(`${TASKS} WHERE t.task_id=$1`,[event.task_id])).rows[0];
      if(!task||task.lifecycle!=="active")return null;
      if(!await this.currentTaskEvent(database,task,event.event_id,event.event_kind))return null;
      if(event.deadline_revision_id&&String(event.deadline_revision_id)!==String(task.revision_id))return null;
      if(event.event_kind==="warning"&&task.due_at&&new Date(task.due_at).getTime()<=Date.now())return null;
      const missing=!people.some(p=>p.actorId===task.assignee_id&&p.actorRoles.includes(task.required_role));
      if(event.event_kind==="created"&&!missing)return null;
      if(!(await this.recipients(database,task,event.event_kind,people)).some(p=>p.actorId===actor.actorId))return null;
      actionable=event.event_kind!=="completed"&&(missing||await new DigitalProductionAccessPolicy(database).allowed(actor,"task",task.task_id,"execute"));
      title=`${task.label} · ${missing?"待分配主办":labels[event.event_kind]??"事项更新"}`;
      route={routeName:"digital_production_task",entityId:task.task_id,todoId:task.task_id};
    }else{
      const row=(await database.query("SELECT * FROM rework_todos WHERE todo_id=$1 AND recipient_user_id=$2 AND status IN ('pending','blocked_recipient')",[event.todo_id,actor.actorId])).rows[0];
      if(!row)return null;
      const parent=await digitalTodoOrder(database,row.route_descriptor);
      if(!parent)return null;
      if(row.todo_type==="information"&&!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(database).allowed(people.find(p=>p.actorId===actor.actorId)!,"order",parent,"technical"))return null;
      if(row.required_role&&!await new DigitalProductionAccessPolicy(database).activeRole(actor.actorId,row.required_role))return null;
      if(row.required_capability&&!(actor.authorizationCapabilities??[]).includes(row.required_capability))return null;
      actionable=row.todo_type!=="information";title=actionable?(event.event_kind==="overdue"?"订单待办已超时":"你有新的订单待办"):"订单事项已更新";
      route=row.route_descriptor;
    }
    return {eventId:event.event_id,title,actionable,route,createdAt:iso(event.created_at)};
  }
  // Atomic claim per recipient is the incremental cursor: refreshes and competing
  // tabs consume only unseen events. Acknowledgement is a separate receipt field.
  async claim(actor:TrustedActorContext):Promise<{notification:DigitalNotification|null}> {
    return this.transaction(async client=>{
      const people=await this.people(client);
      const events=(await client.query(`SELECT e.* FROM digital_production_notification_receipts r JOIN digital_production_notification_events e USING(event_id)
        WHERE r.recipient_id=$1 AND r.shown_at IS NULL ORDER BY e.created_at,e.event_id LIMIT 100 FOR UPDATE OF r SKIP LOCKED`,[actor.actorId])).rows;
      for(const event of events){
        const notification=await this.render(client,actor,event,people);
        await client.query("UPDATE digital_production_notification_receipts SET shown_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND recipient_id=$2 AND shown_at IS NULL",[event.event_id,actor.actorId]);
        if(notification)return {notification};
      }
      return {notification:null};
    });
  }
  async acknowledge(actor:TrustedActorContext,eventId:string) {
    await this.database.query("UPDATE digital_production_notification_receipts SET acknowledged_at=coalesce(acknowledged_at,CURRENT_TIMESTAMP) WHERE event_id=$1 AND recipient_id=$2 AND shown_at IS NOT NULL",[eventId,actor.actorId]);
    return {ok:true};
  }
  async current(actor:TrustedActorContext,eventId:string) {
    const event=(await this.database.query(`SELECT e.* FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id) WHERE e.event_id=$1 AND r.recipient_id=$2 AND r.shown_at IS NOT NULL AND r.acknowledged_at IS NULL`,[eventId,actor.actorId])).rows[0];
    return {notification:event?await this.render(this.database,actor,event,await this.people(this.database)):null};
  }
}
