import {mkdtemp,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser,type SettingsBrowserFault} from '../acceptance/supplychain-settings-browser.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe.sequential:describe.skip)('original designer workspace parent and pure child draft across actual browser reload',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-pure-create-reload-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it.each([['development','无确定客户订单'],['certain_order','有确定客户订单'],['preorder','预下单备料']] as const)('restores %s parent intent, raw document/order input and original row identities with no command or writes',async(mode,label)=>{
  const before=Number((await h.db.query('SELECT count(*) FROM digital_production_sources')).rows[0].count),tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer');
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());
   if(mode==='development'){
    await page.addInitScript(()=>Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true}));
    await page.reload();
    expect(await page.evaluate(()=>typeof globalThis.crypto.randomUUID)).toBe('undefined');
   }
   await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   if(mode!=='development')await page.getByRole('button',{name:label,exact:true}).click();
   const style=page.locator('#development-create-style'),raw='  TEST pure '+mode+' raw  ';await style.fill(raw);
   const instructions=page.locator('#development-instructions');await instructions.waitFor({state:'attached'});const details=instructions.locator('xpath=ancestor::details[1]');if(await details.count()&&!await details.evaluate(node=>(node as HTMLDetailsElement).open))await details.locator('summary').first().click();
   const text='  TEST 未提交制作说明 '+mode+'  ';await instructions.fill(text);
   const rowId=await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id');expect(rowId).toBeTruthy();
   if(mode!=='development')await page.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true}).fill('1.');
   const original=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(original).toHaveLength(1);expect(original[0]).toMatchObject({schemaVersion:1,phase:'draft',snapshot:{intent:mode==='development'?'development':'certain_order',preorder:mode==='preorder'}});
   for(const field of ['sourceId','original','native','version','beforeVersion'])expect(original[0]).not.toHaveProperty(field);
   await page.reload();await style.waitFor();expect(await style.inputValue()).toBe(raw);expect(await instructions.inputValue()).toBe(text);expect(await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id')).toBe(rowId);expect(await page.getByRole('button',{name:label,exact:true}).getAttribute('aria-pressed')).toBe('true');
   if(mode!=='development')expect(await page.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true}).inputValue()).toBe('1.');
   // Two original debounce periods must not turn hydration, quotes or other
   // readonly option refreshes into source/save/publish/confirm commands.
   await page.waitForTimeout(2700);const current=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(current[0].viewId).toBe(original[0].viewId);expect(current[0].phase).toBe('draft');
   expect(h.requests.filter(row=>row.session===tab.session&&!['GET','HEAD'].includes(row.method)&&!row.path.includes('/notifications/'))).toEqual([]);expect(Number((await h.db.query('SELECT count(*) FROM digital_production_sources')).rows[0].count)).toBe(before);
   await page.screenshot({path:join(h.evidence,'pure-create-reload-'+mode+'.png'),fullPage:true});
  }catch(error){await writeFile(join(h.evidence,'pure-create-reload-'+mode+'-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('reuses the acknowledged source and current version when reopening a saved creation draft in the same tab and after reload',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer'),style='TEST-CREATION-SAVE-'+randomUUID();
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'新建开发订单',exact:true}).click();await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();
   const save=page.getByRole('button',{name:'保存开发资料草稿',exact:true}),saved=page.waitForResponse(response=>/\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
   await save.click();const reply=await saved;expect(reply.status(),await reply.text()).toBe(200);const sheet=await reply.json();
   await expect.poll(async()=>{const records=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));return records[0]?.phase;}).toBe('bound');
   const created=h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/sources'&&row.method==='POST');expect(created).toHaveLength(1);
   expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows).toEqual([{source_id:sheet.sourceId}]);
   const boundPath=`/api/digital-production/sources/${sheet.sourceId}/development`,countPuts=()=>h.requests.filter(row=>row.session===tab.session&&row.path===boundPath&&row.method==='PUT').length;
   const reopen=async()=>{await page.getByRole('button',{name:'返回列表',exact:true}).click();await page.getByRole('button',{name:'新建开发订单',exact:true}).click();};
   for(const [index,reload]of [false,true,false].entries()){
    if(reload)await page.reload();else await reopen();
    const field=page.getByRole('textbox',{name:'设计款号',exact:true});await field.waitFor();expect(await field.inputValue()).toBe(style);
    if(reload)await page.waitForTimeout(2700);
    const version=index+1;expect(countPuts()).toBe(version);
    const instructions=page.locator('#development-instructions'),details=instructions.locator('xpath=ancestor::details[1]');if(await details.count()&&!await details.evaluate(node=>(node as HTMLDetailsElement).open))await details.locator('summary').first().click();
    const text=`TEST explicit save after reopen ${version}`;await instructions.fill(text);
    const savedAgain=page.waitForResponse(response=>new URL(response.url()).pathname===boundPath&&response.request().method()==='PUT');await save.click();
    const result=await savedAgain;expect(result.status(),await result.text()).toBe(200);expect(result.request().postDataJSON().expectedVersion).toBe(version);
    expect((await h.db.query('SELECT version,document FROM digital_development_documents WHERE source_id=$1',[sheet.sourceId])).rows[0]).toMatchObject({version:version+1,document:{instructions:text}});
   }
   await page.getByRole('button',{name:'返回列表',exact:true}).click();
   const service=new DigitalDevelopmentService(h.db,true,h.patternOrders),latest=await service.read(h.f.root,sheet.sourceId);
   await service.save(h.f.root,sheet.sourceId,{expectedVersion:latest.version,document:{...latest.document!,instructions:'TEST newer authorized edit'}},randomUUID());
   await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'原开发档案版本已变化'}).waitFor();expect(await save.count()).toBe(0);expect(countPuts()).toBe(4);
   expect(h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/sources'&&row.method==='POST')).toHaveLength(1);
   expect((await h.db.query('SELECT version,document FROM digital_development_documents WHERE source_id=$1',[sheet.sourceId])).rows[0]).toMatchObject({version:5,document:{instructions:'TEST newer authorized edit'}});
  }catch(error){await writeFile(join(h.evidence,'explicit-save-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('retains an acknowledged-server but browser-unknown source creation across real reload without issuing a duplicate source command',async()=>{
  const tab=await h.open(h.f.root.actorId,390,{},'/ui/digital-production?workspace=designer'),style='TEST-CREATION-UNKNOWN-'+randomUUID();let attempts=0;
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'新建开发订单',exact:true}).click();await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.route('**/api/digital-production/sources',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}attempts++;const response=await route.fetch();expect(response.status(),await response.text()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_CREATE_ACK_LOST',message:'TEST 已创建但原回执丢失'}})});});
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'未收到可确认的提交结果'}).waitFor();
   const prior=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(prior[0]).toMatchObject({phase:'pending',sourceId:null,original:{path:'sources',method:'POST'}});expect(prior[0].original.key).toBeTruthy();
   await page.reload();await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();await page.waitForTimeout(2700);
   expect(await page.getByRole('textbox',{name:'设计款号',exact:true}).count()).toBe(0);expect(await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).count()).toBe(0);expect(await page.getByText('该原创建或保存步骤尚无受支持的只读终态入口；原实际标识及输入保留。不能把它当成新草稿再提交，请先核对权威终态。',{exact:true}).count()).toBe(1);
   const next=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(next[0].original).toEqual(prior[0].original);expect(attempts).toBe(1);expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rowCount).toBe(1);
   expect(h.requests.filter(row=>row.session===tab.session&&row.method==='PUT'&&row.path.includes('/development'))).toEqual([]);
  }catch(error){await writeFile(join(h.evidence,'unknown-create-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it.each(['publish','confirm'] as const)('restores native original %s after actual reload and confirms it by one original-key GET with no command replay',async operation=>{
  const actor=h.f.root,style='TEST-CREATION-'+operation+'-'+randomUUID(),source=await new DigitalProductionIdentityService(h.db,true).createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:operation==='confirm'?'PD':null},randomUUID());
  const forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!,price=await new PatternRoomPriceService(h.db).quote(actor,'category',category.price_id);
  const order=operation==='confirm'?InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,primaryMerchandiserId:h.f.people.merchandiser!.actorId,orderDate:'2026-11-17',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',lines:[{formalPoNo:style+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:'2'}]}]}):null;
  let sheet=await forms.save(actor,source.sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,files:[{attachmentId:await h.f.image(actor),kind:'款图'}],patternCategoryId:category.price_id,...(order?{productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order}}:{})}},randomUUID());
  if(operation==='confirm')sheet=await forms.publish(actor,source.sourceId,sheet.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version});
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer');
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'新建开发订单',exact:true}).click();await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   // Isolated restoration fixture: the source/document are prepared by their
   // real services, and this is the same bound state following an acknowledged
   // original draft save. Publication and receipt lookup below are unmocked.
   await page.evaluate(({sheet,categoryId,priceVersion,order})=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('dx:development-creation:'))!,draft=JSON.parse(sessionStorage.getItem(key)!);draft.phase='bound';draft.sourceId=sheet.sourceId;draft.version=sheet.version;draft.snapshot.document=sheet.document;draft.snapshot.quantityInput='1';draft.snapshot.patternChoice={categoryId,priceVersion};if(order){draft.snapshot.intent='certain_order';draft.snapshot.form=order;}sessionStorage.setItem(key,JSON.stringify(draft));},{sheet,categoryId:category.price_id,priceVersion:price.version,order});
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();if(operation==='publish')await page.getByText(/^执行单价：/).waitFor();
   const path=`/api/digital-production/sources/${source.sourceId}/${operation==='publish'?'development/publish':'confirm'}`,attempts:Array<{key:string|undefined;body:string|null}>=[];
   await page.route('**'+path,async route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_NATIVE_PUBLISH_ACK_LOST',message:'TEST 原发布已提交但回执丢失'}})});});
   await page.getByRole('button',{name:operation==='publish'?'发布开发单':'确认客户订单',exact:true}).click();await page.getByRole('region',{name:'原提交结果待核对',exact:true}).waitFor();expect(attempts).toHaveLength(1);
   const pending=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(pending[0]).toMatchObject({phase:'pending',sourceId:source.sourceId,native:{operation,sourceId:source.sourceId,key:attempts[0]!.key}});
   await page.reload();await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();await page.waitForTimeout(2700);expect(attempts).toHaveLength(1);
   await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();await page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/^已发布 ·/}).waitFor();
   const lookups=h.requests.filter(row=>row.session===tab.session&&row.method==='GET'&&row.path.includes('/development/submission-receipt?'));expect(lookups).toHaveLength(1);expect(new URL(lookups[0]!.path,h.base).searchParams.get('key')).toBe(attempts[0]!.key);expect(new URL(lookups[0]!.path,h.base).searchParams.get('operation')).toBe(operation);expect(attempts).toHaveLength(1);
   expect((await forms.read(actor,source.sourceId)).status).toBe('published');expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[source.sourceId])).rowCount).toBe(operation==='confirm'?1:0);expect((await h.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='development_publish'",[source.sourceId])).rowCount).toBe(1);
   expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('dx:development-creation:')))).toEqual([]);
  }catch(error){await writeFile(join(h.evidence,'native-publish-reload-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('preserves the minimal successful source acknowledgement when the following sheet read fails and resumes that same source on explicit save after reload',async()=>{
  const fault:SettingsBrowserFault={},tab=await h.open(h.f.root.actorId,1165,fault,'/ui/digital-production?workspace=designer'),style='TEST-CREATION-READ-FAIL-'+randomUUID();let sourceId='',creates=0;
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await page.getByRole('button',{name:'新建开发订单',exact:true}).click();await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.route('**/api/digital-production/sources',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}creates++;const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);sourceId=(await result.json()).sourceId;fault.readPath=`/api/digital-production/sources/${sourceId}/development`;fault.failRead=true;await route.fulfill({response:result});});
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST 设置读取暂时失败'}).waitFor();
   const stored=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(stored[0]).toMatchObject({phase:'bound',sourceId,version:null});expect(stored[0]).not.toHaveProperty('original');
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();await page.waitForTimeout(2700);expect(creates).toBe(1);
   const saved=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/digital-production/sources/${sourceId}/development`&&response.request().method()==='PUT');await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();expect((await saved).status()).toBe(200);expect(creates).toBe(1);expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows).toEqual([{source_id:sourceId}]);
  }catch(error){await writeFile(join(h.evidence,'source-known-followup-read-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
});
