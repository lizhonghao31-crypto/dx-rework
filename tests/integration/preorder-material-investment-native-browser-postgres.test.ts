import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {materialInvestmentTodos} from '../../apps/api/src/production-platform/preparation-todos.js';
import {materialInvestmentRiskHistory} from '../../apps/api/src/production-platform/material-investment-risk-history.js';
import {DigitalProductionNotificationService} from '../../apps/api/src/production-platform/notification-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {orderTimeCreated} from '../../apps/api/src/production-platform/order-time-created.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('preorder material investment on the original signed App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-preorder-investment-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('lets the actual merchandiser enter from My Tasks, save real procurement and keep the draft unpublished and untimed',async()=>{
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,style='TEST-PREORDER-'+randomUUID();
  const at='2026-11-19T04:00:00.000Z',scene=await h.f.scene(at);
  const diagnosis=await h.f.runtime.run(scene,designer,async()=>{
   const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const draft=initialDevelopmentDocument(),material={...draft.materials[0]!,name:'TEST 预下单棉布',quantity:'75米',supplier:'TEST 供应商'};
   const order=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,
    orderDate:'',contractDeliveryDate:null,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]});
   const sheet=await forms.save(designer,sourceId,{expectedVersion:0,document:{...draft,materials:[material],
    customerOrderDraft:{withOrder:true,stage:'preorder',order}}},randomUUID());
   const readiness=new ProductionReadinessService(h.db);
   await readiness.record(designer,{kind:'source',id:sourceId},{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',
    occurredAt:at,note:'TEST 真预下单有效交接',quantities:[],evidenceIds:[],sourceDocumentVersion:sheet.version,recipientId:merch.actorId},randomUUID());
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   return {sourceId,materialId:material.materialId};
  });
  h.setCollectionScene(scene);
  const tab=await h.open(merch.actorId,1165,{},'/ui/my-tasks?q='+encodeURIComponent(style));
  try{
   const page=tab.page,task=page.locator('a.my-todo-row').filter({hasText:'投面辅料'});
   await task.waitFor();
   expect(await task.count()).toBe(1);
   const acknowledged=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/read')&&response.ok());
   await task.click();
   await page.waitForURL(address=>address.searchParams.get('materialSource')===diagnosis.sourceId);
   const form=page.getByRole('group',{name:'投面辅料',exact:true});await form.waitFor();await acknowledged;
   await form.getByLabel('本次交接物料').selectOption(diagnosis.materialId);
   await form.getByLabel('实际发生时间（北京时间）').fill('2026-11-19T12:00');
   await form.getByLabel('实际数量').fill('75');
   await form.getByLabel('单位',{exact:true}).fill('米');
   await form.getByLabel('本次情况 / 订正原因').fill('TEST 跟单在原面板实际投出75米');
   const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/production-readiness/materials'));
   await form.getByRole('button',{name:'保存本项记录',exact:true}).click();
   const response=await receipt;expect(response.status()).toBe(200);
   expect(await response.json()).toMatchObject({sourceIsPreorderDraft:true,orderId:null,facts:expect.arrayContaining([
    expect.objectContaining({kind:'material_investment',state:'ready',version:1,recordedBy:merch.actorId,occurredAt:at,
     quantities:[expect.objectContaining({materialId:diagnosis.materialId,quantity:75,unit:'米'})]})
   ])});
   await page.getByText('已保存原业务记录',{exact:true}).waitFor();
   await page.screenshot({path:join(h.evidence,'actual-preorder-procurement-1165.png')});
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.waitForURL(url=>url.pathname.endsWith('/ui/my-tasks')&&url.searchParams.get('q')===style);
   await expect.poll(()=>page.locator('a.my-todo-row').filter({hasText:'投面辅料'}).count()).toBe(0);
   await h.f.runtime.run(scene,designer,async()=>{
    expect(await orderTimeCreated(h.db,{kind:'source',id:diagnosis.sourceId})).toBeNull();
    expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[diagnosis.sourceId])).rowCount).toBe(0);
   });
  }finally{await tab.context.close();}
 });
 it('keeps the original purchase record and authorized reminder across real preorder conversion, then closes only the reminder',async()=>{
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,root=h.f.root,style='TEST-FORMAL-PREORDER-'+randomUUID();
  const started='2026-11-19T04:00:00.000Z',scene=await h.f.scene(started);
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),
   preparation=new ProductionReadinessService(h.db),requests=h.orderTimeRequests!,notifications=new DigitalProductionNotificationService(h.db);
  const photo=await h.f.image(designer);
  const order=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,
   orderDate:'2026-11-19',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',primaryMerchandiserId:merch.actorId,
   lines:[{formalPoNo:style+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:'2'}]}]});
  const original=await h.f.runtime.run(scene,designer,async()=>{
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const price=await new PatternRoomPriceService(h.db).quote(root,'category',category.price_id);
   const draft=initialDevelopmentDocument(),material={...draft.materials[0]!,name:'TEST 真预下单材料',quantity:'75米',supplier:'TEST 供应商',specification:'TEST 原布规格'};
   const document={...draft,quantity:1,files:[{attachmentId:photo,kind:'款图' as const}],patternCategoryId:category.price_id,
    materials:[material],productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'preorder' as const,order}};
   const sheet=await forms.save(designer,sourceId,{expectedVersion:0,document},randomUUID()),resource={kind:'source' as const,id:sourceId};
   const handover=await preparation.record(designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',
    occurredAt:started,note:'TEST 正式前交接',quantities:[],evidenceIds:[],sourceDocumentVersion:sheet.version,recipientId:merch.actorId},randomUUID());
   const fact=handover.facts.find(entry=>entry.kind==='design_handover')!;
   expect(await orderTimeCreated(h.db,resource)).toBeNull();
   return {sourceId,resource,category,price,document,version:sheet.version,handoverId:fact.recordId,material};
  });
  const actual={kind:'material_investment' as const,scopeRef:'whole',expectedVersion:0,state:'partial' as const,
   occurredAt:started,note:'TEST 首批部分投料，保留在同一投料记录',quantities:[{lineId:null,materialId:original.material.materialId,
    name:original.material.name,quantity:20,unit:'米'}],evidenceIds:[],sourceDocumentVersion:null,recipientId:null};
  const initial=await h.f.runtime.run(scene,merch,async()=>{
   const result=await preparation.record(merch,original.resource,actual,randomUUID());
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toMatchObject([{dueAt:null,route:{routeName:'digital_source_material_investment'}}]);
   return result.facts.find(record=>record.kind==='material_investment')!;
  });
  await h.f.advance(scene,'2026-11-20T04:00:00.000Z');
  const pending=await h.f.runtime.run(scene,designer,async()=>{
   const sheet=await forms.save(designer,original.sourceId,{expectedVersion:original.version,
    document:{...original.document,customerOrderDraft:{withOrder:true,stage:'formal',order}}},randomUUID());
   const operation={kind:'development_publish' as const,sourceId:original.sourceId,input:{expectedVersion:sheet.version,
    patternOrder:{categoryId:original.category.price_id,priceVersion:original.price.version}}};
   const check=await requests.check(designer,operation);
   return requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST 原预下单转正式'},randomUUID());
  });
  const orderId=await h.f.runtime.run(scene,root,async()=>{
   const review=await requests.read(root,pending.requestId);
   const applied=await requests.apply(root,pending.requestId,{expectedVersion:review.version,fingerprint:review.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(applied.state).toBe('applied');return applied.result!.orderId!;
  });
  const resource={kind:'order' as const,id:orderId};
  const reminder=await h.f.runtime.run(scene,merch,async()=>{
   const plan=await new OrderTimePlanRepository(h.db).current(resource);
   expect(plan?.input.work.find(work=>work.parameterKey==='material_investment')?.dependsOn).toEqual(['design_handover']);
   const state=await preparation.read(merch,resource);
   expect(state.facts.find(record=>record.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:1,state:'partial',occurredAt:started});
   expect(state.materialInvestmentReminder).toMatchObject({handoverId:original.handoverId,startedAt:started,percent:70,closed:null,status:'waiting'});
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toMatchObject([{todoId:original.handoverId,route:{routeName:'digital_order_material_investment',entityId:orderId}}]);
   return state.materialInvestmentReminder!;
  });
  expect(reminder.warningAt).toBeTruthy();
  await h.f.advance(scene,reminder.warningAt!);
  await h.f.runtime.run(scene,root,async()=>{
   await notifications.runOnce();await notifications.runOnce();
   expect((await h.db.query("SELECT count(*)::int n FROM digital_production_notification_events WHERE event_kind='material_investment' AND todo_id=$1",[original.handoverId])).rows[0]!.n).toBe(1);
  });
  await h.f.runtime.run(scene,merch,async()=>{
   const close={fingerprint:reminder.fingerprint,reason:'TEST 已和供应商核对，继续领料'},key=randomUUID();
   const closed=await preparation.closeMaterialInvestmentReminder(merch,resource,close,key);
   expect(closed.materialInvestmentReminder).toMatchObject({closed:{actorId:merch.actorId,reason:close.reason},status:'warning'});
   expect((await preparation.closeMaterialInvestmentReminder(merch,resource,close,key)).materialInvestmentReminder).toEqual(closed.materialInvestmentReminder);
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toHaveLength(1);
  });
  const completeAt=new Date(Date.parse(reminder.dueAt)+3600000).toISOString();
  await h.f.advance(scene,completeAt);
  await h.f.runtime.run(scene,merch,async()=>{
   const result=await preparation.record(merch,resource,{...actual,expectedVersion:1,state:'ready',occurredAt:completeAt,
    quantities:[{...actual.quantities[0]!,quantity:75}]},randomUUID());
   expect(result.facts.find(record=>record.kind==='material_investment')).toMatchObject({recordId:initial.recordId,version:2,state:'ready',occurredAt:completeAt});
   expect(await materialInvestmentTodos(h.db,merch,{todoId:original.handoverId})).toEqual([]);
   expect(await materialInvestmentRiskHistory(h.db,orderId,completeAt)).toMatchObject([{at:completeAt,deadline:reminder.dueAt,assessment:'late',overdueSeconds:3600}]);
  });
 });
});
