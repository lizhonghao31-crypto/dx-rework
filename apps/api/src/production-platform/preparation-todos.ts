import {appendSelectedTodo,type TodoSelectionKey,type TodoProjection} from '../todos/selection.js';
import type {Pool,PoolClient} from 'pg';
import type {TodoResponse} from '@dx-rework/contracts';
import type {TrustedActorContext} from '../tools/repositories.js';
import {acceptanceIncludesNative,businessNow} from '../acceptance-clock/business-time.js';
import {DigitalProductionAccessPolicy} from './access-policy.js';
import {preparationAvailable,preparationIso,preparationContext,preparationMaterialHistory,currentPreparationMaterials,preparationResponsibility} from './preparation-material-repository.js';
import {todoContentToken} from '../todos/content-reads.js';
type DB=Pick<Pool|PoolClient,'query'>;
/** Derived actions share native evidence. Reading or acknowledging them never completes work. */
export async function preparationWindowTodos(db:DB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!actor.actorRoles.includes('order_merchandiser')||!await preparationAvailable(db)||!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'order_merchandiser'))return [];
 const rows=(await db.query(`SELECT w.*,o.design_style_no FROM digital_preparation_windows w JOIN digital_production_orders o USING(production_order_id)
  WHERE o.primary_merchandiser_id=$1 AND ($2::uuid IS NULL OR w.window_id=$2) AND NOT EXISTS(SELECT 1 FROM digital_preparation_instruction_events e WHERE e.production_order_id=w.production_order_id AND e.kind=CASE WHEN w.kind='draft' THEN 'draft_saved' ELSE 'published' END)
  AND NOT EXISTS(SELECT 1 FROM digital_order_closures c WHERE c.production_order_id=w.production_order_id)
  AND NOT EXISTS(SELECT 1 FROM digital_production_resource_lifecycle l WHERE ((l.resource_kind='order' AND l.resource_id=o.production_order_id) OR (l.resource_kind='source' AND l.resource_id=o.source_id)) AND l.state<>'active')`,[actor.actorId,projection?.todoId??null])).rows;
 const result:TodoResponse[]=[];
 for(const r of rows){if(!await acceptanceIncludesNative(db,r.production_order_id))continue;const at=preparationIso(r.recorded_at)!;
  const selectionKey:TodoSelectionKey={todoId:r.window_id,contentToken:todoContentToken(['preparation-window',r.window_id]),taskTitle:r.kind==='draft'?'主料已到仓：完成制单草稿':'前提已齐：发布有效制单',todoType:'business_action',category:'digital_preparation_instruction',sourceAction:'preparation_window',recipientUserId:actor.actorId,route:{routeName:'digital_production_instruction',entityId:r.production_order_id,todoId:r.window_id},dueAt:preparationIso(r.due_at),status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:r.design_style_no,supplierName:null,status:'待订单跟单办理',updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:r.window_id,entityType:'digital_production',entityId:r.production_order_id,requiredRole:'order_merchandiser',requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:businessNow().getTime()>new Date(r.due_at).getTime()?'原24小时窗口已逾期；不会因等待或补料重置':null,version:1,updatedAt:at}));
 }
 return result;
}
export async function preparationSupplement(db:DB,taskId:string){
 if(!await preparationAvailable(db))return null;
 const rows=(await db.query(`SELECT DISTINCT ON(r.kind) r.*,p.production_order_id FROM digital_bulk_work_ranges r JOIN digital_bulk_preparations p USING(preparation_id)
  WHERE r.task_id=$1 OR r.preparation_id IN (SELECT old.preparation_id FROM digital_bulk_preparations current_p JOIN digital_production_tasks current_t ON current_t.route_instance_id=current_p.preparation_id JOIN digital_bulk_preparations old ON old.preparation_id=current_p.clock_origin_preparation_id OR old.clock_origin_preparation_id=current_p.clock_origin_preparation_id WHERE current_t.task_id=$1 AND current_p.clock_origin_preparation_id IS NOT NULL) ORDER BY r.kind,r.occurred_at DESC,r.version DESC`,[taskId])).rows;
 const partial=rows.filter(r=>!r.complete&&r.pending_material_ids.length);if(!partial.length)return null;
 const context=await preparationContext(db,{kind:'order',id:partial[0].production_order_id});
 const head=currentPreparationMaterials(await preparationMaterialHistory(db,context),context.orderId).find(m=>m.kind==='accessories_ready'&&m.scopeRef==='whole');
 return {ranges:partial,context,ready:Boolean(head?.state==='ready'&&head.valid),version:[partial.map(r=>[r.range_id,r.version]),head?[head.recordId,head.version,head.valid]:null]};
}
export async function preparationMaterialsTodos(db:DB,actor:TrustedActorContext,projection?:TodoProjection):Promise<TodoResponse[]>{
 if(!actor.actorRoles.some(r=>['warehouse_receiver','warehouse_supervisor'].includes(r))||!await preparationAvailable(db)||!await new DigitalProductionAccessPolicy(db).activeRole(actor.actorId,'warehouse_receiver'))return [];
 const tasks=(await db.query(`SELECT t.task_id,p.preparation_id,p.production_order_id FROM digital_bulk_preparations p JOIN digital_instruction_documents d ON d.production_order_id=p.production_order_id AND d.published_version=p.instruction_version
  JOIN digital_production_tasks t ON t.route_instance_id=p.preparation_id JOIN digital_production_task_access a USING(task_id)
  WHERE ($1::uuid IS NULL OR p.preparation_id=$1) AND a.task_kind='bulk_pattern' AND t.state NOT IN ('completed','cancelled') AND EXISTS(SELECT 1 FROM digital_bulk_work_ranges r WHERE r.task_id=t.task_id AND NOT r.complete)`,[projection?.todoId??null])).rows;
 const result:TodoResponse[]=[];
 for(const t of tasks){if(!await acceptanceIncludesNative(db,t.production_order_id))continue;const s=await preparationSupplement(db,t.task_id);if(!s||s.ready)continue;
  if((await preparationResponsibility(db,s.context)).warehouseWorkerId!==actor.actorId)continue;
  if((await db.query("SELECT 1 FROM digital_production_resource_lifecycle WHERE ((resource_kind='order' AND resource_id=$1) OR (resource_kind='source' AND resource_id=$2)) AND state<>'active' UNION ALL SELECT 1 FROM digital_order_closures WHERE production_order_id=$1",[t.production_order_id,s.context.sourceId])).rowCount)continue;
  const at=preparationIso(s.ranges.at(-1)!.occurred_at)!;
  const selectionKey:TodoSelectionKey={todoId:t.preparation_id,contentToken:todoContentToken(['preparation-materials',t.preparation_id,s.version]),taskTitle:'纸样唛架局部已做：核实并补齐待补辅料',todoType:'business_action',category:'digital_preparation_materials',sourceAction:'bulk_work_range',recipientUserId:actor.actorId,route:{routeName:'digital_bulk_preparation',entityId:t.production_order_id,todoId:t.preparation_id},dueAt:null,status:'pending',orderContext:{reworkNo:null,orderNo:null,styleNo:s.context.order.design_style_no,supplierName:null,status:'技术已标记待补料',updatedAt:at},unread:true,createdAt:at};
  appendSelectedTodo(result,projection,selectionKey,()=>({...selectionKey,sourceEventId:s.ranges[0].range_id,entityType:'digital_production',entityId:t.production_order_id,requiredRole:actor.actorRoles.includes('warehouse_supervisor')?'warehouse_supervisor':'warehouse_receiver',requiredCapability:null,policyKey:null,reminderCount:0,blockedReason:'只据真实补料记录办理，不替工厂签收，不重启技术原48小时',version:1,updatedAt:at}));
 }
 return result;
}
