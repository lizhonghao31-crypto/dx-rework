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
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
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
  }finally{await merchTab.context.close();}
 });
});
