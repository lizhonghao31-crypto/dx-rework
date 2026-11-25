import {chooseDevelopmentCreation} from "./development-creation-browser-steps.js";
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {initialInstruction} from '@dx-rework/contracts/production-instruction';
import type {ProductionReadinessState} from '@dx-rework/contracts/production-readiness';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {ShipSampleService} from '../../apps/api/src/production-platform/ship-sample-service.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {orderTimeCreated} from '../../apps/api/src/production-platform/order-time-created.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('preorder material investment on the original signed App',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-preorder-investment-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true,merchandiserWorkbench:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('finds an assigned original order without a todo and returns to the same search and order',async()=>{
  const f=h.f,merch=f.people.merchandiser!,viewer=await h.dedicated('order_merchandiser','TEST unrelated workbench merchandiser');
  const search='TEST-X6-FACT-ONLY-'+randomUUID(),designer=f.people['sample-designer']!;
  const order=await new DigitalProductionIdentityService(f.db,true).createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:search,orderDate:'2026-11-25',requiresColorMatching:false,
   primaryMerchandiserId:merch.actorId,productionPlanning:{craftSteps:[],preshrink:false},
   lines:[{formalPoNo:search,color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:1}]}],
  }),randomUUID());
  const original={id:order.productionOrderId};
  await new ShipSampleService(f.db).record(merch,original.id,{occurredAt:new Date().toISOString(),trackingNumber:'TEST-X6-ORIGINAL',note:'TEST completes the native pending task before original order lookup'},randomUUID());
  const listPath='/api/todos/merchandiser/orders?'+new URLSearchParams({search,page:'1'});
  const tab=await h.open(merch.actorId,1165,{},`/ui/digital-production?workspace=merchandiser&search=${encodeURIComponent(search)}`);
  try{
   const ordinary=await tab.context.request.get(h.base+'/api/todos/merchandiser/current?'+new URLSearchParams({search,state:'mine'}));
   expect(ordinary.status(),await ordinary.text()).toBe(200);
   expect(await ordinary.json()).toEqual({items:[],page:1,total:0});
   const emptyDirectory=tab.page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname==='/api/todos/merchandiser/orders');
   await tab.page.getByRole('button',{name:'查找原授权订单',exact:true}).click();
   const response=await emptyDirectory;expect(response.status(),await response.text()).toBe(200);
   expect(await response.json()).toMatchObject({page:1,total:1,items:[{id:original.id,styleNo:search,customer:order.customerCode,orderNumber:null}]});
   const row=tab.page.getByRole('region',{name:'原授权订单',exact:true}).getByRole('row').filter({hasText:search});
   const documentRead=tab.page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname.endsWith(`/document-directory/order/${original.id}`));
   await row.getByRole('button',{name:'订单单据',exact:true}).click();
   const directory=await documentRead;expect(directory.status(),await directory.text()).toBe(200);
   const reader=tab.page.getByRole('dialog');await reader.getByRole('heading',{name:'订单单据',exact:true}).waitFor();
   await reader.press('Escape');await reader.waitFor({state:'hidden'});
   const open=row.getByRole('link',{name:'打开原订单',exact:true});
   expect(new URL((await open.getAttribute('href'))!,tab.page.url()).searchParams.get('order')).toBe(original.id);
   await open.focus();await open.press('Enter');
   await tab.page.getByRole('heading',{name:search,exact:true}).waitFor();
   await tab.page.getByRole('link',{name:'成本预算表',exact:true}).waitFor();
   await tab.page.getByRole('link',{name:'大货制单与客户交期',exact:true}).waitFor();
   await tab.page.getByRole('button',{name:'返回',exact:true}).click();
   await open.waitFor();
   await expect.poll(()=>open.evaluate(element=>document.activeElement===element)).toBe(true);
   expect(new URL(tab.page.url()).searchParams.get('view')).toBe('orders');
   expect(new URL(tab.page.url()).searchParams.get('search')).toBe(search);
  }finally{await tab.close();}
  const unrelated=await h.open(viewer.id,1165,{},'/ui/my-tasks');
  try{
   const reply=await unrelated.context.request.get(h.base+listPath);
   expect(reply.status(),await reply.text()).toBe(200);
   expect(await reply.json()).toEqual({items:[],page:1,total:0});
   expect((await unrelated.context.request.get(`${h.base}/api/digital-production/orders/${original.id}`)).status()).toBe(404);
  }finally{await unrelated.close();}
 });
 it('lets the actual merchandiser enter from My Tasks, save real procurement and keep the draft unpublished and untimed',async()=>{
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,style='TEST-PREORDER-'+randomUUID();
  // This browser creates through the ordinary signed route, without a selected
  // Acceptance clock. The corresponding My Tasks read must use the same scope.
  const at=new Date(Math.floor(Date.now()/60_000)*60_000).toISOString();
  const localTime=new Date(Date.parse(at)+8*3_600_000).toISOString().slice(0,16);
  const creation=await h.open(designer.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  let diagnosis:{sourceId:string;materialId:string};
  try{
   const page=creation.page;
   await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   await chooseDevelopmentCreation(page,'预下单');
   await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.getByLabel('主布 面料名称',{exact:true}).fill('TEST 预下单棉布');
   await page.getByLabel('主布 数量与单位',{exact:true}).fill('75米');
   await page.getByLabel('主布 供应商',{exact:true}).fill('TEST 供应商');
   const fabric=page.getByLabel('主布 面料名称',{exact:true}).locator('xpath=ancestor::tr');
   const materialPrice=fabric.getByRole('textbox',{name:/材料单价$/});
   const pricingUnit=fabric.getByRole('textbox',{name:/计价单位$/});
   expect(await materialPrice.inputValue()).toBe('');
   expect(await pricingUnit.inputValue()).toBe('');
   await materialPrice.fill('12.75');await pricingUnit.fill('米');
   for(const category of ['主布','配布']){
    const control=page.getByRole('button',{name:`＋ 添加${category}`,exact:true});
    expect(await control.evaluate(button=>button.closest('.dx-designer-astryx')!==null&&!button.classList.contains('dx-button'))).toBe(true);
    await control.focus();await control.press('Enter');
    const added=page.getByLabel(`${category} 面料名称`,{exact:true}).last();
    await expect.poll(()=>added.evaluate(input=>input===document.activeElement)).toBe(true);
    await added.locator('xpath=ancestor::tr').getByRole('button',{name:'删除面料',exact:true}).click();
    await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   }
   expect(await page.getByLabel('PO 1 颜色',{exact:true}).count()).toBe(0);
   expect(await page.getByLabel('本轮打板数量',{exact:true}).count()).toBe(0);
   const saved=page.waitForResponse(r=>/\/sources\/[^/]+\/development$/.test(new URL(r.url()).pathname)&&r.request().method()==='PUT');
   await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
   const response=await saved;
   expect(response.status(),await response.text()).toBe(200);
   const draft=await response.json();
   expect(draft).toMatchObject({status:'draft',productionOrderId:null,publishedAt:null,document:{customerOrderDraft:{withOrder:true,stage:'preorder'}}});
   const material=draft.document.materials.find((row:{name:string})=>row.name==='TEST 预下单棉布');
   expect(material).toMatchObject({quantity:'75米',supplier:'TEST 供应商',unitPrice:'12.75',pricingUnit:'米'});
   await page.getByRole('button',{name:'＋ 添加配布',exact:true}).click();
   const spareName=page.getByLabel('配布 面料名称',{exact:true}).last();
   const unnamed=spareName.locator('xpath=ancestor::tr');
   const sparePrice=unnamed.getByRole('textbox',{name:/材料单价$/}),spareUnit=unnamed.getByRole('textbox',{name:/计价单位$/});
   await sparePrice.fill('0');await spareUnit.fill('米');
   await unnamed.getByRole('status').filter({hasText:'请先填写材料名称'}).waitFor();
   const rejected=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith(`/sources/${draft.sourceId}/development`)&&r.request().method()==='PUT');
   await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
   const rejection=await rejected;
   expect(rejection.status()).toBe(400);
   expect(await rejection.text()).toContain('请先填写材料名称');
   expect((await new DigitalDevelopmentService(h.db,true).read(designer,draft.sourceId)).version).toBe(draft.version);
   const validation=page.getByRole('dialog',{name:'保存预下单备料资料',exact:true});
   await validation.getByText(/请先填写材料名称/).waitFor();
   await validation.getByRole('button',{name:'关闭',exact:true}).click();
   await spareName.pressSequentially('TEST spare fabric');
   expect(await sparePrice.inputValue()).toBe('0');
   expect(await spareUnit.inputValue()).toBe('米');
   await unnamed.getByRole('textbox',{name:'配布 规格',exact:true}).fill('TEST changed specification');
   expect(await sparePrice.inputValue()).toBe('');
   expect(await spareUnit.inputValue()).toBe('');
   await unnamed.getByRole('button',{name:'删除面料',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   await materialPrice.fill('13.25');
   const retrySave=page.waitForResponse(r=>new URL(r.url()).pathname.endsWith(`/sources/${draft.sourceId}/development`)&&r.request().method()==='PUT');
   await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
   const recovered=await retrySave;
   expect(recovered.status()).toBe(200);
   const resaved=await recovered.json();
   expect(resaved.version).toBe(draft.version+1);
   expect(resaved.document.materials.find((row:{materialId:string})=>row.materialId===material.materialId)).toMatchObject({unitPrice:'13.25',pricingUnit:'米'});
   await page.getByText('预下单草稿 · 可继续补充资料',{exact:true}).waitFor();
   const disclosure=page.locator('.preparation-readiness > details > summary').filter({hasText:'产前物料办理'});
   await disclosure.waitFor();
   if(!await disclosure.evaluate(summary=>Boolean(summary.closest('details')?.open)))await disclosure.click();
   diagnosis={sourceId:draft.sourceId,materialId:material.materialId};
   const handover=page.getByRole('group',{name:/设计交资料/});
   await handover.getByLabel('实际发生时间（北京时间）').fill(localTime);
   const recipient=handover.getByRole('button',{name:/^接收订单跟单(?:\s|$)/});
   await recipient.click();
   const recipientName=(await page.evaluate(async id=>{
    const response=await fetch('/api/digital-production/access/candidates');
    if(!response.ok)throw Error('Could not read handover recipient');
    return (await response.json()).find((person:{id:string})=>person.id===id)?.displayName;
   },merch.actorId)) as string;
   expect(recipientName).toBeTruthy();
   await page.getByRole('option',{name:recipientName,exact:true}).click();
   await handover.getByLabel('本次情况 / 订正原因').fill('TEST 真预下单有效交接');
   const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/production-readiness/materials'));
   await handover.getByRole('button',{name:'提交备料交接',exact:true}).click();
   const result=await receipt;
   expect(result.status(),await result.text()).toBe(200);
   expect(await result.json()).toMatchObject({orderId:null,sourceIsPreorderDraft:true,facts:expect.arrayContaining([expect.objectContaining({
    kind:'design_handover',state:'ready',recipientId:merch.actorId,recordedBy:designer.actorId,sourceDocumentVersion:resaved.version,
   })])});
   await page.getByText('已保存原业务记录',{exact:true}).waitFor();
   expect(await orderTimeCreated(h.db,{kind:'source',id:diagnosis.sourceId})).toBeNull();
  }finally{await creation.context.close();}
  const newPath=`/ui/digital-production?workspace=merchandiser&kind=preparation&search=${encodeURIComponent(style)}`;
  const work=await h.open(merch.actorId,1165,{},newPath);
  try{
   const queue=work.page.getByRole('region',{name:'待我办理',exact:true}),row=queue.getByRole('row').filter({hasText:style});
   const original=row.getByRole('button',{name:'办理本单投面辅料',exact:true});
   await original.click();
   const panel=work.page.getByRole('region',{name:'本单投面辅料',exact:true});
   const form=panel.getByRole('group',{name:'投面辅料',exact:true});await form.waitFor();
   expect(new URL(work.page.url()).searchParams.get('workspace')).toBe('merchandiser');
   expect(await panel.getByText('指定仓管和对色确认人',{exact:true}).count()).toBe(0);
   await form.getByRole('combobox',{name:/^办理状态/}).selectOption('partial');
   await form.getByLabel('本次交接物料').selectOption(diagnosis.materialId);
   await form.getByLabel('实际发生时间（北京时间）').fill(localTime);
   await form.getByLabel('实际数量').fill('25');
   await form.getByLabel('单位',{exact:true}).fill('米');
   await form.getByLabel('本次情况 / 订正原因').fill('TEST 本单实际部分投出25米');
   await panel.getByRole('button',{name:'返回跟单列表',exact:true}).click();
   await work.page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();
   expect(await form.getByLabel('实际数量').inputValue()).toBe('25');
   const saved=work.page.waitForResponse(response=>response.request().method()==='POST'&&
    new URL(response.url()).pathname.endsWith(`/sources/${diagnosis.sourceId}/production-readiness/materials`));
   await form.getByRole('button',{name:'保存本项记录',exact:true}).click();
   const response=await saved;
   expect(response.status(),await response.text()).toBe(200);
   expect(await response.json()).toMatchObject({sourceIsPreorderDraft:true,orderId:null,facts:expect.arrayContaining([
    expect.objectContaining({kind:'material_investment',state:'partial',version:1,recordedBy:merch.actorId,
     quantities:[expect.objectContaining({materialId:diagnosis.materialId,quantity:25,unit:'米'})]})
   ])});
   await panel.getByText('已保存原业务记录',{exact:true}).waitFor();
   await panel.getByRole('button',{name:'返回跟单列表',exact:true}).click();await original.waitFor();
   expect(new URL(work.page.url()).searchParams.get('search')).toBe(style);
  }finally{await work.close();}
  const tab=await h.open(merch.actorId,1165,{},'/ui/my-tasks?q='+encodeURIComponent(style));
  try{
   const page=tab.page,task=page.locator('a.my-todo-row').filter({hasText:'投面辅料'});
   await task.waitFor();
   expect(await task.count()).toBe(1);
   const acknowledged=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/read')&&response.ok());
   await task.click();
   await page.waitForURL(address=>address.searchParams.get('materialSource')===diagnosis.sourceId);
   const form=page.getByRole('group',{name:'投面辅料',exact:true});await form.waitFor();await acknowledged;
   expect(await form.getByLabel('实际数量').inputValue()).toBe('25');
   await form.getByRole('combobox',{name:/^办理状态/}).selectOption('ready');
   await form.getByLabel('本次交接物料').selectOption(diagnosis.materialId);
   await form.getByLabel('实际发生时间（北京时间）').fill(localTime);
   await form.getByLabel('实际数量').fill('75');
   await form.getByLabel('单位',{exact:true}).fill('米');
   await form.getByLabel('本次情况 / 订正原因').fill('TEST 跟单在原面板实际投出75米');
   const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/production-readiness/materials'));
   await form.getByRole('button',{name:'保存本项记录',exact:true}).click();
   const response=await receipt;expect(response.status()).toBe(200);
   expect(await response.json()).toMatchObject({sourceIsPreorderDraft:true,orderId:null,facts:expect.arrayContaining([
    expect.objectContaining({kind:'material_investment',state:'ready',version:2,recordedBy:merch.actorId,occurredAt:at,
     quantities:[expect.objectContaining({materialId:diagnosis.materialId,quantity:75,unit:'米'})]})
   ])});
   await page.getByText('已保存原业务记录',{exact:true}).waitFor();
   await page.screenshot({path:join(h.evidence,'actual-preorder-procurement-1165.png')});
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.waitForURL(url=>url.pathname.endsWith('/ui/my-tasks')&&url.searchParams.get('q')===style);
   await expect.poll(()=>page.locator('a.my-todo-row').filter({hasText:'投面辅料'}).count()).toBe(0);
   expect(await orderTimeCreated(h.db,{kind:'source',id:diagnosis.sourceId})).toBeNull();
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[diagnosis.sourceId])).rowCount).toBe(0);
   await page.goto(h.base+newPath);
   await page.getByText('没有符合当前授权及筛选的原跟单事项。',{exact:true}).waitFor();
  }finally{await tab.context.close();}
 });
 it('converts the original preorder in the wizard and keeps its handover, procurement, attachments and time',async()=>{
  const {root}=h.f, designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!;
  const style='TEST-V7-CONVERT-'+randomUUID(),at='2026-11-19T04:00:00.000Z',scene=await h.f.scene(at);
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const readiness=new ProductionReadinessService(h.db),requests=h.orderTimeRequests!;
  const picture=await h.f.image(designer);
  const original=await h.f.runtime.run(scene,designer,async()=>{
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const resource={kind:'source' as const,id:sourceId},draft=initialDevelopmentDocument();
   const fabric={...draft.materials[0]!,name:'TEST转换面料',quantity:'75米',supplier:'TEST 布行',specification:'原规格'};
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   await forms.save(designer,sourceId,{expectedVersion:0,document:{
    ...draft,quantity:1,files:[{attachmentId:picture,kind:'款图'}],materials:[fabric],patternCategoryId:category.price_id,
    productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{
     withOrder:true,stage:'preorder',wizardStep:1,order:InitialCustomerOrderDraftSchema.parse({
      customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,primaryMerchandiserId:merch.actorId,
      orderDate:'2026-11-19',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',
      lines:[{formalPoNo:style+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:'2'}]}],
     }),
    },
   }},randomUUID());
   const state=await readiness.record(designer,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',
    occurredAt:at,note:'TEST 预下单原交接',quantities:[],evidenceIds:[],sourceDocumentVersion:1,recipientId:merch.actorId},randomUUID());
   const handover=state.facts.find(fact=>fact.kind==='design_handover')!;
   return {sourceId,resource,fabric,handover};
  });
  const purchase=await h.f.runtime.run(scene,merch,async()=>{
   const state=await readiness.record(merch,original.resource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'partial',
    occurredAt:at,note:'TEST 原记录先投一段',quantities:[{lineId:null,materialId:original.fabric.materialId,name:original.fabric.name,quantity:20,unit:'米'}],
    evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
   return state.facts.find(fact=>fact.kind==='material_investment')!;
  });
  h.setCollectionScene(scene);
  await h.f.advance(scene,'2026-11-20T04:00:00.000Z');
  const tab=await h.open(designer.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page,base='/api/digital-production/sources/'+original.sourceId;
   await page.getByRole('button',{name:style,exact:true}).click();
   await page.getByRole('button',{name:'客户确认下单',exact:true}).click();
   await page.getByRole('button',{name:'确认',exact:true}).click();
   expect(await page.getByLabel('设计款号',{exact:true}).inputValue()).toBe(style);
   expect(await page.locator('#development-'+original.fabric.materialId+'-name').inputValue()).toBe(original.fabric.name);
   await page.getByRole('combobox',{name:/^衣类/}).click();
   await page.getByRole('option',{name:'上衣',exact:true}).click();
   const garment=page.getByRole('alertdialog',{name:'更正衣类'});
   await garment.getByRole('button',{name:'确认更正',exact:true}).click();
   await garment.waitFor({state:'hidden'});
   for(let i=0;i<2;i++)await page.getByRole('button',{name:'下一步',exact:true}).click();
   expect(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue()).toBe('黑');
   const intermediate=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===base+'/development');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const save=await intermediate;expect(save.status(),await save.text()).toBe(200);
   expect(await save.json()).toMatchObject({sourceId:original.sourceId,document:{customerOrderDraft:{stage:'preorder',wizardConfirmPreorder:true,wizardStep:3}}});
   const before=await h.f.runtime.run(scene,merch,()=>readiness.read(merch,original.resource));
   expect(before.facts).toEqual(expect.arrayContaining([expect.objectContaining({recordId:purchase.recordId,occurredAt:at})]));
   expect(await orderTimeCreated(h.db,original.resource)).toBeNull();
   await page.reload();
   await page.getByRole('heading',{name:'客户与交货',exact:true}).waitFor();
   expect(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue()).toBe('黑');
   const checkFor=(kind:'development_publish'|'confirm_order')=>page.waitForResponse(r=>
    r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/order-time/check')&&
    r.request().postDataJSON()?.operation?.kind===kind);
   const publishCheck=checkFor('development_publish'),confirmCheck=checkFor('confirm_order');
   const directConfirm=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname===base+'/confirm').catch(()=>null);
   await page.getByRole('button',{name:'提交并确认订单',exact:true}).click();
   const check=await publishCheck;expect(check.status(),await check.text()).toBe(200);
   const publishOutcome=await check.json();
   expect(publishOutcome.feasibility,publishOutcome.coverage.join('；')).toBe('sufficient');
   const confirmation=await confirmCheck;expect(confirmation.status(),await confirmation.text()).toBe(200);
   const outcome=await confirmation.json();
   if(outcome.feasibility==='insufficient'){
    await page.getByLabel('本单时效申请说明').fill('TEST 用原预下单继续正式确认');
    const receipt=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/order-time/requests'));
    await page.getByRole('button',{name:'提交时效调整申请',exact:true}).click();
    const requested=await receipt;expect(requested.status(),await requested.text()).toBe(200);
    const {requestId}=await requested.json();
    await h.f.runtime.run(scene,root,async()=>{
     const pending=await requests.read(root,requestId);
     expect(pending.operation.kind).toBe('confirm_order');
     const applied=await requests.apply(root,requestId,{expectedVersion:pending.version,fingerprint:pending.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
     expect(applied.state).toBe('applied');
    });
   }else{
    expect(['sufficient','not_applicable'],outcome.coverage.join('；')).toContain(outcome.feasibility);
    const confirmed=await directConfirm;
    if(!confirmed)throw Error('Missing native formal confirmation response after successful time check');
    expect(confirmed.status(),await confirmed.text()).toBe(200);
   }
   const formal=()=>h.db.query<{production_order_id:string}>('SELECT production_order_id FROM digital_production_orders WHERE source_id=$1',[original.sourceId]);
   await expect.poll(async()=>(await formal()).rowCount).toBe(1);
   const orderId=(await formal()).rows[0]!.production_order_id;
   const state=await h.f.runtime.run(scene,merch,()=>readiness.read(merch,{kind:'order',id:orderId}));
   expect(state.facts).toEqual(expect.arrayContaining([
    expect.objectContaining({recordId:original.handover.recordId,version:original.handover.version,occurredAt:at}),
    expect.objectContaining({recordId:purchase.recordId,version:purchase.version,occurredAt:at,quantities:purchase.quantities}),
   ]));
   const sheet=await h.f.runtime.run(scene,designer,()=>forms.read(designer,original.sourceId));
   expect(sheet.document?.files).toEqual([{attachmentId:picture,kind:'款图'}]);
   expect(h.requests.filter(request=>request.session===tab.session&&request.method==='POST'&&request.path==='/api/digital-production/sources/drafts')).toEqual([]);
   expect((await formal()).rowCount).toBe(1);
  }finally{try{await tab.close();}finally{h.setCollectionScene(undefined);}}
 });
 it('renews an instruction-backed handover from the original signed panel after linking a historical source',async()=>{
  const {root}=h.f,designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,style='TEST-ORDER-HANDOVER-'+randomUUID();
  const at='2026-11-19T04:00:00.000Z',renewedAt='2026-11-19T05:00:00.000Z',scene=await h.f.scene(at),requests=h.orderTimeRequests!;
  const input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-19',
   requiresColorMatching:false,salesYear:2027,salesSeries:'P03',primaryMerchandiserId:merch.actorId,
   lines:[{formalPoNo:style+'-PO',color:'黑',customerWarehouseArrivalDate:'2027-04-30',sizes:[{size:'M',quantity:2}]}]});
  const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}};
  const request=await h.f.runtime.run(scene,designer,async()=>{
   const check=await requests.check(designer,operation);
   return requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST 原入口建立直接正式单'},randomUUID());
  });
  const orderId=await h.f.runtime.run(scene,root,async()=>{
   const pending=await requests.read(root,request.requestId);
   const result=await requests.apply(root,request.requestId,{expectedVersion:pending.version,fingerprint:pending.check.fingerprint,overrides:{},acceptLate:true},randomUUID());
   expect(result.state).toBe('applied');return result.result!.orderId!;
  });
  const resource={kind:'order' as const,id:orderId},readiness=new ProductionReadinessService(h.db),instruction=new ProductionInstructionService(h.db,true);
  const fabricId=randomUUID(),revisedFabricId=randomUUID(),secondFabricId=randomUUID();
  const document={...initialInstruction(),secondaryCraft:'无' as const,preshrink:'无需预缩' as const,
   fabrics:[{id:fabricId,name:'TEST 原制单面料',part:'本身',colors:{},remarks:''}]};
  const save=async(value:typeof document)=>h.f.runtime.run(scene,merch,async()=>{
   const current=await instruction.read(merch,orderId);
   return (await instruction.save(merch,orderId,{expectedVersion:current.version,orderVersion:current.currentOrderVersion,document:value},randomUUID())).version;
  });
  const originalVersion=await save(document);
  const original=await h.f.runtime.run(scene,root,async()=>{
   const attachmentId=await h.f.image(root);
   const order=await readiness.record(root,resource,{kind:'design_handover',scopeRef:'whole',state:'ready',expectedVersion:0,
    occurredAt:at,note:'TEST 原正式制单交接',quantities:[],evidenceIds:[attachmentId],sourceDocumentVersion:null,
    orderInstructionVersion:originalVersion,recipientId:merch.actorId},randomUUID());
   const fact=order.facts.find(row=>row.kind==='design_handover')!;
   expect(fact.investmentScopeBasis?.materialIds).toEqual([fabricId]);
   const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
   const owner=(await identity.read(root,orderId)).createdBy===designer.actorId?designer:root;
   const {sourceId}=await identity.createSource(owner,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const price=(await h.db.query("SELECT price_id,version FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const source=await forms.save(owner,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,
    files:[{attachmentId:await h.f.image(owner),kind:'款图'}],patternCategoryId:price.price_id}},randomUUID());
   await forms.publish(root,sourceId,source.version,randomUUID(),{categoryId:price.price_id,priceVersion:price.version});
   expect((await identity.attachSource(root,orderId,sourceId,randomUUID())).sourceId).toBe(sourceId);
   return {fact,sourceId,attachmentId};
  });
  const latest=await save({...document,fabrics:[{...document.fabrics[0]!,id:revisedFabricId,name:'TEST 新制单面料 A'},
   {...document.fabrics[0]!,id:secondFabricId,name:'TEST 新制单面料 B'}]});
  await h.f.advance(scene,renewedAt);
  h.setCollectionScene(scene);
  const path='/ui/digital-production?materialOrder='+orderId;
  const rootTab=await h.open(root.actorId,1165,{},path+'&materialKind=design_handover');
  try{
   const page=rootTab.page,handover=page.locator('[data-preparation-kind="design_handover"]');
   await handover.getByText('凭证已失效',{exact:false}).waitFor();
   await handover.getByRole('button',{name:'追加订正',exact:true}).click();
   const form=page.getByRole('group',{name:/设计交资料/});
   await form.waitFor();
   expect.soft(await form.locator('legend').textContent()).toContain('本单制单资料第'+latest+'版');
   await form.getByLabel('实际发生时间（北京时间）').fill('2026-11-19T13:00');
   await form.getByLabel('本次情况 / 订正原因').fill('TEST 在原面板改交新版制单');
   const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/production-readiness/materials'));
   await form.getByRole('button',{name:'保存本项记录',exact:true}).click();
   const response=await receipt;
   expect(response.request().postDataJSON()).toMatchObject({expectedVersion:1,sourceDocumentVersion:null,orderInstructionVersion:latest});
   const saved=await response.json();
   expect(response.status(),saved.error?.message).toBe(200);
   expect(saved).toMatchObject({sourceId:original.sourceId,orderId,orderInstructionVersion:latest});
   expect((saved as ProductionReadinessState).facts.find(row=>row.kind==='design_handover')).toMatchObject({
    recordId:original.fact.recordId,version:2,valid:true,resource,sourceDocumentVersion:null,occurredAt:renewedAt,
    investmentScopeBasis:{orderInstructionVersion:latest,materialIds:[revisedFabricId,secondFabricId].sort()},
   });
   expect((saved as ProductionReadinessState).history.find(row=>row.recordId===original.fact.recordId&&row.version===1))
    .toMatchObject({occurredAt:at,evidenceIds:[original.attachmentId],orderInstructionVersion:originalVersion});
   await page.getByText('已保存原业务记录',{exact:true}).waitFor();
   const reloaded=page.waitForResponse(r=>r.request().method()==='GET'&&new URL(r.url()).pathname.endsWith('/orders/'+orderId+'/production-readiness'));
   await page.reload();
   const result=await reloaded;
   expect(result.status()).toBe(200);
   expect(await result.json()).toMatchObject({orderId,sourceId:original.sourceId,orderInstructionVersion:latest});
   const summary=page.locator('.preparation-readiness > details > summary');
   await summary.waitFor();
   if(!await summary.evaluate(element=>element.parentElement?.hasAttribute('open')))await summary.click();
   await handover.getByRole('button',{name:'追加订正',exact:true}).click();
   expect(await form.locator('legend').textContent()).toContain('本单制单资料第'+latest+'版');
  }finally{await rootTab.context.close();}
  const sourceTab=await h.open(root.actorId,1165,{},'/ui/digital-production?materialSource='+original.sourceId+'&materialKind=design_handover');
  try{
   const page=sourceTab.page,readinessPath=h.base+'/api/digital-production/sources/'+original.sourceId+'/production-readiness';
   const response=await page.request.get(readinessPath);
   expect(response.status()).toBe(200);
   const source=await response.json() as ProductionReadinessState;
   expect(source.orderInstructionVersion).toBeUndefined();
   expect(source.canRecord).not.toContain('design_handover');
   expect(source.facts.find(row=>row.kind==='design_handover')).toMatchObject({recordId:original.fact.recordId,version:2,resource});
   const handover=page.locator('[data-preparation-kind="design_handover"]');
   await handover.waitFor();
   expect(await handover.getByRole('button',{name:'追加订正',exact:true}).count()).toBe(0);
   const rejected=await page.request.post(readinessPath+'/materials',{
    headers:{'idempotency-key':randomUUID()},
    data:{kind:'design_handover',scopeRef:'whole',state:'ready',expectedVersion:2,occurredAt:renewedAt,
     note:'TEST 开发来源不能续接原正式制单',recipientId:merch.actorId,orderInstructionVersion:latest},
   });
   expect(rejected.status()).toBe(403);
  }finally{await sourceTab.context.close();}
  await h.f.advance(scene,'2026-11-19T05:10:00.000Z');
  const merchTab=await h.open(merch.actorId,1165,{},path+'&materialKind=material_investment');
  try{
   const page=merchTab.page,form=page.getByRole('group',{name:'投面辅料',exact:true});
   const selection=form.getByLabel('本次交接物料');
   const actualTime=form.getByLabel('实际发生时间（北京时间）');
   const submit=async(materialId:string,note:string,quantity:string,occurredAt?:string,unit='米')=>{
    await selection.selectOption(materialId);
    await form.getByLabel('办理状态').selectOption('ready');
    if(occurredAt)await actualTime.fill(occurredAt);
    await form.getByLabel('实际数量').fill(quantity);
    await form.getByLabel('单位',{exact:true}).fill(unit);
    await form.getByLabel('本次情况 / 订正原因').fill(note);
    const receipt=page.waitForResponse(response=>response.request().method()==='POST'&&new URL(response.url()).pathname.endsWith('/production-readiness/materials'));
    await form.getByRole('button',{name:'保存本项记录',exact:true}).click();
    const response=await receipt,saved=await response.json();
    expect(response.status(),saved.error?.message).toBe(200);
    await page.getByText('已保存原业务记录',{exact:true}).waitFor();
    return {saved:saved as ProductionReadinessState,request:response.request().postDataJSON()};
   };
   const first=await submit(revisedFabricId,'TEST 跟单初次录入 A','20','2026-11-19T13:02');
   expect(await selection.locator('option[value="'+fabricId+'"]').count()).toBe(0);
   const originalInvestment=first.saved.facts.find(row=>row.kind==='material_investment')!;
   expect(originalInvestment).toMatchObject({version:1,state:'partial',recordedBy:merch.actorId,quantities:[{materialId:revisedFabricId,quantity:20}]});
   const rowPicker=form.getByLabel('本次修改的物料明细');
   await rowPicker.selectOption('0');
   const corrected=await submit(secondFabricId,'TEST 原 A 误记，订正为 B','12','2026-11-19T13:03');
   expect(corrected.request).toMatchObject({expectedVersion:1,investmentQuantityCorrection:{index:0,previous:{materialId:revisedFabricId}}});
   const replacement=corrected.saved.facts.find(row=>row.kind==='material_investment')!;
   expect(replacement).toMatchObject({recordId:originalInvestment.recordId,version:2,state:'partial',quantities:[{materialId:secondFabricId,quantity:12}]});
   expect(replacement.investmentMaterialOccurrences?.[revisedFabricId]).toBeUndefined();
   expect(corrected.saved.history.find(row=>row.recordId===originalInvestment.recordId&&row.version===1)?.quantities).toEqual(originalInvestment.quantities);
   await rowPicker.selectOption('0');
   await submit(revisedFabricId,'TEST 确认可记 A 的真实投料','20','2026-11-19T13:04');
   await rowPicker.selectOption('new');
   expect.soft(await actualTime.inputValue()).toBe('');
   const appended=await submit(secondFabricId,'TEST 独立追加真实 B','12','2026-11-19T13:05');
   expect(appended.request.investmentQuantityCorrection).toBeUndefined();
   expect(appended.saved).toMatchObject({orderId});
   expect(appended.saved.facts.find(row=>row.kind==='material_investment')).toMatchObject({
    recordId:originalInvestment.recordId,version:4,state:'ready',quantities:[{materialId:revisedFabricId,quantity:20},{materialId:secondFabricId,quantity:12}],
   });
   await rowPicker.selectOption('1');
   expect(await actualTime.inputValue()).toBe('2026-11-19T13:05');
   await rowPicker.selectOption('0');
   expect(await actualTime.inputValue()).toBe('2026-11-19T13:04');
   const lineId=appended.saved.lines[0]!.lineId;
   await form.getByLabel('对应款色').selectOption(lineId);
   const metadataOnly=await submit(revisedFabricId,'TEST 仅订正 A 的单位和 PO','20',undefined,'码');
   expect(metadataOnly.request.occurredAt).toBe('2026-11-19T05:04:00.000Z');
   expect(metadataOnly.saved.facts.find(row=>row.kind==='material_investment')).toMatchObject({
    occurredAt:'2026-11-19T05:05:00.000Z',
    investmentMaterialOccurrences:{
     [revisedFabricId]:{occurredAt:'2026-11-19T05:04:00.000Z'},
     [secondFabricId]:{occurredAt:'2026-11-19T05:05:00.000Z'},
    },
    quantities:[{materialId:revisedFabricId,lineId,unit:'码'},{materialId:secondFabricId}],
   });
   const changedTime=await submit(revisedFabricId,'TEST 明确订正 A 的实际时刻','20','2026-11-19T13:06','码');
   expect(changedTime.saved.facts.find(row=>row.kind==='material_investment')).toMatchObject({
    occurredAt:'2026-11-19T05:06:00.000Z',
    investmentMaterialOccurrences:{[revisedFabricId]:{occurredAt:'2026-11-19T05:06:00.000Z'},[secondFabricId]:{occurredAt:'2026-11-19T05:05:00.000Z'}},
   });
   await form.getByLabel('补充凭证（可选，图片或PDF）').waitFor();
   const tasks=new DigitalProductionTaskService(h.db,'TEST native browser cancellation');
   await h.f.runtime.run(scene,merch,()=>tasks.controlResource(merch,resource,'cancel','TEST cancel from original workflow',randomUUID()));
   const readinessPath=`/api/digital-production/orders/${orderId}/production-readiness`;
   const reloaded=page.waitForResponse(response=>response.request().method()==='GET'&&new URL(response.url()).pathname===readinessPath);
   await page.reload();
   const response=await reloaded;
   expect(response.status()).toBe(200);
   expect(await response.json()).toMatchObject({canRecord:[],history:changedTime.saved.history});
   const panel=page.locator('.preparation-readiness');
   await panel.locator('[data-preparation-kind="material_investment"]').waitFor();
   expect(await form.count()).toBe(0);
   expect(await panel.getByLabel('补充凭证（可选，图片或PDF）').count()).toBe(0);
   const history=panel.getByText(/^原记录与历史版本/).locator('..');
   await history.locator('summary').click();
   await history.getByText(/^TEST 明确订正 A 的实际时刻 · /).waitFor();
   await history.locator('article').filter({hasText:'TEST 原正式制单交接'}).locator(`a[href$="/attachments/${original.attachmentId}"]`).waitFor();
   expect((await page.request.get(h.base+readinessPath+'/attachments/'+original.attachmentId,{maxRedirects:0})).status()).toBe(302);
  }finally{await merchTab.close();}
 });
});
