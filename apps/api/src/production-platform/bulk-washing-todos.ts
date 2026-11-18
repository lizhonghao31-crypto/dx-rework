import {createHash} from 'node:crypto';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {appendSelectedTodo,type TodoProjection,type TodoSelectionKey} from '../todos/selection.js';
import {todoContentToken} from '../todos/content-reads.js';
import {acceptanceIncludesNative} from '../acceptance-clock/business-time.js';
import {wholeOrderActiveSql} from './whole-order-visibility.js';
import {bulkWashingInstalled} from './bulk-washing-coverage.js';
import {readBulkWashing} from './bulk-washing-service.js';
import type {WashingDB} from './bulk-washing-repository.js';
const idFor=(key:string)=>{const h=createHash('sha256').update(key).digest('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-5${h.slice(13,16)}-a${h.slice(17,20)}-${h.slice(20,32)}`;};
/** Native washing assignments and effective quantities are the todo source.
 * No synthetic receipt/task-completion or second responsibility clock. */
export async function bulkWashingTodos(db:WashingDB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!actor.actorRoles.some(r=>['embroidery_washing_merchandiser','quality_control'].includes(r))||!await bulkWashingInstalled(db))return [];
 const orders=(await db.query(`SELECT DISTINCT o.production_order_id,o.design_style_no FROM digital_bulk_washing_plans p JOIN digital_production_orders o USING(production_order_id)
  WHERE (p.document->'staff'->>'logisticsId'=$1 OR p.document->'staff'->>'inspectorId'=$1)
   AND ${await wholeOrderActiveSql(db,'order','o.production_order_id')} AND ${await wholeOrderActiveSql(db,'source','o.source_id')}
   AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=o.production_order_id)
   AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE l.state<>'active' AND (l.resource_kind='order' AND l.resource_id=o.production_order_id OR l.resource_kind='source' AND l.resource_id=o.source_id))`,[actor.actorId])).rows;
 const result:TodoResponse[]=[];
 for(const order of orders){
  if(!await acceptanceIncludesNative(db,order.production_order_id))continue;
  const sheet=await readBulkWashing(db,order.production_order_id,actor,undefined,{includeFees:false});
  for(const scope of sheet.scopes){
   const live=scope.facts.filter(f=>!f.voided),pendingChecks=live.filter(f=>['return','factory_complete'].includes(f.kind)&&!live.some(q=>q.kind==='inspection'&&q.completionId===f.id));
   const candidates:Array<{key:string;label:string;due:string|null;role:string}>=[];
   const uncheckedLinks=scope.mode==='factory'&&scope.receipts?.some(r=>live.filter(f=>f.kind==='receipt_link'&&f.receiptId===r.receiptId&&f.receiptQuantityVersion===r.quantityVersion).reduce((n,f)=>n+f.quantity,0)<r.quantity);
   const rework=scope.ledger.rework,pendingRework=Boolean(rework&&(rework.available.length||rework.sent>rework.washed));
   if(scope.canLogistics&&(scope.ledger.conflict||scope.ledger.washed<scope.quantity||uncheckedLinks||pendingRework))candidates.push({key:'logistics',label:scope.ledger.conflict?'核对洗水批次范围':uncheckedLinks?'关联工厂洗水与本批收货':pendingRework?'办理不合格返洗':'办理大货洗水发收',due:scope.windows.filter(w=>w.kind==='washing'&&w.state==='active'&&w.dueAt).map(w=>w.dueAt!).sort()[0]??null,role:'embroidery_washing_merchandiser'});
   if(scope.canInspect)for(const check of pendingChecks)candidates.push({key:`qc:${check.id}`,label:'办理大货洗后检查',due:scope.windows.find(w=>w.id===`${check.id}:qc`)?.dueAt??null,role:'quality_control'});
   for(const candidate of candidates){
    const todoId=idFor(`bulk-washing:${scope.planId}:${scope.scopeId}:${candidate.key}`);if(projection?.todoId&&projection.todoId!==todoId)continue;
    const at=scope.facts.at(-1)?.recordedAt??scope.availableAt;if(!at)continue;
    const token=todoContentToken([todoId,scope.quantityVersion,String(scope.revision)]);
    const selected:TodoSelectionKey={todoId,contentToken:token,taskTitle:candidate.label,todoType:'business_action',category:'digital_bulk_washing',sourceAction:'bulk_washing',recipientUserId:actor.actorId,
     route:{routeName:'digital_bulk_washing',entityId:order.production_order_id,todoId},dueAt:candidate.due,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:order.design_style_no,supplierName:null,status:`${scope.label} · ${candidate.label}`,updatedAt:at},unread:true,createdAt:at};
    appendSelectedTodo(result,projection,selected,()=>({...selected,sourceEventId:todoId,entityType:'digital_production_order',entityId:order.production_order_id,requiredRole:candidate.role,requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:null,version:scope.revision+1,updatedAt:at}));
   }
  }
 }
 return result;
}
