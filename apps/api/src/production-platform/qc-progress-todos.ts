import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import {memberCanWriteModule} from '../access/member-module-policy.js';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse,TodoRouteDescriptor} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {acceptanceIncludesNative,ContextBusinessClock} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {readQcExecutionEvidenceForOrders} from './qc-progress-evidence.js';
import {todoContentToken} from '../todos/content-reads.js';
type DB=Pick<Pool|PoolClient,'query'>;
export const qcNoticeId=(key:string)=>{const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-4${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
export type QcProgressNotice={key:string;orderId:string;taskId:string;title:string;recipients:string[];blockedReason:string|null;dueAt:string;createdAt:string;route:TodoRouteDescriptor;styleNo:string;supplierName:string;lineIds:string[]};
/** Single source for current todos, server projection and delivery-time revalidation. */
export async function qcProgressNotices(db:DB,people:TrustedActorContext[],onlyOrder?:string,database:Pool=db as Pool):Promise<QcProgressNotice[]>{
 if(!(await db.query("SELECT to_regclass('digital_qc_tracking_starts') AS relation")).rows[0]?.relation)return [];
 const orders=(await db.query(`SELECT o.production_order_id,o.primary_merchandiser_id,o.design_style_no,a.task_id,a.assignee_id FROM digital_production_orders o
 JOIN digital_production_task_access a ON a.production_order_id=o.production_order_id AND a.task_kind='factory_production_qc'
 JOIN digital_production_tasks t USING(task_id) WHERE t.state<>'cancelled' AND ($1::uuid IS NULL OR o.production_order_id=$1)
 AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)
 AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE (l.resource_kind='order' AND l.resource_id=o.production_order_id OR l.resource_kind='source' AND l.resource_id=o.source_id) AND l.state<>'active')`,[onlyOrder??null])).rows;
 const scoped:typeof orders=[];
 for(const order of orders)if(await acceptanceIncludesNative(database,order.task_id))scoped.push(order);
 if(!scoped.length)return [];
 const ids=[...new Set<string>(scoped.map(order=>order.production_order_id))];
 const settings=(await db.query<{production_order_id:string;quality_lead_id:string|null}>(`SELECT DISTINCT ON(production_order_id) production_order_id,quality_lead_id
  FROM digital_qc_supervision_settings WHERE production_order_id=ANY($1::uuid[]) ORDER BY production_order_id,version DESC`,[ids])).rows;
 const leads=new Map(settings.map(setting=>[setting.production_order_id,setting.quality_lead_id]));
 const clock=new ContextBusinessClock(database,db===database?undefined:db as PoolClient),observations=[];
 for(const orderId of ids)observations.push({orderId,asOf:(await clock.read({kind:'order',id:orderId})).now});
 const projected=await readQcExecutionEvidenceForOrders(db,observations);
 const evidenceByOrder=new Map(ids.map((id,index)=>[id,projected[index]!]));
 const result:QcProgressNotice[]=[],policy=new DigitalProductionAccessPolicy(db);
 for(const order of scoped){
  const eligible=async(id:string|null,role:string)=>{const person=people.find(p=>p.actorId===id&&p.actorRoles.includes(role));return person&&await memberCanWriteModule(db,person.actorId,'sourcing')&&await policy.activeRole(person.actorId,role)&&await policy.allowed(person,'order',order.production_order_id,'technical')?person.actorId:null;};
  const qc=await eligible(order.assignee_id,'quality_control'),lead=await eligible(leads.get(order.production_order_id)??null,'quality_control'),primary=await eligible(order.primary_merchandiser_id,'order_merchandiser');
  const managers:string[]=[];
  for(const p of people)if(p.actorRoles.some(r=>['production_management','owner_group'].includes(r))&&await memberCanWriteModule(db,p.actorId,'sourcing')&&await policy.allowed(p,'order',order.production_order_id,'technical'))managers.push(p.actorId);
  for(const evidence of evidenceByOrder.get(order.production_order_id)??[]){
   if(evidence.finished)continue;
   for(const window of evidence.windows){const clock=window.clock;if(!clock.anchor||!clock.remindAt||!clock.escalateAt)continue;
    const add=(suffix:string,title:string,recipients:string[],due:string,blockedReason:string|null=null)=>{
     const key=`qc-progress:${evidence.tracking?.tracking_id}:${window.key}:${suffix}`,todoId=qcNoticeId(key);
     result.push({key,orderId:order.production_order_id,taskId:order.task_id,title,recipients:[...new Set(recipients)],blockedReason,dueAt:due,createdAt:clock.anchor!,route:{routeName:'digital_factory_progress',entityId:order.production_order_id,todoId,...(evidence.group.rows[0].factory_decision_id?{factoryDecisionId:evidence.group.rows[0].factory_decision_id}:{})},styleNo:order.design_style_no,supplierName:evidence.group.rows[0].supplier_name_snapshot,lineIds:window.lineIds});
    };
    const escalated=clock.state==='escalated',due=['due','escalated'].includes(clock.state),escalation=[lead,primary].filter((id):id is string=>Boolean(id));
    if(!qc)add('missing-qc','生产进度待指派QC',managers,clock.remindAt,'QC主办缺失或已失效；计时保留，请从原任务指派');
    if(due&&qc&&!(escalated&&escalation.includes(qc)))add('48','QC生产进度已到48小时更新点',[qc],clock.remindAt);
    if(escalated){if(escalation.length)add('72','生产进度72小时未更新，请跟进',escalation,clock.escalateAt);
     if(!lead||!primary)add('missing-escalation','生产进度升级接收人待补齐',managers,clock.escalateAt,[!lead?'质检负责人未指定或失效':'',!primary?'主跟单缺失或失效':''].filter(Boolean).join('；'));
    }
   }
  }
 }
 return result;
}
export function qcNoticesAsTodos(notices:QcProgressNotice[],actor:TrustedActorContext,projection?:TodoProjection):TodoResponse[]{
 const result:TodoResponse[]=[];for(const n of notices.filter(n=>n.recipients.includes(actor.actorId))){
  const selectionKey:TodoSelectionKey={todoId:n.route.todoId,contentToken:todoContentToken([n.key,...n.lineIds]),taskTitle:n.title,todoType:n.blockedReason?'recipient_routing_exception':'business_action',category:'digital_qc_progress',sourceAction:'digital_qc_progress',recipientUserId:actor.actorId,route:n.route,dueAt:n.dueAt,status:n.blockedReason?'blocked_recipient':'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:n.styleNo,supplierName:n.supplierName,status:n.title,updatedAt:n.createdAt},unread:true,createdAt:n.createdAt};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:n.route.todoId,entityType:'digital_production_order',entityId:n.orderId,requiredRole:null,requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:n.blockedReason,version:1,updatedAt:n.createdAt}));
 }return result;
}
