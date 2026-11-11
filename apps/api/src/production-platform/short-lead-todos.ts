import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import type {Pool} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {todoContentToken} from '../todos/content-reads.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {ShortLeadService} from './short-lead-service.js';
import {shortLeadAvailable} from './short-lead-evidence.js';
import {acceptsNewOrderTime} from './order-time-admission.js';
import {acceptanceIncludesNative} from '../acceptance-clock/business-time.js';
/** Project the original request/decision/consumption records into the existing personal provider. */
export async function shortLeadTodos(database:Pool,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(await acceptsNewOrderTime(database))return [];
 if(!await shortLeadAvailable(database))return [];const policy=new DigitalProductionAccessPolicy(database),boss=isRootActor(actor)||actor.actorRoles.includes('owner_group')&&await policy.activeRole(actor.actorId,'owner_group'),designer=actor.actorRoles.includes('sample_designer')&&await policy.activeRole(actor.actorId,'sample_designer');if(!boss&&!designer)return [];
 const sources=(await database.query(`SELECT DISTINCT r.source_id FROM digital_short_lead_requests r LEFT JOIN digital_short_lead_decisions d USING(request_id) LEFT JOIN digital_short_lead_consumptions c USING(request_id) WHERE r.source_id IS NOT NULL AND c.request_id IS NULL AND (d.approved IS NULL OR d.approved) AND ($1::boolean OR r.requested_by=$2) AND ($3::uuid IS NULL OR r.request_id=$3)`,[boss,actor.actorId,projection?.todoId??null])).rows;
 const result:TodoResponse[]=[],service=new ShortLeadService(database);
 for(const source of sources){if(!await acceptanceIncludesNative(database,source.source_id)||!await policy.allowed(actor,'source',source.source_id,'technical'))continue;const state=await service.read(actor,source.source_id);for(const request of state.requests){if(request.consumedOrderId||request.decision?.approved===false)continue;const approval=boss&&state.canApprove&&request.canDecide===true&&!request.decision,confirmation=designer&&request.requestedBy===actor.actorId&&request.decision?.approved;if(!approval&&!confirmation)continue;if(approval&&request.staleReason)continue;const at=request.decision?.decidedAt??request.requestedAt,title=approval?'审批本次短交期正式单特批':request.staleReason?'回原单核对短交期资料并重新申请':'已获老板特批，回原单正式确认';
  const selectionKey:TodoSelectionKey={todoId:request.requestId,contentToken:todoContentToken(['short-lead',request.requestId,request.decision,request.staleReason,request.currentDocumentVersion]),taskTitle:title,todoType:'business_action',category:approval?'digital_short_lead_approval':'digital_short_lead_confirmation',sourceAction:'short_lead',recipientUserId:actor.actorId,route:{routeName:'digital_short_lead',entityId:source.source_id,todoId:request.requestId},dueAt:null,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:request.designStyleNo,supplierName:null,status:title,updatedAt:at,poNumbers:request.facts.lines.flatMap(line=>line.formalPoNo?[line.formalPoNo]:[])},unread:true,createdAt:request.requestedAt};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:request.requestId,entityType:'digital_development',entityId:source.source_id,requiredRole:approval?'owner_group':'sample_designer',requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:1,updatedAt:at}));
 }}return result;
}
