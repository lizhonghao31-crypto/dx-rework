import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
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
});
