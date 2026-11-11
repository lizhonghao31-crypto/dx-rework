import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import type {Page} from 'playwright-core';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {orderTimeTodos} from '../../apps/api/src/production-platform/order-time-todos.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 original App per-order time application, processing and recovery',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,scene:string;
 const source=async(label:string,date='2027-01-07')=>h.f.runtime.run(scene,h.f.root,async()=>{
  const original=h.f.people['sample-designer']!,actor={...original,authorizationCapabilities:[...original.authorizationCapabilities!,'pattern_room:orders:view']};
  const designStyleNo='TEST-R507-UI-'+label+'-'+randomUUID(),item=await new DigitalProductionIdentityService(h.db,true).createSource(actor,{developmentType:'头版',designStyleNo,temporaryStyleNo:null,customerCode:null},randomUUID());
  const category=(await h.db.query("SELECT price_id,name FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0];
  const document=DevelopmentDocumentSchema.parse({documentFormatVersion:2,sizeQuantities:[1],template:'上衣',quantity:1,sampleSize:'M',orderDate:null,returnDate:date,unit:'cm',sizes:['M'],measurements:[{name:'胸围',values:['50']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST 浏览器原生开发资料',craft:'无',washing:'免洗',materials:[],files:[{attachmentId:await h.f.image(actor),kind:'款图'}],patternCategoryId:category.price_id});
  await new DigitalDevelopmentService(h.db,true,h.patternOrders).save(actor,item.sourceId,{expectedVersion:0,document},randomUUID());
  return {...item,designStyleNo,actor,category};
 });
 const applyPage=async(page:Page)=>{await page.getByRole('heading',{name:'本单时效调整',exact:false}).waitFor();};
 const requestFromOriginalPage=async(label:string)=>{
  const original=await source(label),tab=await h.open(original.actor.actorId,1586,{},'/ui/digital-production?development='+original.sourceId);
  try{
   await tab.page.getByRole('button',{name:'发布开发单',exact:true}).waitFor();
   await tab.page.getByRole('button',{name:'打板信息',exact:true}).click();
   await expect.poll(()=>tab.page.getByRole('button',{name:'发布开发单',exact:true}).isEnabled()).toBe(true);
   await tab.page.getByRole('button',{name:'发布开发单',exact:true}).click();
   const application=tab.page.getByRole('region',{name:'本单时效申请'});
   await application.waitFor();await application.getByLabel('本单时效申请说明',{exact:true}).fill('TEST 确认原资料，申请安排本单时间');
   await application.getByRole('button',{name:'提交时效调整申请',exact:true}).click();
   await expect.poll(()=>new URL(tab.page.url()).searchParams.get('timeRequest')).not.toBeNull();
   const requestId=new URL(tab.page.url()).searchParams.get('timeRequest')!;await applyPage(tab.page);
   expect(await tab.page.getByRole('button',{name:'提交',exact:true}).count()).toBe(0);
   expect((await h.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
   return {...original,requestId};
  }finally{await tab.context.close();}
 };
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,process.env.R507_BROWSER_EVIDENCE??join(process.env.RUNNER_TEMP??tmpdir(),'r507-ui-'+randomUUID()),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});
  await new OrderTimeSettingsService(h.db).save(h.f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());
  scene=await h.f.scene('2027-01-07T15:00:00.000Z');h.setCollectionScene(scene);
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('opens the genuine manager todo, adjusts only this order and applies once after a lost receipt with no designer reconfirmation',async()=>{
  const row=await requestFromOriginalPage('compressed'),manager=h.f.people['production-management']!,path='/api/digital-production/order-time/requests/'+row.requestId+'/apply';
  const tab=await h.open(manager.actorId,1586,{losePath:path},'/ui/my-tasks?q='+encodeURIComponent(row.designStyleNo));
  try{
   const link=tab.page.locator('a.my-todo-row').filter({hasText:row.designStyleNo});await link.waitFor();expect(await link.getAttribute('href')).toContain('timeRequest='+row.requestId);await link.click();await applyPage(tab.page);
   const inputs=tab.page.locator('.r5-time-table input[inputmode="decimal"]');
   for(let i=0;i<await inputs.count();i++){const input=inputs.nth(i);if(await input.isEnabled()){const row=input.locator('xpath=ancestor::tr');await row.getByRole('combobox',{name:/用时单位$/}).selectOption('minutes');await input.fill((await row.innerText()).includes('跟随所属工序')?'2':'10');}}
   await expect.poll(()=>tab.page.locator('.r5-time-sufficient').count()).toBe(1);
   for(const width of [1586,1165]){
    await tab.page.setViewportSize({width,height:992});await tab.page.getByRole('heading',{name:'本单时效调整',exact:false}).scrollIntoViewIfNeeded();expect(await tab.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const row=tab.page.locator('.r5-time-table tbody tr').filter({has:tab.page.getByRole('switch')}).first();
    const layout=await row.evaluate(element=>({height:element.getBoundingClientRect().height,labels:[...element.querySelectorAll('label')].map(label=>({direction:getComputedStyle(label).flexDirection,wrap:getComputedStyle(label).flexWrap,display:getComputedStyle(label).display,width:label.getBoundingClientRect().width,height:label.getBoundingClientRect().height}))}));
    expect(layout.height,JSON.stringify(layout)).toBeLessThan(90);
    await tab.page.screenshot({path:join(h.evidence,'r507-adjust-'+width+'.png'),fullPage:true});
   }
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();await tab.page.getByRole('button',{name:'核对上次提交结果',exact:true}).click();await tab.page.getByText('本单安排已生效，设计师无需再次确认。',{exact:true}).waitFor();
   const calls=h.requests.filter(call=>call.session===tab.session&&call.path===path);expect(calls).toHaveLength(2);expect(new Set(calls.map(call=>call.key)).size).toBe(1);expect(new Set(calls.map(call=>call.bodyHash)).size).toBe(1);
   expect((await h.db.query('SELECT 1 FROM digital_development_pattern_links WHERE source_id=$1',[row.sourceId])).rowCount).toBe(1);
   const policy=await new OrderTimePlanRepository(h.db).current({kind:'source',id:row.sourceId});expect(policy?.time.now).toBe('2027-01-07T15:00:00.000Z');
   await h.f.runtime.run(scene,h.f.root,async()=>{expect((await orderTimeTodos(h.db,h.f.root)).some(todo=>todo.todoId===row.requestId)).toBe(false);});
  }finally{await tab.context.close();}
 });
 it('keeps a late decision in the same confirmation dialog, permits cancellation and retains its real risk on confirmation',async()=>{
  const row=await requestFromOriginalPage('late'),tab=await h.open(undefined,1586,{},'/ui/digital-production?timeRequest='+row.requestId);
  try{
   await applyPage(tab.page);await tab.page.getByRole('button',{name:'提交',exact:true}).click();const dialog=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});await dialog.waitFor();
   expect(await dialog.innerText()).toContain('0.17天');await tab.page.screenshot({path:join(h.evidence,'r507-late-confirmation-1586.png'),fullPage:false});
   await dialog.getByRole('button',{name:'取消',exact:true}).click();expect((await h.db.query('SELECT state FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].state).toBe('pending');
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();await dialog.getByRole('button',{name:'确认',exact:true}).click();await tab.page.getByText('本单安排已生效，设计师无需再次确认。',{exact:true}).waitFor();
   expect((await h.db.query('SELECT result_late_minutes FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].result_late_minutes).toBe('240');
  }finally{await tab.context.close();}
 });
 it('rejects a genuine manager role revoked in the same valid session while keeping the unsaved adjustment',async()=>{
  const row=await requestFromOriginalPage('revocation'),manager=h.f.people['production-management']!,assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0];
  await h.f.access.assignRole(h.admin,{userId:manager.actorId,roleCode:'sample_designer',reason:'TEST 保留有效业务登录，仅撤销本单时效办理角色'});
  const tab=await h.open(manager.actorId,1440,{},'/ui/digital-production?timeRequest='+row.requestId);
  try{
   await applyPage(tab.page);
   const previewed=tab.page.waitForResponse(response=>response.url().endsWith('/order-time/requests/'+row.requestId+'/preview')&&response.status()===200);
   await tab.page.getByLabel('开发纸样本次用时',{exact:true}).fill('0.5');await previewed;
   await expect.poll(()=>tab.page.locator('.r5-time-changes').innerText()).toContain('30分钟');
   await h.f.access.revokeRole(h.admin,assignment.assignment_id,'TEST 同一有效会话撤销时效办理角色');
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();const dialog=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});if(await dialog.count())await dialog.getByRole('button',{name:'确认',exact:true}).click();
   await expect.poll(()=>h.requests.filter(call=>call.session===tab.session&&call.path.endsWith('/apply')).at(-1)?.status).toBe(403);
   expect(await tab.page.getByLabel('开发纸样本次用时',{exact:true}).inputValue()).toBe('0.5');expect((await h.db.query('SELECT state FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].state).toBe('pending');
   expect(h.requests.filter(call=>call.session===tab.session&&call.status===401)).toHaveLength(0);
  }finally{await tab.context.close();}
 });
});
