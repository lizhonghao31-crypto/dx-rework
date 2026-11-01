import {randomUUID} from 'node:crypto';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {ShortLeadService} from '../../apps/api/src/production-platform/short-lead-service.js';
import {SeriesPlanService} from '../../apps/api/src/production-platform/series-plan-service.js';
import {appendSeriesSourceEvent,readSeriesPlanFacts} from '../../apps/api/src/production-platform/series-plan-facts.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {seriesPlanJourney} from '../../apps/api/src/production-platform/series-plan-journey.js';
import {PoCustomerDateService} from '../../apps/api/src/production-platform/po-customer-date-service.js';
import {ContextBusinessClock,businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalOrderCreateSchema,beijingCalendarDate,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {addCalendarDays} from '@dx-rework/contracts/series-calendar';
import type {SeriesPlanPreview} from '@dx-rework/contracts/digital-series-plan';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('series plans and short formal commitments on owned native PostgreSQL',()=>{
 let f:Awaited<ReturnType<typeof businessAnchorFixture>>,identity:DigitalProductionIdentityService,plans:SeriesPlanService,short:ShortLeadService;
 beforeAll(async()=>{f=await businessAnchorFixture(url!);identity=new DigitalProductionIdentityService(f.db,true);plans=new SeriesPlanService(f.db,'TEST-series-plan-signing-secret-not-live');short=new ShortLeadService(f.db);});
 afterAll(async()=>f?.dispose());
 const designer=()=>f.people['sample-designer']!,manager=()=>f.people['production-management']!,owner=()=>f.people.owner!;
 const orderInput=(date?:string)=>DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-SERIES-${randomUUID()}`,orderDate:beijingCalendarDate(new Date()),salesYear:2027,salesSeries:'P05',requiresColorMatching:true,lines:[{formalPoNo:`TEST-PO-${randomUUID()}`,color:'黑',customerWarehouseArrivalDate:date??minimumInitialCustomerDate(new Date()),sizes:[{size:'M',quantity:10}]}]});
 const create=async()=>identity.createOrder(designer(),orderInput('2027-03-20'),randomUUID());
 const prepare=async(id:string,day:string|null=null):Promise<SeriesPlanPreview>=>{const s=await plans.read(manager(),id);return plans.preview(manager(),id,{expectedOrderVersion:s.orderVersion,expectedPlanRevision:s.current?.revision??0,plannedShippingDate:day,selectedNodeIds:null,plannedDurations:{}});};
 const apply=(id:string,p:SeriesPlanPreview,key=randomUUID())=>plans.apply(manager(),id,{...p.input,previewToken:p.previewToken,reason:'TEST 显式采用计划，不改客户承诺',acceptSuggestedDate:true},key);
 const publishedSource=async(input:ReturnType<typeof orderInput>,missingDate=false,publish=true)=>{
  const source=await identity.createSource(designer(),{developmentType:'头版',designStyleNo:input.designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID()),forms=new DigitalDevelopmentService(f.db,true),image=await f.image(designer());
  const draft={...input,lines:input.lines.map(l=>({...l,sizes:l.sizes.map(q=>({...q,quantity:String(q.quantity)})),...(missingDate?{customerWarehouseArrivalDate:null}:{})}))};
  const document=DevelopmentDocumentSchema.parse({...initialDevelopmentDocument(),quantity:1,files:[{attachmentId:image,kind:'款图'}],materials:[{materialId:randomUUID(),category:'主布',label:'主布',supplier:'TEST',name:'TEST棉布',width:'150',weight:'200',composition:'棉',consumption:'1',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}],customerOrderDraft:{withOrder:true,stage:'formal',order:draft}});
  const saved=await forms.save(designer(),source.sourceId,{expectedVersion:0,document},randomUUID());if(publish)await forms.publish(designer(),source.sourceId,saved.version,randomUUID());return source.sourceId;
 };
 it('uses exactly 30 natural days and grants a short exception only to the boss/Root; consumes exact approval once',async()=>{
  const calendar=await short.read(designer()),input=orderInput(addCalendarDays(calendar.serverToday,29));
  await expect(identity.createOrder(designer(),input,randomUUID())).rejects.toMatchObject({code:'SHORT_LEAD_APPROVAL_REQUIRED'});
  const requested=await short.request(designer(),null,{order:input,reason:'TEST 29自然日正式单'},randomUUID());
  await expect(short.decide(manager(),null,requested.requestId,{approved:true,reason:'TEST supply director must not approve'},randomUUID())).rejects.toMatchObject({statusCode:403});
  await short.decide(owner(),null,requested.requestId,{approved:true,reason:'TEST 老板确认该客户承诺'},randomUUID());
  const changed=DigitalOrderCreateSchema.parse({...input,lines:input.lines.map(l=>({...l,sizes:[{size:'M',quantity:11}]})),shortLeadApprovalId:requested.requestId});
  await expect(identity.createOrder(designer(),changed,randomUUID())).rejects.toMatchObject({code:'SHORT_LEAD_APPROVAL_STALE'});
  const command={...input,shortLeadApprovalId:requested.requestId},key=randomUUID(),order=await identity.createOrder(designer(),command,key);
  expect((await identity.createOrder(designer(),command,key)).productionOrderId).toBe(order.productionOrderId);
  expect((await f.db.query('SELECT * FROM digital_short_lead_consumptions WHERE request_id=$1',[requested.requestId])).rowCount).toBe(1);
  const normal=await identity.createOrder(designer(),orderInput(calendar.minimumNormalDate),randomUUID());expect(normal.productionOrderId).toBeTruthy();
 });
 it('preserves the native Root self-approval exception without extending director authority',async()=>{
  const calendar=await short.read(f.root),input=orderInput(addCalendarDays(calendar.serverToday,10));
  const requested=await short.request(f.root,null,{order:input,reason:'TEST Root原生自己执行'},randomUUID());
  await short.decide(f.root,null,requested.requestId,{approved:true,reason:'TEST Root可执行自己的申请'},randomUUID());
  const made=await identity.createOrder(f.root,{...input,shortLeadApprovalId:requested.requestId},randomUUID());expect(made.productionOrderId).toBeTruthy();
  await expect(f.db.query("UPDATE digital_short_lead_decisions SET reason='overwrite' WHERE request_id=$1",[requested.requestId])).rejects.toMatchObject({code:'55000'});
 });
 it('previews without writing; adopts one explicit plan while preserving all customer dates and original SLA snapshots',async()=>{
  const o=await create(),id=o.productionOrderId,before=(await f.db.query('SELECT * FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows;
  const native=(await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1',[id])).rows;
  const p=await prepare(id);expect(p.candidateDate).toBe('2027-03-15');expect(p.basis).toBe('series-suggestion');expect(p.milestones.find(m=>m.key==='material_investment')?.targetDate).toBe('2026-12-10');
  expect((await f.db.query('SELECT 1 FROM digital_series_plans WHERE production_order_id=$1',[id])).rowCount).toBe(0);
  await expect(plans.apply(manager(),id,{...p.input,previewToken:p.previewToken,reason:'TEST 未明确采用建议'},randomUUID())).rejects.toMatchObject({statusCode:409});
  const key=randomUUID();const result=await apply(id,p,key);expect(result.revision).toBe(1);expect((await apply(id,p,key)).revision).toBe(1);
  expect(result.planningGraph).toEqual(p.planningGraph);expect(result.dependencies).toEqual(p.dependencies);expect(result.risks).toEqual(p.risks);expect(result.slaSnapshotRef).toEqual(p.sourceRevisionSet.slaSnapshotRef);
  expect((await f.db.query('SELECT * FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows).toEqual(before);
  expect((await f.db.query('SELECT * FROM digital_sla_order_snapshots WHERE production_order_id=$1',[id])).rows).toEqual(native);
  await expect(apply(id,p)).rejects.toMatchObject({statusCode:409});
 });
 it('invalidates a preview on series changes, preserves the adopted P, and keeps customer-date changes separate',async()=>{
  const o=await create(),id=o.productionOrderId;await apply(id,await prepare(id));const old=await prepare(id);
  await plans.context(designer(),id,{expectedOrderVersion:o.version,salesYear:2028,salesSeries:'P05',requiresColorMatching:false,reason:'TEST 改系列只出候选'},randomUUID());
  await expect(apply(id,old)).rejects.toMatchObject({statusCode:409});const current=await plans.read(manager(),id);expect(current.current?.plannedShippingDate).toBe('2027-03-15');
  const p=await prepare(id);expect(p.candidateDate).toBe('2028-03-15');expect(p.milestones.find(m=>m.key==='material_investment')?.targetDate).toBe('2028-01-11');expect(p.risks.some(r=>r.code==='CUSTOMER_EARLIER_THAN_PLAN')).toBe(true);
  const dates=new PoCustomerDateService(f.db),s=await dates.read(f.root,id),request=await dates.request(f.root,id,{orderVersion:current.orderVersion,reason:'TEST 客户正式改期',changes:s.customerPoDates.map(l=>({lineId:l.lineId,date:'2027-03-25',expectedVersion:l.version}))},randomUUID());
  await dates.decide(f.root,id,request.requestId,true,randomUUID());expect((await plans.read(f.root,id)).current?.plannedShippingDate).toBe('2027-03-15');
 });
 it('retains completed/unknown-time targets and rejects stale real-event previews and cross-scope corrections',async()=>{
  const id=(await create()).productionOrderId;await apply(id,await prepare(id));const stale=await prepare(id,'2027-03-18'),time=await new ContextBusinessClock(f.db).read({kind:'order',id});
  const event={eventId:randomUUID(),orderId:id,key:'fabric_receipt' as const,scopeRef:'whole',sourceDomain:'bulk-preparation' as const,sourceRecordId:randomUUID(),sourceVersion:1,occurredAt:null,occurredDate:null,precision:'unknown' as const,supersedesEventId:null,voided:false,reason:'TEST 已形成到仓事实，真实时间未知'};
  await appendSeriesSourceEvent(f.db,event,f.root.actorId,time);await expect(apply(id,stale)).rejects.toMatchObject({statusCode:409});const fresh=await prepare(id,'2027-03-18');
  const m=fresh.milestones.find(m=>m.key==='fabric_receipt')!;expect(m.targetDate).toBe('2027-01-20');expect(m.templateDate).toBe('2027-01-23');expect(m.frozenReason).toContain('已完成');
  expect(fresh.facts.find(f=>f.key==='fabric_receipt')?.occurredAt).toBeNull();await apply(id,fresh);
  await expect(appendSeriesSourceEvent(f.db,{...event,eventId:randomUUID(),scopeRef:'other',sourceVersion:2,supersedesEventId:event.eventId},f.root.actorId,time)).rejects.toMatchObject({code:'23514'});
  const corrections=await Promise.allSettled([2,3].map(sourceVersion=>appendSeriesSourceEvent(f.db,{...event,eventId:randomUUID(),sourceVersion,supersedesEventId:event.eventId,voided:true,reason:'TEST并发订正，必须追加同一当前头'},f.root.actorId,time)));
  expect(corrections.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(corrections.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await plans.read(manager(),id)).facts.some(f=>f.key==='fabric_receipt')).toBe(false);
  const head=(await f.db.query("SELECT event_id,source_version FROM digital_series_source_events WHERE production_order_id=$1 AND node_key='fabric_receipt' ORDER BY source_version DESC LIMIT 1",[id])).rows[0];
  await appendSeriesSourceEvent(f.db,{...event,eventId:randomUUID(),sourceVersion:head.source_version+1,supersedesEventId:head.event_id,precision:'date',occurredDate:'2026-10-31',reason:'TEST只有实际日期，禁止补造时分秒'},f.root.actorId,time);
  const projection=await seriesPlanJourney(f.db,id,'2026-11-01',false);expect(projection.find(n=>n.key==='series_fabric_receipt')).toMatchObject({actualAt:null,actualDate:'2026-10-31',planningOnly:true});expect(projection.find(n=>n.key==='series_material_investment')?.owner?.name).toBeTruthy();
  await expect(f.db.query('DELETE FROM digital_series_plans WHERE production_order_id=$1',[id])).rejects.toMatchObject({code:'55000'});
 });
 it('accepts an original pending plan across JSONB key ordering, without letting the proposer approve its own request',async()=>{
  const id=(await create()).productionOrderId,p=await prepare(id),r=await plans.request(designer(),id,{...p.input,reason:'TEST 设计提出计划'},randomUUID());
  const fresh=await plans.preview(manager(),id,(await plans.read(manager(),id)).pendingRequests[0]!.input);
  const adopted=await plans.apply(manager(),id,{...fresh.input,previewToken:fresh.previewToken,reason:'TEST 总监确认计划',acceptSuggestedDate:true,requestId:r.requestId},randomUUID());expect(adopted.revision).toBe(1);
  expect((await f.db.query('SELECT approved FROM digital_series_request_decisions WHERE request_id=$1',[r.requestId])).rows).toEqual([{approved:true}]);
 });
 it('freezes the short commitment business day across a scene advance, while keeping the real customer date unchanged',async()=>{
  const scene=await f.scene('2027-02-28T02:00:00Z');let id='',requestId='',input:ReturnType<typeof orderInput>;
  await f.runtime.run(scene,f.root,async()=>{input=DigitalOrderCreateSchema.parse({...orderInput('2027-03-10'),orderDate:'2027-02-28'});id=await publishedSource(input);requestId=(await short.request(designer(),id,{order:input,reason:'TEST 冻结2月28日承诺'},randomUUID())).requestId;await short.decide(owner(),id,requestId,{approved:true,reason:'TEST 老板批准此版本'},randomUUID());});
  await f.advance(scene,'2027-03-02T02:00:00Z');
  await f.runtime.run(scene,f.root,async()=>{const made=await identity.createOrder(designer(),{...input!,shortLeadApprovalId:requestId},randomUUID(),id);expect(made.lines[0]?.customerWarehouseArrivalDate).toBe('2027-03-10');const r=(await f.db.query('SELECT commitment_day::text AS day,business_time FROM digital_short_lead_consumptions WHERE production_order_id=$1',[made.productionOrderId])).rows[0];expect(r.day).toBe('2027-02-28');expect(r.business_time.scenarioId).toBe(scene);});
 });
 it.each([true,false])('completes a published incomplete/short draft without rewriting it (missing date: %s)',async(missingDate)=>{
  const calendar=await short.read(designer()),originalInput=orderInput(addCalendarDays(calendar.serverToday,8)),id=await publishedSource(originalInput,missingDate),input=missingDate?originalInput:DigitalOrderCreateSchema.parse({...originalInput,lines:originalInput.lines.map(l=>({...l,customerWarehouseArrivalDate:addCalendarDays(calendar.serverToday,9)}))});
  const r=await short.request(designer(),id,{order:input,reason:'TEST 补客户确认日期并申请短交期'},randomUUID());await short.decide(owner(),id,r.requestId,{approved:true,reason:'TEST 明确本次补全的客户承诺'},randomUUID());
  const made=await identity.createOrder(designer(),{...input,shortLeadApprovalId:r.requestId},randomUUID(),id);expect(made.productionOrderId).toBeTruthy();
  const original=(await f.db.query('SELECT document FROM digital_development_documents WHERE source_id=$1',[id])).rows[0].document;expect(original.customerOrderDraft.order.lines[0].customerWarehouseArrivalDate).toBe(missingDate?null:addCalendarDays(calendar.serverToday,8));
 });
 it('keeps an approval valid across the original unchanged draft publication, but never across a content change',async()=>{
  const calendar=await short.read(designer()),input=orderInput(addCalendarDays(calendar.serverToday,12)),id=await publishedSource(input,false,false),forms=new DigitalDevelopmentService(f.db,true);
  const r=await short.request(designer(),id,{order:input,reason:'TEST 原草稿版本申请'},randomUUID());await short.decide(owner(),id,r.requestId,{approved:true,reason:'TEST 老板批准此正式承诺'},randomUUID());
  const draft=await forms.read(designer(),id);await forms.publish(designer(),id,draft.version,randomUUID());
  expect((await short.read(designer(),id)).requests.find(x=>x.requestId===r.requestId)?.staleReason).toBeNull();
  const made=await identity.createOrder(designer(),{...input,shortLeadApprovalId:r.requestId},randomUUID(),id);expect(made.productionOrderId).toBeTruthy();
 });
 it('commits exactly one of two concurrently confirmed previews at the same revision',async()=>{
  const id=(await create()).productionOrderId,p=await prepare(id),results=await Promise.allSettled([apply(id,p),apply(id,p)]);
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(results.filter(r=>r.status==='rejected')).toHaveLength(1);
  expect((await f.db.query('SELECT 1 FROM digital_series_plans WHERE production_order_id=$1',[id])).rowCount).toBe(1);
 });
 it('keeps P as the mandatory linked anchor and preserves a visible customer conflict after adoption/refresh',async()=>{
  const id=(await create()).productionOrderId,p=await prepare(id,'2027-03-25');
  await expect(plans.preview(manager(),id,{...p.input,selectedNodeIds:['design_handover:whole']})).rejects.toMatchObject({statusCode:409});
  await apply(id,p);const current=await plans.read(manager(),id);expect(current.current?.milestones.find(m=>m.key==='planned_shipment')?.targetDate).toBe(current.current?.plannedShippingDate);expect(current.risks.some(r=>r.code==='CUSTOMER_EARLIER_THAN_PLAN')).toBe(true);
  const time=await new ContextBusinessClock(f.db).read({kind:'order',id});await appendSeriesSourceEvent(f.db,{eventId:randomUUID(),orderId:id,key:'planned_shipment',scopeRef:'whole',sourceDomain:'receiving',sourceRecordId:randomUUID(),sourceVersion:1,occurredAt:null,occurredDate:'2026-10-31',precision:'date',supersedesEventId:null,voided:false,reason:'TEST实际出货已有原记录，原计划不可平移'},f.root.actorId,time);
  await expect(prepare(id,'2027-03-26')).rejects.toMatchObject({statusCode:409});expect((await plans.read(manager(),id)).current?.plannedShippingDate).toBe('2027-03-25');
 });
 it('projects native v2 partial dispatch and all-PO completion from actual cut quantities, retaining the last actual dispatch time',async()=>{
  const scene=await f.scene('2026-11-01T15:50:00Z'),flow=new FactoryFlowService(f.db);let id='',sourceId='',lineId='';
  await f.runtime.run(scene,f.root,async()=>{
   const ready=await f.bulkReady('无');id=ready.id;sourceId=ready.sourceId;
   const cut=(await f.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0];
   const cutter={...f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await f.image(cutter)]},randomUUID());
   const state=await flow.read(f.root,id);lineId=(await f.db.query('SELECT line_id FROM digital_production_po_lines WHERE production_order_id=$1',[id])).rows[0].line_id;
   await flow.dispatch(f.people.warehouse!,id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST首批4件',lines:[{lineId,quantity:4}]},randomUUID());
   const partial=(await readSeriesPlanFacts(f.db,id,sourceId,'PD')).facts.find(x=>x.key==='processing_dispatch'&&x.scopeRef==='whole');
   expect(partial).toMatchObject({started:true,completed:false,occurredAt:null,precision:'unknown'});
  });
  await f.advance(scene,'2026-11-01T16:10:00Z');
  await f.runtime.run(scene,f.root,async()=>{
   const state=await flow.read(f.root,id);await flow.dispatch(f.people.warehouse!,id,{expectedRevision:state.revision,occurredAt:businessNow().toISOString(),supplierId:f.supplierId,note:'TEST余量6件发齐',lines:[{lineId,quantity:6}]},randomUUID());
   const all=(await readSeriesPlanFacts(f.db,id,sourceId,'PD')).facts;
   expect(all.filter(x=>x.key==='processing_dispatch'&&x.scopeRef.startsWith('batch:'))).toHaveLength(2);
   expect(all.find(x=>x.key==='processing_dispatch'&&x.scopeRef==='whole')).toMatchObject({started:true,completed:true,occurredAt:'2026-11-01T16:10:00.000Z',precision:'instant'});
  });
 });
 it('does not silently overflow profile dates or rewrite in-flight plans, and keeps revoked manager retries denied',async()=>{
  const id=(await create()).productionOrderId;await apply(id,await prepare(id));
  const saved=await plans.saveProfile(manager(),{customerCode:'PD',expectedVersion:0,monthOffset:-2,shippingDay:31,reason:'TEST 配置日号，非法月份需人工明确'},randomUUID());expect(saved.version).toBe(1);
  const s=await plans.read(designer(),id);await plans.context(designer(),id,{expectedOrderVersion:s.orderVersion,salesYear:2028,salesSeries:'P04',requiresColorMatching:true,reason:'TEST 二月31日不可溢出'},randomUUID());
  const p=await prepare(id);expect(p.candidateDate).toBeNull();expect(p.risks.some(r=>r.code==='INVALID_SERIES_DAY')).toBe(true);expect((await plans.read(designer(),id)).current?.plannedShippingDate).toBe('2027-03-15');
  const input={customerCode:'PD',expectedVersion:1,monthOffset:-2,shippingDay:null,reason:'TEST 清除固定日恢复建议'},key=randomUUID();await plans.saveProfile(manager(),input,key);
  const assignment=(await f.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager().actorId])).rows[0];await f.access.revokeRole(f.root,assignment.assignment_id,'TEST native audited role revocation');
  await expect(plans.saveProfile(manager(),input,key)).rejects.toMatchObject({statusCode:403});
 });
});
