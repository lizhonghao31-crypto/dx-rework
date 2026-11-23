import {DEVELOPMENT_MEASUREMENTS} from '@dx-rework/contracts/digital-development';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import type {Page} from 'playwright-core';
import {randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser,type SettingsBrowserFault} from '../acceptance/supplychain-settings-browser.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {orderTimeCreated,orderTimeCreatedMany} from '../../apps/api/src/production-platform/order-time-created.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
async function openNewWizard(page:Page,label:'纯开发'|'已确认订单'|'预下单'='纯开发'){
 await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
 const choices=page.getByRole('dialog',{name:'请选择创建类型'});
 await choices.getByRole('button',{name:label,exact:true}).click();
 await choices.waitFor({state:'hidden'});
}
async function fillRequiredWorkbenchSheet(page:Page){
 const styleName=page.getByRole('textbox',{name:'款名（必填）'});
 if(!await styleName.isVisible())return;
 if(!await styleName.inputValue())await styleName.fill('TEST 款名');
 const gender=page.getByRole('combobox',{name:'性别（必填）'}),board=page.getByRole('combobox',{name:'板类（必填）'});
 if(!await gender.inputValue())await gender.selectOption('男装');
 if(!await board.inputValue())await board.selectOption('头版');
 const noCraft=page.getByRole('checkbox',{name:'无加工工艺'});
 if(await noCraft.isVisible())await noCraft.check();
 else if(await page.getByRole('combobox',{name:'工艺',exact:true}).isVisible())
  await page.getByRole('combobox',{name:'工艺',exact:true}).selectOption('无');
}
async function wizardNext(page:Page,{fillRequirements=true}={}){
 await fillRequiredWorkbenchSheet(page);
 if(fillRequirements&&await page.getByLabel('建单步骤').getByRole('heading',{name:'开发需求',exact:true}).isVisible()
    &&await page.getByRole('combobox',{name:'打板品类',exact:true}).isVisible()){
  const category=page.getByRole('combobox',{name:'打板品类',exact:true});
  const boardCount=page.getByRole('textbox',{name:'本轮打板数量',exact:true});
  if(!await boardCount.inputValue())await boardCount.fill('1');
  if(!(await page.getByText(/^执行单价：/).count())){
   await category.click();
   await page.getByRole('listbox').getByRole('option').filter({hasNotText:/^请选择$/}).first().click();
   await page.getByText(/^执行单价：/).waitFor();
  }
 }
 await page.getByRole('button',{name:'下一步',exact:true}).click();
}

