import {r5RoleFixture} from '../helpers/r5-role-fixture.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {OrderTimeRequestService} from '../../apps/api/src/production-platform/order-time-request-service.js';
import {orderTimeNativeExecutor} from '../../apps/api/src/production-platform/order-time-native-commands.js';
import {SourcingService} from '../../apps/api/src/sourcing/sourcing-service.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {randomUUID,createHash} from 'node:crypto';
import {join} from 'node:path';
import {writeFile} from 'node:fs/promises';
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
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {arrangeTestRound} from '../helpers/development-arrangement-fixture.js';
import {ORDER_TIME_NODES} from '@dx-rework/contracts/order-time-settings';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {DeliveryCalendarFiltersSchema} from '@dx-rework/contracts/delivery-calendar';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {FactoryFlowService} from '../../apps/api/src/production-platform/factory-flow-service.js';
import {ProductionReportingService} from '../../apps/api/src/sourcing/production-reporting-service.js';
import {ReceivingService} from '../../apps/api/src/receiving/receiving-service.js';
import {OrderClosureService} from '../../apps/api/src/production-platform/order-closure-service.js';
import {DeliveryCalendarQuery} from '../../apps/api/src/production-platform/delivery-calendar-query.js';
import {JourneyFactRepository} from '../../apps/api/src/production-platform/journey-fact-repository.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {JourneyFilterSchema,journeyReturnUrl,type OrderJourney} from '@dx-rework/contracts/digital-production-journey';


vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('R5 original App per-order time application, processing and recovery',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>,scene:string;
 const source=async(label:string,date:string|null='2027-01-07',customerCode:string|null=null)=>h.f.runtime.run(scene,h.f.root,async()=>{
  const original=h.f.people['sample-designer']!,actor={...original,authorizationCapabilities:[...original.authorizationCapabilities!,'pattern_room:orders:view']};
  const designStyleNo='TEST-R507-UI-'+label+'-'+randomUUID(),item=await new DigitalProductionIdentityService(h.db,true).createSource(actor,{developmentType:'头版',designStyleNo,temporaryStyleNo:null,customerCode},randomUUID());
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
   // Locator.click owns native actionability, including the real asynchronous
   // calendar/category-price loads. A separate1s poll is not that contract.
   await tab.page.getByRole('button',{name:'发布开发单',exact:true}).click();
   const application=tab.page.getByRole('region',{name:'本单时效申请'});
   await application.waitFor();await application.getByLabel('本单时效申请说明',{exact:true}).fill('TEST 确认原资料，申请安排本单时间');
   const opened=tab.page.waitForURL(url=>Boolean(url.searchParams.get('timeRequest')));
   await application.getByRole('button',{name:'提交时效调整申请',exact:true}).click();await opened;
   const requestId=new URL(tab.page.url()).searchParams.get('timeRequest')!;await applyPage(tab.page);
   expect(await tab.page.getByRole('button',{name:'提交',exact:true}).count()).toBe(0);
   expect((await h.db.query('SELECT 1 FROM digital_production_task_access WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
   return {...original,requestId};
  }finally{await tab.context.close();}
 };
 beforeAll(async()=>{
  h=await supplychainSettingsBrowser(url!,process.env.R507_BROWSER_EVIDENCE??join(process.env.RUNNER_TEMP??tmpdir(),'r507-ui-'+randomUUID()),{fullApp:true,orderTimeModel:true,orderTimeFlow:true});
  await new OrderTimeSettingsService(h.db,true,false).save(h.f.root,{expectedVersion:0,values:r5OneHourConfiguration()},randomUUID());
  scene=await h.f.scene('2027-01-07T15:00:00.000Z');h.setCollectionScene(scene);
 });
 it('opens the exact native request as a read-only original and returns to the same designer directory',async()=>{
  const row=await requestFromOriginalPage('original-directory');
  const query=new URLSearchParams({workspace:'designer',section:'workspace',development:row.sourceId,area:'records',originalStage:'creation',originalCategory:'time_requests'});
  const designer=await h.open(row.actor.actorId,1165,{},'/ui/digital-production?'+query);
  try{
   const link=designer.page.getByRole('link',{name:'时效申请 · v1 · 待处理',exact:true});
   await link.waitFor();const href=new URL((await link.getAttribute('href'))!,designer.page.url());
   expect(href.searchParams.get('timeRequest')).toBe(row.requestId);expect(href.searchParams.get('requestVersion')).toBe('1');
   await link.click();await applyPage(designer.page);
   await designer.page.getByText('版本 1 · 只读',{exact:true}).waitFor();
   expect(await designer.page.getByRole('button',{name:'撤回申请',exact:true}).count()).toBe(0);
   await designer.page.getByRole('button',{name:'返回',exact:true}).click();await link.waitFor();
   expect(new URL(designer.page.url()).searchParams.get('development')).toBe(row.sourceId);
   expect(new URL(designer.page.url()).searchParams.get('originalCategory')).toBe('time_requests');
   expect(h.requests.filter(request=>request.session===designer.session&&request.method!=='GET'&&request.path.includes('/order-time/requests/'))).toEqual([]);
   const directoryPath=`**/api/digital-production/sources/${row.sourceId}/order-time/original-requests?*`;
   const pageReads:number[]=[];
   await designer.page.route(directoryPath,async route=>{
    const response=await route.fetch(),body=await response.json(),page=Number(new URL(route.request().url()).searchParams.get('page'));
    expect(response.status()).toBe(200);pageReads.push(page);
    // Keep the real authorized v1 for opening. Supply a larger total only to exercise the page controls.
    await route.fulfill({response,json:{...body,total:16}});
   });
   await designer.page.reload();await link.waitFor();
   const jump=designer.page.getByRole('textbox',{name:'跳转页码',exact:true});
   const pageError=designer.page.getByRole('region',{name:'订单相关单据',exact:true}).getByText('请输入 1 至 2 的整数页码',{exact:true});
   await jump.fill('999');await jump.press('Enter');
   await pageError.waitFor();
   expect(pageReads).toEqual([1]);
   await jump.fill('0');await designer.page.getByRole('button',{name:'跳转',exact:true}).click();
   await pageError.waitFor();
   expect(pageReads).toEqual([1]);
   await jump.fill('2');await jump.press('Enter');
   await designer.page.getByText('本页没有时效申请，请返回有效页。',{exact:true}).waitFor();
   expect(pageReads).toEqual([1,2]);
   await designer.page.unroute(directoryPath);
  }finally{await designer.close();}
  const manager=h.f.people['production-management']!;
  const mismatch=await h.open(manager.actorId,1165,{},`/ui/digital-production?timeRequest=${row.requestId}&requestVersion=2`);
  try{await mismatch.page.getByRole('alert').filter({hasText:'所选申请版本没有可打开的原件'}).waitFor();
   expect(await mismatch.page.getByRole('button',{name:'提交',exact:true}).count()).toBe(0);
  }finally{await mismatch.close();}
 });
 for(const operation of ['publish','confirm'] as const)it(`keeps a failed ${operation} precheck separate from an unsent native command in the original designer App`,async()=>{
  const original=await source('precheck-'+operation,null,operation==='confirm'?'PD':null),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  if(operation==='confirm')await h.f.runtime.run(scene,original.actor,async()=>{
   const current=await forms.read(original.actor,original.sourceId),document={...current.document!,productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal' as const,order:{customerCode:'PD',productGroup:'男装',designStyleNo:original.designStyleNo,temporaryStyleNo:null,primaryMerchandiserId:h.f.people.merchandiser!.actorId,orderDate:'2027-01-07',contractDeliveryDate:null,lines:[{formalPoNo:original.designStyleNo+'-PO',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'黑',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:'2027-04-01',sizes:[{size:'M',quantity:'10'}]}]}}};
   const saved=await forms.save(original.actor,original.sourceId,{expectedVersion:current.version,document:DevelopmentDocumentSchema.parse(document)},randomUUID()),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',original.category.price_id);
   await forms.publish(original.actor,original.sourceId,saved.version,randomUUID(),{categoryId:original.category.price_id,priceVersion:price.version});
  });
  if(operation==='confirm'){
   const editor=await h.open(original.actor.actorId,1165,{},'/ui/digital-production?workspace=designer&development='+original.sourceId);
   try{
    const begin=editor.page.getByRole('button',{name:'客户确定订单',exact:true});
    await begin.waitFor();
    const reads=()=>h.requests.filter(request=>request.session===editor.session&&request.method==='GET').map(request=>new URL(request.path,'http://localhost'));
    const sheets=()=>reads().filter(read=>read.pathname===`/api/digital-production/sources/${original.sourceId}/development`);
    expect(sheets()).toHaveLength(1);
    const directory=reads().filter(read=>read.pathname==='/api/digital-production/workspaces/designer');
    expect(directory.map(read=>read.searchParams.get('search'))).toEqual([original.sourceId]);
    const [fresh]=await Promise.all([
     editor.page.waitForResponse(response=>response.request().method()==='GET'&&
      new URL(response.url()).pathname===`/api/digital-production/sources/${original.sourceId}/development`),
     begin.click(),
    ]);
    expect(fresh.status()).toBe(200);
    await editor.page.locator('.development-breadcrumb').getByText('客户确定订单',{exact:true}).waitFor();
    expect(sheets()).toHaveLength(2);
    expect(h.requests.filter(request=>request.session===editor.session&&request.method==='POST'&&request.path.endsWith('/confirm'))).toEqual([]);
   }finally{await editor.context.close();}
   const documentTab=await h.open(original.actor.actorId,1165,{},`/ui/digital-production?workspace=designer&development=${original.sourceId}&round=1&documentCategory=customer`);
   try{
    const {page,session}=documentTab,confirm=page.getByRole('button',{name:'客户确定订单',exact:true});
    const sheetReads=()=>h.requests.filter(request=>request.session===session&&request.method==='GET')
     .map(request=>new URL(request.path,'http://localhost')).filter(read=>read.pathname===`/api/digital-production/sources/${original.sourceId}/development`);
    await page.getByRole('heading',{name:'第 1 轮客户确认与寄样资料',exact:true}).waitFor();
    await confirm.waitFor();
    expect(sheetReads().map(read=>read.searchParams.get('round'))).toEqual(['1']);
    await page.getByRole('button',{name:'面辅料与检测报告',exact:true}).click();
    await page.getByRole('heading',{name:'面辅料与检测报告',exact:true}).waitFor();
    await page.getByRole('button',{name:'其他关联单据',exact:true}).click();
    await page.getByRole('heading',{name:'其他关联单据',exact:true}).waitFor();
    await confirm.waitFor();
    expect(sheetReads()).toHaveLength(1);
    await page.reload();
    await page.getByRole('heading',{name:'其他关联单据',exact:true}).waitFor();
    await confirm.waitFor();
    expect(sheetReads().map(read=>read.searchParams.get('round'))).toEqual(['1','1']);
    expect(h.requests.filter(request=>request.session===session&&request.method==='POST'&&request.path.endsWith('/confirm'))).toEqual([]);
   }finally{await documentTab.context.close();}
  }
  const entry=operation==='confirm'?`/ui/digital-production?workspace=designer&section=workspace&area=customer&development=${original.sourceId}`:'/ui/digital-production?development='+original.sourceId;
  const tab=await h.open(original.actor.actorId,operation==='publish'?1165:390,{},entry),path=`/api/digital-production/sources/${original.sourceId}/${operation==='publish'?'development/publish':'confirm'}`;
  let checks=0;
  try{
   // Only the named check transport fails. Original auth, saved source, form,
   // publication/confirmation commands and all later requests stay native.
   await tab.page.route('**/api/digital-production/order-time/check',async route=>{checks++;await route.fulfill({status:500,contentType:'application/json',headers:{'x-request-id':'TEST-read-check-'+operation},body:JSON.stringify({error:{code:'INTERNAL_ERROR',message:'原提交结果尚未确认，请先核对原记录，不要重复提交'}})});});
   if(operation==='publish')await tab.page.getByRole('button',{name:'打板信息',exact:true}).click();
   else await tab.page.getByRole('region',{name:'客户与报价'}).getByRole('button',{name:'客户确认下单',exact:true}).click();
   const button=operation==='publish'?tab.page.getByRole('button',{name:'发布开发单',exact:true})
    :tab.page.getByRole('region',{name:'客户与报价'}).getByRole('button',{name:'确认下单',exact:true});
   if(operation==='confirm')expect(await tab.page.getByRole('region',{name:'版单资料'}).getByRole('button',{name:/确认.*订单|确认下单/}).count()).toBe(0);
   for(let attempt=0;attempt<2;attempt++){
    const check=tab.page.waitForResponse(response=>response.url().endsWith('/order-time/check')&&response.request().method()==='POST');
    await button.click();expect((await check).status()).toBe(500);await tab.page.getByRole('status').filter({hasText:operation==='publish'?'本次开发发布尚未发送':'本次客户订单确认尚未发送'}).waitFor();
    await expect.poll(()=>button.isEnabled()).toBe(true);
    expect(await tab.page.getByRole('region',{name:'原提交结果待核对',exact:true}).count()).toBe(0);
    expect(h.requests.filter(request=>request.session===tab.session&&request.method==='POST'&&request.path===path)).toHaveLength(0);
   }
   expect(checks).toBe(2);expect((await forms.read(original.actor,original.sourceId)).status).toBe(operation==='publish'?'draft':'published');
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
   await tab.page.screenshot({path:join(h.evidence,`failed-${operation}-read-check.png`),fullPage:true});
   await tab.page.unroute('**/api/digital-production/order-time/check');
   const command=tab.page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');
   await button.click();const response=await command;expect(response.status(),await response.text()).toBe(200);
   expect(h.requests.filter(request=>request.session===tab.session&&request.method==='POST'&&request.path===path)).toHaveLength(1);
   if(operation==='confirm'){
    const created=await response.json();
    try {await tab.page.getByRole('link',{name:'查看关联客户订单',exact:true}).waitFor();}
    catch(error){await writeFile(join(h.evidence,'workbench-confirm-result.txt'),[tab.page.url(),String(created.productionOrderId),await tab.page.locator('body').innerText()].join('\n'));throw error;}
    expect(new URL((await tab.page.getByRole('link',{name:'查看关联客户订单',exact:true}).getAttribute('href'))!,tab.page.url()).searchParams.get('order')).toBe(created.productionOrderId);
    expect(new URL(tab.page.url()).searchParams.get('development')).toBe(original.sourceId);
    expect(new URL(tab.page.url()).searchParams.get('area')).toBe('customer');
    expect(await tab.page.getByRole('navigation',{name:'本单区域'}).getByRole('link').count()).toBe(6);
   }
  }finally{await tab.context.close();}
 });
 it('publishes from the original designer App with its optional sample date empty, without a false time application or fabricated date',async()=>{
  const original=await source('optional-date',null),tab=await h.open(original.actor.actorId,1165,{},'/ui/digital-production?development='+original.sourceId);
  let releasePublish=()=>{};
  try{
   await tab.page.getByRole('button',{name:'打板信息',exact:true}).click();
   const date=tab.page.getByLabel('预计样板完成日期',{exact:true});expect(await date.inputValue()).toBe('');
   const publish=tab.page.getByRole('button',{name:'发布开发单',exact:true});
   const path=`/api/digital-production/sources/${original.sourceId}/development/publish`;
   let entered!:()=>void;const started=new Promise<void>(resolve=>{entered=resolve;}),pending=new Promise<void>(resolve=>{releasePublish=resolve;});
   await tab.page.route('**'+path,async route=>{entered();await pending;await route.continue();});
   const publication=tab.page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');
   const response=tab.page.waitForResponse(response=>response.url().endsWith('/order-time/check'));
   await publish.click();const checked=await response;expect(checked.status()).toBe(200);expect(await checked.json()).toMatchObject({feasibility:'not_applicable',availableMinutes:null,lateMinutes:null});
   // A successful preflight cannot certify the later publication. Hold only
   // its transport before forwarding to prove the native draft/disabled state.
   await started;expect((await h.db.query('SELECT status FROM digital_development_documents WHERE source_id=$1',[original.sourceId])).rows[0]?.status).toBe('draft');
   expect(await tab.page.getByRole('button',{name:'保存中…',exact:true}).isDisabled()).toBe(true);
   releasePublish();const receipt=await publication,body=await receipt.json();expect({status:receipt.status(),body}).toMatchObject({status:200,body:{status:'published',document:{returnDate:null}}});
   expect((await h.db.query('SELECT status FROM digital_development_documents WHERE source_id=$1',[original.sourceId])).rows[0]?.status).toBe('published');
   expect(h.requests.filter(request=>request.session===tab.session&&request.path===path)).toHaveLength(1);
   expect(await tab.page.getByRole('region',{name:'本单时效申请'}).count()).toBe(0);
   const stored=(await h.db.query('SELECT document,published_at,task_id FROM digital_development_documents WHERE source_id=$1',[original.sourceId])).rows[0];
   expect(stored.document.returnDate).toBeNull();expect(stored.published_at).not.toBeNull();expect(stored.task_id).not.toBeNull();
   expect((await h.db.query('SELECT 1 FROM digital_order_time_requests WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
   // Successful publication reloads the original read-only document, replacing
   // the create-form caption. Wait for that actual current-version status.
   const publishedStatus=tab.page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/^已发布 ·/});
   await publishedStatus.waitFor();expect(await tab.page.getByRole('button',{name:'发布开发单',exact:true}).count()).toBe(0);
   await tab.page.reload();await publishedStatus.waitFor();
  }finally{releasePublish();await tab.context.close();}
 });
 for(const committed of [false,true])it(`recovers original development publication after an unknown response, committed=${committed}, without changing the command`,async()=>{
  const original=await source('publish-recovery-'+committed,null),tab=await h.open(original.actor.actorId,1165,{},'/ui/digital-production?development='+original.sourceId);
  const path=`/api/digital-production/sources/${original.sourceId}/development/publish`,attempts:Array<{key:string|null;body:string|null}>=[];
  try{
   await tab.page.route('**'+path,async route=>{
    attempts.push({key:route.request().headers()['idempotency-key']??null,body:route.request().postData()});
    if(attempts.length!==1){await route.continue();return;}
    if(committed){const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);}
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_UNKNOWN_PUBLICATION',message:'TEST原发布回执未取得'}})});
   });
   await tab.page.getByRole('button',{name:'打板信息',exact:true}).click();
   await tab.page.getByRole('button',{name:'发布开发单',exact:true}).click();
   const recovery=tab.page.getByRole('region',{name:'原提交结果待核对',exact:true});await recovery.waitFor();
   await tab.page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/结果待核对/}).waitFor();
   expect(await tab.page.getByRole('button',{name:'发布开发单',exact:true}).isDisabled()).toBe(true);
   expect(await tab.page.getByRole('button',{name:'保存开发资料草稿',exact:true}).isDisabled()).toBe(true);
   expect(await tab.page.getByRole('button',{name:'有确定客户订单',exact:true}).isDisabled()).toBe(true);
   expect((await h.db.query('SELECT status FROM digital_development_documents WHERE source_id=$1',[original.sourceId])).rows[0].status).toBe(committed?'published':'draft');
   await tab.page.screenshot({path:join(h.evidence,`development-publish-unknown-${committed}-1165.png`),fullPage:true});
   const lookup=tab.page.waitForResponse(response=>response.request().method()==='GET'&&response.url().includes('/development/submission-receipt?'));
   await recovery.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();const read=await lookup;
   expect(read.status(),await read.text()).toBe(200);expect(read.headers()['cache-control']).toContain('no-store');
   expect((await read.json()).status).toBe(committed?'completed':'unconfirmed');expect(attempts).toHaveLength(1);
   if(!committed){
    await recovery.getByText('原资料和操作标识已保留；先只读核对回执，查不到仍保持待核。',{exact:false}).waitFor();
    const retry=tab.page.waitForResponse(response=>new URL(response.url()).pathname===path&&response.request().method()==='POST');
    await recovery.getByRole('button',{name:'沿原命令继续核对',exact:true}).click();expect((await retry).status()).toBe(200);
    expect(attempts).toHaveLength(2);expect(attempts[1]).toEqual(attempts[0]);
   }
   await tab.page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/^已发布 ·/}).waitFor();
   expect(await recovery.count()).toBe(0);
   expect((await h.db.query('SELECT 1 FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[original.actor.actorId,`development:${original.sourceId}:publish`,attempts[0]!.key])).rowCount).toBe(1);
   expect((await h.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='development_publish'",[original.sourceId])).rowCount).toBe(1);
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
  }finally{await tab.context.close();}
 });
 it('only reads committed original-actor receipts, keeps an in-flight publication unknown and denies unrelated or revoked readers',async()=>{
  const original=await source('receipt-snapshot',null),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),key=randomUUID(),db=await h.db.connect();
  try{
   await db.query('BEGIN');
   const current=await forms.read(original.actor,original.sourceId,db),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',original.category.price_id);
   const published=await h.f.runtime.run(scene,original.actor,()=>forms.inTransaction(db).publish(original.actor,original.sourceId,current.version,key,{categoryId:original.category.price_id,priceVersion:price.version}));
   expect(await forms.submissionReceipt(original.actor,original.sourceId,'publish',key)).toEqual({status:'unconfirmed'});
   await db.query('COMMIT');
   expect(await forms.submissionReceipt(original.actor,original.sourceId,'publish',key)).toEqual({status:'completed',operation:'publish',sourceId:original.sourceId,documentVersion:published.version});
   expect(await forms.submissionReceipt(h.f.root,original.sourceId,'publish',key)).toEqual({status:'unconfirmed'});
   expect(await forms.submissionReceipt(original.actor,original.sourceId,'confirm',key)).toEqual({status:'unconfirmed'});
   await expect(forms.submissionReceipt(h.f.people['pattern-room-worker']!,original.sourceId,'publish',key)).rejects.toMatchObject({statusCode:404});
   const person=await h.dedicated('sample_designer','TEST receipt revoke designer'),stale={...original.actor,actorId:person.id};
   const owned=await new DigitalProductionIdentityService(h.db,true).createSource(stale,{developmentType:'头版',designStyleNo:'TEST-RECEIPT-REVOKE-'+randomUUID(),temporaryStyleNo:null,customerCode:null},randomUUID());
   const tab=await h.open(person.id,1165,{},'/ui/digital-production?development='+owned.sourceId);
   try{
    const endpoint=h.base+`/api/digital-production/sources/${owned.sourceId}/development/submission-receipt?operation=publish&key=${key}`;
    expect((await tab.context.request.get(endpoint)).status()).toBe(200);
    const cookie=(await tab.context.cookies()).find(cookie=>cookie.name==='dx_rework_session')!.value;
    await h.f.access.revokeRole(h.admin,person.assignmentId,'TEST revoke receipt reader in same session');
    expect([401,403,404]).toContain((await tab.context.request.get(endpoint)).status());
    expect((await tab.context.cookies()).find(item=>item.name==='dx_rework_session')!.value).toBe(cookie);
    await expect(forms.submissionReceipt(stale,owned.sourceId,'publish',key)).rejects.toMatchObject({statusCode:404});
   }finally{await tab.context.close();}
  }finally{await db.query('ROLLBACK');db.release();}
 });
 it('recovers a committed customer confirmation through the same original designer page using only the receipt GET',async()=>{
  const original=await source('confirm-recovery','2027-04-01','PD'),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  await h.f.runtime.run(scene,original.actor,async()=>{
   const current=await forms.read(original.actor,original.sourceId),document={...current.document!,productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal' as const,order:{customerCode:'PD',productGroup:'男装',designStyleNo:original.designStyleNo,temporaryStyleNo:null,primaryMerchandiserId:h.f.people.merchandiser!.actorId,orderDate:'2027-01-07',contractDeliveryDate:null,lines:[{formalPoNo:original.designStyleNo+'-PO',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'黑',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:'2027-04-01',sizes:[{size:'M',quantity:'10'}]}]}}};
   const saved=await forms.save(original.actor,original.sourceId,{expectedVersion:current.version,document:DevelopmentDocumentSchema.parse(document)},randomUUID()),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',original.category.price_id);
   await forms.publish(original.actor,original.sourceId,saved.version,randomUUID(),{categoryId:original.category.price_id,priceVersion:price.version});
  });
  const tab=await h.open(original.actor.actorId,1165,{},'/ui/digital-production?development='+original.sourceId),path=`/api/digital-production/sources/${original.sourceId}/confirm`;
  let attempts=0,key='';
  try{
   await tab.page.route('**'+path,async route=>{
    attempts++;key=route.request().headers()['idempotency-key']!;const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_LOST_CONFIRMATION',message:'TEST原确认回执未取得'}})});
   });
   await tab.page.getByRole('button',{name:'确认客户订单',exact:true}).click();
   const recovery=tab.page.getByRole('region',{name:'原提交结果待核对',exact:true});await recovery.waitFor();
   await tab.page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/结果待核对/}).waitFor();
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rowCount).toBe(1);
   expect(await tab.page.getByRole('button',{name:'确认客户订单',exact:true}).isDisabled()).toBe(true);
   await tab.page.screenshot({path:join(h.evidence,'customer-confirmation-unknown-1165.png'),fullPage:true});
   const read=tab.page.waitForResponse(response=>response.request().method()==='GET'&&response.url().includes('/development/submission-receipt?'));
   await recovery.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();
   expect(await (await read).json()).toMatchObject({status:'completed',operation:'confirm',sourceId:original.sourceId});
   await tab.page.getByRole('link',{name:'客户报价协作',exact:true}).waitFor();
   expect(await recovery.count()).toBe(0);expect(attempts).toBe(1);
   expect((await h.db.query('SELECT 1 FROM digital_production_commands WHERE actor_id=$1 AND command=$2 AND key=$3',[original.actor.actorId,`confirm-source:${original.sourceId}`,key])).rowCount).toBe(1);
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rowCount).toBe(1);
  }finally{await tab.context.close();}
 });
 it('R5-08 opens actual independent PLT, sizes, usage, comments and exact older files in the original authenticated App',async()=>{
  const s=await source('detail-documents','2027-02-20'),worker=h.f.people['pattern-room-worker']!,materialId=randomUUID(),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),execution=new DevelopmentExecutionService(h.db,true,h.patternOrders);
  let paperId='',firstFile='',middleCommentId='',finalCommentId='',reviewTaskId='',finalEvidence='';
  await h.f.runtime.run(scene,s.actor,async()=>{
   const current=await forms.read(s.actor,s.sourceId),document={...current.document!,materials:[{materialId,category:'主布' as const,label:'主布',name:'TEST棉布',supplier:'TEST',width:'150',weight:'200',composition:'棉',consumption:'1.5',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}]};
   const saved=await forms.save(s.actor,s.sourceId,{expectedVersion:current.version,document},randomUUID()),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',s.category.price_id);
   await forms.publish(s.actor,s.sourceId,saved.version,randomUUID(),{categoryId:s.category.price_id,priceVersion:price.version});
   let state=await execution.read(h.f.root,s.sourceId);
   await execution.configureFixedCutting(h.f.root,s.sourceId,{expectedVersion:state.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST original detail cutter'},randomUUID());
   state=await execution.read(h.f.root,s.sourceId);const check=state.tasks.find(task=>task.taskKind==='development_materials')!;
   const verification=await execution.saveMaterials(h.f.root,s.sourceId,{taskId:check.taskId,expectedVersion:state.materialVerification!.version,expectedDocumentVersion:state.sheet.version,entries:[{materialId,usage:'use',physical:true,quantity:true,color:true,specification:true,note:'TEST原生核配',confirmedWith:''}],note:'TEST原生核配',result:'通过'},randomUUID());
   await execution.check(h.f.root,s.sourceId,{taskId:check.taskId,result:'通过',note:'TEST原生核配完成',expectedVerificationVersion:verification.version,items:[{materialId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
   await arrangeTestRound(h.db,execution,h.f.root,s.sourceId,worker.actorId);
   const ready=await execution.read(worker,s.sourceId),paper=ready.tasks.find(task=>task.taskKind==='development_pattern')!;paperId=paper.taskId;
   const bytes=Buffer.from('IN;SP1;PU0,0;PD100,100;PU;SP0;'),sha256=createHash('sha256').update(bytes).digest('hex'),intent=await h.f.attachments.createTechnicalPlotUploadIntent(worker,s.sourceId,paper.taskId,{filename:'TEST-R508-original.plt',mimeType:'application/octet-stream',sizeBytes:bytes.length,sha256});
   await execution.recordUploadPurpose(worker,s.sourceId,intent.attachmentId,'纸样成果',paper.taskId);await h.f.storage.writeImmutable(intent.objectKey,bytes,{mimeType:'application/octet-stream',sha256});await h.f.attachments.finalize(worker,intent.attachmentId);firstFile=intent.attachmentId;
   const body={pltAttachmentIds:[firstFile],consumptionRows:[{materialId,unit:'米',consumption:'1.500000'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['M'],measurements:[{pointId:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['50']}],gradingNote:'TEST放码',templateRef:null},note:'TEST真实技术成果',basedOnFinalComment:null},technical=execution.technicalEvidenceService();
   for(const version of [0,1])await technical.saveArtifact(worker,s.sourceId,{taskId:paper.taskId,expectedDocumentVersion:ready.sheet.version,expectedVersion:version,scopeRef:'整款',action:'publish',body:{...body,note:'TEST独立原版本 '+(version+1)}},randomUUID());
   finalEvidence=await h.f.image(s.actor);
   await execution.recordUploadPurpose(s.actor,s.sourceId,finalEvidence,'客户评语依据');
   const middle=await technical.recordComment(s.actor,s.sourceId,{roundNumber:1,scopeRef:'整款',expectedVersion:0,isFinal:false,decision:'approved',text:'TEST客户中间评语',evidenceRefs:[],evidenceNote:'TEST原记录',occurredAt:null},randomUUID());
   const final=await technical.recordComment(s.actor,s.sourceId,{roundNumber:1,scopeRef:'整款',expectedVersion:1,isFinal:true,decision:'approved',text:'TEST客户最终认可',evidenceRefs:[finalEvidence],evidenceNote:'TEST原记录',occurredAt:null},randomUUID());
   middleCommentId=middle.commentId;finalCommentId=final.commentId;reviewTaskId=final.reviewTaskId!;
   const selected=(await technical.read(worker,s.sourceId,1)).artifacts.find(artifact=>artifact.version===2)!;
   await technical.completeReview(worker,s.sourceId,{taskId:reviewTaskId,expectedReviewVersion:1,finalCommentId,finalCommentVersion:2,
    decision:'reuse',artifactSetId:selected.artifactSetId,artifactVersion:2,note:'TEST 原尺寸复核确认沿用第2版'},randomUUID());
  });
  const tab=await h.open(h.f.root.actorId,1585,{},'/ui/digital-cockpit?scope=development&selected='+s.sourceId+'&expanded=development');
  try{
   const page=tab.page;await page.locator('[data-view="order"][aria-busy="false"]').waitFor();
   const docs=page.locator('.journey-documents-panel');expect(await docs.getByRole('tab',{name:'开发',exact:true}).getAttribute('aria-selected')).toBe('true');
   const readyDocument=async(key:string)=>{const item=docs.locator(`[data-category="${key}"]`);await docs.locator(`[data-category="${key}"][data-read-state="ready"]`).waitFor();expect(await item.getAttribute('data-state'),key+' after the real directory read completed').toBe('created');};
   for(const key of ['development_plt','development_sizes','development_consumption'])await readyDocument(key);
   expect(await docs.locator('[data-category="customer_final_approval"]').count()).toBe(0);expect(await docs.locator('[data-category="factory_history"]').count()).toBe(0);
   await docs.locator('[data-category="development_plt"]').click();let dialog=page.getByRole('dialog',{name:'全部相关单据',exact:true});await dialog.waitFor();
   await dialog.getByText('技术成果 v2',{exact:false}).last().waitFor();await dialog.locator('summary').filter({hasText:'技术成果 v1'}).click();
   const original=dialog.getByRole('link',{name:'PLT纸样原件 1',exact:true}).last();await original.waitFor();expect(await original.getAttribute('href')).toContain('/sources/'+s.sourceId+'/development/attachments/'+firstFile);
   const downloaded=tab.context.waitForEvent('response',{predicate:response=>response.url().includes('/development/attachments/'+firstFile)}),opened=tab.context.waitForEvent('page');await original.click();expect((await downloaded).status()).toBe(302);await (await opened).close();
   await page.keyboard.press('Escape');await docs.getByRole('tab',{name:'产前',exact:true}).click();
   for(const key of ['customer_comments','customer_final_approval'])await readyDocument(key);
   await docs.locator('[data-category="customer_comments"]').click();dialog=page.getByRole('dialog',{name:'全部相关单据',exact:true});await dialog.waitFor();await dialog.locator('summary').filter({hasText:'客户中间评语 v1'}).click();await dialog.getByText('TEST客户中间评语',{exact:false}).last().waitFor();expect(await dialog.innerText()).not.toContain('TEST客户最终认可');
   await page.keyboard.press('Escape');await docs.getByRole('tab',{name:'开发',exact:true}).click();
   const failurePath='**/execution/technical/history?*';await page.route(failurePath,async route=>new URL(route.request().url()).searchParams.get('kind')==='comments'?route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'TEST单项评语读取失败'}})}):route.continue());
   await docs.locator('[data-category="development_plt"]').click();dialog=page.getByRole('dialog',{name:'全部相关单据',exact:true});await dialog.waitFor();await dialog.getByText('技术成果 v2',{exact:false}).last().waitFor();await page.keyboard.press('Escape');
   await docs.getByRole('tab',{name:'产前',exact:true}).click();await docs.locator('[data-category="customer_comments"][data-read-state="error"]').waitFor();expect(await docs.locator('[data-category="customer_comments"]').innerText()).toContain('读取失败');
   const refreshedFailure=page.waitForResponse(response=>response.url().includes('/technical/history?')&&new URL(response.url()).searchParams.get('kind')==='comments'&&response.status()===503);await docs.locator('[data-category="customer_comments"]').click();dialog=page.getByRole('dialog',{name:'全部相关单据',exact:true});await dialog.waitFor();await refreshedFailure;await dialog.getByRole('button',{name:'重试读取目录',exact:true}).waitFor();await page.unroute(failurePath);await dialog.getByRole('button',{name:'重试读取目录',exact:true}).click();await dialog.getByText('客户中间评语 v1',{exact:false}).last().waitFor();await page.keyboard.press('Escape');
   await docs.getByRole('tab',{name:'开发',exact:true}).click();
   for(const key of ['development_plt','development_sizes','development_consumption'])await readyDocument(key);
   const dateLayouts=new Set<string>();
   for(const width of [1585,1165]){
    await page.setViewportSize({width,height:992});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
    const panels=await page.locator('.journey-documents-panel,.journey-activity-panel').evaluateAll(elements=>elements.map(element=>element.getBoundingClientRect().bottom));
    expect(Math.max(...panels)-Math.min(...panels)).toBeLessThanOrEqual(1);
    const dates=await page.locator('.cockpit-stage-dates>div').evaluateAll(elements=>elements.map(element=>({height:element.getBoundingClientRect().height,date:element.querySelector('time')?.textContent??null})));
    for(const row of dates){expect(row.height).toBeLessThan(24);if(row.date)expect(row.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);}
    const differences=await page.locator('.cockpit-stage-dates-with-delta').evaluateAll(elements=>elements.map(element=>{
     const stage=element.closest('.cockpit-stage')!;
     const style=getComputedStyle(stage);
     const stageWidth=stage.getBoundingClientRect().width
      -parseFloat(style.paddingLeft)-parseFloat(style.paddingRight)
      -parseFloat(style.borderLeftWidth)-parseFloat(style.borderRightWidth);
     const dates=element.querySelector('.cockpit-stage-dates')!.getBoundingClientRect();
     const delta=element.querySelector('.cockpit-target-difference')!.getBoundingClientRect();
     const group=element.getBoundingClientRect();
     return {stageWidth,horizontalGap:delta.left-dates.right,verticalGap:delta.top-dates.bottom,
      centerOffset:Math.abs((delta.top+delta.bottom-dates.top-dates.bottom)/2),leftOffset:Math.abs(delta.left-dates.left),
      rightOverflow:Math.max(dates.right,delta.right)-group.right,bottomOverflow:Math.max(dates.bottom,delta.bottom)-group.bottom};
    }));
    expect(differences.length).toBeGreaterThan(0);
    for(const difference of differences){
     // The existing compact stage layout stacks the delta under the dates below the container breakpoint.
     if(difference.stageWidth<=150){
      dateLayouts.add('stacked');
      expect(difference.verticalGap).toBeGreaterThanOrEqual(0);
      expect(difference.leftOffset).toBeLessThanOrEqual(1);
     }else{
      dateLayouts.add('side by side');
      expect(difference.horizontalGap).toBeGreaterThanOrEqual(0);
      expect(difference.centerOffset).toBeLessThanOrEqual(1);
     }
     expect(difference.rightOverflow).toBeLessThanOrEqual(1);
     expect(difference.bottomOverflow).toBeLessThanOrEqual(1);
    }
    await page.screenshot({path:join(h.evidence,`r508-real-source-${width}.png`),fullPage:true});
   }
   expect(dateLayouts).toEqual(new Set(['side by side','stacked']));
   await page.setViewportSize({width:1585,height:992});
   await page.locator('.journey-node-panel').getByRole('button',{name:'查看更多 ›',exact:true}).click();const nodes=page.getByRole('dialog',{name:'全部节点明细',exact:true});await nodes.waitFor();expect(await nodes.locator(`#journey-full-node-${paperId}`).count()).toBe(1);const targetHeader=nodes.locator('th').filter({hasText:'原截止 / 节点目标'});await targetHeader.waitFor();expect(await targetHeader.evaluate(el=>el.scrollWidth<=el.clientWidth+1)).toBe(true);await page.screenshot({path:join(h.evidence,'r508-full-node-dates-1585.png'),fullPage:true});await page.keyboard.press('Escape');
   const origin=new URL(h.base+'/ui/digital-production?'+new URLSearchParams({workspace:'designer',section:'workspace',development:s.sourceId,
    area:'records',originalStage:'preparation',originalCategory:'customer_comments'}));
   await page.goto(origin.href);
   await page.locator(`a[href*="originalTechnicalId=${middleCommentId}"]`).click();
   await page.getByText('TEST客户中间评语；TEST原记录',{exact:true}).waitFor();
   const reviewLink=page.getByRole('link',{name:'查看原尺寸复核',exact:true});
   expect(await reviewLink.count()).toBe(0);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.locator(`a[href*="originalTechnicalId=${middleCommentId}"]`).waitFor();
   origin.searchParams.set('originalCategory','customer_final_approval');await page.goto(origin.href);
   await page.locator(`a[href*="originalTechnicalId=${finalCommentId}"]`).click();
   await page.getByText('TEST客户最终认可；TEST原记录',{exact:true}).waitFor();
   const file=page.getByRole('link',{name:'客户原确认依据 1',exact:true});
   expect(await file.getAttribute('href')).toContain(`/sources/${s.sourceId}/development/attachments/${finalEvidence}`);
   await page.getByText('技术尺寸复核 · 明确沿用 v2',{exact:true}).waitFor();
   await page.getByText('TEST 原尺寸复核确认沿用第2版',{exact:true}).waitFor();
   const reviewTarget=new URL((await reviewLink.getAttribute('href'))!,h.base);
   expect(reviewTarget.searchParams.get('task')).toBe(reviewTaskId);
   expect(reviewTarget.searchParams.get('taskView')).toBe('read');
   await reviewLink.click();await page.waitForURL(url=>url.searchParams.get('task')===reviewTaskId);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await page.getByText('TEST客户最终认可；TEST原记录',{exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('originalTechnicalId')).toBe(finalCommentId);
   expect(h.errors).toEqual([]);
  }finally{await tab.context.close();}
 });
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('opens the genuine manager todo, adjusts only this order and applies once after a lost receipt with no designer reconfirmation',async()=>{
  const row=await requestFromOriginalPage('compressed'),manager=h.f.people['production-management']!,path='/api/digital-production/order-time/requests/'+row.requestId+'/apply';
  const tab=await h.open(manager.actorId,1586,{losePath:path},'/ui/my-tasks?q='+encodeURIComponent(row.designStyleNo));
  try{
   const link=tab.page.locator('a.my-todo-row').filter({hasText:row.designStyleNo});await link.waitFor();expect(await link.getAttribute('href')).toContain('timeRequest='+row.requestId);await link.click();await applyPage(tab.page);
   const stages=tab.page.getByRole('navigation',{name:'本单时效阶段'}).getByRole('button');
   for(let stage=0;stage<await stages.count();stage++){
    await stages.nth(stage).click();
    const inputs=tab.page.locator('.r5-time-table input[inputmode="decimal"]');
    for(let i=0;i<await inputs.count();i++){const input=inputs.nth(i);if(await input.isEnabled()){const row=input.locator('xpath=ancestor::tr');await row.getByRole('combobox',{name:/用时单位$/}).selectOption('minutes');await input.fill((await row.innerText()).includes('跟随所属工序')?'2':'10');}}
   }
   await tab.page.locator('.r5-time-sufficient').waitFor();expect(await tab.page.locator('.r5-time-sufficient').count()).toBe(1);
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
   // Keep the real pending request and auth. Place its read response exactly
   // on the exclusive boundary to exercise both native UI consumers.
   const path=`**/api/digital-production/order-time/requests/${row.requestId}`,boundary='2027-01-07T16:00:00.000Z';
   await tab.page.route(path,async route=>{
    const response=await route.fetch(),request=await response.json();
    await route.fulfill({response,json:{...request,check:{...request.check,lateMinutes:0,framework:{riskAccepted:false,milestones:[{
     scopeRef:`source:${row.sourceId}:round:1`,key:'planned_shipment',date:'2027-01-07',status:'insufficient',marginMinutes:0,lateMinutes:0,
     target:{at:boundary,exclusive:true,reasons:[]},planned:{at:boundary,exclusive:false,reasons:[]},workIds:['development_confirmation'],blockingWorkIds:['development_confirmation'],
    }]}}}});
   });
   await tab.page.reload();await applyPage(tab.page);
   const warning=await tab.page.locator('.r5-time-risk').innerText();
   expect(warning).toContain('最终交期时间不足');expect(warning).not.toContain('最终交期仍可满足');
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();
   const exact=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});
   expect(await exact.innerText()).toContain('最终交期时间不足');expect(await exact.innerText()).not.toContain('晚0天');
   await exact.getByRole('button',{name:'取消',exact:true}).click();
   expect(h.requests.filter(call=>call.session===tab.session&&call.path.endsWith('/apply'))).toEqual([]);
   await tab.page.unroute(path);await tab.page.reload();
   await applyPage(tab.page);await tab.page.getByRole('button',{name:'提交',exact:true}).click();const dialog=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});await dialog.waitFor();
   expect(await dialog.innerText()).toContain('0.17天');await tab.page.screenshot({path:join(h.evidence,'r507-late-confirmation-1586.png'),fullPage:false});
   await dialog.getByRole('button',{name:'取消',exact:true}).click();expect((await h.db.query('SELECT state FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].state).toBe('pending');
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();await dialog.getByRole('button',{name:'确认',exact:true}).click();await tab.page.getByText('本单安排已生效，设计师无需再次确认。',{exact:true}).waitFor();
   expect((await h.db.query('SELECT result_late_minutes FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].result_late_minutes).toBe('240');
  }finally{await tab.context.close();}
 });
 it('requires explicit acceptance for a genuine legacy application with zero delay at the exclusive cutoff',async()=>{
  const previous=scene;
  scene=await h.f.scene('2027-01-07T11:00:00.000Z');h.setCollectionScene(scene);
  try{
   const row=await requestFromOriginalPage('legacy-zero');
   const tab=await h.open(undefined,1165,{},'/ui/digital-production?timeRequest='+row.requestId);
   try{
    await applyPage(tab.page);
    const path='/api/digital-production/order-time/requests/'+row.requestId,response=await tab.page.request.get(h.base+path);
    expect(response.status()).toBe(200);
    const receipt=await response.json();
    expect(receipt).toMatchObject({state:'pending',check:{feasibility:'insufficient',lateMinutes:0,expectedEnd:'2027-01-07T16:00:00.000Z'}});
    expect(receipt.check.framework).toBeUndefined();
    expect(await tab.page.locator('.r5-time-risk').innerText()).toBe('本单时间不足');
    await tab.page.getByRole('button',{name:'提交',exact:true}).click();
    const dialog=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});
    expect(await dialog.innerText()).toContain('本单时间不足');
    await dialog.getByRole('button',{name:'取消',exact:true}).click();
    expect(h.requests.filter(call=>call.session===tab.session&&call.path===path+'/apply')).toEqual([]);
    expect(await (await tab.page.request.get(h.base+path)).json()).toMatchObject({state:'pending'});
   }finally{await tab.context.close();}
  }finally{scene=previous;h.setCollectionScene(scene);}
 });
 it('R5-09 follows one new order from actual saved company time through native work, qualified packing and the original cockpit/calendar',async()=>{
  const standards=new OrderTimeSettingsService(h.db,true,false),original=await standards.read(h.f.root),priorScene=scene;
  const settings=await h.open(h.f.root.actorId,1586,{},'/ui/digital-cockpit?workspace=settings');
  try{
   for(const [key,hours]of [['development_pattern','4'],['development_cutting','2'],['development_sewing','1.5']] as const){
    const label=ORDER_TIME_NODES.find(node=>node.key===key)!.label;
    await settings.page.locator('.r5-node-list').getByRole('button',{name:label,exact:true}).click();
    await settings.page.getByLabel(label+'时间单位',{exact:true}).selectOption('hours');await settings.page.getByLabel(label+'用时',{exact:true}).fill(hours);
    await settings.page.getByRole('region',{name:label+'设置',exact:true}).getByRole('button',{name:'确定',exact:true}).click();
   }
   await settings.page.getByRole('button',{name:'保存并使用',exact:true}).click();await settings.page.getByRole('status').filter({hasText:'已保存并使用'}).waitFor();
  }finally{await settings.context.close();}
  scene=await h.f.scene('2026-11-20T00:00:00.000Z');h.setCollectionScene(scene);
  const at=async<T>(hours:number,work:()=>Promise<T>)=>{await h.f.advance(scene,new Date(Date.parse('2026-11-20T00:00:00.000Z')+hours*3600000).toISOString());return h.f.runtime.run(scene,h.f.root,work);};
  let sourceId='',orderId='',style='',lineId='';
  try{
   const row=await source('R509-COMPLETE','2026-12-01','PD');sourceId=row.sourceId;style=row.designStyleNo;
   const worker=h.f.people['pattern-room-worker']!,forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),execution=new DevelopmentExecutionService(h.db,true,h.patternOrders),technical=execution.technicalEvidenceService();
   // This older downstream fixture supplies only digital-read capabilities.
   // Load the real persisted native capabilities for the two actual operators;
   // do not replace their roles or complete their work as Root.
   for(const actor of [worker,row.actor]){const rows=(await h.db.query('SELECT DISTINCT c.capability FROM user_role_assignments a JOIN role_capabilities c USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL',[actor.actorId])).rows;actor.authorizationCapabilities=[...new Set([...(actor.authorizationCapabilities??[]),...rows.map(item=>item.capability as string)])];}
   let paperTask='',published:{artifactSetId:string;version:number};
   await h.f.runtime.run(scene,h.f.root,async()=>{
    const before=await forms.read(row.actor,sourceId),materialId=randomUUID(),document={...before.document!,materials:[{materialId,category:'主布' as const,label:'主布',name:'TEST全链主布',supplier:'TEST',width:'150',weight:'200',composition:'棉',consumption:'1.5',color:'黑',specification:'TEST',quantity:'1',requiredThisRound:true,available:true,expectedDate:null}]};
    const saved=await forms.save(row.actor,sourceId,{expectedVersion:before.version,document},randomUUID()),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',row.category.price_id);
    await forms.publish(row.actor,sourceId,saved.version,randomUUID(),{categoryId:row.category.price_id,priceVersion:price.version});
    const current=await execution.read(h.f.root,sourceId);await execution.configureFixedCutting(h.f.root,sourceId,{expectedVersion:current.fixedCutting?.version??0,assigneeId:worker.actorId,reason:'TEST全链真实裁板'},randomUUID());
    const task=current.tasks.find(task=>task.taskKind==='development_materials')!;expect(task.dueAt).toBe('2026-11-20T01:00:00.000Z');
   });
   await at(1,async()=>{
    const current=await execution.read(h.f.root,sourceId),task=current.tasks.find(task=>task.taskKind==='development_materials')!,material=current.sheet.document!.materials[0]!;
    const saved=await execution.saveMaterials(h.f.root,sourceId,{taskId:task.taskId,expectedVersion:current.materialVerification!.version,expectedDocumentVersion:current.sheet.version,entries:[{materialId:material.materialId,usage:'use',physical:true,quantity:true,color:true,specification:true,note:'TEST实物齐备',confirmedWith:''}],note:'TEST全链核配',result:'通过'},randomUUID());
    await execution.check(h.f.root,sourceId,{taskId:task.taskId,result:'通过',note:'TEST一小时核配',expectedVerificationVersion:saved.version,items:[{materialId:material.materialId,physical:true,quantity:true,color:true,specification:true}]},randomUUID());
    await arrangeTestRound(h.db,execution,h.f.root,sourceId,worker.actorId);
    const link=(await h.db.query('SELECT order_id FROM digital_development_pattern_links WHERE source_id=$1',[sourceId])).rows[0]!,native=await h.patternOrders.get(h.f.root,link.order_id);
    if(native.status==='pending_assignment'){const person=(await h.db.query('SELECT person_id FROM business_people WHERE app_user_id=$1 AND active',[worker.actorId])).rows[0]!;await h.patternOrders.assign(h.f.root,native.orderId,{version:native.version,roundId:native.currentRoundId,personId:person.person_id},randomUUID());}

    const next=await execution.read(worker,sourceId),paper=next.tasks.find(task=>task.taskKind==='development_pattern')!;paperTask=paper.taskId;expect(paper.dueAt).toBe('2026-11-20T05:00:00.000Z');
    const bytes=Buffer.from('IN;SP1;PU0,0;PD100,100;PU;SP0;'),sha256=createHash('sha256').update(bytes).digest('hex'),intent=await h.f.attachments.createTechnicalPlotUploadIntent(worker,sourceId,paperTask,{filename:'TEST-R509-complete.plt',mimeType:'application/octet-stream',sizeBytes:bytes.length,sha256});
    await execution.recordUploadPurpose(worker,sourceId,intent.attachmentId,'纸样成果',paperTask);await h.f.storage.writeImmutable(intent.objectKey,bytes,{mimeType:'application/octet-stream',sha256});await h.f.attachments.finalize(worker,intent.attachmentId);
    published=await technical.saveArtifact(worker,sourceId,{taskId:paperTask,expectedDocumentVersion:next.sheet.version,expectedVersion:0,scopeRef:'整款',action:'publish',body:{pltAttachmentIds:[intent.attachmentId],consumptionRows:[{materialId:material.materialId,unit:'米',consumption:'1.500000'}],baseSizeTable:{unit:'cm',baseSize:'M',sizes:['M'],measurements:[{pointId:randomUUID(),name:'胸围',tolerance:'±1',method:'平量',values:['50']}],gradingNote:'TEST真实全链',templateRef:null},note:'TEST原生全链PLT',basedOnFinalComment:null}},randomUUID());
   });
   await at(5.5,async()=>{await execution.complete(worker,sourceId,{taskId:paperTask,attachmentIds:[],artifactRef:{id:published.artifactSetId,version:published.version,scopeRef:'整款'},note:'TEST四小时额度实际四小时半'},randomUUID());const task=(await execution.read(worker,sourceId)).tasks.find(task=>task.taskKind==='development_cutting')!;expect(task.dueAt).toBe('2026-11-20T07:30:00.000Z');});
   await at(7.5,async()=>{const task=(await execution.read(worker,sourceId)).tasks.find(task=>task.taskKind==='development_cutting')!;await execution.complete(worker,sourceId,{taskId:task.taskId,attachmentIds:[],note:'TEST两小时裁板'},randomUUID());const next=(await execution.read(worker,sourceId)).tasks.find(task=>task.taskKind==='development_sewing')!;expect(next.dueAt).toBe('2026-11-20T09:00:00.000Z');});
   await at(9,async()=>{const task=(await execution.read(worker,sourceId)).tasks.find(task=>task.taskKind==='development_sewing')!,photo=await h.f.image(worker);await execution.recordUploadPurpose(worker,sourceId,photo,'车板成果',task.taskId);await execution.route(worker,sourceId,{taskId:task.taskId,note:'TEST一小时半车板',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo]},randomUUID());});
   await at(9.25,async()=>{const task=(await execution.read(h.f.root,sourceId)).tasks.find(task=>task.taskKind==='development_tail_check')!,photo=await h.f.image(h.f.root);await execution.recordUploadPurpose(h.f.root,sourceId,photo,'尾查照片',task.taskId);await execution.route(h.f.root,sourceId,{taskId:task.taskId,note:'TEST真实尾查',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null,attachmentIds:[photo],measurements:[{name:'胸围',values:['50']}]},randomUUID());});
   await at(9.5,async()=>{const task=(await execution.read(row.actor,sourceId)).tasks.find(task=>task.taskKind==='development_confirmation')!;await execution.route(row.actor,sourceId,{taskId:task.taskId,note:'TEST真实设计确认',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:null,trackingNo:null},randomUUID());});
   await at(10,async()=>{const task=(await execution.read(h.f.root,sourceId)).tasks.find(task=>task.taskKind==='development_shipping')!;await execution.route(h.f.root,sourceId,{taskId:task.taskId,note:'TEST实际寄样',result:'通过',craftExecution:null,nextAssigneeId:null,sentDate:'2026-11-20',trackingNo:'TEST-R509-'+sourceId},randomUUID());});
   await at(10.5,async()=>{const state=await technical.read(row.actor,sourceId,1),comment=await technical.recordComment(row.actor,sourceId,{roundNumber:1,scopeRef:'整款',expectedVersion:state.comments[0]?.version??0,isFinal:true,decision:'approved',text:'TEST全链客户实际认可',evidenceRefs:[],evidenceNote:'TEST客户确认',occurredAt:businessNow().toISOString()},randomUUID());await technical.completeReview(h.f.root,sourceId,{taskId:comment.reviewTaskId!,expectedReviewVersion:1,finalCommentId:comment.commentId,finalCommentVersion:comment.version,decision:'reuse',artifactSetId:published.artifactSetId,artifactVersion:published.version,note:'TEST真实复核'},randomUUID());
    const order=await new DigitalProductionIdentityService(h.db,true).createOrder(row.actor,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,requiresColorMatching:false,orderDate:'2026-11-20',primaryMerchandiserId:h.f.people.merchandiser!.actorId,productionPlanning:{craftSteps:[],preshrink:true},lines:[{formalPoNo:style+'-PO1',color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:10}]}]}),randomUUID(),sourceId);orderId=order.productionOrderId;lineId=order.lines[0]!.lineId;
   });
   await at(11.5,async()=>{
    const ready=await h.f.bulkReady('无',undefined,1,new SourcingService(h.db,undefined,undefined,new TodoProjectionService(new TodoService(h.db)),h.f.contracts),{designerActor:row.actor,existingOrder:{orderId,sourceId}}),cut=(await h.db.query('SELECT cutting_order_id FROM cutting_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0]!.cutting_order_id;
    const cutter={...h.f.people['cutting-worker']!,authorizationCapability:'cutting:records:create',authorizationCapabilities:['cutting:records:create']};await ready.cutting.record(cutter,cut,{pieceCount:1,actualCutCount:10,attachmentIds:[await h.f.image(cutter)]},randomUUID());
    const flow=new FactoryFlowService(h.db),before=await flow.read(h.f.root,orderId);await flow.dispatch(h.f.people.warehouse!,orderId,{expectedRevision:before.revision,occurredAt:businessNow().toISOString(),supplierId:h.f.supplierId,note:'TEST全链实际发厂'},randomUUID());
    const qcState=await flow.read(h.f.root,orderId);await flow.productionQc(h.f.root,orderId,{expectedRevision:qcState.revision,factoryDecisionId:null,occurredAt:businessNow().toISOString(),checks:[{lineId,result:'合格',problem:''}],note:'TEST本厂范围成衣质检'},randomUUID());
    const sampleState=await flow.read(h.f.people.merchandiser!,orderId);await flow.followup(h.f.people.merchandiser!,orderId,{expectedRevision:sampleState.revision,kind:'船样寄出',lineIds:[lineId],occurredAt:businessNow().toISOString(),trackingNumber:'TEST-R509-SHIP-'+orderId,note:'TEST主跟单实际船样'},randomUUID());
    const productionId=(await h.db.query('SELECT production_order_id FROM sourcing_production_orders WHERE sourcing_case_id=$1',[ready.caseId])).rows[0]!.production_order_id,reports=new ProductionReportingService(h.db);await reports.report(h.f.root,productionId,{position:1,factoryDecisionId:null,businessDate:'2026-11-20',quantity:10},randomUUID());await reports.execute(h.f.root,productionId,'complete',{factoryDecisionId:null,businessDate:'2026-11-20',confirmed:true},randomUUID());await reports.execute(h.f.root,productionId,'ship',{factoryDecisionId:null,businessDate:'2026-11-20',confirmed:true},randomUUID());
    const receiving=new ReceivingService(h.db),receiver={...h.f.people.warehouse!,authorizationCapability:'receiving:create',authorizationCapabilities:['receiving:create']},receipt=(await receiving.create(receiver,{cuttingOrderId:cut,documentQuantity:10,actualQuantity:10,attachmentIds:[await h.f.image(receiver)]},randomUUID())).value,closure=new OrderClosureService(h.db),quality=(await closure.read(h.f.root,orderId)).quality!.find(item=>item.receiptId===receipt.receiptId)!;
    await closure.recordQuality(h.f.root,orderId,{receiptId:quality.receiptId,quantityVersion:quality.quantityVersion,occurredAt:businessNow().toISOString(),qualifiedQuantity:10,problem:''},randomUUID());
    const board=(await receiving.board('2026-11-01','2026-11-30','','all',1,15,receipt.receivingBatchId)).rows[0]!;await receiving.recordPacking({...h.f.root,authorizationCapability:'receiving:packing_manage',authorizationCapabilities:['receiving:packing_manage']},{receivingBatchId:receipt.receivingBatchId,expectedVersion:board.version,expectedPackingRevisionId:board.packingRevisionId,packingQuantity:10,packingTime:{mode:'now'}},randomUUID());await new JourneyFactRepository(h.db).buildOne({kind:'order',id:orderId});
    const day=await new DeliveryCalendarQuery(h.db).day(h.f.root,DeliveryCalendarFiltersSchema.parse({search:style}),'2027-03-01');expect(day.items.find(item=>item.lineId===lineId)?.rawPackedQty).toBe(10);expect(day.daySummary.pendingQty).toBe(0);
   });
   const tab=await h.open(h.f.root.actorId,1586,{},'/ui/digital-cockpit?scope=production&search='+encodeURIComponent(style));try{await tab.page.locator('.journey-orders[aria-busy=false]').waitFor();expect(await tab.page.locator('.journey-orders tbody tr').count()).toBe(1);
    const result=await tab.page.evaluate(async term=>(await fetch('/api/digital-production/journeys?scope=production&search='+encodeURIComponent(term))).json(),style);expect(result.total).toBe(1);
    const dto=await tab.page.evaluate(async id=>(await fetch('/api/digital-production/journeys/'+id+'?view=cockpit')).json(),orderId);
    const persisted=(await h.db.query("SELECT payload->'fixedSchedule' AS basis FROM digital_journey_fact_models WHERE resource_kind='order' AND resource_id=$1",[orderId])).rows[0]?.basis;
    await writeFile(join(h.evidence,'r509-new-order-actuals.json'),JSON.stringify({sourceId,orderId,style,createdAt:dto.createdAt,persisted,fixed:dto.fixedSchedule,stages:dto.stages.map((stage:{key:string;nodes:Array<{key:string;state:string;enteredAt:string|null;expectedAt:string|null;actualAt:string|null;actualDate?:string|null}>})=>({key:stage.key,nodes:stage.nodes.map(node=>({key:node.key,state:node.state,enteredAt:node.enteredAt,expectedAt:node.expectedAt,actualAt:node.actualAt,actualDate:node.actualDate}))})),summary:result.summary},null,2));
    expect(result.summary.completed,JSON.stringify({summary:result.summary,nodes:dto.stages.flatMap((stage:{nodes:Array<{key:string;state:string}>})=>stage.nodes.map(node=>[node.key,node.state]))})).toBe(1);
    expect(dto.createdAt).toBe('2026-11-20T00:00:00.000Z');
    expect(dto.fixedSchedule.durationSummary).toMatchObject({planStart:'2026-11-20T10:30:00.000Z',planEnd:'2027-03-01T16:00:00.000Z',planSpanMinutes:145770,finalActualSpanMinutes:{minimum:690,maximum:690}});
    // Independent arithmetic: formal adoption Nov20 10:30Z to Mar1 16:00Z
    // is101 days5.5h. Source history adds the approved2h final-design standard:
    // paper target Dec1 16:00Z minus2+1.5+1+2h =09:30Z; own window still ends05:00Z.
    for(const key of ['budget','sourcing_ie','sourcing_selection','sourcing_approval','warehouse_accessories']){const result=dto.fixedSchedule.scopes[0].nodes.find((node:{id:string})=>node.id===key);expect(result.goalDelta.actual,key+' verified native completion').toMatchObject({precision:'instant',at:'2026-11-20T11:30:00.000Z'});}
    const paperResult=dto.fixedSchedule.scopes[0].nodes.find((node:{id:string})=>node.id==='source:development_pattern');expect(paperResult.goalDelta).toMatchObject({kind:'early',targetAt:'2026-12-01T09:30:00.000Z',signedValue:-16080,unit:'minute'});expect(paperResult.ownSla).toMatchObject({state:'overdue',overdueMinutes:{minimum:30,maximum:30}});
    const indexed=await new DigitalJourneyQuery(h.db,{listReadMode:'indexed'}).list(h.f.root,JourneyFilterSchema.parse({scope:'production',search:style,startDate:'2026-11-20',endDate:'2026-11-20'}));expect(indexed.total).toBe(1);expect(indexed.items[0]?.createdAt).toBe('2026-11-20T00:00:00.000Z');
    const excluded=await new DigitalJourneyQuery(h.db,{listReadMode:'indexed'}).list(h.f.root,JourneyFilterSchema.parse({scope:'production',search:style,startDate:'2026-11-11',endDate:'2026-11-11'}));expect(excluded.total).toBe(0);
    await tab.page.locator('.journey-order-select').click();await tab.page.locator('[data-view=order][aria-busy=false]').waitFor();const durations=await tab.page.getByLabel('订单总用时').locator('strong').allTextContents();expect(durations.map(value=>value.replace(/\s+/g,''))).toEqual(['101天5小时30分钟','11小时30分钟','11小时30分钟']);
    const photo=await tab.page.locator('.cockpit-detail-photo').boundingBox(),heading=await tab.page.locator('.cockpit-identity-heading').boundingBox();expect(photo!.x+photo!.width).toBeLessThanOrEqual(heading!.x);
    expect(await tab.page.locator('[data-identity-fact="created"] time').getAttribute('datetime')).toBe('2026-11-20T10:30:00.000Z');
    await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();await tab.page.locator('[data-view=order][aria-busy=false]').waitFor();const paperLabel=dto.stages.flatMap((stage:{nodes:Array<{key:string;label:string}>})=>stage.nodes).find((node:{key:string})=>node.key==='development_pattern').label,paperRow=tab.page.locator('.cockpit-framework-nodes tbody tr').filter({has:tab.page.getByRole('button',{name:paperLabel,exact:true})});await paperRow.waitFor();const responsibility=paperRow.locator('td.cockpit-responsibility');expect((await responsibility.innerText()).replace(/\s+/g,'')).toBe('责任超时（有责）');expect(await responsibility.getAttribute('class')).toContain('is-danger');expect(await tab.page.getByRole('heading',{name:'全部节点',exact:true}).count()).toBe(1);await tab.page.screenshot({path:join(h.evidence,'r509-new-order-complete.png'),fullPage:true});
    await tab.page.getByRole('button',{name:'本单全部节点',exact:true}).click();await tab.page.locator('[data-view=order][aria-busy=false]').waitFor();await tab.page.locator('.journey-node-panel').getByRole('button',{name:'查看更多 ›',exact:true}).click();const allNodes=tab.page.getByRole('dialog',{name:'全部节点明细',exact:true});await allNodes.waitFor();
    for(const [key,at]of [['customer_sample','2026-11-20T10:30:00.000Z'],['budget','2026-11-20T11:30:00.000Z'],['sourcing_ie','2026-11-20T11:30:00.000Z']] as const){const label=dto.stages.flatMap((stage:{nodes:Array<{key:string;label:string}>})=>stage.nodes).find((node:{key:string})=>node.key===key).label,actual=allNodes.locator('tbody tr').filter({hasText:label}).locator('td').nth(4);expect(await actual.locator('time').getAttribute('datetime'),key+' actual column uses the delta occurrence').toBe(at);}
    await allNodes.getByRole('button',{name:'关闭全部节点明细',exact:true}).click();
    const calendarResponse=tab.page.waitForResponse(response=>response.url().includes('/delivery-calendar/day?')&&response.url().includes(encodeURIComponent(style)));
    await tab.page.goto(h.base+'/ui/digital-cockpit?'+new URLSearchParams({workspace:'delivery',scope:'current',view:'day',date:'2027-03-01',search:style}));const calendarRead=await calendarResponse;expect(calendarRead.status()).toBe(200);const calendarDto=await calendarRead.json();await writeFile(join(h.evidence,'r509-calendar-read.json'),JSON.stringify(calendarDto,null,2));expect(calendarDto.items.map((item:{lineId:string})=>item.lineId)).toContain(lineId);await tab.page.locator('.delivery-calendar[aria-busy=false]').waitFor();await writeFile(join(h.evidence,'r509-calendar-visible.txt'),await tab.page.locator('main').innerText());
    const po=tab.page.locator('.delivery-po-table tbody tr').filter({hasText:style+'-PO1'});await po.waitFor();const headers=await tab.page.locator('.delivery-po-table thead th').allTextContents(),packedColumn=headers.indexOf('已交件数'),pendingColumn=headers.indexOf('待交件数');expect(packedColumn).toBeGreaterThan(-1);expect(pendingColumn).toBeGreaterThan(-1);expect(await po.locator('td').nth(packedColumn).innerText()).toBe('10');expect(await po.locator('td').nth(pendingColumn).innerText()).toBe('0');await tab.page.screenshot({path:join(h.evidence,'r509-new-order-calendar.png'),fullPage:true});
}finally{await tab.context.close();}
  }finally{scene=priorScene;h.setCollectionScene(priorScene);const current=await standards.read(h.f.root);await standards.save(h.f.root,{expectedVersion:current.version,values:original.current},randomUUID());}
 });
 it('rejects a genuine manager role revoked in the same valid session while keeping the unsaved adjustment',async()=>{
  const row=await requestFromOriginalPage('revocation'),manager=h.f.people['production-management']!,assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='production_management' AND revoked_at IS NULL",[manager.actorId])).rows[0];
  await h.f.access.assignRole(h.admin,{userId:manager.actorId,roleCode:'sample_designer',reason:'TEST 保留有效业务登录，仅撤销本单时效办理角色'});
  const tab=await h.open(manager.actorId,1440,{},'/ui/digital-production?timeRequest='+row.requestId);
  try{
   await applyPage(tab.page);
   const previewed=tab.page.waitForResponse(response=>response.url().endsWith('/order-time/requests/'+row.requestId+'/preview')&&response.status()===200);
   await tab.page.getByRole('navigation',{name:'本单时效阶段'}).getByRole('button',{name:'产品开发打板',exact:true}).click();
   await tab.page.getByLabel('开发纸样本次用时',{exact:true}).fill('0.5');await previewed;
   await tab.page.locator('.r5-time-changes').getByText(/30分钟/).first().waitFor();
   await h.f.access.revokeRole(h.admin,assignment.assignment_id,'TEST 同一有效会话撤销时效办理角色');
   const denied=tab.page.waitForResponse(response=>response.url().endsWith('/apply')&&response.request().method()==='POST');
   await tab.page.getByRole('button',{name:'提交',exact:true}).click();const dialog=tab.page.getByRole('dialog',{name:'提交本单时效',exact:true});await dialog.waitFor();await dialog.getByRole('button',{name:'确认',exact:true}).click();
   expect((await denied).status()).toBe(403);
   expect(await tab.page.getByLabel('开发纸样本次用时',{exact:true}).inputValue()).toBe('0.5');expect((await h.db.query('SELECT state FROM digital_order_time_requests WHERE request_id=$1',[row.requestId])).rows[0].state).toBe('pending');
   expect(h.requests.filter(call=>call.session===tab.session&&call.status===401)).toHaveLength(0);
  }finally{await tab.context.close();}
 });
 it('publishes a framework development draft with incomplete ordering through the real designer App without sending formal confirmation',async()=>{
  const settings=new OrderTimeSettingsService(h.db,true,true),standard=await settings.read(h.f.root);
  await settings.save(h.f.root,{expectedVersion:standard.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const original=await source('incomplete-order',null,'PD'),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  await h.f.runtime.run(scene,original.actor,async()=>{
   const current=await forms.read(original.actor,original.sourceId);
   await forms.save(original.actor,original.sourceId,{expectedVersion:current.version,document:DevelopmentDocumentSchema.parse({...current.document!,productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order:{customerCode:'PD',productGroup:'男装',designStyleNo:original.designStyleNo,temporaryStyleNo:null,primaryMerchandiserId:h.f.people.merchandiser!.actorId,orderDate:'2027-01-07',contractDeliveryDate:null,requiresColorMatching:false,lines:[{formalPoNo:'TEST-incomplete-'+randomUUID(),poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'黑',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:null,sizes:[{size:'M',quantity:'10'}]}]}}})},randomUUID());
  });
  const tab=await h.open(original.actor.actorId,1165,{},'/ui/digital-production?development='+original.sourceId);
  try{
   await tab.page.getByRole('button',{name:'打板信息',exact:true}).click();
   const checked=tab.page.waitForResponse(response=>response.url().endsWith('/order-time/check')&&response.request().method()==='POST');
   const published=tab.page.waitForResponse(response=>response.url().endsWith(`/sources/${original.sourceId}/development/publish`));
   await tab.page.getByRole('button',{name:'发布开发单',exact:true}).click();
   const check=await checked;expect(check.status()).toBe(200);expect(await check.json()).toMatchObject({feasibility:'not_applicable'});expect((await published).status()).toBe(200);
   await tab.page.getByRole('button',{name:'确认客户订单',exact:true}).waitFor();
   expect(h.requests.filter(request=>request.session===tab.session&&request.method==='POST'&&request.path.endsWith(`/sources/${original.sourceId}/confirm`))).toHaveLength(0);
   const saved=await forms.read(original.actor,original.sourceId);expect(saved.status).toBe('published');expect(saved.document!.customerOrderDraft!.order.lines[0]!.customerWarehouseArrivalDate).toBeNull();
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[original.sourceId])).rowCount).toBe(0);
   expect((await new OrderTimePlanRepository(h.db).current({kind:'source',id:original.sourceId}))!.input.frameworkPlans).toBeUndefined();
  }finally{await tab.context.close();}
 });

 it('clears the previous adopted notice as soon as a new ordinary duration draft is edited, while retaining the unsaved guard',async()=>{
  const original=await source('notice-draft','2027-01-10'),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  await h.f.runtime.run(scene,h.f.root,async()=>{
   const sheet=await forms.read(original.actor,original.sourceId),price=await new PatternRoomPriceService(h.db).quote(h.f.root,'category',original.category.price_id);
   await forms.publish(original.actor,original.sourceId,sheet.version,randomUUID(),{categoryId:original.category.price_id,priceVersion:price.version});
  });
  const tab=await h.open(h.f.people.owner!.actorId,1165,{},'/ui/digital-production?timeSource='+original.sourceId);
  try{
   const page=tab.page;await applyPage(page);
   const input=page.locator('.r5-time-table input[aria-label$="本次用时"]:enabled').first();
   const row=input.locator('xpath=ancestor::tr'),unit=row.getByRole('combobox',{name:/用时单位$/});
   await unit.selectOption('days');
   const preview=page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.status()===200);
   await input.fill('2');await preview;
   await page.getByRole('button',{name:'提交',exact:true}).and(page.locator(':enabled')).waitFor();
   const confirmation=await page.locator('.r5-time-risk').count()>0;
   await page.getByRole('button',{name:'提交',exact:true}).click();
   if(confirmation){const dialog=page.getByRole('dialog',{name:'提交本单时效',exact:true});await dialog.waitFor();await dialog.getByRole('button',{name:'确认',exact:true}).click();}
   await page.getByText('本单新安排已生效。',{exact:true}).waitFor();
   const before=await new OrderTimePlanRepository(h.db).current({kind:'source',id:original.sourceId});
   await input.fill('不是数字');expect(await page.getByText('本单新安排已生效。',{exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'提交',exact:true}).isDisabled()).toBe(true);
   await page.getByRole('button',{name:'返回',exact:true}).click();const invalidDraft=page.getByRole('dialog');await invalidDraft.waitFor();
   expect(await invalidDraft.innerText()).toContain('还没提交');await invalidDraft.getByRole('button',{name:'取消',exact:true}).click();expect(await input.inputValue()).toBe('不是数字');
   const uncommitted=page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.status()===200);
   await input.fill('200');expect(await page.getByText('本单新安排已生效。',{exact:true}).count()).toBe(0);await uncommitted;
   expect(await input.inputValue()).toBe('200');expect(await page.locator('.r5-time-risk').count()).toBeGreaterThan(0);
   expect((await new OrderTimePlanRepository(h.db).current({kind:'source',id:original.sourceId}))!.revision).toBe(before!.revision);
   await page.getByRole('button',{name:'返回',exact:true}).click();
   const unsaved=page.getByRole('dialog');await unsaved.waitFor();expect(await unsaved.innerText()).toContain('还没提交');
   await unsaved.getByRole('button',{name:'取消',exact:true}).click();expect(await input.inputValue()).toBe('200');
  }finally{await tab.context.close();}
 });

 it('adopts washing through the original grouped order adjustment page with real authenticated roles',async()=>{
  const settings=new OrderTimeSettingsService(h.db,true,true),current=await settings.read(h.f.root);
  await settings.save(h.f.root,{expectedVersion:current.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  const requests=new OrderTimeRequestService(h.db,orderTimeNativeExecutor(h.db,true,h.patternOrders));
  const orderId=await h.f.runtime.run(scene,h.f.root,async()=>{
   const designer=h.f.people['sample-designer']!,input=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',requiresColorMatching:false,designStyleNo:'TEST-TIME06-UI-'+randomUUID(),orderDate:'2027-01-07',primaryMerchandiserId:h.f.people.merchandiser!.actorId,lines:[{formalPoNo:'TEST-TIME06-PO-'+randomUUID(),color:'黑',customerWarehouseArrivalDate:'2027-02-20',sizes:[{size:'M',quantity:10}]}]});
   const operation={kind:'direct_order' as const,input,route:{craftSteps:[],preshrink:false}},check=await requests.check(designer,operation);
   const pending=await requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST original UI new arrangement'},randomUUID());
   const manager=h.f.people.owner!,preview=await requests.read(manager,pending.requestId);
   return (await requests.apply(manager,pending.requestId,{expectedVersion:preview.version,fingerprint:preview.check.fingerprint,overrides:{},acceptLate:true},randomUUID())).result!.orderId!;
  });
  const {actor:nextInspector}=await r5RoleFixture(h.db,h.f.access,{...h.f.root,requestId:randomUUID()},'quality_control');
  const tab=await h.open(h.f.people.owner!.actorId,1165,{},'/ui/digital-production?timeOrder='+orderId);
  try{
   const page=tab.page;await applyPage(page);
   const stages=page.getByRole('navigation',{name:'本单时效阶段'}).getByRole('button');
   expect(await stages.count()).toBeGreaterThan(1);
   await stages.last().click();
   expect(await stages.last().getAttribute('aria-pressed')).toBe('true');
   expect(await page.locator('.r5-time-table').innerText()).not.toContain('订单创建');
   await page.locator('summary').filter({hasText:'大货洗水'}).click();
   await page.getByRole('combobox',{name:/^洗水方式/}).selectOption('after_receipt');
   expect(await page.getByRole('button',{name:'提交',exact:true}).isEnabled()).toBe(false);
   await page.getByLabel('洗水用时（小时）',{exact:true}).fill('2');
   await page.getByLabel('洗后检查（小时）',{exact:true}).fill('1');
   await page.getByRole('combobox',{name:/^洗水跟单/}).selectOption(h.f.people['embroidery-washing-merchandiser']!.actorId);
   const previewed=page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.status()===200);
   await page.getByRole('combobox',{name:/^质检/}).selectOption(h.f.people.qc!.actorId);await previewed;
   await page.getByRole('button',{name:'提交',exact:true}).and(page.locator(':enabled')).waitFor();
   const layout=await page.locator('.r5-time-table,.r5-time-changes').evaluateAll(elements=>elements.map(element=>({top:element.getBoundingClientRect().top,left:element.getBoundingClientRect().left,right:element.getBoundingClientRect().right})));
   expect(Math.abs(layout[0]!.top-layout[1]!.top)).toBeLessThan(2);
   expect(layout[1]!.left).toBeGreaterThanOrEqual(layout[0]!.right);
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
   await page.screenshot({path:join(h.evidence,'time06-real-grouped-adjustment-1165.png'),fullPage:true});
   const needsConfirmation=await page.locator('.r5-time-risk').count()>0;
   await page.getByRole('button',{name:'提交',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'提交本单时效',exact:true});
   if(needsConfirmation){await dialog.waitFor();await dialog.getByRole('button',{name:'确认',exact:true}).click();}
   await page.getByText('本单新安排已生效。',{exact:true}).waitFor();
   const plans=(await h.db.query('SELECT document FROM digital_bulk_washing_plans WHERE production_order_id=$1',[orderId])).rows;
   expect(plans).toHaveLength(1);expect(plans[0].document.arrangement).toMatchObject({mode:'after_receipt',washing:{minutes:120},inspection:{minutes:60}});
   const competing=await h.open(h.f.people.owner!.actorId,1165,{},'/ui/digital-production?timeOrder='+orderId);
   try{
    await applyPage(competing.page);await competing.page.locator('summary').filter({hasText:'大货洗水'}).click();
    const competitorPreview=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===240);
    await competing.page.getByLabel('洗水用时（小时）',{exact:true}).fill('4');expect((await competitorPreview).status()).toBe(200);
    await competing.page.getByRole('button',{name:'提交',exact:true}).and(competing.page.locator(':enabled')).waitFor();
   // Same page and session: the saved editor must use the new native version,
   // without requiring a reload to make the next ordinary edit possible.
   await page.locator('summary').filter({hasText:'大货洗水'}).click();
   const secondPreview=page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===180&&response.request().postDataJSON()?.washing?.[0]?.document?.staff?.inspectorId===nextInspector.actorId);
   await page.getByLabel('洗水用时（小时）',{exact:true}).fill('3');
   await page.getByLabel('洗后检查（小时）',{exact:true}).fill('2');
   await page.getByRole('combobox',{name:/^质检/}).selectOption(nextInspector.actorId);
   expect(await page.getByText('本单新安排已生效。',{exact:true}).count()).toBe(0);
   const previewResponse=await secondPreview;expect(previewResponse.status()).toBe(200);
   const previewBody=await previewResponse.json();
   await page.getByRole('button',{name:'提交',exact:true}).and(page.locator(':enabled')).waitFor();
   const secondConfirmation=previewBody.feasibility==='insufficient';
   // Hold only this command before forwarding: prove that pending submission
   // is not confused with persisted success, without sleeps or a longer poll.
   let releaseSave!:()=>void,requestStarted!:()=>void;
   const saveGate=new Promise<void>(resolve=>{releaseSave=resolve;}),started=new Promise<void>(resolve=>{requestStarted=resolve;});
   await page.route('**/order-time/arrange',async route=>{requestStarted();await saveGate;await route.continue();});
   const secondSaved=page.waitForResponse(response=>response.url().endsWith('/order-time/arrange')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===180&&response.request().postDataJSON()?.washing?.[0]?.document?.staff?.inspectorId===nextInspector.actorId);
   await page.getByRole('button',{name:'提交',exact:true}).click();
   if(secondConfirmation){await dialog.waitFor();await dialog.getByRole('button',{name:'确认',exact:true}).click();}
   try{
    await started;
    expect(Number((await h.db.query('SELECT count(*) AS count FROM digital_bulk_washing_plans WHERE production_order_id=$1',[orderId])).rows[0].count)).toBe(1);
    expect(await page.getByRole('button',{name:'提交',exact:true}).isDisabled()).toBe(true);
   }finally{releaseSave();}
   const savedResponse=await secondSaved;const savedBody=await savedResponse.json();
   expect({status:savedResponse.status(),body:savedBody}).toMatchObject({status:200,body:{saved:true}});
   expect(savedBody.check.washing[0]).toMatchObject({version:2,document:{arrangement:{washing:{minutes:180}}}});
   const savedPlans=(await h.db.query('SELECT document FROM digital_bulk_washing_plans WHERE production_order_id=$1 ORDER BY version',[orderId])).rows;
   expect(savedPlans).toHaveLength(2);expect(savedPlans[1].document.arrangement.washing.minutes).toBe(180);
    const stale=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/arrange'));
    const repreview=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===240);
    await competing.page.getByRole('button',{name:'提交',exact:true}).click();
    const staleDialog=competing.page.getByRole('dialog',{name:'提交本单时效',exact:true});
    if(await staleDialog.count())await staleDialog.getByRole('button',{name:'确认',exact:true}).click();
    expect((await stale).status()).toBe(409);await repreview;
    const conflict=competing.page.getByText('原单已有变化，调整内容已保留；请重新读取并复核新基线，再提交本次草稿。',{exact:true});
    await conflict.waitFor();expect(await competing.page.getByRole('button',{name:'提交',exact:true}).isDisabled()).toBe(true);
    expect(await competing.page.getByLabel('洗水用时（小时）',{exact:true}).inputValue()).toBe('4');
    expect((await h.db.query('SELECT count(*)::int AS count FROM digital_bulk_washing_plans WHERE production_order_id=$1',[orderId])).rows[0].count).toBe(2);
    const acknowledged=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===240);
    await competing.page.getByRole('button',{name:'重新读取并复核新基线',exact:true}).click();await acknowledged;
    expect(await conflict.count()).toBe(0);expect(await competing.page.getByLabel('洗水用时（小时）',{exact:true}).inputValue()).toBe('4');
    expect(await competing.page.getByLabel('洗后检查（小时）',{exact:true}).inputValue()).toBe('2');
    expect(await competing.page.getByRole('combobox',{name:/^质检/}).inputValue()).toBe(nextInspector.actorId);
    await competing.page.getByRole('button',{name:'提交',exact:true}).and(competing.page.locator(':enabled')).waitFor();
    // Explicit acknowledgement/preview is read-only; no second adoption yet.
    expect((await h.db.query('SELECT count(*)::int AS count FROM digital_bulk_washing_plans WHERE production_order_id=$1',[orderId])).rows[0].count).toBe(2);
    const edited=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/preview')&&response.request().postDataJSON()?.washing?.[0]?.document?.arrangement?.washing?.minutes===300);
    await competing.page.getByLabel('洗水用时（小时）',{exact:true}).fill('5');
    const editResponse=await edited,editBody=editResponse.request().postDataJSON().washing[0];
    expect(editBody).toMatchObject({expectedVersion:2,document:{arrangement:{washing:{minutes:300},inspection:{minutes:120}},staff:{inspectorId:nextInspector.actorId}}});
    const finalSaved=competing.page.waitForResponse(response=>response.url().endsWith('/order-time/arrange'));
    await competing.page.getByRole('button',{name:'提交',exact:true}).and(competing.page.locator(':enabled')).waitFor();
    await competing.page.getByRole('button',{name:'提交',exact:true}).click();
    if((await editResponse.json()).feasibility==='insufficient'){await staleDialog.waitFor();await staleDialog.getByRole('button',{name:'确认',exact:true}).click();}
    expect((await finalSaved).status()).toBe(200);await competing.page.getByText('本单新安排已生效。',{exact:true}).waitFor();
    const finalPlans=(await h.db.query('SELECT version,document FROM digital_bulk_washing_plans WHERE production_order_id=$1 ORDER BY version',[orderId])).rows;
    expect(finalPlans).toHaveLength(3);expect(finalPlans[2]).toMatchObject({version:3,document:{arrangement:{washing:{minutes:300},inspection:{minutes:120}},staff:{inspectorId:nextInspector.actorId}}});
   }finally{await competing.context.close();}
   // Actual adopted work produces110/121-character identities. Click, refresh,
   // original record and return must all preserve the complete identity.
   for(const mode of ['after_receipt','factory'] as const){
    if(mode==='factory')await h.f.runtime.run(scene,h.f.root,async()=>{
     const manager=h.f.people.owner!,resource={kind:'order' as const,id:orderId},operation={kind:'arrangement' as const,resource};
     const current=(await requests.check(manager,operation)).washing![0]!;
     const washing=[{lineId:current.lineId,expectedVersion:current.version,document:{...current.document!,arrangement:{...current.document!.arrangement,mode}}}];
     const preview=await requests.check(manager,operation,{},washing);
     await requests.arrange(manager,{resource,overrides:{},washing,fingerprint:preview.fingerprint,acceptLate:true},randomUUID());
    });
    const response=await page.request.get(h.base+`/api/digital-production/journeys/${orderId}?view=cockpit`);
    expect(response.status()).toBe(200);const journey=await response.json() as OrderJourney;
    const prefix=mode==='factory'?'bulk_factory_washing':'bulk_return_washing';
    const nodes=journey.stages.flatMap(stage=>stage.nodes).filter(node=>node.key.startsWith(prefix));expect(nodes).toHaveLength(2);
    const beforeNavigation=h.requests.length;
    for(const node of nodes){
     expect(node.instanceId.length).toBeGreaterThan(100);
     await page.goto(h.base+journeyReturnUrl({selected:journey.id,search:'TEST-TIME06-UI-',page:2,milestone:'',expanded:''}));
     await page.locator('[data-view=order][aria-busy=false]').waitFor();
     const button=page.locator('.journey-node-panel').getByRole('button',{name:node.label,exact:true});await button.click();
     await expect.poll(()=>new URL(page.url()).searchParams.get('focus')).toBe(node.instanceId);
     expect(new URL(page.url()).searchParams.get('row')).toBe(node.instanceId);
     const current=page.getByRole('region',{name:'当前节点详情'});expect(await current.getByRole('heading').innerText()).toContain(node.label);
     expect(await button.getAttribute('aria-pressed')).toBe('true');
     await page.reload();await page.locator('[data-view=order][aria-busy=false]').waitFor();
     expect(await current.getByRole('heading').innerText()).toContain(node.label);
     const link=current.getByRole('link',{name:'查看节点记录',exact:true}),href=new URL((await link.getAttribute('href'))!,h.base);
     expect(href.searchParams.get('factory')).toBe(orderId);
     const restore=new URL(href.searchParams.get('returnTo')!,h.base);
     expect(restore.searchParams.get('focus')).toBe(node.instanceId);expect(restore.searchParams.get('row')).toBe(node.instanceId);
     await link.click();await page.getByRole('region',{name:'工厂流程资料'}).getByRole('button',{name:'返回',exact:true}).click();
     await page.locator('[data-view=order][aria-busy=false]').waitFor();expect(await current.getByRole('heading').innerText()).toContain(node.label);
     expect(new URL(page.url()).searchParams.get('page')).toBe('2');expect(new URL(page.url()).searchParams.get('search')).toBe('TEST-TIME06-UI-');
    }
    expect(h.requests.slice(beforeNavigation).filter(request=>request.method==='POST'&&request.path.includes(`/orders/${orderId}/`))).toEqual([]);
    await page.screenshot({path:join(h.evidence,`washing-${mode}-node-return-1165.png`),fullPage:true});
   }
  }finally{await tab.context.close();}
 });

});
