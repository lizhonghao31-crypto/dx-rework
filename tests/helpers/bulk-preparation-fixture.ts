import {DigitalJourneyQuery} from "../../apps/api/src/production-platform/journey-query.js";
import {DigitalCockpitQuery} from "../../apps/api/src/production-platform/cockpit-query.js";
import { DevelopmentRoundService } from "../../apps/api/src/production-platform/development-round-service.js";
import { randomUUID } from "node:crypto";
import {writeFile} from "node:fs/promises";
import type { Pool } from "pg";
import { expect } from "vitest";
import type { DigitalOrder } from "@dx-rework/contracts/digital-production";
import type { BudgetDocument } from "@dx-rework/contracts/digital-budget";
import { DevelopmentDocumentSchema } from "@dx-rework/contracts/digital-development";
import { initialInstruction } from "@dx-rework/contracts/production-instruction";
import type { TrustedActorContext } from "../../apps/api/src/tools/repositories.js";
import type { AttachmentService } from "../../apps/api/src/tools/attachments.js";
import type { SourcingService } from "../../apps/api/src/sourcing/sourcing-service.js";
import type { DigitalBudgetService } from "../../apps/api/src/production-platform/budget-service.js";
import { DigitalProductionIdentityService } from "../../apps/api/src/production-platform/identity-service.js";
import { DigitalDevelopmentService } from "../../apps/api/src/production-platform/development-service.js";
import { DevelopmentExecutionService } from "../../apps/api/src/production-platform/development-execution-service.js";
import { ProductionInstructionService } from "../../apps/api/src/production-platform/production-instruction-service.js";
import { BulkPreparationService } from "../../apps/api/src/production-platform/bulk-preparation-service.js";
import { DigitalProductionTaskService } from "../../apps/api/src/production-platform/task-service.js";
import { CuttingService } from "../../apps/api/src/cutting/cutting-source-service.js";
import { developmentRoute } from "../../apps/api/src/production-platform/development-route.js";
export async function exerciseBulkPreparation(db:Pool,fixture:{order:DigitalOrder;designer:TrustedActorContext;document:BudgetDocument;budget:DigitalBudgetService},service:SourcingService,attachments:AttachmentService,actors:{primary:TrustedActorContext;manager:TrustedActorContext;owner:TrustedActorContext;ie:TrustedActorContext;root:TrustedActorContext},factoryId:string,craftId:string,mode:'none'|'pattern-first'|'preshrink-first'|'concurrent',options?:{cuttingProcess:'in_house'|'outsourced';stopAtReady:boolean;secondaryCraft?:'无'|'印花';accessory?:boolean;warehouseRole?:'warehouse_receiver'|'warehouse_supervisor';sourceCustomerCode?:string|null;legacyDevelopment?:boolean}){
 const primary=actors.primary,designer=fixture.designer,id=fixture.order.productionOrderId,bulk=new BulkPreparationService(db),identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),instruction=new ProductionInstructionService(db,true),execution=new DevelopmentExecutionService(db,true),tasks=new DigitalProductionTaskService(db),cutting=new CuttingService(db);
 const beforeRecords=await bulk.workroom(actors.root,{page:1,search:fixture.order.designStyleNo,scope:"all"});
 expect(beforeRecords.items.some(item=>item.orderId===id)).toBe(false);
 const people:Record<string,TrustedActorContext>={};
 for(const role of ['development_clerk','pattern_room_worker','warehouse_receiver','cutting_worker','embroidery_washing_merchandiser','quality_control','pattern_room_tail_inspector']){
  const actualRole=role==='warehouse_receiver'?options?.warehouseRole??role:role;
  if(role==='embroidery_washing_merchandiser'){
   const existing=(await db.query('SELECT user_id FROM user_role_assignments WHERE role_code=$1 AND revoked_at IS NULL',[role])).rows[0];
   if(existing){people[role]={actorId:existing.user_id,actorRoles:[actualRole],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};continue;}
  }
  const person=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[person,`TEST P11 ${role}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),person]);
  await db.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');try{await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST P11')",[randomUUID(),person,actualRole,primary.actorId]);}finally{await db.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
  people[role]={actorId:person,actorRoles:[actualRole],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};
 }
 const worker=people.pattern_room_worker!,warehouse=people.warehouse_receiver!,clerk=people.development_clerk!;
 const sourceInput={developmentType:'头版' as const,designStyleNo:fixture.order.designStyleNo,temporaryStyleNo:null,customerCode:options?.sourceCustomerCode===undefined?'PD':options.sourceCustomerCode};
 let source:{sourceId:string};
 if(options?.legacyDevelopment){
  // Only explicit historical same-source revision cases use this pre-SLA fixture.
  const nodes=['development_materials','development_material_supply','development_material_recheck',...developmentRoute({craft:'无',washing:'免洗'})];
  const baseline=(await db.query(`SELECT max(changed_at)::text AS created_at,count(*)::int AS nodes
    FROM digital_production_deadline_policies WHERE version=1 AND node_key=ANY($1::text[])`,[nodes])).rows[0];
  expect(baseline.nodes).toBe(nodes.length);
  expect((await db.query(`SELECT count(*)::int AS n FROM digital_production_deadline_policies
    WHERE node_key=ANY($1::text[]) AND version>1 AND changed_at<=$2::timestamptz`,[nodes,baseline.created_at])).rows[0].n).toBe(0);
  source={sourceId:randomUUID()};
  await db.query("INSERT INTO digital_production_sources(source_id,created_by,development_type,design_style_no,temporary_style_no,customer_code,created_at) VALUES($1,$2,$3,$4,$5,$6,$7::timestamptz)",[source.sourceId,designer.actorId,sourceInput.developmentType,sourceInput.designStyleNo,sourceInput.temporaryStyleNo,sourceInput.customerCode,baseline.created_at]);
 }else source=await identity.createSource(designer,sourceInput,randomUUID());
 await identity.attachSource(designer,id,source.sourceId,randomUUID());
 const image=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-bulk.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/bulk/${image}`,'a'.repeat(64),designer.actorId]);
 const development=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6 1/8']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:image,kind:'款图'}]});
 const savedDevelopment=await forms.save(designer,source.sourceId,{expectedVersion:0,document:development},randomUUID());
 const publishedDevelopment=await forms.publish(designer,source.sourceId,savedDevelopment.version,randomUUID());
 expect((await db.query('SELECT count(*)::int AS n FROM digital_development_sla_plans WHERE source_id=$1',[source.sourceId])).rows[0].n).toBe(options?.legacyDevelopment?0:2);
 expect(publishedDevelopment.document!.orderDate).toBe(publishedDevelopment.developmentCreatedDate);
 // Isolate bulk release from the independently tested development route; seed its final-design fact, then use the real customer confirmation command.
 await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,1,'最终设计确认','{}',$3)",[randomUUID(),source.sourceId,designer.actorId]);
 let order=await identity.read(primary,id);
 const doc={...initialInstruction(),...(options?.accessory?{accessories:[{id:randomUUID(),group:'车缝' as const,garmentColors:'黑白',materialColor:'黑',name:'TEST拉链',category:'拉链',part:'门襟',specification:'20cm',consumption:'1',remarks:''}]}:{}),styleName:'TEST产前',secondaryCraft:options?.secondaryCraft??'沿用开发',category:'上衣',date:'2026-10-01',preshrink:mode==='none'?'无需预缩' as const:'需要预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'袖长',tolerance:'±1/4',method:'平量',values:['6 1/8']}],images:[{attachmentId:image,kind:'款图' as const,description:'TEST'}]};
 await expect(instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,document:doc},randomUUID())).rejects.toMatchObject({statusCode:409});
 await expect(instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,sourceRound:2,document:doc},randomUUID())).rejects.toMatchObject({statusCode:409});
 await instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,sourceRound:1,document:doc},randomUUID());await instruction.publish(primary,id,{expectedVersion:1,orderVersion:order.version},randomUUID());
 const dispatch={expectedVersion:0,patternWorkerId:worker.actorId,warehouseWorkerId:warehouse.actorId,cuttingWorkerId:people.cutting_worker!.actorId,deliverPattern:false};
 await bulk.dispatch(actors.manager,id,dispatch,randomUUID());expect((await bulk.read(primary,id)).tasks).toHaveLength(0);
 await expect(bulk.dispatch(clerk,id,{expectedVersion:1,patternWorkerId:worker.actorId,deliverPattern:true},randomUUID())).rejects.toMatchObject({statusCode:409});
 await fixture.budget.save(designer,id,{expectedVersion:1,document:fixture.document},randomUUID());await fixture.budget.publish(primary,id,2,randomUUID());
 const prepared=await fixture.budget.prepareSourcing(primary,id,2,attachments);
 const created=await service.createCase(primary,{gender:prepared.gender,styleName:prepared.styleName,deliveryDate:'2026-11-10',estimatedCutPieceSendDate:'2026-10-20',daxingUnitPrice:prepared.daxingUnitPrice,attachmentIds:prepared.images.map(i=>i.attachmentId),lineItems:prepared.lineItems.map(({lineId,styleNo,alternateStyleNo,color,quantity})=>({lineId,styleNo,alternateStyleNo,color,quantity,factoryDeliveryDate:"2026-11-10"})),digitalBudget:{productionOrderId:id,budgetVersion:prepared.budgetVersion,orderVersion:prepared.orderVersion}},randomUUID());
 const caseId=created.value.sourcingCaseId,prices=[{position:1,unitPrice:'5.50'},{position:2,unitPrice:'5.50'}];
 await service.quoteIePrice(actors.ie,caseId,{linePrices:prices},randomUUID());await service.recordManagementDecision(actors.manager,caseId,{supplierId:factoryId,craftIds:[craftId],linePrices:prices,cuttingProcess:options?.cuttingProcess??'in_house'},randomUUID());
 if(mode==='none'){await execution.customerSample(designer,source.sourceId,{routeVersion:1,note:'TEST客户确认'},randomUUID());expect((await bulk.read(primary,id)).tasks.some(t=>t.taskKind==='bulk_pattern')).toBe(true);}
 if(mode==='none'){
  await service.decideOwner(actors.owner,caseId,{decision:'rejected'},randomUUID());
  const rejected=await new DigitalJourneyQuery(db).read(actors.root,id),owner=rejected.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='sourcing_owner');
  expect(owner).toMatchObject({state:'blocked',actualAt:null,completionResult:null,risks:['blocked']});
  expect(owner?.records[0]?.url).toContain('node=owner');expect((await bulk.read(primary,id)).ownerApproved).toBe(false);
  const director=rejected.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='sourcing_director');
  expect(director).toMatchObject({state:'pending',actualAt:null,owner:null,operator:null});
  expect(director?.records[0]?.url).toContain('node=management');
  await service.recordManagementDecision(actors.manager,caseId,{supplierId:factoryId,craftIds:[craftId],linePrices:prices,decisionReason:'TEST按原拒绝意见重新确认',cuttingProcess:options?.cuttingProcess??'in_house'},randomUUID());
 }
 await service.decideOwner(actors.owner,caseId,{decision:'approved'},randomUUID());
 if(mode!=='none'){expect((await bulk.read(primary,id)).tasks).toHaveLength(0);await execution.customerSample(designer,source.sourceId,{routeVersion:1,note:'TEST客户确认'},randomUUID());}
 let sheet=await bulk.read(primary,id);
 const publishedAt=(await db.query('SELECT published_at FROM digital_instruction_versions WHERE production_order_id=$1 AND version=1',[id])).rows[0].published_at.toISOString();
 expect(sheet.tasks.find(t=>t.taskKind==='bulk_pattern')).toMatchObject({state:'pending',enteredAt:publishedAt,dueAt:new Date(Date.parse(publishedAt)+48*3600000).toISOString()});
 // Reject clearing an already-created assignment atomically; UI and execution remain aligned.
 for(const field of ['patternWorkerId','warehouseWorkerId']){
  const before=await bulk.read(primary,id);
  await expect(bulk.dispatch(actors.root,id,{expectedVersion:before.dispatch.version,patternWorkerId:worker.actorId,warehouseWorkerId:warehouse.actorId,cuttingWorkerId:people.cutting_worker!.actorId,deliverPattern:false,[field]:null},randomUUID())).rejects.toMatchObject({statusCode:409});
  expect((await bulk.read(primary,id)).dispatch).toEqual(before.dispatch);
 }

 const workerJourney=await new DigitalJourneyQuery(db).read(worker,id);
 expect(workerJourney.styleImageUrl).toBe(`/api/digital-production/orders/${id}/instruction/attachments/${image}`);
 expect(Number.isFinite(Date.parse(workerJourney.asOf!))).toBe(true);
 const rootWorkroom=await bulk.workroom(actors.root,{page:1,search:fixture.order.designStyleNo,scope:'all'});
 expect(rootWorkroom.items.some(item=>item.orderId===id)).toBe(true);expect(rootWorkroom.pageSize).toBe(15);
 expect(rootWorkroom.items.find(item=>item.orderId===id)?.sheet.adoptedRound).toBe(1);
 if(options?.sourceCustomerCode!==undefined){
  const customer=fixture.order.customerCode;
  expect(rootWorkroom.items.find(item=>item.orderId===id)?.customer).toBe(customer);
  const byCustomer=await bulk.workroom(actors.root,{page:1,search:customer.toLowerCase(),scope:'all'});
  expect(byCustomer.items.find(item=>item.orderId===id)?.customer).toBe(customer);
  expect(byCustomer.total).toBeGreaterThanOrEqual(1);
  expect((await bulk.workroom(actors.root,{page:byCustomer.page+100,search:customer.toLowerCase(),scope:'all'})).total).toBe(byCustomer.total);
  const ownCustomer=await bulk.workroom(worker,{page:1,search:customer.toLowerCase(),scope:'mine'});
  expect(ownCustomer.items.map(item=>item.orderId)).toContain(id);
  expect((await bulk.workroom(actors.root,{page:1,search:`TEST-NO-CUSTOMER-${randomUUID()}`,scope:'all'}))).toMatchObject({total:0,items:[]});
  const cockpit=await new DigitalCockpitQuery(db).list(actors.root,{page:1,search:fixture.order.designStyleNo,stage:'bulk'});
  expect(cockpit.items.find(item=>item.orderId===id)?.customer).toBe(customer);
  expect(rootWorkroom.items.find(item=>item.orderId===id)?.sheet.reference.customerCode).toBe(customer);
  expect((await db.query('SELECT customer_code FROM digital_production_sources WHERE source_id=$1',[source.sourceId])).rows[0].customer_code).toBe(options.sourceCustomerCode);
  expect((await db.query('SELECT order_snapshot FROM digital_instruction_versions WHERE production_order_id=$1 AND version=1',[id])).rows[0].order_snapshot.customerCode).toBe(customer);
  if(process.env.ERP_BULK_CUSTOMER_EVIDENCE)await writeFile(process.env.ERP_BULK_CUSTOMER_EVIDENCE,JSON.stringify({customer,style:fixture.order.designStyleNo,orderId:id,styleSearch:rootWorkroom,customerSearch:byCustomer},null,2));
 }
 expect((await bulk.workroom(actors.root,{page:1,search:'TEST P11 pattern_room_worker',scope:'all'})).items.some(item=>item.orderId===id)).toBe(true);
 await expect(bulk.workroom(actors.primary,{page:1,search:'',scope:'all'})).rejects.toMatchObject({statusCode:403});
 const ownWorkroom=await bulk.workroom(worker,{page:1,search:fixture.order.designStyleNo,scope:'mine'});
 expect(ownWorkroom.items.some(item=>item.orderId===id)).toBe(true);
 await expect(bulk.workroom(worker,{page:1,search:'',scope:'all'})).rejects.toMatchObject({statusCode:403});
 await expect(bulk.workroom(warehouse,{page:1,search:'',scope:'mine'})).rejects.toMatchObject({statusCode:403});
 await db.query('UPDATE identity_mappings SET employed=false WHERE user_id=$1',[worker.actorId]);
 await expect(bulk.workroom(worker,{page:1,search:'',scope:'mine'})).rejects.toMatchObject({statusCode:403});
 await db.query('UPDATE identity_mappings SET employed=true WHERE user_id=$1',[worker.actorId]);
 const cuttingId=(await db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1 ORDER BY sourcing_line_position',[caseId])).rows[0].cutting_order_id;
 expect((await cutting.get(actors.root,cuttingId)).canRecord).toBe(false);
 await expect(cutting.record(actors.root,cuttingId,{pieceCount:1,actualCutCount:137,attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:409});
 await expect(tasks.handover(worker,sheet.tasks.find(t=>t.taskKind==='bulk_pattern')!.taskId,{note:'不能自行绕过文员'},randomUUID())).rejects.toMatchObject({statusCode:409});
 await bulk.dispatch(clerk,id,{expectedVersion:1,patternWorkerId:worker.actorId,deliverPattern:true},randomUUID());
 sheet=await bulk.read(worker,id);expect(sheet.tasks.map(t=>t.taskKind)).toEqual(['bulk_pattern']);expect(sheet.tasks.find(t=>t.taskKind==='bulk_pattern')).toMatchObject({state:'ready',slaHours:48,timeQuality:'现场登记'});
 expect(sheet.dispatch).toMatchObject({patternWorkerId:worker.actorId,warehouseWorkerId:null,cuttingWorkerId:null});
 expect((await tasks.history(worker,sheet.tasks[0]!.taskId)).events.length).toBeGreaterThan(0);
 await bulk.reportFabric(warehouse,id,{expectedReportId:null,material:'TEST本单整批面料',arrivedAt:new Date(Date.now()-3600000).toISOString(),inspectedAt:new Date().toISOString(),result:'合格',note:'TEST原链验布合格'},randomUUID());
 {
  const warehouseSheet=await bulk.read(warehouse,id),warehouseTask=warehouseSheet.tasks.find(t=>t.taskKind==='warehouse_preshrink')!;
  expect(warehouseSheet.tasks.map(t=>t.taskKind)).toEqual(['warehouse_preshrink']);expect(warehouseTask).toMatchObject({state:'ready',slaHours:36,timeQuality:'补报未核实'});
  await expect(tasks.read(worker,warehouseTask.taskId)).rejects.toMatchObject({statusCode:404});
  await expect(tasks.history(worker,warehouseTask.taskId)).rejects.toMatchObject({statusCode:404});
  await expect(tasks.read(warehouse,sheet.tasks[0]!.taskId)).rejects.toMatchObject({statusCode:404});
  expect(JSON.stringify(sheet)).not.toContain(warehouseTask.taskId);expect((await bulk.read(clerk,id)).tasks).toHaveLength(2);
 }
 await expect(fixture.budget.read(worker,id)).rejects.toMatchObject({statusCode:404});
 expect((await instruction.read(worker,id)).canEdit).toBe(false);
 await expect(bulk.complete(clerk,id,{preparationId:sheet.preparationId!,kind:'纸样完成'},randomUUID())).rejects.toMatchObject({statusCode:404});
 const done=async(kind:'纸样完成'|'唛架完成'|'预缩完成')=>bulk.complete(kind==='预缩完成'?warehouse:worker,id,{preparationId:sheet.preparationId!,kind},randomUUID());
 if(mode==='preshrink-first')await done('预缩完成');
 await done('纸样完成');expect((await bulk.read(primary,id)).tasks.some(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toBe(false);
 if(mode==='concurrent')await Promise.all([done('唛架完成'),done('预缩完成')]);else await done('唛架完成');
 if(mode==='pattern-first'||mode==='none'){expect((await bulk.read(primary,id)).tasks.some(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toBe(false);await expect(bulk.complete(worker,id,{preparationId:sheet.preparationId!,kind:'预缩完成'},randomUUID())).rejects.toMatchObject({statusCode:404});await done('预缩完成');}
 if(!(options?.cuttingProcess==='outsourced')){
  const before=await bulk.read(primary,id);await expect(bulk.dispatch(actors.root,id,{expectedVersion:before.dispatch.version,patternWorkerId:worker.actorId,warehouseWorkerId:warehouse.actorId,cuttingWorkerId:null,deliverPattern:false},randomUUID())).rejects.toMatchObject({statusCode:409});expect((await bulk.read(primary,id)).dispatch).toEqual(before.dispatch);
 }
 const complete=await bulk.read(primary,id);expect(complete.tasks.filter(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toHaveLength(1);expect(complete.tasks.find(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toMatchObject({state:'ready',slaHours:options?.cuttingProcess==='outsourced'?null:24,timeQuality:'缺失',enteredAt:null,dueAt:null});
 const completedIds=complete.tasks.filter(t=>['bulk_pattern','warehouse_preshrink'].includes(t.taskKind)&&t.state==='completed').map(t=>t.taskId);
 const clocks=(await db.query('SELECT entered_quality,completed_quality,extract(epoch FROM completed_at-entered_at)::float8 AS seconds FROM digital_production_tasks WHERE task_id=ANY($1::uuid[])',[completedIds])).rows;
 expect(clocks).toHaveLength(2);for(const clock of clocks){expect(['现场登记','补报未核实']).toContain(clock.entered_quality);expect(clock.completed_quality).toBe('现场登记');expect(clock.seconds).toBeGreaterThan(0);}
 await Promise.all([done('唛架完成'),done('唛架完成')]);expect((await bulk.read(primary,id)).tasks.filter(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toHaveLength(1);
 if(mode==='concurrent'){
  const nextFactory=(await db.query("SELECT supplier_id FROM supplier_catalog_items WHERE supplier_code='FAC-02'")).rows[0].supplier_id;
  await service.requestFactoryChange(actors.manager,caseId,{supplierId:nextFactory,unitPrice:'5.50',changeReason:'TEST已批准后的有效同价转厂'},randomUUID());
  const effective=await bulk.read(primary,id);expect(effective.ownerApproved).toBe(true);expect(effective.preparationId).toBe(complete.preparationId);
  expect((await db.query("SELECT 1 FROM sourcing_owner_decisions WHERE sourcing_decision_id=(SELECT sourcing_decision_id FROM sourcing_decisions WHERE sourcing_case_id=$1 ORDER BY decision_version DESC LIMIT 1)",[caseId])).rowCount).toBe(0);
 }
 expect((await cutting.get(actors.root,cuttingId)).canRecord).toBe(true);
 expect((await db.query('SELECT 1 FROM sourcing_finance_reconciliations WHERE sourcing_case_id=$1',[caseId])).rowCount).toBe(0);
 expect((await db.query('SELECT sum(quantity)::int n FROM digital_production_po_sizes WHERE line_id IN (SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1)',[id])).rows[0].n).toBe(200);
 if(options?.stopAtReady)return {id,caseId,cuttingId,people,sourceId:source.sourceId,preparationId:sheet.preparationId!,cutting,bulk,instruction};
 if(mode==='concurrent'){
  const recorder={...actors.root,authorizationCapability:'cutting:records:create'};
  await expect(cutting.record(recorder,cuttingId,{pieceCount:1,actualCutCount:137,attachmentIds:[]},randomUUID())).rejects.toMatchObject({statusCode:400});
  const evidence=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-cut-sheet.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[evidence,`TEST/cut/${evidence}`,'c'.repeat(64),recorder.actorId]);
  await cutting.record(recorder,cuttingId,{pieceCount:1,actualCutCount:137,attachmentIds:[evidence]},randomUUID());
  expect((await cutting.get(actors.root,cuttingId)).record?.actualCutCount).toBe(137);
  await expect(instruction.save(primary,id,{expectedVersion:1,orderVersion:order.version,document:{...doc,comments:'开裁后不能实改'}},randomUUID())).rejects.toMatchObject({statusCode:409});
  return;
 }
 // New technical release invalidates the old completed facts and the old pending cutting event.

 order=await identity.read(primary,id);await instruction.save(primary,id,{expectedVersion:1,orderVersion:order.version,document:{...doc,comments:'TEST新技术要求'}},randomUUID());await instruction.publish(primary,id,{expectedVersion:2,orderVersion:order.version},randomUUID());
 const revised=await bulk.read(primary,id);expect(revised.preparationId).not.toBe(sheet.preparationId);expect(revised.tasks.some(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toBe(false);expect(revised.facts.some(f=>f.kind==='纸样完成')).toBe(false);
 await expect(bulk.read(people.cutting_worker!,id)).rejects.toMatchObject({statusCode:404});await expect(instruction.read(people.cutting_worker!,id)).rejects.toMatchObject({statusCode:404});expect((await instruction.read(worker,id)).canEdit).toBe(false);
 await expect(done('纸样完成')).rejects.toMatchObject({statusCode:409});expect((await cutting.get(actors.root,cuttingId)).canRecord).toBe(false);
 if(mode==='none'){
  if(options?.legacyDevelopment){
  const rounds=new DevelopmentRoundService(db,true);
  const revision={basedOnRound:1,document:{...publishedDevelopment.document!,unit:'cm' as const,measurements:[{name:'袖长',values:['15.5575']},{name:'袖长',values:['16']}],instructions:'TEST客户新技术要求'},origin:'客户新增要求' as const,customerComment:'TEST改版',internalProblem:'',explanation:'',categories:['尺寸' as const],affectedNodes:['纸样' as const],outputKind:'整件样板' as const};
  // The initial request had no development date. Later revisions must use the server's saved basis, never erase it with that stale request.
  await expect(rounds.save(designer,source.sourceId,{expectedDraftVersion:0,revision:{...revision,document:{...revision.document,orderDate:development.orderDate}}},randomUUID())).rejects.toMatchObject({statusCode:400});
  expect((await db.query('SELECT count(*)::int n FROM digital_development_round_drafts WHERE source_id=$1',[source.sourceId])).rows[0].n).toBe(0);
  await rounds.save(designer,source.sourceId,{expectedDraftVersion:0,revision},randomUUID());
  const publishedRound=await rounds.publish(designer,source.sourceId,{expectedDraftVersion:1,basedOnRound:1},randomUUID());
  expect(publishedRound).toEqual({sourceId:source.sourceId,roundNumber:2});
  expect((await forms.read(designer,source.sourceId)).document!.orderDate).toBe(publishedDevelopment.document!.orderDate);
  expect((await forms.read(designer,source.sourceId,undefined,1)).document!.orderDate).toBe(publishedDevelopment.document!.orderDate);
  await expect(instruction.read(worker,id)).rejects.toMatchObject({statusCode:404});
  expect((await bulk.read(primary,id))).toMatchObject({customerConfirmed:false,instructionValid:false,preparationId:null});
  await execution.customerSample(designer,source.sourceId,{routeVersion:1,note:'TEST旧确认不能解新轮'},randomUUID());
  expect((await bulk.read(primary,id)).customerConfirmed).toBe(false);
  await instruction.save(primary,id,{expectedVersion:2,orderVersion:order.version,document:{...doc,comments:'TEST核对第二轮开发'}},randomUUID());
  const unreviewed=await instruction.read(primary,id);expect(unreviewed.sourceRound).toBe(1);expect(unreviewed.latestSourceRound).toBe(2);expect(unreviewed.document.comments).toBe('TEST核对第二轮开发');
  await expect(instruction.publish(primary,id,{expectedVersion:3,orderVersion:order.version},randomUUID())).rejects.toMatchObject({statusCode:409});
  const comparison=unreviewed.sourceComparison!;
  const review={expectedVersion:3,orderVersion:order.version,sourceRound:comparison.sourceRound,sourceVersion:comparison.sourceVersion,document:unreviewed.document,decisions:comparison.groups.map(group=>({group,action:group==='measurements'?'adopt' as const:'retain' as const}))};
  await expect(instruction.reviewSource(designer,id,review,randomUUID())).rejects.toMatchObject({statusCode:403});
  await expect(instruction.reviewSource(primary,id,{...review,sourceVersion:comparison.sourceVersion+1},randomUUID())).rejects.toMatchObject({statusCode:409});
  await expect(instruction.reviewSource(primary,id,{...review,decisions:[]},randomUUID())).rejects.toMatchObject({statusCode:409});
  const reviewKey=randomUUID(),reviewed=await instruction.reviewSource(primary,id,review,reviewKey);
  expect(reviewed).toMatchObject({version:4,sourceRound:2,document:{comments:'TEST核对第二轮开发'},sourceReview:{sourceVersion:comparison.sourceVersion,instructionVersion:4,decisions:review.decisions}});
  expect(reviewed.document.unit).toBe('cm');expect(reviewed.document.measurements.map(row=>row.values)).toEqual([['15.5575'],['16']]);
  expect(new Set(reviewed.document.measurements.map(row=>row.id)).size).toBe(2);
  expect(reviewed.sourceReview?.priorMeasurements).toMatchObject({unit:'inch',sizes:['M'],measurements:doc.measurements});
  expect((await instruction.reviewSource(primary,id,review,reviewKey)).version).toBe(4);
  expect((await instruction.read(primary,id,undefined,1)).sourceRound).toBe(1);
  expect((await db.query("SELECT count(*)::int n FROM audit_events WHERE entity_id=$1 AND action='instruction_source_decisions'",[id])).rows[0].n).toBe(1);
  const publishKey=randomUUID();await Promise.all([instruction.publish(primary,id,{expectedVersion:4,orderVersion:order.version},publishKey),instruction.publish(primary,id,{expectedVersion:4,orderVersion:order.version},publishKey)]);
  expect((await db.query('SELECT count(*)::int n FROM digital_instruction_versions WHERE production_order_id=$1 AND version=4',[id])).rows[0].n).toBe(1);
  expect((await bulk.read(primary,id)).tasks).toHaveLength(0);
  await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,2,'最终设计确认','{}',$3)",[randomUUID(),source.sourceId,designer.actorId]);
  await execution.customerSample(designer,source.sourceId,{routeVersion:2,note:'TEST客户确认第二轮'},randomUUID());
  const latest=await bulk.read(primary,id);expect(latest).toMatchObject({customerConfirmed:true,instructionValid:true,sourceRound:2,instructionVersion:4});expect(latest.tasks.some(t=>t.taskKind===(options?.cuttingProcess==='outsourced'?'bulk_cutting_external':'bulk_cutting'))).toBe(false);

  }else{
  const rounds=new DevelopmentRoundService(db,true);
  const revision={basedOnRound:1,document:{...publishedDevelopment.document!,unit:'cm' as const,measurements:[{name:'袖长',values:['15.5575']},{name:'袖长',values:['16']}],instructions:'TEST客户新技术要求'},origin:'客户新增要求' as const,customerComment:'TEST改版',internalProblem:'',explanation:'',categories:['尺寸' as const],affectedNodes:['纸样' as const],outputKind:'整件样板' as const};
  // The initial request had no development date. Later revisions must use the server's saved basis, never erase it with that stale request.
  await expect(rounds.save(designer,source.sourceId,{expectedDraftVersion:0,revision:{...revision,document:{...revision.document,orderDate:development.orderDate}}},randomUUID())).rejects.toMatchObject({statusCode:400});
  expect((await db.query('SELECT count(*)::int n FROM digital_development_round_drafts WHERE source_id=$1',[source.sourceId])).rows[0].n).toBe(0);
  await rounds.save(designer,source.sourceId,{expectedDraftVersion:0,revision},randomUUID());
  const originalInstruction=await instruction.read(worker,id),originalOrder=await identity.read(primary,id);
  const revisionResult=await rounds.publish(designer,source.sourceId,{expectedDraftVersion:1,basedOnRound:1},randomUUID());
  expect(revisionResult.sourceId).not.toBe(source.sourceId);
  expect(revisionResult).toMatchObject({roundNumber:1,revisionNumber:1,status:'draft'});
  const revised=(await db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[revisionResult.sourceId])).rows[0];
  expect(revised.design_style_no).toContain('复版1');
  expect((await forms.read(designer,source.sourceId)).document!.orderDate).toBe(publishedDevelopment.document!.orderDate);
  expect((await forms.read(designer,source.sourceId,undefined,1)).document!.orderDate).toBe(publishedDevelopment.document!.orderDate);
  expect((await instruction.read(worker,id)).document).toEqual(originalInstruction.document);
  expect((await identity.read(primary,id)).lines).toEqual(originalOrder.lines);
  expect((await bulk.read(primary,id))).toMatchObject({customerConfirmed:true,instructionValid:true,sourceRound:1});
  expect((await db.query('SELECT count(*)::int n FROM digital_production_orders WHERE source_id=$1',[revisionResult.sourceId])).rows[0].n).toBe(0);
  expect((await db.query('SELECT count(*)::int n FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND t.completed_at IS NOT NULL',[revisionResult.sourceId])).rows[0].n).toBe(0);


  }
 }

}

/** Real commands up to technical readiness, deliberately before any sourcing case/approval. */
export async function exerciseParallelTechnical(db:Pool,fixture:Parameters<typeof exerciseBulkPreparation>[1],actors:Parameters<typeof exerciseBulkPreparation>[4],options?:Parameters<typeof exerciseBulkPreparation>[8]){
 const primary=actors.primary,designer=fixture.designer,id=fixture.order.productionOrderId,bulk=new BulkPreparationService(db),identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),instruction=new ProductionInstructionService(db,true),execution=new DevelopmentExecutionService(db,true);
 const beforeRecords=await bulk.workroom(actors.root,{page:1,search:fixture.order.designStyleNo,scope:"all"});
 expect(beforeRecords.items.some(item=>item.orderId===id)).toBe(false);
 const people:Record<string,TrustedActorContext>={};
 for(const role of ['development_clerk','pattern_room_worker','warehouse_receiver','cutting_worker','embroidery_washing_merchandiser','quality_control','pattern_room_tail_inspector']){
  const actualRole=role==='warehouse_receiver'?options?.warehouseRole??role:role;
  if(role==='embroidery_washing_merchandiser'){
   const existing=(await db.query('SELECT user_id FROM user_role_assignments WHERE role_code=$1 AND revoked_at IS NULL',[role])).rows[0];
   if(existing){people[role]={actorId:existing.user_id,actorRoles:[actualRole],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};continue;}
  }
  const person=randomUUID();await db.query("INSERT INTO app_users(id,display_name,enabled) VALUES($1,$2,true)",[person,`TEST P11 ${role}`]);await db.query("INSERT INTO identity_mappings(id,user_id,provider,corp_id,provider_user_id,union_id,active,employed,last_verified_at) VALUES($1,$2::uuid,'dingtalk','corp',$2::text,$2::text,true,true,CURRENT_TIMESTAMP)",[randomUUID(),person]);
  await db.query('ALTER TABLE user_role_assignments DISABLE TRIGGER user_role_assignments_guard_creation');try{await db.query("INSERT INTO user_role_assignments(assignment_id,user_id,role_code,granted_by,grant_reason) VALUES($1,$2,$3,$4,'TEST P11')",[randomUUID(),person,actualRole,primary.actorId]);}finally{await db.query('ALTER TABLE user_role_assignments ENABLE TRIGGER user_role_assignments_guard_creation');}
  people[role]={actorId:person,actorRoles:[actualRole],authorizationCapability:'digital_production:view',authorizationCapabilities:['digital_production:view'],requestId:randomUUID()};
 }
 const worker=people.pattern_room_worker!,warehouse=people.warehouse_receiver!;
 const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:fixture.order.designStyleNo,temporaryStyleNo:null,customerCode:options?.sourceCustomerCode===undefined?'PD':options.sourceCustomerCode},randomUUID());
 await identity.attachSource(designer,id,source.sourceId,randomUUID());
 const image=randomUUID();await db.query("INSERT INTO attachments(attachment_id,object_key,original_filename,mime_type,size_bytes,sha256,uploaded_by,status,ready_at) VALUES($1,$2,'TEST-bulk.png','image/png',100,$3,$4,'ready',CURRENT_TIMESTAMP)",[image,`TEST/bulk/${image}`,'a'.repeat(64),designer.actorId]);
 const development=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:null,unit:'inch',sizes:['M'],measurements:[{name:'袖长',values:['6 1/8']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:image,kind:'款图'}]});
 const savedDevelopment=await forms.save(designer,source.sourceId,{expectedVersion:0,document:development},randomUUID());
 const publishedDevelopment=await forms.publish(designer,source.sourceId,savedDevelopment.version,randomUUID());
 expect(publishedDevelopment.document!.orderDate).toBe(publishedDevelopment.developmentCreatedDate);
 // Isolate bulk release from the independently tested development route; seed its final-design fact, then use the real customer confirmation command.
 await db.query("INSERT INTO digital_development_route_facts(fact_id,source_id,route_version,kind,payload,actor_id) VALUES($1,$2,1,'最终设计确认','{}',$3)",[randomUUID(),source.sourceId,designer.actorId]);
 const order=await identity.read(primary,id);
 const doc={...initialInstruction(),...(options?.accessory?{accessories:[{id:randomUUID(),group:'车缝' as const,garmentColors:'黑白',materialColor:'黑',name:'TEST拉链',category:'拉链',part:'门襟',specification:'20cm',consumption:'1',remarks:''}]}:{}),styleName:'TEST产前',secondaryCraft:options?.secondaryCraft??'沿用开发',category:'上衣',date:'2026-10-01',preshrink:'需要预缩' as const,sizes:['M'],measurements:[{id:randomUUID(),name:'袖长',tolerance:'±1/4',method:'平量',values:['6 1/8']}],images:[{attachmentId:image,kind:'款图' as const,description:'TEST'}]};
 await expect(instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,document:doc},randomUUID())).rejects.toMatchObject({statusCode:409});
 await expect(instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,sourceRound:2,document:doc},randomUUID())).rejects.toMatchObject({statusCode:409});
 await instruction.save(primary,id,{expectedVersion:0,orderVersion:order.version,sourceRound:1,document:doc},randomUUID());await instruction.publish(primary,id,{expectedVersion:1,orderVersion:order.version},randomUUID());

 await execution.customerSample(designer,source.sourceId,{routeVersion:1,note:'TEST技术线不等批价'},randomUUID());
 const sheet=await bulk.dispatch(actors.manager,id,{expectedVersion:0,patternWorkerId:worker.actorId,warehouseWorkerId:warehouse.actorId,cuttingWorkerId:people.cutting_worker!.actorId,deliverPattern:true},randomUUID());
 expect(sheet.ownerApproved).toBe(false);
 const pattern=sheet.tasks.find(t=>t.taskKind==='bulk_pattern')!;
 expect(pattern).toMatchObject({state:'ready',slaHours:48});
 expect(sheet.tasks.find(t=>t.taskKind==='warehouse_preshrink')).toMatchObject({state:'pending',enteredAt:null});
 expect((await db.query('SELECT approval_snapshot_id,workflow_version FROM digital_bulk_preparations WHERE preparation_id=$1',[sheet.preparationId])).rows[0]).toEqual({approval_snapshot_id:null,workflow_version:2});
 for(const kind of ['纸样完成','唛架完成'] as const)await bulk.complete(worker,id,{preparationId:sheet.preparationId!,kind},randomUUID());
 const completed=await bulk.read(actors.root,id);
 expect(completed.tasks.find(t=>t.taskKind==='bulk_pattern')?.state).toBe('completed');
 expect(completed.tasks.some(t=>['bulk_cutting','bulk_cutting_external'].includes(t.taskKind))).toBe(false);
 await expect(bulk.complete(warehouse,id,{preparationId:sheet.preparationId!,kind:'预缩完成'},randomUUID())).rejects.toMatchObject({statusCode:409});
 return {bulk,id,source,worker,warehouse,preparationId:sheet.preparationId!,people};
}