(url?describe.sequential:describe.skip)('original designer workspace parent and pure child draft across actual browser reload',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-pure-create-reload-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps one creation draft panel and the old designer URL opens the work list',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;
   await page.getByRole('heading',{name:'开发草稿',exact:true}).waitFor();
   expect(await page.getByRole('heading',{name:'开发草稿',exact:true}).count()).toBe(1);
   expect(await page.getByRole('button',{name:'新建开发订单',exact:true}).count()).toBe(1);
   expect(h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/workspaces/designer')).toHaveLength(0);
   const trigger=page.getByRole('button',{name:'新建开发订单',exact:true});
   await trigger.click();
   const types=page.getByRole('dialog',{name:'请选择创建类型'});
   await types.waitFor();
   expect(await types.getByRole('button',{name:/^(纯开发|已确认订单|预下单)$/}).allTextContents()).toEqual(['纯开发','已确认订单','预下单']);
   expect(await page.getByRole('textbox',{name:'设计款号',exact:true}).count()).toBe(0);
   await types.getByRole('button',{name:'取消',exact:true}).click();
   await types.waitFor({state:'hidden'});
   expect(await trigger.evaluate(element=>element===document.activeElement)).toBe(true);
   const searched=page.waitForResponse(response=>{
    const url=new URL(response.url());
    return url.pathname.endsWith('/sources/drafts')&&url.searchParams.get('search')==='TEST-无草稿'&&response.ok();
   });
   await page.getByRole('textbox',{name:'搜索草稿款号',exact:true}).fill('TEST-无草稿');
   await searched;
   await page.goto(h.base+'/ui/digital-production?workspace=designer');
   const list=page.locator('.development-list-panel');
   await list.waitFor();
   expect(await list.locator('thead th').allTextContents()).toContain('款图 / 款号');
   expect(await page.getByRole('heading',{name:'开发草稿',exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'新建开发订单',exact:true}).count()).toBe(0);
   expect(await page.getByRole('columnheader',{name:'操作',exact:true}).count()).toBe(0);
  }finally{await tab.context.close();}
 });
 async function verifyCreationDetail(id:string,name:string,expected:Array<{label:string;at:string;target:string}>){
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+id);
  try{
   const page=tab.page;await page.setViewportSize({width:1165,height:747});
   const flow=page.getByRole('region',{name:'订单全流程'});await flow.waitFor();
   expect(await flow.locator('.cockpit-creation-events').count()).toBe(0);
   await page.locator('[data-identity-fact="created"] time').waitFor();
   const read=()=>page.evaluate(async id=>{
    const response=await fetch('/api/digital-production/journeys/'+encodeURIComponent(id)+'?view=cockpit');
    if(!response.ok)throw Error('Cannot verify original time facts: '+response.status);
    const value=await response.json();
    return {cockpitCreation:value.cockpitCreation,creationDetails:value.cockpitCreationDetails,supervision:value.supervision,fixedSchedule:value.fixedSchedule,visualProgress:value.visualProgress};
   },id);
   const before=await read(),nodes=page.getByRole('region',{name:'小流程明细'});
   for(const row of expected){
    const key=row.label==='创建纯开发'?'developmentCreatedAt':'orderCreatedAt';
    expect(before.cockpitCreation[key]).toBe(row.at);
   }
   const cardDate=page.locator('[data-identity-fact="created"] time');
   expect(await cardDate.getAttribute('datetime')).toBe(expected.at(-1)?.at);
   const identity=page.locator('[data-identity-fact="created"]');
   expect(await identity.getByText('创建人：',{exact:true}).count()).toBe(1);
   expect(await identity.locator('dd').last().innerText()).not.toMatch(/未记录|姓名未登记/);
   for(const entry of expected){
    const source=entry.label==='创建纯开发';
    const fact=before.creationDetails.find((detail:{subject:string})=>detail.subject===(source?'source':'order'));
    expect(fact.at).toBe(entry.at);
    const url=new URL(fact.record.url,page.url());
    expect(url.searchParams.get(source?'development':'instruction')).toBe(entry.target);
    if(source)expect(url.searchParams.get('round')).toBe('1');
   }
   // Only the original seven-stage view already has a creation stage. The
   // unchanged nine/eight view receives this same entry with its F3 grouping.
   if(!before.fixedSchedule?.framework){
    const currentHeading=page.getByRole('region',{name:'当前节点详情'}).getByRole('heading',{level:2});
    const priorHeading=await currentHeading.innerText();
    const creation=flow.getByRole('button',{name:'订单创建节点明细',exact:true});
    await creation.focus();await page.keyboard.press('Space');
    await creation.filter({visible:true}).waitFor();
    expect(await creation.getAttribute('aria-pressed')).toBe('true');
    expect(await currentHeading.innerText()).toBe(priorHeading);
    const records=nodes.locator('.cockpit-creation-records[aria-label="创建记录"]');
    const links=records.getByRole('link');
    expect(await links.allTextContents()).toEqual(expected.map(entry=>entry.label));
    for(const [index,entry] of expected.entries()){
     const source=entry.label==='创建纯开发',param=source?'development':'instruction';
     const outgoing=page.waitForResponse(response=>new URL(response.url()).pathname.endsWith(source?'/sources/'+entry.target+'/development':'/orders/'+entry.target+'/instruction')&&response.request().method()==='GET'&&response.ok());
     await links.nth(index).click();
     await page.waitForURL(url=>url.searchParams.get(param)===entry.target&&(!source||url.searchParams.get('round')==='1'));
     await outgoing;
     await page.getByRole('button',{name:'返回来源',exact:true}).click();
     await page.waitForURL(url=>url.searchParams.get('selected')===id&&url.searchParams.get('expanded')==='creation');
     await records.getByRole('link',{name:entry.label,exact:true}).waitFor();
     expect(await currentHeading.innerText()).toBe(priorHeading);
    }
   }
   await nodes.getByRole('button',{name:'本单全部节点',exact:true}).click();
   const removed=['创建产品开发','开发资料保存/发布','订购信息'];
   for(const label of removed)expect(await nodes.locator('.journey-node-toggle').filter({hasText:label}).count()).toBe(0);
   await nodes.getByRole('button',{name:/查看更多/}).click();
   const expanded=page.getByRole('dialog',{name:'全部节点明细'});await expanded.waitFor();
   for(const label of removed)expect(await expanded.locator('.journey-node-toggle').filter({hasText:label}).count()).toBe(0);
   await page.keyboard.press('Escape');await expanded.waitFor({state:'detached'});
   expect(await read()).toEqual(before);
   await page.screenshot({path:join(process.env.DX_COCKPIT_CREATION_EVIDENCE??h.evidence,'creation-flow-'+name+'.png')});
  }finally{await tab.context.close();}
 }
 it.each([['development','纯开发'],['certain_order','已确认订单'],['preorder','预下单']] as const)('restores %s parent intent, raw document/order input and original row identities with no command or writes',async(mode,label)=>{
  const before=Number((await h.db.query('SELECT count(*) FROM digital_production_sources')).rows[0].count),tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());
   if(mode==='development'){
    await page.addInitScript(()=>Object.defineProperty(globalThis.crypto,'randomUUID',{value:undefined,configurable:true}));
    await page.reload();
    expect(await page.evaluate(()=>typeof globalThis.crypto.randomUUID)).toBe('undefined');
   }
   await openNewWizard(page,label);
   const style=page.locator('#development-create-style'),raw='  TEST pure '+mode+' raw  ';await style.fill(raw);
   const instructions=page.locator('#development-instructions');
   const text='  TEST 未提交制作说明 '+mode+'  ';await instructions.fill(text);
   if(mode!=='preorder')await page.getByText(/^尺寸资料 ·/).click();
   const rowId=mode==='preorder'?null:await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id');
   const step=page.locator('.development-creation-steps [aria-current="step"]');
   if(mode==='preorder'){
    expect(await page.getByLabel('尺寸模板',{exact:true}).count()).toBe(0);
    expect(await page.getByLabel('PO 1 颜色',{exact:true}).count()).toBe(0);
    await page.getByLabel('主布 数量与单位',{exact:true}).fill('7.5米');
   }else{
    expect(rowId).toBeTruthy();
    expect(await step.innerText()).toContain('版单');
    await wizardNext(page);
    expect(await step.innerText()).toContain('开发需求');
    if(mode==='certain_order'){
     await wizardNext(page);
     expect(await step.innerText()).toContain('客户与交货');
     await page.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true}).fill('1.');
    }
   }
   const original=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));
   const wizardStep=mode==='preorder'?1:mode==='development'?2:3;
   expect(original).toHaveLength(1);expect(original[0]).toMatchObject({schemaVersion:1,phase:'draft',snapshot:{intent:mode==='development'?'development':'certain_order',preorder:mode==='preorder',wizardStep}});
   for(const field of ['sourceId','original','native','version','beforeVersion'])expect(original[0]).not.toHaveProperty(field);
   await page.reload();
   if(mode==='certain_order'){
    await step.waitFor();expect(await step.innerText()).toContain('客户与交货');
    const quantity=page.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true});
    expect(await quantity.inputValue()).toBe('1.');
    await page.getByRole('button',{name:'提交并确认订单',exact:true}).click();
    await page.getByRole('alert').filter({hasText:/填写有误|请选择客户/}).waitFor();
    await page.getByRole('button',{name:'上一步',exact:true}).click();
   }
   if(mode!=='preorder'){
    await step.waitFor();expect(await step.innerText()).toContain('开发需求');
    await page.getByRole('button',{name:'上一步',exact:true}).click();
    const sizes=page.getByText(/^尺寸资料 ·/);
    if(!await sizes.locator('..').evaluate(node=>(node as HTMLDetailsElement).open))await sizes.click();
    expect(await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id')).toBe(rowId);
   }else expect(await page.getByLabel('主布 数量与单位',{exact:true}).inputValue()).toBe('7.5米');
   await style.waitFor();expect(await style.inputValue()).toBe(raw);expect(await instructions.inputValue()).toBe(text);
   // Two original debounce periods must not turn hydration, quotes or other
   // readonly option refreshes into source/save/publish/confirm commands.
   await page.waitForTimeout(2700);const current=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(current[0].viewId).toBe(original[0].viewId);expect(current[0].phase).toBe('draft');
   expect(h.requests.filter(row=>row.session===tab.session&&!['GET','HEAD'].includes(row.method)&&!row.path.includes('/notifications/'))).toEqual([]);expect(Number((await h.db.query('SELECT count(*) FROM digital_production_sources')).rows[0].count)).toBe(before);
   await page.screenshot({path:join(h.evidence,'pure-create-reload-'+mode+'.png'),fullPage:true});
  }catch(error){await writeFile(join(h.evidence,'pure-create-reload-'+mode+'-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('reuses the acknowledged source and current version when reopening a saved creation draft in the same tab and after reload',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create'),style='TEST-CREATION-SAVE-'+randomUUID();
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await openNewWizard(page);await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();
   const save=page.getByRole('button',{name:'保存开发资料草稿',exact:true}),saved=page.waitForResponse(response=>/\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
   await save.click();const reply=await saved;expect(reply.status(),await reply.text()).toBe(200);const sheet=await reply.json();
   await expect.poll(async()=>{const records=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));return records[0]?.phase;}).toBe('bound');
   const created=h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/sources/drafts'&&row.method==='POST');expect(created).toHaveLength(1);
   expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows).toEqual([{source_id:sheet.sourceId}]);
   const boundPath=`/api/digital-production/sources/${sheet.sourceId}/development`,countPuts=()=>h.requests.filter(row=>row.session===tab.session&&row.path===boundPath&&row.method==='PUT').length;
   const reopen=async()=>{await page.getByRole('button',{name:'返回列表',exact:true}).click();
    await page.getByRole('heading',{name:'开发草稿',exact:true}).waitFor();
    await page.getByRole('button',{name:style,exact:true}).click();
   };
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
   const unsaved=page.locator('#development-instructions'),section=unsaved.locator('xpath=ancestor::details[1]');
   if(await section.count()&&!await section.evaluate(node=>(node as HTMLDetailsElement).open))await section.locator('summary').first().click();
   await unsaved.fill('TEST unsaved input survives conflict');
   await page.getByRole('button',{name:'返回列表',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   const service=new DigitalDevelopmentService(h.db,true,h.patternOrders),latest=await service.read(h.f.root,sheet.sourceId);
   await service.save(h.f.root,sheet.sourceId,{expectedVersion:latest.version,document:{...latest.document!,instructions:'TEST newer authorized edit'}},randomUUID());
   await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'原开发档案版本已变化'}).waitFor();expect(await save.count()).toBe(0);expect(countPuts()).toBe(4);
   expect(h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/sources/drafts'&&row.method==='POST')).toHaveLength(1);
   expect((await h.db.query('SELECT version,document FROM digital_development_documents WHERE source_id=$1',[sheet.sourceId])).rows[0]).toMatchObject({version:5,document:{instructions:'TEST newer authorized edit'}});
  }catch(error){await writeFile(join(h.evidence,'explicit-save-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('restores a saved wizard step in a separate signed session without publishing or reserving again',async()=>{
  const designer=h.f.people['sample-designer']!,style='TEST-WIZARD-PROGRESS-'+randomUUID();
  const url='/ui/digital-production?workspace=designer&section=create';
  const start=await h.open(designer.actorId,1165,{},url);
  let sourceId:string;
  try{
   const page=start.page;
   await openNewWizard(page,'已确认订单');
   await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await wizardNext(page);
   await wizardNext(page);
   await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).fill('TEST 蓝');
   const receipt=page.waitForResponse(response=>/\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const response=await receipt;
   expect(response.status(),await response.text()).toBe(200);
   const draft=await response.json();
   sourceId=draft.sourceId;
   expect(draft).toMatchObject({status:'draft',publishedAt:null,productionOrderId:null,version:1,document:{
    customerOrderDraft:{withOrder:true,stage:'formal',wizardStep:3,order:{lines:[expect.objectContaining({color:'TEST 蓝'})]}},
   }});
  }finally{await start.context.close();}
  const resumed=await h.open(designer.actorId,1165,{},url);
  try{
   const page=resumed.page,step=page.locator('.development-creation-steps [aria-current="step"]');
   await page.getByRole('button',{name:style,exact:true}).click();
   expect(await step.innerText()).toContain('客户与交货');
   expect(await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).inputValue()).toBe('TEST 蓝');
   expect(await page.getByRole('dialog',{name:'请选择创建类型'}).count()).toBe(0);
   await page.getByRole('button',{name:'上一步',exact:true}).click();
   expect(await step.innerText()).toContain('开发需求');
   expect(h.requests.filter(row=>row.session===resumed.session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'))).toEqual([]);
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId!})).toBeNull();
   expect((await h.db.query('SELECT version FROM digital_development_documents WHERE source_id=$1',[sourceId!])).rows).toEqual([{version:1}]);
  }finally{await resumed.context.close();}
  const direct=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+sourceId!);
  try{
   const step=direct.page.locator('.development-creation-steps [aria-current="step"]');
   expect(await step.innerText()).toContain('客户与交货');
   expect(await direct.page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).inputValue()).toBe('TEST 蓝');
   expect(h.requests.filter(row=>row.session===direct.session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'))).toEqual([]);
  }finally{await direct.context.close();}
 });
 it.each([['上衣',8,12],['裤子',6,10]] as const)('keeps the complete %s long sheet when locating, editing and reopening a hidden material',async(template,fabricCount,accessoryCount)=>{
  const actor=h.f.people['sample-designer']!,style='TEST-V7-LONG-'+randomUUID(),kind='digital-production?workspace=designer&section=create';
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const {sourceId}=await identity.createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
  const garment=initialDevelopmentDocument();
  const materials=Array.from({length:fabricCount+accessoryCount},(_,index)=>({
   ...garment.materials[0]!,materialId:randomUUID(),category:index<fabricCount?'主布' as const:'辅料' as const,
   label:'材料 '+(index+1),name:'TEST面辅料 '+(index+1),width:'150 cm',composition:'棉',supplier:index===fabricCount-1?'':'布行',
   color:'米白',garmentColor:'藏青',part:'前幅',quantity:'20',quantityUnit:'米',
  }));
  const bad=materials[fabricCount-1]!,sizes=template==='上衣'?['M','L','XL','2XL']:['S','M','L','XL','2XL'];
  const making=sizes.map((_,i)=>i<2?1:0);
  const sewingRows=(template==='上衣'?['藏青']:['藏青','米白','灰']).map((color,i)=>({rowId:randomUUID(),color,size:sizes[i]!,quantity:null}));
  const files=await Promise.all(Array.from({length:6},async(_,index)=>({
   attachmentId:await h.f.image(actor),kind:index===0?'款图' as const:'局部图' as const,
  })));
  const order=InitialCustomerOrderDraftSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-19',temporaryStyleNo:null,contractDeliveryDate:null,
   lines:[{formalPoNo:style+'-1',color:'藏青',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-16',sizes:[{size:'M',quantity:'2'}]},
    {formalPoNo:style+'-2',color:'米白',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-22',sizes:[{size:'XL',quantity:'3'}]}],
  });
  const before=await forms.save(actor,sourceId,{expectedVersion:0,document:{
   ...garment,template,quantity:2,sizes,sizeQuantities:making,
   measurements:DEVELOPMENT_MEASUREMENTS[template].map((name,index)=>({name,values:sizes.map((_,column)=>String((index+1)*10+column))})),
   materials,files,interlining:'朴料',placketInterlining:'门筒朴',sewingThread:'车缝线',buttonholeThread:'纽门线',stitchDensity:'12针',
   washing:'内洗',washingMethod:'原洗水要求',ironing:'整烫',packaging:'包装',mainLabel:true,mainLabelMethod:'主唛车法',sizeLabel:true,careLabel:true,
   workbenchSheet:{version:1,styleName:'长表测试',brand:'原品牌',gender:'男装',boardType:'产前版',processingSelected:true,referenceNote:'原参考备注',
    sewingRows},
   customerOrderDraft:{withOrder:true,stage:'formal',order,wizardStep:1},
  }},randomUUID());
  const tab=await h.open(actor.actorId,1165,{},'/ui/'+kind);
  try{
   const page=tab.page;
   await page.getByRole('button',{name:style,exact:true}).click();
   const docs=page.getByRole('heading',{name:'版单',exact:true});
   await docs.waitFor();
   const lookup=page.getByRole('searchbox',{name:'查找字段'});
   await lookup.fill('针距');
   await page.getByRole('button',{name:'针距',exact:true}).click();
   expect(await page.getByLabel('针距',{exact:true}).inputValue()).toBe('12针');
   const firstRow=page.locator('#development-'+bad.materialId+'-supplier');
   expect(await firstRow.count()).toBe(0);
   await page.getByRole('button',{name:'下一步',exact:true}).click();
   const dialog=page.getByRole('dialog',{name:'全部面辅料'});
   await dialog.waitFor();
   await expect.poll(()=>firstRow.evaluate(el=>document.activeElement===el)).toBe(true);
   await firstRow.fill('补齐供应商');
   await dialog.getByLabel(bad.label+' 实样图片',{exact:true}).selectOption(files[1]!.attachmentId);
   await dialog.getByRole('button',{name:'返回版单',exact:true}).click();
   await dialog.waitFor({state:'hidden'});
   await wizardNext(page);await wizardNext(page);
   expect(await page.getByLabel('尺码列 1',{exact:true}).inputValue()).toBe('M');
   expect(await page.getByLabel('PO 2 尺码 1',{exact:true}).inputValue()).toBe('XL');
   expect(await page.locator('#development-po-date-2').inputValue()).toBe('2027-03-22');
   const saved=page.waitForResponse(response=>response.url().endsWith('/sources/'+sourceId+'/development')&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const response=await saved;expect(response.status(),await response.text()).toBe(200);
   const after=await response.json();
   const {materials:originalMaterials,customerOrderDraft:prevOrder,patternCategoryId,...originalSheet}=before.document!;
   const {materials:updatedMaterials,customerOrderDraft:nextOrder,patternCategoryId:chosenCategory,...updatedSheet}=after.document;
   expect(patternCategoryId).toBeFalsy();
   expect(updatedSheet).toEqual(originalSheet);
   expect(chosenCategory).toBeTruthy();
   expect(nextOrder).toEqual({...prevOrder,wizardStep:3});
   expect(updatedMaterials).toEqual(originalMaterials.map(row=>row.materialId===bad.materialId?{...row,supplier:'补齐供应商',sampleAttachmentId:files[1]!.attachmentId}:row));
   expect(after.document.materials).toHaveLength(fabricCount+accessoryCount);
   await page.reload();
   expect(await page.getByLabel('PO 2 尺码 1',{exact:true}).inputValue()).toBe('XL');
   expect(await page.locator('#development-po-date-2').inputValue()).toBe('2027-03-22');
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
  }finally{await tab.context.close();}
 });
 it('returns to the actual craft control when a workbench craft attachment blocks publication',async()=>{
  const actor=h.f.people['sample-designer']!,style='TEST-V7-CRAFT-LOCATOR-'+randomUUID();
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const {sourceId}=await identity.createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
  const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
  const file={attachmentId:await h.f.image(actor),kind:'工艺开发板' as const};
  await forms.save(actor,sourceId,{expectedVersion:0,document:{
   ...initialDevelopmentDocument(),quantity:1,patternCategoryId:category.price_id,files:[file],
   workbenchSheet:{version:1,styleName:'工艺定位',brand:'',gender:'男装',boardType:'头版',processingSelected:true,referenceNote:'',sewingRows:[]},
  }},randomUUID());
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page,steps=page.getByLabel('建单步骤');
   await page.getByRole('button',{name:style,exact:true}).click();
   await page.getByRole('button',{name:'下一步',exact:true}).click();
   await steps.getByRole('heading',{name:'开发需求',exact:true}).waitFor();
   await page.getByText(/^执行单价：/).waitFor();
   await page.getByRole('button',{name:'提交开发单',exact:true}).click();
   const issue=page.getByRole('button',{name:'工艺：工艺开发板仅适用于印花或绣花',exact:true});
   await issue.click();
   expect(await steps.getByRole('heading',{name:'版单',exact:true}).isVisible()).toBe(true);
   const checkbox=page.getByRole('checkbox',{name:'绣花',exact:true}),native=await checkbox.isVisible();
   const craft=native?checkbox:page.getByRole('combobox',{name:'工艺',exact:true});
   await expect.poll(()=>craft.evaluate(el=>document.activeElement===el)).toBe(true);
   if(native)await craft.check();else await craft.selectOption('绣花');
   await issue.waitFor({state:'hidden'});
   const saved=page.waitForResponse(response=>response.url().endsWith('/sources/'+sourceId+'/development')&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const result=await saved;expect(result.status(),await result.text()).toBe(200);
   expect(await result.json()).toMatchObject({sourceId,status:'draft',document:{craft:'绣花',files:[file]}});
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
  }finally{await tab.context.close();}
 });
 it('opens two independent server drafts from a new authenticated browser session, retaining three PO rows and two original ready files',async()=>{
  const actor=h.f.root,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const styles=[`TEST-CABINET-A-${randomUUID()}`,`TEST-CABINET-B-${randomUUID()}`];
  const sourceIds:string[]=[],attachments=[await h.f.image(actor),await h.f.image(actor)];
  for(const [index,designStyleNo] of styles.entries()){
   const {sourceId}=await identity.createSource(actor,{developmentType:'头版',designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   sourceIds.push(sourceId);
   const order=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo,orderDate:'2026-11-19',
    temporaryStyleNo:null,contractDeliveryDate:null,lines:Array.from({length:index===0?3:1},(_,line)=>({
     formalPoNo:`TEST-${index}-PO${line+1}`,color:['黑','白','灰'][line],deliveryDate:null,sizes:[{size:'M',quantity:String(line+1)}]
    }))});
   await forms.save(actor,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),instructions:`TEST independent ${index}`,
    customerOrderDraft:{withOrder:true,stage:'formal',order},files:index===0?attachments.map(attachmentId=>({attachmentId,kind:'款图' as const})):[]}},randomUUID());
  }
  const initialTab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  await initialTab.context.close();
  const {context,page,session}=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   await page.getByRole('heading',{name:'开发草稿',exact:true}).waitFor();
   for(const index of [0,1,0]){
    await page.getByRole('button',{name:styles[index]!,exact:true}).click();
    expect(await page.getByLabel('设计款号',{exact:true}).inputValue()).toBe(styles[index]);
    await wizardNext(page,{fillRequirements:false});await wizardNext(page,{fillRequirements:false});
    const po=page.getByRole('textbox',{name:/^PO \d+ 正式款号 \/ PO$/});
    expect(await po.count()).toBe(index===0?3:1);
    for(let line=0;line<await po.count();line++)expect(await po.nth(line).inputValue()).toBe(`TEST-${index}-PO${line+1}`);
    const sheet=await forms.read(actor,sourceIds[index]!);
    expect(sheet.version).toBe(1);expect(sheet.document!.files.map(file=>file.attachmentId)).toEqual(index===0?attachments:[]);
    if(index===0){
     const metadata=await page.evaluate(async({id,attachments})=>Promise.all(attachments.map(async attachment=>{
      const response=await fetch(`/api/digital-production/sources/${id}/development/attachments/${attachment}/metadata`);
      return {status:response.status,attachmentId:(await response.json()).attachmentId};
     })),{id:sourceIds[0]!,attachments});
     expect(metadata).toEqual(attachments.map(attachmentId=>({status:200,attachmentId})));
    }
    await page.getByRole('button',{name:'返回列表',exact:true}).click();
   }
   expect(h.requests.filter(row=>row.session===session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'))).toEqual([]);
   const journeys=new DigitalJourneyQuery(h.db);
   for(const id of sourceIds)await expect(journeys.read(actor,id)).rejects.toMatchObject({statusCode:404});
   const clocks=await orderTimeCreatedMany(h.db,sourceIds.map(id=>({kind:'source',id})));
   expect([...clocks.values()]).toEqual([null,null]);
  }finally{await context.close();}
 });

 it('starts one effective clock at successful publication, rolls back a failed native pattern write, and preserves it through later order confirmation',async()=>{
  const actor=h.f.root,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const designStyleNo='TEST-FIRST-EFFECTIVE-'+randomUUID(),scene=await h.f.scene('2026-11-19T01:02:03.123Z');
  const input={developmentType:'头版' as const,designStyleNo,temporaryStyleNo:null,customerCode:'PD'},reserveKey=randomUUID();
  const sourceId=await h.f.runtime.run(scene,actor,async()=>{
   const {sourceId}=await identity.createSource(actor,input,reserveKey,true);
   expect(await identity.createSource(actor,input,reserveKey,true)).toEqual({sourceId});
   await expect(identity.createSource(actor,input,randomUUID(),true)).rejects.toThrow('已有开发档案');
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   expect((await h.db.query("SELECT 1 FROM digital_preparation_rule_adoptions WHERE resource_kind='source' AND resource_id=$1",[sourceId])).rowCount).toBe(0);
   return sourceId;
  });
  const publication='2026-11-19T06:07:08.456Z';
  await h.f.advance(scene,publication);
  const saved=await h.f.runtime.run(scene,actor,async()=>{
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const price=await new PatternRoomPriceService(h.db).quote(actor,'category',category.price_id);
   const sheet=await forms.save(actor,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,
    files:[{attachmentId:await h.f.image(actor),kind:'款图'}],patternCategoryId:category.price_id}},randomUUID());
   const operation={kind:'development_publish' as const,sourceId,input:{expectedVersion:sheet.version,patternOrder:{categoryId:category.price_id,priceVersion:price.version}}};
   const requests=h.orderTimeRequests!;
   const check=await requests.check(actor,operation);
   const pending=await requests.submit(actor,{operation,fingerprint:check.fingerprint,reason:'TEST first publication requires this original decision'},randomUUID());
   expect(pending.state).toBe('pending');
   await expect(forms.publish(actor,sourceId,sheet.version,randomUUID(),operation.input.patternOrder)).rejects.toMatchObject({code:'ORDER_TIME_REQUEST_REQUIRED'});
   expect((await identity.developmentDrafts(actor,1,designStyleNo)).items[0]).toMatchObject({sourceId,approvalState:'pending'});
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   const returned=await requests.close(actor,pending.requestId,{expectedVersion:pending.version,reason:'TEST return before original publication'},randomUUID(),'returned');
   expect(returned.state).toBe('returned');
   expect((await identity.developmentDrafts(actor,1,designStyleNo)).items[0]).toMatchObject({sourceId,approvalState:'returned'});
   await expect(forms.publish(actor,sourceId,sheet.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version+1000})).rejects.toMatchObject({code:'PRICE_CHANGED'});
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   expect(await new OrderTimePlanRepository(h.db).current({kind:'source',id:sourceId})).toBeNull();
   expect((await forms.read(actor,sourceId)).version).toBe(sheet.version);
   const valid={categoryId:category.price_id,priceVersion:price.version},key=randomUUID();
   const sameSource=await Promise.all([key,randomUUID()].map(id=>forms.publish(actor,sourceId,sheet.version,id,valid)));
   for(const value of sameSource)expect(value).toMatchObject({sourceId,version:sheet.version+1,publishedAt:publication});
   expect(await forms.publish(actor,sourceId,sheet.version,key,valid)).toEqual(sameSource[0]);
   expect((await h.db.query("SELECT count(*)::int AS n FROM audit_events WHERE action='digital_development_first_published' AND entity_id=$1",[sourceId])).rows[0]!.n).toBe(1);
   expect((await h.db.query("SELECT effective FROM digital_order_time_subjects WHERE source_id=$1",[sourceId])).rows).toEqual([{effective:true}]);
   const creation=await orderTimeCreated(h.db,{kind:'source',id:sourceId});
   expect(creation).toMatchObject({at:publication});
   const plan=await new OrderTimePlanRepository(h.db).current({kind:'source',id:sourceId});
   expect(plan).toBeTruthy();
   return {creation,plan};
  });
  h.setCollectionScene(scene);
  await verifyCreationDetail(sourceId,'development',[{label:'创建纯开发',at:publication,target:sourceId}]);
  const workList=await h.open(actor.actorId,1165,{},`/ui/digital-production?workspace=designer&section=workspace&search=${encodeURIComponent(designStyleNo)}`);
  try{
   const {page}=workList,link=page.locator(`#development-open-${sourceId}`);
   await link.waitFor();
   expect(await page.locator('style[data-designer-style="astryx-v0.7.16"]').count()).toBe(1);
   expect(await link.evaluate(element=>element.tagName)).toBe('A');
   const destination=new URL((await link.getAttribute('href'))!,page.url());
   expect(destination.searchParams.get('development')).toBe(sourceId);
   expect(destination.searchParams.get('search')).toBe(designStyleNo);
   await link.focus();
   await page.keyboard.press('Enter');
   await page.getByRole('heading',{name:'本单资料',exact:true}).waitFor();
   expect(new URL(page.url()).searchParams.get('development')).toBe(sourceId);
   await page.getByRole('button',{name:'返回来源',exact:true}).click();
   await link.waitFor();
   expect(new URL(page.url()).searchParams.get('search')).toBe(designStyleNo);
   await expect.poll(()=>link.evaluate(element=>document.activeElement===element)).toBe(true);
   await link.click();
   const edit=page.getByRole('button',{name:'编辑版单',exact:true});
   await edit.waitFor();
   const beforeEdit=h.requests.length;
   await edit.click();
   await page.locator('#development-revision').waitFor();
   await page.getByRole('button',{name:'保存草稿',exact:true}).waitFor();
   expect(h.requests.slice(beforeEdit).filter(call=>call.session===workList.session&&['POST','PUT','PATCH'].includes(call.method)
    &&call.path.startsWith(`/api/digital-production/sources/${sourceId}/development`))).toEqual([]);
  }finally{await workList.context.close();}
  const rounds=new DevelopmentRoundService(h.db,true,h.patternOrders),originalSheet=await forms.read(actor,sourceId);
  const originalComment='TEST 原已保存客户评语';
  await h.f.runtime.run(scene,actor,()=>rounds.save(actor,sourceId,{expectedDraftVersion:0,revision:{basedOnRound:1,
    document:originalSheet.document!,origin:'客户新增要求',customerComment:originalComment,internalProblem:'',explanation:'TEST 保留原复版资料',
    categories:['其他'],affectedNodes:['车板'],outputKind:'整件样板'}},randomUUID()));
  const resume=await h.open(actor.actorId,1165,{},`/ui/digital-production?workspace=designer&section=workspace&development=${sourceId}`);
  try{
   const edit=resume.page.getByRole('button',{name:'编辑版单',exact:true});
   await edit.waitFor();
   expect(await edit.getAttribute('title')).toBe('继续修订草稿');
   await edit.click();
   await resume.page.locator('#development-revision').waitFor();
   expect(await resume.page.getByRole('textbox',{name:/客户原评语/}).inputValue()).toBe(originalComment);
   expect((await rounds.read(actor,sourceId)).draft.version).toBe(1);
   expect((await forms.read(actor,sourceId)).version).toBe(originalSheet.version);
  }finally{await resume.context.close();}
  const formal='2026-11-19T06:18:09.789Z';
  await h.f.advance(scene,formal);
  const created=await h.f.runtime.run(scene,actor,async()=>{
   const formalInput=DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo,temporaryStyleNo:null,
    orderDate:'2026-11-19',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',
    productionPlanning:{craftSteps:[],preshrink:false},lines:[{formalPoNo:designStyleNo+'-PO',color:'黑',
     deliveryDate:null,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:2}]}]});
   await expect(identity.createOrder(actor,{...formalInput,designStyleNo:'TEST-MISMATCH'},randomUUID(),sourceId)).rejects.toThrow();
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
   const key=randomUUID(),order=await identity.createOrder(actor,formalInput,key,sourceId);
   expect(await identity.createOrder(actor,formalInput,key,sourceId)).toEqual(order);
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(1);
   expect(await orderTimeCreated(h.db,{kind:'order',id:order.productionOrderId})).toMatchObject({at:formal});
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toEqual(saved.creation);
   expect(await new OrderTimePlanRepository(h.db).current({kind:'source',id:sourceId})).toEqual(saved.plan);
   const directStyle='TEST-DIRECT-'+randomUUID();
   const direct=await identity.createOrder(actor,{...formalInput,designStyleNo:directStyle,
    lines:formalInput.lines.map(line=>({...line,formalPoNo:directStyle+'-PO'}))},randomUUID());
   expect(direct.sourceId).toBeNull();
   expect(await orderTimeCreated(h.db,{kind:'order',id:direct.productionOrderId})).toMatchObject({at:formal});
   return {converted:order.productionOrderId,direct:direct.productionOrderId};
  });
  await verifyCreationDetail(created.converted,'converted',[{label:'创建纯开发',at:publication,target:sourceId},{label:'创建正式订单',at:formal,target:created.converted}]);
  await verifyCreationDetail(created.direct,'direct',[{label:'创建正式订单',at:formal,target:created.direct}]);
  await h.f.runtime.run(scene,actor,async()=>{
   const designer=h.f.people['sample-designer']!,policy=new DigitalProductionAccessPolicy(h.db),query=new DigitalJourneyQuery(h.db);
   // Preserve a narrowly authorized historical association in this synthetic
   // schema. Production attachment commands intentionally enforce one creator.
   const original=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-SOURCE-ONLY-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const origin=await orderTimeCreated(h.db,{kind:'source',id:original.sourceId});
   expect(origin?.at).toBe(formal);
   const unlinked=await query.read(designer,original.sourceId,undefined,true);
   const projection=(journey:typeof unlinked)=>journey.stages.flatMap(stage=>stage.nodes).filter(node=>node.key!=='order_information')
    .map(node=>[node.instanceId,node.state,node.countsInProgress]);
   const sourceFact=(journey:typeof unlinked)=>journey.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='order_information');
   expect(sourceFact(unlinked)).toMatchObject({actualAt:formal,records:[{domain:'source',id:original.sourceId}]});
   await h.db.query('UPDATE digital_production_orders SET source_id=$2 WHERE production_order_id=$1',[created.direct,original.sourceId]);
   expect(await policy.allowed(designer,'source',original.sourceId,'technical')).toBe(true);
   expect(await policy.allowed(designer,'order',created.direct,'technical')).toBe(false);
   const restricted=await query.read(designer,original.sourceId,undefined,true);
   expect(restricted.cockpitCreationDetails?.map(entry=>entry.subject)).toEqual(['source']);
   expect(sourceFact(restricted)).toMatchObject({actualAt:formal,records:[{domain:'source',id:original.sourceId}],countsInProgress:false});
   const scopedRaw=await query.read(designer,original.sourceId);
   expect(restricted.progress).toEqual(scopedRaw.progress);
   expect(projection(restricted)).toEqual(projection(scopedRaw));
  });

 });
 it('applies a real manager approval to publish and confirm a complete draft in one native transaction with both exact clocks',async()=>{
  const designer=h.f.people['sample-designer']!,manager=h.f.root;
  const identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),requests=h.orderTimeRequests!;
  const designStyleNo='TEST-APPROVAL-FIRST-'+randomUUID(),scene=await h.f.scene('2026-11-19T01:30:00.000Z');
  const {pending,sourceId}=await h.f.runtime.run(scene,designer,async()=>{
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo,temporaryStyleNo:null,customerCode:'PD'},randomUUID(),true);
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const price=await new PatternRoomPriceService(h.db).quote(manager,'category',category.price_id);
   const order=InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo,temporaryStyleNo:null,
    orderDate:'2026-11-19',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',
    lines:[{formalPoNo:designStyleNo+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:'2'}]}]});
   const sheet=await forms.save(designer,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,
    files:[{attachmentId:await h.f.image(designer),kind:'款图'}],patternCategoryId:category.price_id,
    customerOrderDraft:{withOrder:true,stage:'formal',order},productionPlanning:{craftSteps:[],preshrink:false}}},randomUUID());
   const operation={kind:'development_publish' as const,sourceId,input:{expectedVersion:sheet.version,patternOrder:{categoryId:category.price_id,priceVersion:price.version}}};
   const check=await requests.check(designer,operation);
   const pending=await requests.submit(designer,{operation,fingerprint:check.fingerprint,reason:'TEST native formal execution on manager approval'},randomUUID());
   expect(pending.state).toBe('pending');
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
   return {pending,sourceId};
  });
  const approvedAt='2026-11-19T04:15:25.555Z';
  await h.f.advance(scene,approvedAt);
  const orderId=await h.f.runtime.run(scene,manager,async()=>{
   const review=await requests.read(manager,pending.requestId),key=randomUUID();
   const input={expectedVersion:review.version,fingerprint:review.check.fingerprint,overrides:{},acceptLate:false};
   const applied=await requests.apply(manager,pending.requestId,input,key);
   expect(applied.state).toBe('applied');
   const orderId=applied.result?.orderId;
   expect(orderId).toBeTruthy();
   expect(await requests.apply(manager,pending.requestId,input,key)).toEqual(applied);
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toMatchObject({at:approvedAt});
   expect(await orderTimeCreated(h.db,{kind:'order',id:orderId!})).toMatchObject({at:approvedAt});
   expect((await h.db.query(`SELECT a.actor_id,a.after_state->>'createdBy' AS designer_id
    FROM digital_development_first_publications p JOIN audit_events a ON a.id=p.event_id WHERE p.source_id=$1`,[sourceId])).rows)
    .toEqual([{actor_id:manager.actorId,designer_id:designer.actorId}]);
   expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(1);
   return orderId!;
  });
  h.setCollectionScene(scene);
  await verifyCreationDetail(orderId,'approved-formal',[{label:'创建正式订单',at:approvedAt,target:orderId}]);
  const detail=await h.f.runtime.run(scene,manager,()=>new DigitalJourneyQuery(h.db).read(manager,orderId,undefined,true));
  expect(detail.cockpitCreation).toEqual({developmentCreatedAt:approvedAt,orderCreatedAt:approvedAt,developmentPublishedWithOrder:true});
  const creator=(await h.db.query<{display_name:string}>('SELECT display_name FROM app_users WHERE id=$1',[designer.actorId])).rows[0]!.display_name;
  expect(designer.actorId).not.toBe(manager.actorId);
  expect(detail.cockpitCreationDetails?.map(entry=>entry.creator?.name)).toEqual([creator,creator]);

  const name=(await h.db.query<{display_name:string}>('SELECT display_name FROM app_users WHERE id=$1',[designer.actorId])).rows[0]!.display_name;
  expect(detail.cockpitCreationDetails).toMatchObject([
   {subject:'source',at:approvedAt,creator:{name},record:{id:sourceId}},
   {subject:'order',at:approvedAt,creator:{name},record:{id:orderId}}
  ]);
  const canonical=detail.stages.flatMap(stage=>stage.nodes).find(node=>node.key==='order_information');
  expect(canonical?.records[0]).toMatchObject({domain:'source',id:sourceId});
  expect(detail.cockpitCreationDetails?.find(entry=>entry.subject==='order')?.record)
   .toMatchObject({domain:'order',id:orderId});
 });

 it('reuses a legacy provisional identity without rewriting historical clocks and blocks an already frozen draft',async()=>{
  const legacy=await businessAnchorFixture(url!,{throughVersion:'0295_order_time_rewash_input'});
  try{
   const identity=new DigitalProductionIdentityService(legacy.db,true),forms=new DigitalDevelopmentService(legacy.db,true),actor=legacy.root;
   const source=async(prefix:string)=>(await identity.createSource(actor,{developmentType:'头版',
    designStyleNo:`TEST-${prefix}-${randomUUID()}`,temporaryStyleNo:null,customerCode:null},randomUUID())).sourceId;
   const save=async(id:string)=>forms.save(actor,id,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,
    files:[{attachmentId:await legacy.image(actor),kind:'款图'}]}},randomUUID());
   const frozen=await source('FROZEN');const frozenDraft=await save(frozen);
   await prepareRewashSettings(legacy);
   const published=await source('HISTORICAL');const publishedDraft=await save(published);
   await forms.publish(actor,published,publishedDraft.version,randomUUID());
   const provisional=await source('PROVISIONAL');const pending=await save(provisional);
   const tables=['digital_development_sla_plans','digital_timeline_adoptions','digital_order_time_plan_versions','digital_order_time_subjects'];
   const snapshot=async(id:string)=>await Promise.all(tables.map(table=>legacy.db.query(`SELECT to_jsonb(t) AS row FROM ${table} t WHERE source_id=$1 ORDER BY to_jsonb(t)::text`,[id]).then(result=>result.rows)));
   const beforePublished=await snapshot(published),beforeFrozen=await snapshot(frozen);
   const oldOrigin=await orderTimeCreated(legacy.db,{kind:'source',id:provisional});
   expect(oldOrigin).toBeTruthy();
   const migration=await readFile(new URL('../../apps/api/migrations/0296_development_first_publication.sql',import.meta.url),'utf8');
   await legacy.db.query(migration);
   expect(await orderTimeCreated(legacy.db,{kind:'source',id:provisional})).toBeNull();
   expect(await orderTimeCreated(legacy.db,{kind:'source',id:frozen})).toBeNull();
   await expect(forms.publish(actor,frozen,frozenDraft.version,randomUUID())).rejects.toMatchObject({code:'DEVELOPMENT_DRAFT_TIMELINE_CONFLICT'});
   expect(await snapshot(frozen)).toEqual(beforeFrozen);
   const effective=await forms.publish(actor,provisional,pending.version,randomUUID());
   const newOrigin=await orderTimeCreated(legacy.db,{kind:'source',id:provisional});
   expect(newOrigin).toMatchObject({at:effective.publishedAt});
   expect(newOrigin?.evidence).not.toBe(oldOrigin?.evidence);
   expect((await legacy.db.query('SELECT creation_event_ref,created_business_time FROM digital_order_time_subjects WHERE source_id=$1',[provisional])).rows[0]).toMatchObject({
    creation_event_ref:oldOrigin?.evidence,created_business_time:{now:oldOrigin?.at}
   });
   expect(await snapshot(published)).toEqual(beforePublished);
  }finally{await legacy.dispose();}
 });

 it('saves the first document when a reservation is reopened on another Beijing calendar day',async()=>{
  const actor=h.f.root,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true,h.patternOrders);
  const designStyleNo='TEST-RESERVE-LATER-DAY-'+randomUUID();
  const {sourceId}=await identity.createSource(actor,{developmentType:'头版',designStyleNo,temporaryStyleNo:null,customerCode:null},randomUUID(),true);
  const reserved=await forms.read(actor,sourceId);
  expect(reserved.version).toBe(0);
  expect(reserved.developmentCreatedDate).toBeUndefined();
  const origin=reserved.draftDocumentDate!;
  expect(origin).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const later=new Date(Date.parse(origin)+86400000).toISOString().slice(0,10);
  const {page,context}=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   await page.route('**/api/digital-production/options*',async route=>{
    const response=await route.fetch(),body=await response.json();
    await route.fulfill({response,json:{...body,serverToday:later}});
   });
   await page.getByRole('heading',{name:'开发草稿',exact:true}).waitFor();
   await page.getByRole('button',{name:designStyleNo,exact:true}).click();
   const saved=page.waitForResponse(response=>response.url().endsWith(`/sources/${sourceId}/development`)&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const response=await saved;
   expect(response.status(),await response.text()).toBe(200);
   expect(response.request().postDataJSON().document.orderDate).toBe(origin);
   expect((await forms.read(actor,sourceId)).document?.orderDate).toBe(origin);
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
  }finally{await page.unrouteAll({behavior:'wait'});await context.close();}
 });

 it('reads the authorized original reservation receipt when creation is paused and preserves the unknown command on browser reload',async()=>{
  const actor=h.f.root,style='TEST-PAUSED-RECEIPT-'+randomUUID(),tab=await h.open(actor.actorId,390,{},'/ui/digital-production?workspace=designer&section=create');
  const {page,session}=tab;
  try{
   await openNewWizard(page);
   await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   let originalKey='',sourceId='';
   await page.route('**/api/digital-production/sources/drafts',async route=>{
    if(route.request().method()!=='POST'){await route.continue();return;}
    const response=await route.fetch();
    expect(response.status()).toBe(200);
    sourceId=(await response.json()).sourceId;originalKey=route.request().headers()['idempotency-key']!;
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_ACK_LOST',message:'TEST 原回执不可用'}})});
   });
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'未收到可确认的提交结果'}).waitFor();
   const paused=new DigitalProductionIdentityService(h.db,false);
   expect(await paused.developmentDraftReceipt(actor,originalKey)).toEqual({sourceId});
   const designer=h.f.people['sample-designer']!;
   expect(await paused.developmentDraftReceipt(designer,originalKey)).toEqual({sourceId:null});
   const ownKey=randomUUID(),owned=await new DigitalProductionIdentityService(h.db,true).createSource(designer,{
    developmentType:'头版',designStyleNo:'TEST-EXISTING-READ-'+randomUUID(),temporaryStyleNo:null,customerCode:null},ownKey,true);
   const reader={...designer,authorizationCapabilities:['digital_production:view']};
   expect(await paused.developmentDraftReceipt(reader,ownKey)).toEqual(owned);
   expect((await new DigitalDevelopmentService(h.db,true).read(reader,owned.sourceId)).canEdit).toBe(false);
   const pausedForm=new DigitalDevelopmentService(h.db,false,h.patternOrders);
   expect((await pausedForm.read(actor,sourceId)).canEdit).toBe(false);
   await page.route('**/api/digital-production/options',async route=>{
    const response=await route.fetch();await route.fulfill({response,json:{...await response.json(),creationEnabled:false}});
   });
   await page.route('**/api/digital-production/sources/'+sourceId+'/development',async route=>{
    if(route.request().method()!=='GET'){await route.continue();return;}
    await route.fulfill({json:await pausedForm.read(actor,sourceId)});
   });
   await page.reload();
   await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();
   await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();
   await page.getByRole('alert').filter({hasText:'已核对原草稿回执。当前没有编辑权限'}).waitFor();
   expect(h.requests.filter(row=>row.session===session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'))).toHaveLength(1);
   const reads=h.requests.filter(row=>row.session===session&&row.path==='/api/digital-production/sources/drafts/receipt');
   expect(reads).toHaveLength(1);expect(reads[0]?.key).toBe(originalKey);
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
  }finally{await page.unrouteAll({behavior:'wait'});await tab.context.close();}
 });

 it('retains an acknowledged-server but browser-unknown source creation across real reload without issuing a duplicate source command',async()=>{
  const tab=await h.open(h.f.root.actorId,390,{},'/ui/digital-production?workspace=designer&section=create'),style='TEST-CREATION-UNKNOWN-'+randomUUID();let attempts=0;
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await openNewWizard(page);await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.route('**/api/digital-production/sources/drafts',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}attempts++;const response=await route.fetch();expect(response.status(),await response.text()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_CREATE_ACK_LOST',message:'TEST 已创建但原回执丢失'}})});});
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'未收到可确认的提交结果'}).waitFor();
   const prior=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(prior[0]).toMatchObject({phase:'pending',sourceId:null,original:{path:'sources/drafts',method:'POST'}});expect(prior[0].original.key).toBeTruthy();
   await page.reload();await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();await page.waitForTimeout(2700);
   expect(await page.getByRole('textbox',{name:'设计款号',exact:true}).count()).toBe(0);
   const next=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));
   expect(next[0].original).toEqual(prior[0].original);expect(attempts).toBe(1);
   await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();
   const restored=page.getByRole('textbox',{name:'设计款号',exact:true});await restored.waitFor();expect(await restored.inputValue()).toBe(style);
   const receipt=h.requests.filter(row=>row.session===tab.session&&row.method==='GET'&&row.path==='/api/digital-production/sources/drafts/receipt');
   expect(receipt).toHaveLength(1);expect(receipt[0]!.key).toBe(prior[0].original.key);
   expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rowCount).toBe(1);
   expect(h.requests.filter(row=>row.session===tab.session&&row.method==='PUT'&&row.path.includes('/development'))).toEqual([]);
  }catch(error){await writeFile(join(h.evidence,'unknown-create-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it.each(['publish','confirm'] as const)('restores native original %s after actual reload and confirms it by one original-key GET with no command replay',async operation=>{
  const actor=h.f.root,style='TEST-CREATION-'+operation+'-'+randomUUID(),source=await new DigitalProductionIdentityService(h.db,true).createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:operation==='confirm'?'PD':null},randomUUID());
  const forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!,price=await new PatternRoomPriceService(h.db).quote(actor,'category',category.price_id);
  const order=operation==='confirm'?InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,primaryMerchandiserId:h.f.people.merchandiser!.actorId,orderDate:'2026-11-17',contractDeliveryDate:null,requiresColorMatching:false,salesYear:2027,salesSeries:'P03',lines:[{formalPoNo:style+'-PO',color:'黑',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:'2'}]}]}):null;
  let sheet=await forms.save(actor,source.sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,files:[{attachmentId:await h.f.image(actor),kind:'款图'}],patternCategoryId:category.price_id,...(order?{productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order}}:{})}},randomUUID());
  if(operation==='confirm')sheet=await forms.publish(actor,source.sourceId,sheet.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version});
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await openNewWizard(page);await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   // Isolated restoration fixture: the source/document are prepared by their
   // real services, and this is the same bound state following an acknowledged
   // original draft save. Publication and receipt lookup below are unmocked.
   await page.evaluate(({sheet,categoryId,priceVersion,order})=>{const key=Object.keys(sessionStorage).find(key=>key.startsWith('dx:development-creation:'))!,draft=JSON.parse(sessionStorage.getItem(key)!);draft.phase='bound';draft.sourceId=sheet.sourceId;draft.version=sheet.version;draft.snapshot.document=sheet.document;draft.snapshot.quantityInput='1';draft.snapshot.patternChoice={categoryId,priceVersion};if(order){draft.snapshot.intent='certain_order';draft.snapshot.form=order;}sessionStorage.setItem(key,JSON.stringify(draft));},{sheet,categoryId:category.price_id,priceVersion:price.version,order});
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();await wizardNext(page);
   if(operation==='publish')await page.getByText(/^执行单价：/).waitFor();else await wizardNext(page);
   const path=`/api/digital-production/sources/${source.sourceId}/${operation==='publish'?'development/publish':'confirm'}`,attempts:Array<{key:string|undefined;body:string|null}>=[];
   await page.route('**'+path,async route=>{attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_NATIVE_PUBLISH_ACK_LOST',message:'TEST 原发布已提交但回执丢失'}})});});
   await page.getByRole('button',{name:operation==='publish'?'提交开发单':'提交并确认订单',exact:true}).click();await page.getByRole('region',{name:'原提交结果待核对',exact:true}).waitFor();expect(attempts).toHaveLength(1);
   const pending=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(pending[0]).toMatchObject({phase:'pending',sourceId:source.sourceId,native:{operation,sourceId:source.sourceId,key:attempts[0]!.key}});
   await page.reload();await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();await page.waitForTimeout(2700);expect(attempts).toHaveLength(1);
   await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();await page.locator('.dx-doc-toolbar .dx-doc-status').filter({hasText:/^已发布 ·/}).waitFor();
   const lookups=h.requests.filter(row=>row.session===tab.session&&row.method==='GET'&&row.path.includes('/development/submission-receipt?'));expect(lookups).toHaveLength(1);expect(new URL(lookups[0]!.path,h.base).searchParams.get('key')).toBe(attempts[0]!.key);expect(new URL(lookups[0]!.path,h.base).searchParams.get('operation')).toBe(operation);expect(attempts).toHaveLength(1);
   expect((await forms.read(actor,source.sourceId)).status).toBe('published');expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[source.sourceId])).rowCount).toBe(operation==='confirm'?1:0);expect((await h.db.query("SELECT 1 FROM audit_events WHERE entity_id=$1 AND action='development_publish'",[source.sourceId])).rowCount).toBe(1);
   expect(await page.evaluate(()=>Object.keys(sessionStorage).filter(key=>key.startsWith('dx:development-creation:')))).toEqual([]);
  }catch(error){await writeFile(join(h.evidence,'native-publish-reload-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('preserves the minimal successful source acknowledgement when the following sheet read fails and resumes that same source on explicit save after reload',async()=>{
  const fault:SettingsBrowserFault={},tab=await h.open(h.f.root.actorId,1165,fault,'/ui/digital-production?workspace=designer&section=create'),style='TEST-CREATION-READ-FAIL-'+randomUUID();let sourceId='',creates=0;
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await openNewWizard(page);await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await page.route('**/api/digital-production/sources/drafts',async route=>{if(route.request().method()!=='POST'){await route.continue();return;}creates++;const result=await route.fetch();expect(result.status(),await result.text()).toBe(200);sourceId=(await result.json()).sourceId;fault.readPath=`/api/digital-production/sources/${sourceId}/development`;fault.failRead=true;await route.fulfill({response:result});});
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST 设置读取暂时失败'}).waitFor();
   const stored=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(stored[0]).toMatchObject({phase:'bound',sourceId,version:null});expect(stored[0]).not.toHaveProperty('original');
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();await page.waitForTimeout(2700);expect(creates).toBe(1);
   const saved=page.waitForResponse(response=>new URL(response.url()).pathname===`/api/digital-production/sources/${sourceId}/development`&&response.request().method()==='PUT');await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();expect((await saved).status()).toBe(200);expect(creates).toBe(1);expect((await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows).toEqual([{source_id:sourceId}]);
  }catch(error){await writeFile(join(h.evidence,'source-known-followup-read-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
});
