import {type TodoSelection,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import {shortLeadTodos} from './short-lead-todos.js';
import {qcProgressNotices,qcNoticesAsTodos} from './qc-progress-todos.js';
import {preparationWindowTodos,preparationMaterialsTodos,preparationSupplement} from './preparation-todos.js';
import {effectiveSourcingDueSql} from './sla-sourcing-deadline-sql.js';
import {slaNotificationWindow} from './sla-notification-window.js';
import {slaNotificationPreferences,slaNotificationDue,type SlaNotificationPreference} from './sla-notification-preferences.js';
import {todoSlaTiming,explicitlyUnlimitedSla} from "../todos/sla-presentation.js";
import {acceptanceBusinessContext,acceptanceClockReaderEnabled,acceptanceIncludesNative,businessNow,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {garmentQualityTodos} from './garment-quality-todos.js';
import {factoryProductionQcTodos} from './factory-production-qc-todos.js';
import {bulkFabricDecisionTodos} from "./bulk-fabric-todos.js";
import {applyTodoReadState,todoContentToken} from '../todos/content-reads.js';
import {fabricDecisionTodos} from "./development-fabric-cases.js";
import {arrangementTodos,hiddenNativeDevelopmentTodo} from "./development-arrangement-todos.js";
import {arrangementsAvailable} from "./development-arrangement.js";
import {DEVELOPMENT_ARRANGEABLE_KINDS} from "@dx-rework/contracts/development-arrangement";
import { hasRequiredWarehouseRole } from "@dx-rework/contracts";
import { projectDevelopmentNotices } from "./development-notifications.js";
import { receivedDevelopmentAccessories } from "./development-accessory-receipts.js";
import { developmentDocumentRow } from "./development-round-repository.js";
import { effectiveVerificationDocument } from "./development-material-verification.js";
import { patternOrderScopeSql } from "../pattern-room/order-authority.js";
import { SourcingService } from "../sourcing/sourcing-service.js";
import { SourcingProductionService } from "../sourcing/sourcing-production-service.js";
import { ReworkBusinessDetailService } from "../rework/rework-business-detail-service.js";
import { ExternalResponsibilityService } from "../rework/external-responsibility-service.js";
import { ApplicationError } from "../platform/errors.js";
import { isRootActor } from "../access/business-authority.js";
import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TodoResponse, TodoRouteDescriptor } from "@dx-rework/contracts";
import type { DigitalNotification } from "@dx-rework/contracts/digital-production-notifications";
import type { TrustedActorContext } from "../tools/repositories.js";
import { DigitalProductionAccessPolicy } from "./access-policy.js";
import { digitalTodoTarget } from "./notification-policy.js";

type Database = Pick<Pool | PoolClient, "query">;
const iso = (value: Date | string) => new Date(value).toISOString();
const ACTIVE = "t.state IN ('pending','ready','blocked') AND coalesce(l.state,'active')='active'";
const TASKS = `SELECT t.*,a.assignee_id,a.required_role,a.task_kind,a.production_order_id,a.source_id,
  coalesce(o.created_by,s.created_by) AS designer_id,o.primary_merchandiser_id,
  o.design_style_no AS order_style_no,s.design_style_no AS source_style_no,
  p.label,d.revision_id,d.entered_at,to_jsonb(d)->'sla_basis' AS sla_basis,d.warning_at,d.due_at,NULLIF(to_jsonb(d)->'sla_basis','null'::jsonb) IS NOT NULL AS source_sla,coalesce((to_jsonb(d)->'sla_basis'->>'exclusive')::boolean,false) AS deadline_exclusive,coalesce(l.state,'active') AS lifecycle
  FROM digital_production_tasks t JOIN digital_production_task_access a ON a.task_id=t.task_id AND a.task_kind<>'factory_material_count'
  LEFT JOIN digital_production_orders o USING(production_order_id)
  LEFT JOIN digital_production_sources s ON s.source_id=a.source_id
  LEFT JOIN digital_production_resource_lifecycle l ON l.resource_kind=CASE WHEN a.production_order_id IS NULL THEN 'source' ELSE 'order' END AND l.resource_id=coalesce(a.production_order_id,a.source_id)
  JOIN LATERAL(SELECT label FROM digital_production_deadline_policies WHERE node_key=t.node_key ORDER BY version DESC LIMIT 1)p ON true
  LEFT JOIN LATERAL(SELECT * FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)d ON true`;
type Task = {entered_at:Date|null;sla_basis?:unknown;deadline_exclusive?:boolean;source_sla?:boolean;route_version:number;task_id:string;state:string;assignee_id:string|null;required_role:string;task_kind:string;production_order_id:string|null;source_id:string|null;order_style_no:string|null;source_style_no:string|null;designer_id:string;primary_merchandiser_id:string|null;label:string;revision_id:string|null;warning_at:Date|null;due_at:Date|null;lifecycle:string;created_at:Date};
type NotificationTasks={tasks:Map<string,Task>;preferences:Map<string,SlaNotificationPreference>};
const labels: Record<string,string> = {ready:"待办理",reassigned:"已改派给你",unblocked:"已解除阻断",blocked:"办理遇到阻断",completed:"已完成",warning:"即将超时",overdue:"已超时",created:"待分配主办"};

export class DigitalProductionNotificationService {
  constructor(private readonly database: Pool) {}
  private async notificationTasks(database:Database,events:Array<{task_id:string|null;event_kind:string}>):Promise<NotificationTasks>{
    const ids=[...new Set(events.flatMap(event=>event.task_id?[event.task_id]:[]))],tasks=ids.length?(await database.query<Task>(`${TASKS} WHERE t.task_id=ANY($1::uuid[])`,[ids])).rows:[];
    const timed=new Set(events.filter(event=>['warning','overdue'].includes(event.event_kind)).map(event=>event.task_id));
    return {tasks:new Map(tasks.map(task=>[task.task_id,task])),preferences:await slaNotificationPreferences(database,tasks.filter(task=>timed.has(task.task_id)))};
  }
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
    const assignee=people.find(p=>p.actorId===task.assignee_id&&hasRequiredWarehouseRole(p.actorRoles,task.required_role));
    const development=task.task_kind.startsWith("development_");
    const technical=development||["bulk_pattern","bulk_cutting","bulk_cutting_external","process_logistics"].includes(task.task_kind);
    const missing=!assignee;
    const risk=["warning","overdue","blocked"].includes(kind);
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
      const allPeople=await this.people(client),context=acceptanceBusinessContext(),people=context?await Promise.all(allPeople.map(async p=>await context.acceptsActor(p.actorId)?p:null)).then(rows=>rows.filter((p):p is TrustedActorContext=>p!==null)):allPeople;
      const unified=await arrangementsAvailable(client);
      if ((await client.query("SELECT to_regclass('digital_development_documents') AS table_name")).rows[0]?.table_name) await projectDevelopmentNotices(client,people,businessNow(),id=>acceptanceIncludesNative(this.database,id));
      const scopeFilter=acceptanceClockReaderEnabled(this.database)?`${context?'AND EXISTS':'AND NOT EXISTS'}(SELECT 1 FROM digital_production_task_access a
        JOIN acceptance_sla_clock_resources m ON m.resource_kind=CASE WHEN a.production_order_id IS NULL THEN 'source' ELSE 'order' END
          AND m.resource_id=coalesce(a.production_order_id,a.source_id)
        WHERE a.task_id=i.task_id ${context?'AND m.scenario_id=$1':''})`:'';
      const intents=(await client.query(`SELECT i.* FROM digital_production_event_intents i
        WHERE NOT EXISTS(SELECT 1 FROM digital_production_notification_projection p WHERE p.event_id=i.event_id)
        ${scopeFilter} ORDER BY i.created_at,i.event_id LIMIT 200`,context?[context.scenarioId]:[])).rows;
      for(const intent of intents){
        const task=intent.task_id?(await client.query<Task>(`${TASKS} WHERE t.task_id=$1`,[intent.task_id])).rows[0]:undefined;
        if(task&&!await acceptanceIncludesNative(this.database,task.task_id))continue;
        if(task&&people.some(p=>p.actorId===task.assignee_id&&hasRequiredWarehouseRole(p.actorRoles,task.required_role))&&labels[intent.event_kind]&&task.lifecycle==="active"&&
          await this.currentTaskEvent(client,task,intent.event_id,intent.event_kind)&&
          (intent.event_kind!=="created"||(task.state==="pending"&&!task.assignee_id))){
          await this.notice(client,{key:`event:${intent.event_id}`,eventId:intent.event_id,taskId:task.task_id,kind:intent.event_kind},(await this.recipients(client,task,intent.event_kind,people)).map(p=>p.actorId));
        }
        await client.query("INSERT INTO digital_production_notification_projection(event_id) VALUES($1) ON CONFLICT DO NOTHING",[intent.event_id]);
      }
      const tasks=(await client.query<Task>(`${TASKS} WHERE ${ACTIVE}`)).rows;
      const preferences=await slaNotificationPreferences(client,tasks);
      for(const task of tasks){
        if(!await acceptanceIncludesNative(this.database,task.task_id))continue;
        // Repair an unassigned/disabled operator as an upstream routing task; never broadcast to all craftspeople.
        if(!(unified&&task.source_id&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind))&&!people.some(p=>p.actorId===task.assignee_id&&hasRequiredWarehouseRole(p.actorRoles,task.required_role)))
          await this.notice(client,{key:`missing:${task.task_id}:${task.assignee_id??'none'}`,taskId:task.task_id,kind:"created"},(await this.recipients(client,task,"created",people)).map(p=>p.actorId));
        const flags=preferences.get(task.task_id),noticeDue=slaNotificationDue(task,flags);
        if(task.state==="pending"&&!task.source_sla||!noticeDue)continue;
        const now=businessNow().getTime(),due=new Date(noticeDue).getTime(),kind=(task.source_sla&&!task.deadline_exclusive?due<now:due<=now)?"overdue":task.warning_at&&new Date(task.warning_at).getTime()<=now?"warning":null;
        if(kind==='warning'&&flags?.warning===false)continue;
        if(kind){
          const prior=task.source_sla?(await client.query(`SELECT n.source_key,r.entered_at,to_jsonb(r)->'sla_basis' AS sla_basis
            FROM digital_production_notification_events n JOIN digital_production_deadline_revisions r ON r.revision_id=n.deadline_revision_id
            WHERE n.task_id=$1 AND n.event_kind=$2 ORDER BY n.created_at,n.event_id`,[task.task_id,kind])).rows.find(row=>slaNotificationWindow(row)===slaNotificationWindow(task)):null;
          await this.notice(client,{key:prior?.source_key??`deadline:${task.task_id}:${task.revision_id}:${kind}`,taskId:task.task_id,kind,revision:task.revision_id},(await this.recipients(client,task,kind,people)).map(p=>p.actorId));
        }
      }
      for(const notice of await qcProgressNotices(client,people,undefined,this.database)){if(await acceptanceIncludesNative(this.database,notice.taskId))await this.notice(client,{key:notice.key,taskId:notice.taskId,kind:'qc_progress'},notice.recipients);}
      await this.projectChildren(client);
    });
  }
  private async projectChildren(client:PoolClient) {
    if(!(await client.query("SELECT to_regclass('rework_todos') AS relation")).rows[0]?.relation)return;
    const applied=!!(await client.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation;
    const rows=(await client.query(`SELECT t.*${applied?`,${effectiveSourcingDueSql('t')} AS due_at`:''} FROM rework_todos t JOIN digital_production_child_links l ON
      l.child_id=coalesce(nullif(t.route_descriptor->>'reworkOrderId',''),t.route_descriptor->>'entityId')::uuid
      AND l.module=CASE t.route_descriptor->>'routeName' WHEN 'sourcing_detail' THEN 'sourcing' WHEN 'production_detail' THEN 'production' WHEN 'pattern_room_order' THEN 'pattern_room' ELSE 'rework' END
      WHERE t.status IN ('pending','blocked_recipient')`)).rows;
    if((await client.query("SELECT to_regclass('digital_development_pattern_links') AS relation")).rows[0]?.relation){
      const development=(await client.query(`SELECT t.* FROM rework_todos t JOIN digital_development_pattern_links l
        ON t.route_descriptor->>'routeName'='pattern_room_order' AND t.route_descriptor->>'entityId'=l.order_id::text
        WHERE t.status IN ('pending','blocked_recipient')`)).rows;
      for(const row of development)if(!rows.some(existing=>existing.todo_id===row.todo_id))rows.push(row);
    }
    for(const row of rows){
      const nativeId=row.route_descriptor?.reworkOrderId??row.route_descriptor?.entityId;
      if(!nativeId||!await acceptanceIncludesNative(this.database,nativeId))continue;
      const context=acceptanceBusinessContext();if(context&&!await context.acceptsActor(row.recipient_user_id))continue;
      if(await hiddenNativeDevelopmentTodo(client,row.route_descriptor))continue;
      const kind=row.todo_type==="information"?"information":"ready";
      await this.notice(client,{key:`child:${row.source_event_id}:${row.todo_id}`,todoId:row.todo_id,kind,sourceEventId:row.source_event_id},[row.recipient_user_id]);
      if(row.todo_type!=="information"&&row.due_at&&new Date(row.due_at).getTime()<=businessNow().getTime()){
        const prior=(await client.query("SELECT source_key FROM digital_production_notification_events WHERE todo_id=$1 AND event_kind='overdue' ORDER BY created_at,event_id LIMIT 1",[row.todo_id])).rows[0];
        await this.notice(client,{key:prior?.source_key??`child-overdue:${row.todo_id}:${iso(row.due_at)}`,todoId:row.todo_id,kind:"overdue"},[row.recipient_user_id]);
      }
    }
  }
  async todos(actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]> {
    let targetSelected=false;
    if(projection?.todoId&&projection.select){const select=projection.select;projection={...projection,select:(key,load)=>{if(key.todoId===projection!.todoId)targetSelected=true;select(key,load);}};}
    const people=await this.people(this.database);
    if(!people.some(p=>p.actorId===actor.actorId))return [];
    const tasks=(await this.database.query<Task>(`${TASKS} WHERE ${ACTIVE}${projection?.todoId?' AND t.task_id=$1::uuid':''} ORDER BY d.due_at NULLS LAST,t.created_at,t.task_id`,...(projection?.todoId?[[projection.todoId]]:[]))).rows;
    const unified=await arrangementsAvailable(this.database);
    const result:TodoResponse[]=unified?[...await arrangementTodos(this.database,actor,projection),...await fabricDecisionTodos(this.database,actor,projection)]:[];
    result.push(...await shortLeadTodos(this.database,actor,projection));
    result.push(...await preparationWindowTodos(this.database,actor,projection),...await preparationMaterialsTodos(this.database,actor,projection),...await bulkFabricDecisionTodos(this.database,actor,projection),...await factoryProductionQcTodos(this.database,actor,new ContextBusinessClock(this.database),projection),...await garmentQualityTodos(this.database,actor,new ContextBusinessClock(this.database),projection));

    if(!projection?.todoId)result.push(...qcNoticesAsTodos(await qcProgressNotices(this.database,people),actor,projection));
    for(const task of tasks){
      const missing=!people.some(p=>p.actorId===task.assignee_id&&hasRequiredWarehouseRole(p.actorRoles,task.required_role));
      if(unified&&missing&&task.source_id&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind))continue;
      if(task.state==="pending"&&!missing)continue;
      if(!(await this.recipients(this.database,task,"ready",people)).some(p=>p.actorId===actor.actorId))continue;
      const readContext=async()=>{
      const ownAction=!missing&&await new DigitalProductionAccessPolicy(this.database).allowed(actor,"task",task.task_id,"execute");
      const styleNo=task.production_order_id?task.order_style_no:task.source_id?task.source_style_no:null;
      const readableAssignment=missing&&await new DigitalProductionAccessPolicy(this.database).allowed(actor,"task",task.task_id,"technical");
      const orderContext:TodoResponse['orderContext']=(ownAction||readableAssignment)&&styleNo?{reworkNo:null,orderNo:null,styleNo,supplierName:null,status:task.state,updatedAt:iso(task.created_at)}:null;
      if(orderContext&&readableAssignment){
        const linkedOrder=task.production_order_id??(task.source_id?(await this.database.query('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1',[task.source_id])).rows[0]?.production_order_id:null);
        // Source/task visibility alone does not reveal a linked mother's PO list.
        if(linkedOrder&&await new DigitalProductionAccessPolicy(this.database).allowed(actor,'order',linkedOrder,'technical'))orderContext.poNumbers=(await this.database.query('SELECT po_number FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position',[linkedOrder])).rows.flatMap(row=>row.po_number?[row.po_number as string]:[]);
      }
      const supplement=ownAction&&task.task_kind==='bulk_pattern'?await preparationSupplement(this.database,task.task_id):null;
       return {orderContext,supplement};
      };
      const metadata=projection?.select&&!projection.countOnly?await readContext():null;
      const build=async():Promise<TodoResponse>=>{const {orderContext,supplement}=metadata??await readContext();
      const time=await new ContextBusinessClock(this.database).read(task.production_order_id?{kind:'order',id:task.production_order_id}:{kind:'source',id:task.source_id!});
       return {... (supplement?{contentToken:todoContentToken(['preparation-supplement',task.task_id,supplement.version])}:{}),todoId:task.task_id,taskTitle:supplement?`${task.label} · ${supplement.ready?'补料已到，请复核补做':'局部已做，仍待补料'}`:task.label,todoType:missing?"recipient_routing_exception":"business_action",category:missing?"digital_assignment":"digital_task",sourceEventId:task.task_id,sourceAction:"digital_task",entityType:"digital_task",entityId:task.task_id,recipientUserId:actor.actorId,requiredRole:task.required_role,requiredCapability:null,route:{routeName:"digital_production_task",entityId:task.task_id,todoId:task.task_id,...(task.source_id?{developmentRound:task.route_version}:{})},policyKey:null,dueAt:task.due_at?iso(task.due_at):null,timing:todoSlaTiming({dueAt:task.due_at?iso(task.due_at):null,warningAt:task.warning_at?iso(task.warning_at):null,enteredAt:task.entered_at?iso(task.entered_at):null,exclusive:task.source_sla?(task.deadline_exclusive??false):false,asOf:time.now,unlimited:explicitlyUnlimitedSla(task.sla_basis)}),reminderCount:0,status:missing?"blocked_recipient":"pending",blockedReason:missing?"主办缺失或已失效，请重新分配":null,orderContext,unread:true,version:1,createdAt:iso(task.created_at),updatedAt:iso(task.created_at)};
      };
      if(projection?.select){
       const supplement=metadata?.supplement;
       const key:TodoSelectionKey={todoId:task.task_id,sourceAction:'digital_task',taskTitle:supplement?`${task.label} · ${supplement.ready?'补料已到，请复核补做':'局部已做，仍待补料'}`:task.label,category:missing?'digital_assignment':'digital_task',recipientUserId:actor.actorId,todoType:missing?'recipient_routing_exception':'business_action',route:{routeName:'digital_production_task',entityId:task.task_id,todoId:task.task_id,...(task.source_id?{developmentRound:task.route_version}:{})},dueAt:task.due_at?iso(task.due_at):null,status:missing?'blocked_recipient':'pending',createdAt:iso(task.created_at),orderContext:metadata?.orderContext??null,unread:true};
       projection.select(key,build);
      }else result.push(await build());
    }
    // Hashed QC-window IDs have no native row key. Resolve their windows only if
    // this single ID was not already found by the native/auxiliary providers.
    if(projection?.todoId&&!targetSelected)result.push(...qcNoticesAsTodos(await qcProgressNotices(this.database,people),actor,projection));
    return projection?.select?result:applyTodoReadState(this.database,actor,result);
  }
  async todoSelections(actor:TrustedActorContext,options:{metadata?:boolean;todoId?:string}={}){
    const selected:TodoSelection[]=[];await this.todos(actor,{countOnly:!options.metadata,...(options.todoId?{todoId:options.todoId}:{}),select:(key,load)=>selected.push({key,load})});
    const keys=await applyTodoReadState(this.database,actor,selected.map(item=>item.key));
    return selected.map((item,index)=>({key:keys[index]!,load:async()=>{const todo=await item.load(),key=keys[index]!;if(!key.contentToken)delete todo.contentToken;return {...todo,...(key.contentToken?{contentToken:key.contentToken}:{}),...(key.readAt===undefined?{}:{readAt:key.readAt}),...(key.unread===undefined?{}:{unread:key.unread})};}}));
  }
  async todoCounts(actor:TrustedActorContext){const rows=await this.todoSelections(actor);return {totalCount:rows.length,pendingCount:rows.length,unreadCount:rows.filter(row=>row.key.contentToken&&row.key.unread===true).length};}
  async todo(actor:TrustedActorContext,id:string){const selected=await this.todoSelections(actor,{todoId:id});return selected[0]?selected[0].load():null;}
  private async render(database:Database,actor:TrustedActorContext,event:{instruction_order_id?:string|null;development_source_id?:string|null;event_id:string;task_id:string|null;todo_id:string|null;event_kind:string;deadline_revision_id:string|null;created_at:Date;source_key?:string},people:TrustedActorContext[],includeContext=true,prepared?:NotificationTasks):Promise<DigitalNotification|null> {
    if(!people.some(p=>p.actorId===actor.actorId))return null;
    if(event.event_kind==='qc_progress'){
      const parent=(await database.query('SELECT production_order_id FROM digital_production_task_access WHERE task_id=$1',[event.task_id])).rows[0];
      if(!parent)return null;
      const notice=(await qcProgressNotices(database,people,parent.production_order_id,this.database)).find(n=>n.key===event.source_key&&n.recipients.includes(actor.actorId));
      if(!notice)return null;
      return {eventId:event.event_id,title:notice.title,actionable:true,route:notice.route,createdAt:iso(event.created_at),...(includeContext?{context:{styleNo:notice.styleNo,orderId:notice.orderId,colors:[],poNumbers:[]}}:{})};
    }
    let title:string,actionable:boolean,route:TodoRouteDescriptor;
    let contextTarget:{kind:"source"|"order";id:string}|null=null;
    let ownDevelopmentTask:Task|null=null;
    let ownPatternOrderId:string|null=null;
    let ownChildResource:{kind:"sourcing"|"production"|"rework";id:string}|null=null;
    let ownExternalResource:{kind:"case"|"batch";id:string}|null=null;
    let ownOrderTask:Task|null=null;
    if(event.instruction_order_id){
      if(!await new DigitalProductionAccessPolicy(database).allowed(actor,"order",event.instruction_order_id,"technical"))return null;
      const notice=(await database.query("SELECT title,version FROM digital_instruction_notices WHERE event_id=$1",[event.event_id])).rows[0];
      if(!notice)return null;
      contextTarget={kind:"order",id:event.instruction_order_id};
      title=notice.title;actionable=false;
      route={routeName:"digital_production_instruction",entityId:event.instruction_order_id,todoId:event.event_id,...(notice.version?{developmentRound:notice.version}:{})};
    }else if(event.development_source_id){
      if(!await new DigitalProductionAccessPolicy(database).allowed(actor,"source",event.development_source_id,"technical"))return null;
      const notice=(await database.query("SELECT title,to_jsonb(d)->>'material_id' AS material_id,COALESCE((to_jsonb(d)->>'round_number')::integer,1) AS round_number FROM digital_development_notices d WHERE event_id=$1",[event.event_id])).rows[0];
      if(!notice)return null;
      if (notice.material_id) {
        const current = await developmentDocumentRow(database,event.development_source_id);
        if (!current || (current.round_number??1) !== notice.round_number) return null;
        const document = await effectiveVerificationDocument(database,event.development_source_id,notice.round_number,current.document);
        if (!document.materials.some(m=>m.materialId===notice.material_id&&m.requiredThisRound)
          || (await receivedDevelopmentAccessories(database,event.development_source_id,notice.round_number,document)).has(notice.material_id)) return null;
      }
      contextTarget={kind:"source",id:event.development_source_id};
      title=notice.title;actionable=false;
      route={routeName:"digital_development",entityId:event.development_source_id,todoId:event.event_id,developmentRound:notice.round_number};
    }else if(event.task_id){
      const task=prepared?prepared.tasks.get(event.task_id):(await database.query<Task>(`${TASKS} WHERE t.task_id=$1`,[event.task_id])).rows[0];
      if(!task||task.lifecycle!=="active")return null;
      if(!await this.currentTaskEvent(database,task,event.event_id,event.event_kind))return null;
      if(event.deadline_revision_id&&String(event.deadline_revision_id)!==String(task.revision_id)){
        const prior=task.source_sla?(await database.query("SELECT entered_at,to_jsonb(r)->'sla_basis' AS sla_basis FROM digital_production_deadline_revisions r WHERE revision_id=$1 AND task_id=$2",[event.deadline_revision_id,task.task_id])).rows[0]:null;
        if(!prior||slaNotificationWindow(prior)!==slaNotificationWindow(task))return null;
      }
      const taskTime=await new ContextBusinessClock(this.database).read(task.production_order_id?{kind:'order',id:task.production_order_id}:{kind:'source',id:task.source_id!});
      const timed=['warning','overdue'].includes(event.event_kind),flags=timed?(prepared?.preferences??await slaNotificationPreferences(database,[task])).get(task.task_id):undefined,noticeDue=slaNotificationDue(task,flags);
      if(timed&&task.task_kind==='bulk_ship_sample'&&!noticeDue)return null;
      if(event.event_kind==='warning'&&flags?.warning===false)return null;
      if(event.event_kind==="warning"&&noticeDue&&(task.source_sla&&!task.deadline_exclusive?new Date(noticeDue).getTime()<Date.parse(taskTime.now):new Date(noticeDue).getTime()<=Date.parse(taskTime.now)))return null;
      if(event.event_kind==='warning'&&(!task.warning_at||Date.parse(taskTime.now)<new Date(task.warning_at).getTime()))return null;
      if(event.event_kind==='overdue'&&(!noticeDue||(task.source_sla&&!task.deadline_exclusive?Date.parse(taskTime.now)<=new Date(noticeDue).getTime():Date.parse(taskTime.now)<new Date(noticeDue).getTime())))return null;
      const missing=!people.some(p=>p.actorId===task.assignee_id&&hasRequiredWarehouseRole(p.actorRoles,task.required_role));
      if(event.event_kind==="created"&&(!missing||task.source_id&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind)&&await arrangementsAvailable(database)))return null;
      if(!(await this.recipients(database,task,event.event_kind,people)).some(p=>p.actorId===actor.actorId))return null;
      actionable=event.event_kind!=="completed"&&(missing||await new DigitalProductionAccessPolicy(database).allowed(actor,"task",task.task_id,"execute"));
      if(actionable&&!missing&&task.source_id&&task.task_kind.startsWith("development_"))ownDevelopmentTask=task;
      if(actionable&&!missing&&task.production_order_id)ownOrderTask=task;
      title=`${task.label} · ${missing?"待分配主办":labels[event.event_kind]??"事项更新"}`;
      contextTarget=task.production_order_id?{kind:"order",id:task.production_order_id}:task.source_id?{kind:"source",id:task.source_id}:null;
      route=missing&&task.source_id&&(DEVELOPMENT_ARRANGEABLE_KINDS as readonly string[]).includes(task.task_kind)&&await arrangementsAvailable(database)?{routeName:"digital_development_arrangement",entityId:task.source_id,todoId:task.task_id,developmentRound:(task as Task & {route_version:number}).route_version}:{routeName:"digital_production_task",entityId:task.task_id,todoId:task.task_id};
    }else{
      const row=(await database.query("SELECT * FROM rework_todos WHERE todo_id=$1 AND recipient_user_id=$2 AND status IN ('pending','blocked_recipient')",[event.todo_id,actor.actorId])).rows[0];
      if(!row||await hiddenNativeDevelopmentTodo(database,row.route_descriptor))return null;
      const parent=await digitalTodoTarget(database,row.route_descriptor);
      if(!parent)return null;
      if(event.event_kind==='overdue'){
        const applied=row.entity_type==='sourcing_case'&&!!(await database.query("SELECT to_regclass('digital_sla_order_snapshots') AS relation")).rows[0]?.relation;
        const due=applied?(await database.query(`SELECT ${effectiveSourcingDueSql('t')} AS due_at FROM rework_todos t WHERE t.todo_id=$1`,[row.todo_id])).rows[0]?.due_at:row.due_at;
        const time=await new ContextBusinessClock(this.database).read(parent);
        if(!due||new Date(due).getTime()>Date.parse(time.now))return null;
      }
      if(row.todo_type==="information"&&!isRootActor(actor)&&!await new DigitalProductionAccessPolicy(database).allowed(people.find(p=>p.actorId===actor.actorId)!,parent.kind,parent.id,"technical"))return null;
      if(row.required_role&&!await new DigitalProductionAccessPolicy(database).activeRole(actor.actorId,row.required_role))return null;
      if(row.required_capability&&!(actor.authorizationCapabilities??[]).includes(row.required_capability))return null;
      actionable=row.todo_type!=="information";title=actionable?(event.event_kind==="overdue"?"订单待办已超时":"你有新的订单待办"):"订单事项已更新";
      contextTarget=parent;
      route=row.route_descriptor;
      if(actionable&&route.routeName==="pattern_room_order"&&row.required_role==="pattern_room_worker")ownPatternOrderId=route.entityId;
      // Bind personal business context to its original route. The child reader below
      // must still authorize that exact object before its identity can be projected.
      if(row.todo_type==="business_action"&&(row.required_role||row.required_capability)){
        if(route.routeName==="sourcing_detail"&&row.entity_type==="sourcing_case"){
          if(row.entity_id!==route.entityId)return null;
          ownChildResource={kind:"sourcing",id:route.entityId};
        }else if(route.routeName==="production_detail"&&["production_order","sourcing_production_order"].includes(row.entity_type)){
          if(row.entity_id!==route.entityId)return null;
          ownChildResource={kind:"production",id:route.entityId};
        }else if(route.reworkOrderId||["rework_detail","process_configuration","whole_order_review","responsibility_detail","own_factory_approval"].includes(route.routeName)){
          const childId=route.reworkOrderId??route.entityId;
          const bindings:Record<string,string>={
            rework_tail_inspection_assignment:"SELECT rework_order_id FROM rework_tail_inspection_assignments WHERE tail_inspection_assignment_id::text=$1",
            own_factory_approval:"SELECT rework_order_id FROM rework_own_factory_approvals WHERE approval_id::text=$1",
            external_responsibility_case:"SELECT rework_order_id FROM rework_external_responsibility_cases WHERE case_id::text=$1",
            responsibility_determination:"SELECT rework_order_id FROM rework_responsibility_determinations WHERE determination_id::text=$1",
          };
          if(row.entity_type==="rework_order"||Object.hasOwn(bindings,row.entity_type)){
            const boundId=row.entity_type==="rework_order"?row.entity_id:(await database.query(bindings[row.entity_type]!,[row.entity_id])).rows[0]?.rework_order_id;
            if(boundId!==childId)return null;
            ownChildResource={kind:"rework",id:childId};
          }
        }
        if(route.routeName==="external_responsibility_detail"){
          if(ownChildResource?.kind!=="rework")return null;
          if(row.entity_type==="external_responsibility_case"&&row.entity_id!==route.entityId)return null;
          // Allocation routes identify a batch; all other existing routes identify a case.
          ownExternalResource={kind:route.tab==="external_responsibility"?"batch":"case",id:route.entityId};
        }
      }
    }
    let context:DigitalNotification["context"];
    const parentReadable=contextTarget&&(includeContext||ownChildResource)&&await new DigitalProductionAccessPolicy(database).allowed(actor,contextTarget.kind,contextTarget.id,"technical");
    if(includeContext&&contextTarget&&parentReadable){
      const resource=(await database.query(contextTarget.kind==='order'?"SELECT design_style_no,production_order_id FROM digital_production_orders WHERE production_order_id=$1":"SELECT design_style_no,NULL::uuid AS production_order_id FROM digital_production_sources WHERE source_id=$1",[contextTarget.id])).rows[0];
      if(resource){
        const lines=resource.production_order_id?(await database.query("SELECT po_number,color FROM digital_production_po_lines WHERE production_order_id=$1 ORDER BY position",[resource.production_order_id])).rows:[];
        context={styleNo:resource.design_style_no??null,orderId:resource.production_order_id??null,colors:[...new Set<string>(lines.map(l=>l.color))],poNumbers:[...new Set<string>(lines.map(l=>l.po_number).filter(Boolean))]};
      }
    }
    // A valid own task can identify itself without granting source/order technical access.
    // Project only its style; never use this fallback to enumerate parent PO lines or data.
    if(includeContext&&!context&&ownDevelopmentTask){
      const resource=(await database.query(`SELECT s.design_style_no FROM digital_production_task_access a
        JOIN digital_production_tasks t USING(task_id) JOIN digital_production_sources s USING(source_id)
        WHERE a.task_id=$1 AND a.source_id=$2 AND t.state IN ('ready','blocked')`,[ownDevelopmentTask.task_id,ownDevelopmentTask.source_id])).rows[0];
      if(resource)context={styleNo:resource.design_style_no??null,orderId:null,colors:[],poNumbers:[]};
    }
    if(includeContext&&!context&&ownPatternOrderId&&contextTarget){
      const resource=(await database.query(`SELECT orders.style_no FROM pattern_room_orders orders
        WHERE ${patternOrderScopeSql} AND orders.order_id=$5 AND orders.status='in_progress'
        AND todo_user_has_direct_role($1,'pattern_room_worker','pattern_room:orders:view')
        AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle
          WHERE resource_kind=$6 AND resource_id=$7 AND state<>'active')`,
      [actor.actorId,false,["pattern_room_worker"],true,ownPatternOrderId,contextTarget.kind,contextTarget.id])).rows[0];
      if(resource)context={styleNo:resource.style_no,orderId:null,colors:[],poNumbers:[]};
    }
    if(ownChildResource&&contextTarget&&(!parentReadable||ownExternalResource)){
      if((await database.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE resource_kind=$1 AND resource_id=$2 AND state<>'active'",[contextTarget.kind,contextTarget.id])).rowCount)return null;
      // These read-only entry methods use query only. Bind them to the current
      // transaction client so a claim never borrows another pool connection.
      const childDatabase={query:database.query.bind(database)} as Pool;
      let styleNo:string|null=null;
      try{
        if(ownExternalResource){
          const external=new ExternalResponsibilityService(childDatabase);
          if(ownExternalResource.kind==="case"){
            const target=await external.getCase(actor,ownExternalResource.id,childDatabase);
            if(target.reworkOrderId!==ownChildResource.id)return null;
          }else{
            const target=await external.get(actor,ownChildResource.id,childDatabase);
            if(!target||target.batchId!==ownExternalResource.id||target.reworkOrderId!==ownChildResource.id)return null;
          }
        }
        if(!parentReadable){
          if(ownChildResource.kind==="sourcing")styleNo=(await new SourcingService(childDatabase).getCase({...actor,authorizationCapability:"sourcing:view"},ownChildResource.id)).styleNo;
          else if(ownChildResource.kind==="production")styleNo=(await new SourcingProductionService(childDatabase).get(actor,ownChildResource.id)).firstStyleNo;
          else {
            const child=await new ReworkBusinessDetailService(childDatabase).get(actor,ownChildResource.id);
            if(["cancelled","deleted"].includes(child.status))return null;
            styleNo=child.styleNo;
          }
        }
      }catch(error){
        if(error instanceof ApplicationError&&[403,404].includes(error.statusCode))return null;
        throw error;
      }
      if(includeContext&&styleNo)context={styleNo,orderId:null,colors:[],poNumbers:[]};
    }
    if(includeContext&&!context&&ownOrderTask?.order_style_no)context={styleNo:ownOrderTask.order_style_no,orderId:null,colors:[],poNumbers:[]};
    return {eventId:event.event_id,title,actionable,route,createdAt:iso(event.created_at),...(context?{context}:{})};
  }
  // Atomic claim per recipient is the incremental cursor: refreshes and competing
  // tabs consume only unseen events. Acknowledgement is a separate receipt field.
  async claim(actor:TrustedActorContext,includeRemaining=false):Promise<{notification:DigitalNotification|null;remainingCount?:number}> {
    const result=await this.transaction(async client=>{
      const allPeople=await this.people(client),context=acceptanceBusinessContext(),people=context?await Promise.all(allPeople.map(async p=>await context.acceptsActor(p.actorId)?p:null)).then(rows=>rows.filter((p):p is TrustedActorContext=>p!==null)):allPeople;
      const events=(await client.query(`SELECT e.* FROM digital_production_notification_receipts r JOIN digital_production_notification_events e USING(event_id)
        WHERE r.recipient_id=$1 AND r.shown_at IS NULL ORDER BY e.created_at,e.event_id LIMIT 100 FOR UPDATE OF r SKIP LOCKED`,[actor.actorId])).rows;
      const prepared=await this.notificationTasks(client,events);
      for(const event of events){
        const notification=await this.render(client,actor,event,people,true,prepared);
        await client.query("UPDATE digital_production_notification_receipts SET shown_at=CURRENT_TIMESTAMP WHERE event_id=$1 AND recipient_id=$2 AND shown_at IS NULL",[event.event_id,actor.actorId]);
        if(notification)return {notification};
      }
      return {notification:null};
    });
    // Counting uses the same validity and permissions after the claim lock is released.
    return includeRemaining?{...result,remainingCount:await this.remaining(actor)}:result;
  }
  private async remaining(actor:TrustedActorContext){
    const people=await this.people(this.database);
    const events=(await this.database.query(`SELECT e.* FROM digital_production_notification_receipts r JOIN digital_production_notification_events e USING(event_id)
      WHERE r.recipient_id=$1 AND r.shown_at IS NULL AND r.acknowledged_at IS NULL`,[actor.actorId])).rows;
    const prepared=await this.notificationTasks(this.database,events);
    let count=0;for(const event of events)if(await this.render(this.database,actor,event,people,false,prepared))count++;
    return count;
  }
  async acknowledge(actor:TrustedActorContext,eventId:string) {
    await this.database.query("UPDATE digital_production_notification_receipts SET acknowledged_at=coalesce(acknowledged_at,CURRENT_TIMESTAMP) WHERE event_id=$1 AND recipient_id=$2 AND shown_at IS NOT NULL",[eventId,actor.actorId]);
    return {ok:true};
  }
  async current(actor:TrustedActorContext,eventId:string,includeRemaining=false) {
    const event=(await this.database.query(`SELECT e.* FROM digital_production_notification_events e JOIN digital_production_notification_receipts r USING(event_id) WHERE e.event_id=$1 AND r.recipient_id=$2 AND r.shown_at IS NOT NULL AND r.acknowledged_at IS NULL`,[eventId,actor.actorId])).rows[0];
    return {notification:event?await this.render(this.database,actor,event,await this.people(this.database)):null,...(includeRemaining?{remainingCount:await this.remaining(actor)}:{})};
  }
}
