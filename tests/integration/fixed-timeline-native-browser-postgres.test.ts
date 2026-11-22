import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {afterEach,beforeEach,describe,it,expect,vi} from 'vitest';
import type {Page} from 'playwright-core';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';
import {cockpitHomeBrowser} from '../acceptance/m01-cockpit-home-native-browser.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {DigitalProductionTaskService} from '../../apps/api/src/production-platform/task-service.js';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {orderTimeCreated} from '../../apps/api/src/production-platform/order-time-created.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('fixed timeline choices through the original production App and AuthService',()=>{
 let h:Awaited<ReturnType<typeof cockpitHomeBrowser>>;
 const dismiss=async(page:Page)=>{const notice=page.locator('[aria-label="站内提醒"]');if(await notice.isVisible())await notice.getByRole('button',{name:'我知道了',exact:true}).click();};
 beforeEach(async()=>{
  h=await cockpitHomeBrowser({databaseUrl:url!,productionAssets:true,fixtureProfile:'navigation',evidence:join(process.env.M01_SETTINGS_NATIVE_EVIDENCE??tmpdir(),'fixed-timeline-'+randomUUID()),...(process.env.M01_SETTINGS_BROWSER_EXECUTABLE?{executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE}:{})});
  configureTimelineAdoption(h.fixture.db,'fixed_v2');
 });
 afterEach(async()=>{if(h){configureTimelineAdoption(h.fixture.db,'legacy');await h.dispose();}});
 it('saves the actual chosen craft order as a native draft and restores it at1165px',async()=>{
  const {db,root}=h.fixture,settings=new OrderTimeSettingsService(db);
  const current=await settings.read(root);
  await settings.save(root,{expectedVersion:current.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const {context,page}=await h.open(undefined,{},1165);try{
   await page.goto(h.base+'/ui/digital-production?workspace=designer&section=create');await page.getByRole('button',{name:'新建开发订单',exact:true}).waitFor();await dismiss(page);await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   const choices=page.getByRole('group',{name:'工艺',exact:true});await choices.waitFor();
   await page.getByRole('textbox',{name:'设计款号',exact:true}).fill('TEST-FIXED-UI-'+randomUUID());
   await choices.getByRole('checkbox',{name:'印花',exact:true}).check();await choices.getByRole('checkbox',{name:'绣花',exact:true}).check();
   expect(await choices.getByRole('combobox',{name:'工艺先后顺序'}).inputValue()).toBe('printing');
   await choices.getByRole('combobox',{name:'工艺先后顺序'}).selectOption('embroidery');
   const saved=page.waitForResponse(response=>/\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();const response=await saved;expect(response.status()).toBe(200);
   const sheet=await response.json();
   expect(sheet).toMatchObject({orderTimeEnabled:true,timelineSchemaVersion:2,status:'draft',productionOrderId:null,publishedAt:null});
   expect(await orderTimeCreated(db,{kind:'source',id:sheet.sourceId})).toBeNull();
   expect(sheet.document.craftSteps).toEqual([{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}]);
   await page.goto(h.base+'/ui/digital-production?development='+sheet.sourceId);
   await page.getByRole('group',{name:'工艺',exact:true}).waitFor();expect(await page.getByRole('combobox',{name:'工艺先后顺序'}).inputValue()).toBe('embroidery');
   await page.screenshot({path:join(h.evidence,'development-independent-craft-1165.png'),fullPage:true});expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('keeps native factory movement forms on the selected step and the warehouse on terminal returns',async()=>{
  const ready=await h.runInScene(()=>h.fixture.bulkReady('印绣花',undefined,1,h.fixture.sourcing,{craftSteps:[{craftKind:'printing',sequence:1},{craftKind:'embroidery',sequence:2}]}));
  await h.runInScene(async()=>{
   const cutter={...h.fixture.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};
   const cuts=(await h.fixture.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows;
   for(const cut of cuts)await ready.cutting.record(cutter,cut.cutting_order_id,{pieceCount:1,actualCutCount:10,attachmentIds:[await h.fixture.image(cutter)]},randomUUID());
   const rows=(await h.fixture.db.query("SELECT a.task_id,a.required_role FROM digital_production_task_access a WHERE production_order_id=$1 AND task_kind IN ('process_logistics','bulk_qc')",[ready.id])).rows;
   for(const row of rows){const person=Object.values(h.fixture.people).find(person=>person.actorRoles.includes(row.required_role))!;await new DigitalProductionTaskService(h.fixture.db).reassign(h.fixture.root,row.task_id,person.actorId,randomUUID());}
  });
  const {context,page}=await h.open(undefined,{},1165);try{
   await page.goto(h.base+'/ui/digital-production?factory='+ready.id);await page.getByRole('combobox',{name:'办理工艺',exact:true}).waitFor();await dismiss(page);
   const picker=page.getByRole('combobox',{name:'办理工艺',exact:true});expect(await picker.locator('option').allTextContents()).toEqual(['1. 印花','2. 绣花']);
   await picker.selectOption({label:'2. 绣花'});expect(await page.getByRole('combobox',{name:'来源',exact:true}).innerText()).toContain('请选择前道回仓');
   expect(await page.getByLabel('末道回仓批次',{exact:true}).locator('option').count()).toBe(0);
   await page.screenshot({path:join(h.evidence,'factory-step-controls-1165.png'),fullPage:true});expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
});
