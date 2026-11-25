import type {Pool} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {DigitalNotification} from '@dx-rework/contracts/digital-production-notifications';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';
import {appendSelectedTodo,type TodoProjection,type TodoSelectionKey} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import {secondaryCraftDirectory} from './secondary-craft-quotation.js';

export async function secondaryCraftApprovalTodos(db:Pick<Pool,'query'>,actor:TrustedActorContext,projection?:TodoProjection){
 const root=isRootActor(actor);
 if(!root&&!actor.actorRoles.includes('owner_group'))return [];
 const result:TodoResponse[]=[];
 const directory=await secondaryCraftDirectory(db,actor,new Set(root?[]:['owner_group']));
 for(const item of directory.items){
  const todoId=item.approvalTodoId,at=item.submittedAt;
  if(!todoId||!at||projection?.todoId&&projection.todoId!==todoId)continue;
  const route={routeName:item.resource.kind==='order'?'digital_secondary_craft_order' as const:'digital_secondary_craft_source' as const,
   entityId:item.resource.id,todoId,craftRowId:item.rowId};
  const selected:TodoSelectionKey={todoId,contentToken:todoContentToken(['secondary-craft-approval',todoId]),taskTitle:`审批${item.label}报价 v${item.version}`,
   todoType:'business_action',category:'digital_secondary_craft_approval',sourceAction:'secondary_craft_approval',
   recipientUserId:actor.actorId,route,dueAt:null,status:'pending',
   orderContext:{reworkNo:null,orderNo:null,styleNo:item.styleNo,supplierName:item.supplier?.name??null,status:'待审批',updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selected,()=>({...selected,sourceEventId:todoId,entityType:'secondary_craft_quotation',
   entityId:item.rowId,requiredRole:root?'root_superuser':'owner_group',requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:item.version,updatedAt:at}),{sourceId:item.resource.kind==='source'?item.resource.id:null,orderId:item.resource.kind==='order'?item.resource.id:null});
 }
 return result;
}

export async function secondaryCraftApprovalNotification(db:Pick<Pool,'query'>,actor:TrustedActorContext,event:{event_id:string;todo_id:string|null;created_at:Date}):Promise<DigitalNotification|null>{
 if(!event.todo_id)return null;
 const [todo]=await secondaryCraftApprovalTodos(db,actor,{todoId:event.todo_id});
 return todo?{eventId:event.event_id,title:todo.taskTitle!,actionable:true,route:todo.route,createdAt:event.created_at.toISOString()}:null;
}
