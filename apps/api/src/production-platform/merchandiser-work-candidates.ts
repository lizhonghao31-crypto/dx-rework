import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {isRootActor} from '../access/business-authority.js';

type NativeWork=Pick<TodoResponse,'todoId'|'route'|'category'|'requiredRole'|'recipientUserId'|'todoType'|'status'|'dueAt'|'taskTitle'>;
type WorkKind='preparation'|'commercial'|'sourcing'|'delivery'|'exceptions';
type Candidate={itemId:string;kind:WorkKind;title:string;route:TodoResponse['route'];dueAt:string|null};

const nativeIntents=[
 {category:'digital_material_investment',route:'digital_source_material_investment',kind:'preparation'},
 {category:'digital_material_investment',route:'digital_order_material_investment',kind:'preparation'},
 {category:'digital_preparation_instruction',route:'digital_production_instruction',kind:'commercial'},
 {category:'sourcing_merchandiser_correction',route:'sourcing_detail',kind:'sourcing'},
 {category:'sourcing_contract_return',route:'sourcing_detail',kind:'sourcing'},
] as const;

/** Only after the original provider authorizes the item. A module/route
 * alone does not make the task a merchandiser action. In particular, a
 * multifunction user still opens each entry in its original business role. */
export function merchandiserWorkCandidate(actor:TrustedActorContext,item:NativeWork):Candidate|null{
 if((!isRootActor(actor)&&!actor.actorRoles.includes('order_merchandiser'))||item.recipientUserId!==actor.actorId||
  item.requiredRole!=='order_merchandiser'||item.todoType!=='business_action'||item.status!=='pending'||
  item.route.todoId!==item.todoId)return null;
 const intent=nativeIntents.find(row=>row.category===item.category&&row.route===item.route.routeName);
 if(item.category==='sourcing_contract_return'&&item.route.tab!=='contract_return')return null;
 return intent?{itemId:item.todoId,kind:intent.kind,title:item.taskTitle,route:item.route,dueAt:item.dueAt}:null;
}
