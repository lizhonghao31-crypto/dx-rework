import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalProductionAccessService } from "../../apps/api/src/production-platform/access-service.js";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { expect, vi } from "vitest";
import { initialInstruction, InstructionDocumentSchema } from "@dx-rework/contracts/production-instruction";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import { ProductionInstructionService } from "../../apps/api/src/production-platform/production-instruction-service.js";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
export async function exerciseInstructions(database:Pool,order:DigitalOrder,primary:TrustedActorContext,designer:TrustedActorContext,manager:TrustedActorContext,budgetImageId:string){
 // This isolated fixture now exercises real active-role authorization, not a role label alone.
 await database.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) SELECT $1,$2::uuid,'dingtalk','corp','ding-'||$2::text,'union-'||$2::text,true,true,CURRENT_TIMESTAMP WHERE NOT EXISTS(SELECT 1 FROM identity_mappings WHERE user_id=$2 AND active AND employed)",[randomUUID(),manager.actorId]);
 await database.query("ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation");
 try {await database.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) SELECT $1,$2,'production_management',$3,'TEST PO date director' WHERE NOT EXISTS(SELECT 1 FROM user_role_assignments WHERE user_id=$2 AND role_code='production_management' AND revoked_at IS NULL)",[randomUUID(),manager.actorId,primary.actorId]);}
 finally {await database.query("ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation");}
 const service=new ProductionInstructionService(database,true),id=order.productionOrderId;
 const imageId=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-instruction.png','image/png',10,$3,$4,'ready',CURRENT_TIMESTAMP)",[imageId,`TEST/p10/${imageId}`,"a".repeat(64),primary.actorId]);
 const doc=InstructionDocumentSchema.parse({...initialInstruction(),styleName:"TEST连衣裙",category:"连衣裙",date:"2026-10-01",preshrink:"无需预缩",sizes:["M"],measurements:[{id:randomUUID(),name:"袖长",tolerance:"±1/4",method:"平量",values:["6 1/8"]}],images:[{attachmentId:imageId,kind:"款图",description:"TEST款图"}]});
 await expect(service.save(designer,id,{expectedVersion:0,orderVersion:order.version,document:doc},randomUUID())).rejects.toMatchObject({statusCode:403});
 await expect(service.save(primary,id,{expectedVersion:0,orderVersion:order.version,document:{...doc,images:[{attachmentId:budgetImageId,kind:"款图",description:"不能偷读预算图"}]}},randomUUID())).rejects.toMatchObject({statusCode:403});
 const key=randomUUID();const saved=await service.save(primary,id,{expectedVersion:0,orderVersion:order.version,document:doc},key);
 expect((await service.save(primary,id,{expectedVersion:0,orderVersion:order.version,document:doc},key)).version).toBe(1);
 const pk=randomUUID();const published=await Promise.all([service.publish(primary,id,{expectedVersion:1,orderVersion:order.version},pk),service.publish(primary,id,{expectedVersion:1,orderVersion:order.version},pk)]);
 expect(published.map(x=>x.publishedVersion)).toEqual([1,1]);expect(await service.canDownload(designer,id,imageId)).toBe(true);
 expect(await service.canDownload(primary,id,budgetImageId)).toBe(false);
 expect((await service.read(primary,id,undefined,1)).document.measurements[0]?.values[0]).toBe("6 1/8");
 const draftImage=randomUUID();await database.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-draft.png','image/png',10,$3,$4,'ready',CURRENT_TIMESTAMP)",[draftImage,`TEST/p10/${draftImage}`,"b".repeat(64),primary.actorId]);
 await service.save(primary,id,{expectedVersion:saved.version,orderVersion:order.version,document:{...doc,remarks:"新版未发布",images:[...doc.images,{attachmentId:draftImage,kind:"其它工艺",description:"未发布新图"}]}},randomUUID());
 expect((await service.read(designer,id))).toMatchObject({version:1,isPublishedSnapshot:true,document:{remarks:""}});
 expect(await service.canDownload(designer,id,draftImage)).toBe(false);
 expect(await service.canDownload(primary,id,draftImage)).toBe(true);
 expect((await service.read(primary,id)).isPublishedSnapshot).toBe(false);
 expect((await service.read(primary,id)).publishedVersion).toBe(1);
 expect((await service.read(primary,id,undefined,1)).document.remarks).toBe("");
 await expect(database.query("UPDATE digital_instruction_versions SET document='{}' WHERE production_order_id=$1",[id])).rejects.toThrow("immutable");
 expect((await database.query("SELECT count(*)::int n FROM digital_production_task_access WHERE production_order_id=$1 AND task_kind LIKE 'bulk_%'",[id])).rows[0].n).toBe(0);
 const request=await service.requestDate(primary,id,{orderVersion:order.version,changes:order.lines.map(line=>({lineId:line.lineId,expectedVersion:line.customerDateVersion??0,date:"2026-11-25"})),reason:"TEST 客户要求"},randomUUID());
 expect(request.order.contractDeliveryDate).toBe("2026-11-20");const requestId=request.dateRequests[0]!.requestId;
 await expect(service.decideDate(primary,id,requestId,true,randomUUID())).rejects.toMatchObject({statusCode:403});
 await expect(service.decideDate({...primary,actorRoles:[...primary.actorRoles,"production_management"]},id,requestId,true,randomUUID())).rejects.toMatchObject({statusCode:403});
 const commonAccess=new DigitalProductionAccessService(database);expect((await commonAccess.deliveryRequests(manager,id)).some(r=>r.requestId===requestId)).toBe(true);
 await commonAccess.decideDelivery(manager,requestId,"approved");
 const decided=await service.read(manager,id);expect(decided.customerPoDates!.map(line=>line.date)).toEqual(order.lines.map(()=>"2026-11-25"));expect(decided.currentDeliveryDate).toBe("2026-11-20");
 await expect(service.publish(primary,id,{expectedVersion:2,orderVersion:order.version},randomUUID())).rejects.toMatchObject({statusCode:409});
 expect((await service.read(primary,id,undefined,1)).order.contractDeliveryDate).toBe("2026-11-20");
 const access=new DigitalProductionAccessService(database);
 await expect(access.requestDelivery(primary,id,{expectedVersion:decided.currentOrderVersion,deliveryDate:"2026-11-28",reason:"旧入口退休"})).rejects.toMatchObject({statusCode:409});
 // Seed the two genuine old request shapes on independent unchanged legacy orders.
 const legacyIdentity=new DigitalProductionIdentityService(database,true);
 for(const lane of ["instruction","delivery"] as const){
   const oldOrder=await legacyIdentity.createOrder(designer,{customerCode:order.customerCode,productGroup:order.productGroup,designStyleNo:`TEST-old-${randomUUID()}`,temporaryStyleNo:null,primaryMerchandiserId:primary.actorId,orderDate:order.orderDate,contractDeliveryDate:"2026-11-20",lines:order.lines.map(line=>({poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:line.color,colorForeign:null,deliveryDate:"2026-11-20",sizes:line.sizes}))},randomUUID());
   const oldId=randomUUID();
   if(lane==="instruction")await database.query("INSERT INTO digital_instruction_date_requests(request_id,production_order_id,order_version,old_date,new_date,reason,requested_by) VALUES($1,$2,$3,'2026-11-20','2026-11-28','TEST旧制单申请',$4)",[oldId,oldOrder.productionOrderId,oldOrder.version,primary.actorId]);
   else await database.query("INSERT INTO digital_production_delivery_requests(request_id,production_order_id,expected_version,previous_date,requested_date,reason,requested_by) VALUES($1,$2,$3,'2026-11-20','2026-11-28','TEST旧访问申请',$4)",[oldId,oldOrder.productionOrderId,oldOrder.version,primary.actorId]);
   await access.decideDelivery(manager,oldId,"approved");await access.decideDelivery(manager,oldId,"approved");
   const oldSheet=await service.read(primary,oldOrder.productionOrderId);
   expect(oldSheet.customerPoDates!.map(line=>line.date)).toEqual(oldOrder.lines.map(()=>"2026-11-28"));
   expect(oldSheet.currentDeliveryDate).toBe("2026-11-20");expect(oldSheet.dateRequests[0]).toMatchObject({source:lane,status:"已批准"});
 }
 const legacy={requestId:randomUUID()};await database.query("INSERT INTO digital_production_delivery_requests(request_id,production_order_id,expected_version,previous_date,requested_date,reason,requested_by) VALUES($1,$2,$3,'2026-11-20','2026-11-28','TEST旧申请保留',$4)",[legacy.requestId,id,decided.currentOrderVersion,primary.actorId]);
 await expect(access.decideDelivery(manager,legacy.requestId,"approved")).rejects.toMatchObject({statusCode:409});await access.decideDelivery(manager,legacy.requestId,"rejected");
 expect((await service.read(primary,id)).customerPoDates!.map(line=>line.date)).toEqual(order.lines.map(()=>"2026-11-25"));
 expect((await database.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE source_key LIKE $1",[`po-customer-decision:${legacy.requestId}`])).rows[0].n).toBe(1);
 await database.query("INSERT INTO digital_production_resource_lifecycle(resource_kind,resource_id,state,changed_by) VALUES('order',$1,'paused',$2) ON CONFLICT(resource_kind,resource_id) DO UPDATE SET state='paused'",[id,primary.actorId]);
 await expect(access.requestDelivery(primary,id,{expectedVersion:decided.currentOrderVersion+1,deliveryDate:"2026-11-29",reason:"暂停不能改期"})).rejects.toMatchObject({statusCode:409});
 await database.query("UPDATE digital_production_resource_lifecycle SET state='active' WHERE resource_kind='order' AND resource_id=$1",[id]);
 const pending=await service.requestDate(primary,id,{orderVersion:decided.currentOrderVersion,changes:(await service.read(primary,id)).customerPoDates!.map(line=>({lineId:line.lineId,expectedVersion:line.version,date:"2026-11-30"})),reason:"TEST开裁前申请"},randomUUID());
 const pendingId=pending.dateRequests.find(r=>r.date==="2026-11-30")!.requestId;
 const cutFact=vi.spyOn(service,"cutStarted").mockResolvedValue(true);
 try {
  const approved=await service.decideDate(manager,id,pendingId,true,randomUUID());expect(approved.dateRequests.find(r=>r.requestId===pendingId)?.status).toBe("已批准");expect(approved.cutStarted).toBe(true);expect(approved.customerPoDates!.map(line=>line.date)).toEqual(order.lines.map(()=>"2026-11-30"));
  await expect(service.save(primary,id,{expectedVersion:2,orderVersion:approved.currentOrderVersion,document:doc},randomUUID())).rejects.toMatchObject({statusCode:409});
 } finally {cutFact.mockRestore();}
 const other={...primary,actorId:randomUUID()};await expect(service.read(other,id)).rejects.toMatchObject({statusCode:404});
 expect((await database.query("SELECT count(*)::int n FROM digital_instruction_versions WHERE production_order_id=$1",[id])).rows[0].n).toBe(1);
 const identity=new DigitalProductionIdentityService(database,true),live=await identity.read(primary,id);
 const corrected=await identity.correctNumbers(primary,id,live.lines[0]!.lineId,{expectedVersion:live.version,formalPoNo:'TEST-P10-PO'},randomUUID());
 const effective=await service.read(designer,id);
 expect(effective.order.lines[0]).toMatchObject({poNumber:'TEST-P10-PO',formalStyleNo:'TEST-P10-PO'});
 const historical=(await database.query('SELECT order_snapshot FROM digital_instruction_versions WHERE production_order_id=$1 AND version=1',[id])).rows[0].order_snapshot;
 expect(historical.lines[0].formalStyleNo).toBe(order.lines[0]!.formalStyleNo);
 expect(effective.document).toEqual(doc);expect(effective.order.lines.map(line=>line.sizes)).toEqual(order.lines.map(line=>line.sizes));
 let draftVersion=(await service.read(primary,id)).version;
 for(const row of [{...doc.measurements[0]!,name:''},{...doc.measurements[0]!,values:['']},{...doc.measurements[0]!,name:'',values:['']}]){
   const draft=await service.save(primary,id,{expectedVersion:draftVersion,orderVersion:corrected.version,document:{...doc,measurements:[row]}},randomUUID());draftVersion=draft.version;
   await expect(service.publish(primary,id,{expectedVersion:draftVersion,orderVersion:corrected.version},randomUUID())).rejects.toMatchObject({statusCode:409});
 }
 expect((await service.read(designer,id)).version).toBe(1);

}
