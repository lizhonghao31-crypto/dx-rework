import {chooseDevelopmentCreation} from "./development-creation-browser-steps.js";
import {DEVELOPMENT_MEASUREMENTS} from '@dx-rework/contracts/digital-development';
import {mkdtemp,readFile,writeFile} from 'node:fs/promises';
import type {Page,Response} from 'playwright-core';
import {createHash,randomUUID} from 'node:crypto';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeAll,afterAll,describe,it,expect,vi} from 'vitest';
import {supplychainSettingsBrowser,type SettingsBrowserFault} from '../acceptance/supplychain-settings-browser.js';
import {businessAnchorFixture} from '../helpers/business-anchor-fixture.js';
import {prepareRewashSettings} from '../helpers/order-time-rewash-fixture.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {DevelopmentRoundService} from '../../apps/api/src/production-platform/development-round-service.js';
import {PatternRoomPriceService} from '../../apps/api/src/pattern-room/price-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {DigitalOrderCreateSchema,InitialCustomerOrderDraftSchema} from '@dx-rework/contracts/digital-production';
import {CreateSupplierSchema} from '@dx-rework/contracts';
import {orderTimeCreated,orderTimeCreatedMany} from '../../apps/api/src/production-platform/order-time-created.js';
import {OrderTimePlanRepository} from '../../apps/api/src/production-platform/order-time-plan-repository.js';
import {DigitalProductionAccessPolicy} from '../../apps/api/src/production-platform/access-policy.js';
import {DigitalJourneyQuery} from '../../apps/api/src/production-platform/journey-query.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

vi.setConfig({testTimeout:testExecutionConfig.correctnessTimeoutMs,hookTimeout:testExecutionConfig.correctnessTimeoutMs});
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
async function inspectCreationControl(page:Page,selector:string){
 const session=await page.context().newCDPSession(page);
 try{
  await session.send('DOM.enable');await session.send('CSS.enable');
  const {root}=await session.send('DOM.getDocument');
  const {nodeId}=await session.send('DOM.querySelector',{nodeId:root.nodeId,selector});
  const [actual,values]=await Promise.all([session.send('CSS.getMatchedStylesForNode',{nodeId}),session.send('CSS.getComputedStyleForNode',{nodeId})]);
  const matched=actual.matchedCSSRules?.flatMap(rule=>rule.matchingSelectors.map(index=>rule.rule.selectorList.selectors[index]?.text))??[];
  expect(matched.some(text=>text?.includes('dx-production-refined')&&text.includes('.development-create-wizard'))).toBe(false);
  expect(matched.some(text=>text?.includes('.dx-doc-instruction')&&text.includes('[aria-invalid=true]'))).toBe(false);
  const computed=Object.fromEntries(values.computedStyle.filter(row=>['border-top-width','outline-style','box-shadow','opacity','cursor'].includes(row.name)).map(row=>[row.name,row.value]));
  const native=await page.locator(selector).evaluate(node=>({disabled:node.getAttribute('aria-disabled')??(node.hasAttribute('disabled')?'true':null),invalid:node.getAttribute('aria-invalid'),
   focused:document.activeElement===node,astryx:Boolean(node.closest('.dx-development-astryx-control,.astryx-selector'))}));
  expect(native.astryx).toBe(true);
  return {matched,computed,native};
 }finally{await session.detach();}
}
async function openNewWizard(page:Page,label:'纯开发'|'已确认订单'|'预下单'='纯开发',garment:'上衣'|'裤子'='上衣',rush=false){
 await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
 await chooseDevelopmentCreation(page,label,garment,rush);
}
async function changeGarment(page:Page,garment:'上衣'|'裤子',confirm?:boolean){
 const choice=page.getByRole('combobox',{name:/^衣类/});
 await choice.click();await page.getByRole('option',{name:garment==='上衣'?/^(上装|上衣)$/:/^(下装|裤子)$/}).click();
 if(confirm!==undefined){
  const warning=page.getByRole('alertdialog',{name:'更正衣类'});
  await warning.getByRole('button',{name:confirm?'确认更正':'取消',exact:true}).click();
  await warning.waitFor({state:'hidden'});
 }
}
async function fillRequiredWorkbenchSheet(page:Page){
 const styleName=page.getByRole('textbox',{name:/款式（品名）|款名（必填）/});
 const gender=page.getByRole('combobox',{name:/^性别/}),board=page.getByRole('combobox',{name:/^板类/});
 if(!await gender.isVisible())return;
 if(await styleName.isVisible()&&!await styleName.inputValue())await styleName.fill('TEST 款名');
 const brand=page.getByRole('textbox',{name:/^品牌/});
 if(await brand.isVisible()&&!await brand.inputValue())await brand.fill('TEST 品牌');
 for(const [field,option] of [[gender,'男装'],[board,'头版']] as const){
  if(await field.evaluate(el=>el instanceof HTMLSelectElement)){
   if(!await field.inputValue())await field.selectOption(option);
  }else if((await field.innerText()).trim()==='请选择'){
   await field.click();
   await page.getByRole('option',{name:option,exact:true}).click();
  }
 }
}
async function fillRequiredCraft(page:Page){
 const noCraft=page.getByRole('checkbox',{name:'无加工工艺'});
 if(await noCraft.isVisible())await noCraft.check();
 else {
  const craft=page.getByRole('combobox',{name:'工艺',exact:true});
  if(!await craft.isVisible())return;
  if(await craft.evaluate(element=>element.tagName==='SELECT')){if(!await craft.inputValue())await craft.selectOption('无');}
  else if((await craft.innerText()).trim()==='选择加工类型'){await craft.press('Enter');await page.getByRole('option',{name:'无',exact:true}).click();}
 }
}
async function wizardNext(page:Page,{fillRequirements=true}={}){
 await fillRequiredWorkbenchSheet(page);
 await fillRequiredCraft(page);
 const category=page.locator('.development-pattern-preparation [aria-haspopup="listbox"]').filter({visible:true});
 if(fillRequirements&&await page.getByLabel('建单步骤').getByRole('heading',{name:'开发需求',exact:true}).isVisible()
    &&await category.isVisible()){
  const boardCount=page.getByRole('textbox',{name:'本轮打板数量',exact:true});
  if(await boardCount.count()){if(!await boardCount.inputValue())await boardCount.fill('1');}
  else{
   const making=page.getByRole('table',{name:'颜色尺码与制作件数',exact:true});
   if(!await making.getByRole('spinbutton').count())await page.getByRole('button',{name:'添加颜色尺码行',exact:true}).click();
   if(!await making.getByRole('textbox',{name:'第 1 行 颜色',exact:true}).inputValue()){
    await making.getByRole('textbox',{name:'第 1 行 颜色',exact:true}).fill('黑');
    await making.getByRole('textbox',{name:'第 1 行 尺码',exact:true}).fill('M');
    await making.getByRole('spinbutton',{name:'第 1 行 件数',exact:true}).fill('1');
   }
  }
  if(!(await page.getByText(/^执行单价：/).count())){
   await category.click();
   await page.getByRole('listbox').getByRole('option').filter({hasNotText:/^请选择$/}).first().click();
   await page.getByText(/^执行单价：/).waitFor();
  }
 }
 await page.getByRole('button',{name:'下一步',exact:true}).click();
}

(url?describe:describe.skip)('C2 G2 numbered preorder native entry',()=>{
 it('keeps a lost numbered reservation out of ordinary deletion and recovers the same source by the original key',async()=>{
  const h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-ui01-numbered-lost-')),{fullApp:true,workbenchNumberedCreation:true,orderTimeFlow:true,orderTimeModel:true});
  try{
   await prepareRewashSettings(h.f);
   const actor=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
   const style='TEST-UNRELATED-'+randomUUID(),temporary='TEST-LOST-'+randomUUID();
   await identity.createSource(actor,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:null},randomUUID(),true);
   const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
   try{
    const page=tab.page,path='/api/digital-production/sources/numbered-drafts',target='**'+path;
    await openNewWizard(page,'预下单');
    await page.getByRole('textbox',{name:'代用款号（选填）',exact:true}).fill(temporary);
    let created='',key='';
    await page.route(target,async route=>{
     const request=route.request();if(request.method()!=='POST'){await route.continue();return;}
     key=request.headers()['idempotency-key']!;
     const response=await route.fetch();expect(response.status(),await response.text()).toBe(200);
     created=(await response.json()).sourceId;
     await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_UI01_LOST_NUMBER_ACK',message:'TEST 已预留，回执丢失'}})});
    });
    await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
    await page.getByRole('alert').filter({hasText:'未收到可确认的提交结果'}).waitFor();
    await page.reload();
    await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();
    expect(created).toBeTruthy();expect(key).toBeTruthy();
    await page.unroute(target);
    const receiptTarget='**'+path+'/receipt';
    await page.route(receiptTarget,route=>route.abort('failed'));
    await page.getByRole('button',{name:'返回列表并保留资料',exact:true}).click();
    const box=page.getByRole('region',{name:'开发草稿箱',exact:true});
    await box.getByRole('button',{name:`删除草稿 ${style}`,exact:true}).waitFor();
    expect(await box.getByRole('button',{name:`删除草稿 ${temporary}`,exact:true}).count()).toBe(0);
    const server=await page.request.get(h.base+'/api/digital-production/sources/drafts');
    expect(await server.json()).toMatchObject({items:expect.arrayContaining([expect.objectContaining({sourceId:created,temporaryStyleNo:temporary,numbered:true,ownedByRequester:true})])});
    await page.unroute(receiptTarget);
    const background=page.waitForResponse(r=>r.url().endsWith(path+'/receipt')&&r.ok());
    await page.reload();
    expect(await (await background).json()).toMatchObject({sourceId:created});
    await box.getByRole('button',{name:`删除草稿 ${style}`,exact:true}).waitFor();
    expect(await box.getByRole('button',{name:`删除草稿 ${temporary}`,exact:true}).count()).toBe(0);
    await page.getByRole('region',{name:'原提交结果待核对',exact:true}).getByRole('button',{name:'核对原创建提交结果',exact:true}).click();
    const receipt=page.waitForResponse(r=>r.url().endsWith(path+'/receipt')&&r.ok());
    await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();
    expect(await (await receipt).json()).toMatchObject({sourceId:created});
    const alternate=page.getByRole('textbox',{name:'代用款号（选填）',exact:true});
    await alternate.waitFor();expect(await alternate.inputValue()).toBe(temporary);
    const actual=h.requests.filter(row=>row.session===tab.session&&row.path===path&&row.method==='POST');
    expect(actual).toHaveLength(1);expect(actual[0]?.key).toBe(key);
    expect((await h.db.query('SELECT 1 FROM digital_development_draft_discards WHERE source_id=$1',[created])).rowCount).toBe(0);
   }catch(error){await writeFile(join(h.evidence,'ui01-lost-number-browser.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
 it('resumes an unnumbered draft, recovers preorder publication and formally confirms the same numbered source',async()=>{
  const evidence=await mkdtemp(join(tmpdir(),'dx-c2-numbered-preorder-'));
  const h=await supplychainSettingsBrowser(url!,evidence,{fullApp:true,orderTimeFlow:true,orderTimeModel:true,workbenchNumberedCreation:true});
  try{
   await prepareRewashSettings(h.f);
   const actor=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
   const supplier=await h.f.access.createSupplier(h.f.root,CreateSupplierSchema.parse({supplierCode:'TEST-C2-FABRIC',supplierName:'TEST G2 供应商',supplierType:'fabric',changeReason:'TEST C2 原目录取值'}));
   const otherSupplier=await h.f.access.createSupplier(h.f.root,CreateSupplierSchema.parse({supplierCode:'TEST-C2-OTHER',supplierName:'TEST G2 供应商其他类别',supplierType:'other',changeReason:'TEST C2 不得跨目录'}));
   await h.f.access.createSupplier(h.f.root,CreateSupplierSchema.parse({supplierCode:'TEST-C2-STOPPED',supplierName:'TEST G2 供应商已停用',supplierType:'fabric',active:false,changeReason:'TEST C2 不得新选停用档案'}));
   const settings=await identity.orderNumberSettings(h.f.root);
   await identity.saveOrderNumberSettings(h.f.root,{...settings.values,expectedVersion:settings.version,designers:[{userId:actor.actorId,code:'LH'}]},randomUUID());
   const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
   try{
    const page=tab.page;
    await openNewWizard(page,'预下单','上衣',true);
    const code=page.getByRole('textbox',{name:'订单ID',exact:true});
    await code.waitFor();expect(await code.inputValue()).toBe('待生成');
    expect(await code.evaluate(node=>(node as HTMLInputElement).readOnly)).toBe(true);
    await page.getByRole('textbox',{name:/^款式（品名）/}).fill('TEST 预下单品名');
    await page.getByRole('textbox',{name:/^品牌/}).fill('TEST 预下单品牌');
    expect(await page.getByRole('combobox',{name:/^板类/}).count()).toBe(0);
    const reservedResponse=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/sources/numbered-drafts'));
    const savedResponse=page.waitForResponse(r=>r.request().method()==='PUT'&&/\/sources\/[a-f0-9-]+\/development$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
    const reserved=await reservedResponse;expect(reserved.status(),await reserved.text()).toBe(200);
    const {sourceId,orderNumber}=await reserved.json();expect(orderNumber).toBeNull();
    const saved=await savedResponse;expect(saved.status(),await saved.text()).toBe(200);
    await page.getByText(/^开发资料与订购草稿已保存/).waitFor();
    expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
    expect((await h.db.query('SELECT 1 FROM digital_development_preorder_publications WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
    await page.reload();await code.waitFor();expect(await code.inputValue()).toBe('待生成');
    await page.locator('#development-create-customer').getByRole('button',{name:/^客户/}).click();
    await page.getByRole('listbox',{name:'客户',exact:true}).getByRole('option',{name:/^PD ·/}).click();
    await page.getByRole('combobox',{name:/^销售年份/}).click();await page.getByRole('option',{name:/^\d{4}(?:\s|$)/}).first().click();
    await page.getByRole('combobox',{name:/^销售系列/}).click();await page.getByRole('option',{name:/^P02 ·/}).click();
    await page.getByRole('textbox',{name:/^主布(?: A)? 品名/,exact:true}).fill('TEST G2 真实面料');
    await page.getByRole('textbox',{name:/^主布(?: A)? 规格/}).fill('TEST G2 原规格');
    await page.locator('.development-material-inline-row').first().locator('input[id$="-quantity"]').fill('20 米');
    const forbiddenSelection=await page.evaluate(async({id,reference})=>{
     const path=`/api/digital-production/sources/${id}/development`;
     const {version,document}=await (await fetch(path)).json();
     Object.assign(document.materials[0],{supplier:'TEST G2 供应商其他类别',supplierReference:reference});
     return (await fetch(path,{method:'PUT',headers:{'content-type':'application/json','idempotency-key':'test-c2-other-supplier'},body:JSON.stringify({expectedVersion:version,document})})).status;
    },{id:sourceId,reference:otherSupplier});
    expect(forbiddenSelection).toBe(409);
    const readSuppliers=page.waitForResponse(r=>r.ok()&&r.url().includes('/development/material-suppliers?'));
    await page.getByRole('button',{name:/^主布(?: A)? 供应商$/}).click();
    const supplierOptions=await (await readSuppliers).json();
    expect(supplierOptions.items).toContainEqual({...supplier,code:'TEST-C2-FABRIC',name:'TEST G2 供应商'});
    const supplierCodes=supplierOptions.items.map((option:{code:string})=>option.code);
    expect(supplierCodes).not.toContain('TEST-C2-OTHER');
    expect(supplierCodes).not.toContain('TEST-C2-STOPPED');
    await page.getByRole('button',{name:'TEST G2 供应商 · TEST-C2-FABRIC',exact:true}).click();
    await page.getByRole('textbox',{name:/^主布(?: A)? 单价/}).fill('0.35');
    await page.locator('[data-material-total]').filter({hasText:'7 元'}).waitFor();
    const aux=page.locator('#development-preorder-auxiliary');
    await aux.getByRole('button',{name:/添加辅料/}).click();
    await aux.getByRole('textbox',{name:/^辅料 品名/}).fill('TEST G2 辅料计划');
    await aux.getByRole('combobox',{name:/^辅料 已有实物/}).click();
    await page.getByRole('option',{name:'否',exact:true}).click();
    await aux.locator('input[id$="-quantity"]').fill('2');
    await aux.getByRole('combobox',{name:/^辅料 数量单位/}).click();
    await page.getByRole('option',{name:'个',exact:true}).click();
    await aux.getByRole('button',{name:'辅料 供应商',exact:true}).click();
    await page.getByRole('button',{name:'TEST G2 供应商 · TEST-C2-FABRIC',exact:true}).click();
    const planned=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname.endsWith(`/sources/${sourceId}/development`));
    await page.getByRole('button',{name:'保存预下单备料资料',exact:true}).click();
    const planResponse=await planned;expect(planResponse.status(),await planResponse.text()).toBe(200);
    const {version:planVersion,document:planDocument}=await planResponse.json();
    const auxPlan=planDocument.materials.find((item:{category:string})=>item.category==='辅料');
    expect(auxPlan).toMatchObject({designerHasMaterial:false,available:false,expectedDate:null});
    const route=`/api/digital-production/sources/${sourceId}/development/publish-preorder`,attempts:string[]=[];
    const incomplete=await page.evaluate(async({url,version})=>{
     const response=await fetch(url,{method:'POST',headers:{'content-type':'application/json','idempotency-key':'test-c2-aux-plan-no-date'},body:JSON.stringify({expectedVersion:version})});
     return {status:response.status,text:await response.text()};
    },{url:route,version:planVersion});
    expect(incomplete.status).toBe(400);
    expect(JSON.parse(incomplete.text)).toMatchObject({error:{code:'VALIDATION_ERROR',message:'辅料选择了没有实物，请填写预计日期'}});
    expect((await h.db.query('SELECT 1 FROM digital_development_preorder_publications WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
    // This is the ordinary formal-confirmation success fixture. Keep the real
    // early arrival premise so the normal time review does not need an exception.
    await aux.locator(`#development-${auxPlan.materialId}-expectedDate`).fill('2027-01-06');
    await page.route('**'+route,async intercepted=>{
     attempts.push(intercepted.request().headers()['idempotency-key']??'');
     const response=await intercepted.fetch();
     if(response.ok())await intercepted.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_G2_LOST_ACK',message:'TEST 真实发布后回执丢失'}})});
     else await intercepted.fulfill({response});
    });
    await page.getByRole('button',{name:'发布预下单',exact:true}).click();
    await page.getByText(/预下单发布结果尚未确定/).waitFor();
    expect(attempts).toHaveLength(1);
    const published=(await h.db.query('SELECT source_id,document_version,recipient_id,document FROM digital_development_preorder_publications WHERE source_id=$1',[sourceId])).rows;
    expect(published).toMatchObject([{source_id:sourceId,recipient_id:h.f.people.merchandiser!.actorId}]);
    expect(published[0]!.document.materials[0]).toMatchObject({supplier:'TEST G2 供应商',supplierReference:supplier,lineTotal:'7'});
    expect(published[0]!.document.materials.find((item:{category:string})=>item.category==='辅料')).toMatchObject({designerHasMaterial:false,available:false,expectedDate:'2027-01-06'});
    await page.reload();await page.getByRole('heading',{name:'原创建提交结果待核对',exact:true}).waitFor();
    const receipt=page.waitForResponse(r=>r.ok()&&r.url().includes('/submission-receipt?operation=publish_preorder'));
    await page.getByRole('button',{name:'只读核对原提交结果',exact:true}).click();
    expect(await (await receipt).json()).toMatchObject({status:'completed',operation:'publish_preorder',sourceId,documentVersion:published[0]!.document_version});
    await page.waitForURL(u=>u.searchParams.get('development')===sourceId);
    expect(attempts).toHaveLength(1);
    expect(h.requests.filter(row=>row.session===tab.session&&row.method==='POST'&&row.path.endsWith('/sources/numbered-drafts'))).toHaveLength(1);
    const issued=(await h.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[sourceId])).rows[0]?.design_style_no;
    expect(issued).toMatch(/^PDMLH\d{4}P02-\d+$/);
    expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
    expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[sourceId])).rowCount).toBe(0);
    const handover=(await h.db.query(`SELECT record_id,version,occurred_at FROM digital_preparation_material_versions WHERE resource_kind='source' AND resource_id=$1 AND kind='design_handover'`,[sourceId])).rows;
    expect(handover).toHaveLength(1);
    const warehouse=h.f.people.warehouse!,merch=h.f.people.merchandiser!,preparation=new ProductionReadinessService(h.db);
    const receivingSource={kind:'source' as const,id:sourceId},material=published[0]!.document.materials[0];
    await preparation.assign(h.f.root,receivingSource,{expectedVersion:0,warehouseWorkerId:warehouse.actorId,
     colorConfirmationWorkerId:null,colorConfirmationRole:null,reason:'TEST original warehouse for published X2 preorder'},randomUUID());
    const purchaseAt=new Date(Date.now()-1000).toISOString();
    await preparation.record(merch,receivingSource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'partial',
     occurredAt:purchaseAt,note:'TEST binding actual ordered material',quantities:[{lineId:null,materialId:material.materialId,name:material.name,quantity:20,unit:'米'}],
     evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
    const receiving=await h.open(warehouse.actorId,1165,{},'/ui/digital-production?workspace=warehouse');
    try{
     await receiving.page.getByRole('heading',{name:'仓库中心',exact:true}).waitFor();
     const queue=receiving.page.getByRole('region',{name:'待收料',exact:true});
     await queue.getByRole('textbox',{name:'搜索订单ID、PO 或物料',exact:true}).fill(issued);
     await queue.getByRole('button',{name:'搜索',exact:true}).click();
     const open=queue.getByRole('link',{name:'实际收料',exact:true});
     await queue.getByRole('row').filter({has:receiving.page.getByRole('link',{name:'实际收料',exact:true})}).getByText('急单',{exact:true}).waitFor();
     const requested=new URL((await open.getAttribute('href'))!,receiving.page.url()).searchParams;
     expect(requested.get('materialSource')).toBe(sourceId);
     expect(requested.get('warehouseMaterial')).toBe(material.materialId);
     await open.click();
     const work=receiving.page.getByRole('region',{name:'仓库实际收料',exact:true});
     await work.getByRole('textbox',{name:'本次数量（米）',exact:true}).fill('12');
     await work.getByLabel('实际收料时间（北京时间）',{exact:true}).fill(new Date(Date.now()+8*3600000).toISOString().slice(0,19));
     await work.getByRole('textbox',{name:'本次收料说明 / 订正原因',exact:true}).fill('TEST signed browser registers the first warehouse batch');
     const target=`/sources/${sourceId}/production-readiness/warehouse-receipts`,receiptKeys:string[]=[];
     await receiving.page.route(url=>url.pathname.endsWith(target),async route=>{
      receiptKeys.push(route.request().headers()['idempotency-key']??'');
      if(receiptKeys.length===1){
       const result=await route.fetch();expect(result.status()).toBe(200);
       await route.abort('failed');
      }else await route.continue();
     });
     await work.getByRole('button',{name:'保存实际收料',exact:true}).click();
     const retry=work.getByRole('button',{name:'核对并重试原提交',exact:true});
     await retry.waitFor();
     expect(await work.getByRole('textbox',{name:'本次数量（米）',exact:true}).inputValue()).toBe('12');
     await retry.click();
     await work.getByText(/已实收：12 米/).waitFor();
     expect(receiptKeys).toHaveLength(2);expect(receiptKeys[0]).toBeTruthy();expect(receiptKeys[1]).toBe(receiptKeys[0]);
     expect(await work.getByText(/采购待收：8/).isVisible()).toBe(true);
     await receiving.page.setViewportSize({width:390,height:747});
     expect(await receiving.page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)).toBe(true);
     await receiving.page.screenshot({path:join(evidence,'x3-warehouse-receipt-native-390.png'),fullPage:true});
     await work.getByRole('button',{name:'返回来源',exact:true}).click();
     await queue.getByText(/20 米 \/ 12 米 \/ 8 米/).waitFor();
     expect(new URL(receiving.page.url()).searchParams.get('search')).toBe(issued);
     expect(await queue.getByRole('textbox',{name:'搜索订单ID、PO 或物料',exact:true}).inputValue()).toBe(issued);
    }finally{await receiving.close();}
    expect((await h.db.query("SELECT count(*)::int AS n FROM digital_preparation_material_versions WHERE resource_id=$1 AND kind='fabric_receipt'",[sourceId])).rows[0]?.n).toBe(1);
    expect(await orderTimeCreated(h.db,receivingSource)).toBeNull();

    await page.getByRole('button',{name:'客户确认下单',exact:true}).click();
    const formalForm=page.getByRole('region',{name:'客户意见',exact:true});
    await formalForm.getByRole('button',{name:'确认下单',exact:true}).waitFor();
    expect(await formalForm.getByRole('textbox',{name:'订单ID',exact:true}).inputValue()).toBe(issued);
    await formalForm.getByRole('textbox',{name:'PO 1 正式款号 / PO',exact:true}).fill(`${issued}-01`);
    await formalForm.getByRole('textbox',{name:'PO 1 颜色',exact:true}).fill('黑');
    await formalForm.getByRole('textbox',{name:'尺码列 1',exact:true}).fill('M');
    await formalForm.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true}).fill('2');
    await formalForm.locator('#development-po-date-1').fill('2027-04-30');
    await formalForm.getByRole('combobox',{name:'大货工艺是否确定',exact:true}).selectOption('known');
    await formalForm.getByRole('combobox',{name:'大货是否预缩',exact:true}).selectOption('no');
    await formalForm.getByLabel('辅料是否需要对色',{exact:true}).selectOption('no');
    const confirmation=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(`/sources/${sourceId}/confirm`));
    await formalForm.getByRole('button',{name:'确认下单',exact:true}).click();
    const formal=await confirmation;expect(formal.status(),await formal.text()).toBe(200);
    const {productionOrderId}=await formal.json();
    expect((await h.db.query('SELECT production_order_id,design_style_no FROM digital_production_orders WHERE source_id=$1',[sourceId])).rows).toEqual([{production_order_id:productionOrderId,design_style_no:issued}]);
    expect(await orderTimeCreated(h.db,{kind:'order',id:productionOrderId})).toBeTruthy();
    expect((await h.db.query(`SELECT record_id,version,occurred_at FROM digital_preparation_material_versions WHERE resource_kind='source' AND resource_id=$1 AND kind='design_handover'`,[sourceId])).rows).toEqual(handover);
    const inherited=await h.open(warehouse.actorId,1165,{},`/ui/digital-production?workspace=warehouse&search=${encodeURIComponent(issued)}`);
    try{
     const queue=inherited.page.getByRole('region',{name:'待收料',exact:true});
     await queue.getByText(/20 米 \/ 12 米 \/ 8 米/).waitFor();
     const links=queue.getByRole('link',{name:'实际收料',exact:true});
     expect(await links.count()).toBe(1);
     const exact=new URL((await links.getAttribute('href'))!,inherited.page.url()).searchParams;
     expect(exact.get('materialOrder')).toBe(productionOrderId);
     expect(exact.has('materialSource')).toBe(false);
     await links.click();
     const formalReceipt=inherited.page.getByRole('region',{name:'仓库实际收料',exact:true});
     await formalReceipt.getByText(/已实收：12 米/).waitFor();
     expect((await h.db.query("SELECT resource_id,version FROM digital_preparation_material_versions WHERE resource_id=ANY($1::uuid[]) AND kind='fabric_receipt'",[[sourceId,productionOrderId]])).rows).toEqual([{resource_id:sourceId,version:1}]);
     await formalReceipt.getByRole('textbox',{name:'本次数量（米）',exact:true}).fill('8');
     await formalReceipt.getByLabel('实际收料时间（北京时间）',{exact:true}).fill(new Date(Date.now()+8*3600000).toISOString().slice(0,19));
     await formalReceipt.getByRole('textbox',{name:'本次收料说明 / 订正原因',exact:true}).fill('TEST formal order receives the remaining quantity');
     await formalReceipt.getByRole('button',{name:'保存实际收料',exact:true}).click();
     await formalReceipt.getByText(/已实收：20 米/).waitFor();
     await formalReceipt.getByRole('button',{name:'返回来源',exact:true}).click();
     await queue.getByText('没有符合授权及筛选的收料事项。',{exact:true}).waitFor();
     await queue.getByRole('combobox',{name:'收料状态',exact:true}).click();
     await inherited.page.getByRole('option',{name:'采购收足',exact:true}).click();
     await queue.getByText('采购已收足',{exact:true}).waitFor();
     const finished=queue.getByRole('link',{name:'查看原收料与订正',exact:true});
     expect(new URL((await finished.getAttribute('href'))!,inherited.page.url()).searchParams.get('materialOrder')).toBe(productionOrderId);
     expect((await h.db.query("SELECT resource_id,version,state FROM digital_preparation_material_versions WHERE resource_id=ANY($1::uuid[]) AND kind='fabric_receipt' ORDER BY version",[[sourceId,productionOrderId]])).rows).toEqual([
      {resource_id:sourceId,version:1,state:'partial'},{resource_id:sourceId,version:2,state:'partial'},
     ]);
    }finally{await inherited.close();}
   }catch(error){
    const body=tab.page.locator('body');
    await writeFile(join(evidence,'preorder-entry-failure.txt'),await body.innerText());
    await writeFile(join(evidence,'preorder-entry-aria.yml'),await body.ariaSnapshot());
    throw error;
   }
   finally{await tab.context.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
 it('numbers new pure and confirmed orders in their own X1 contexts, and submits the formal order with the issued identity',async()=>{
  const evidence=await mkdtemp(join(tmpdir(),'dx-c2-numbered-creation-'));
  const h=await supplychainSettingsBrowser(url!,evidence,{fullApp:true,orderTimeFlow:true,orderTimeModel:true,workbenchNumberedCreation:true});
  const entry='/ui/digital-production?workspace=designer&section=create';
  try{
   await prepareRewashSettings(h.f);
   const actor=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
   const settings=await identity.orderNumberSettings(h.f.root);
   await identity.saveOrderNumberSettings(h.f.root,{...settings.values,expectedVersion:settings.version,designers:[{userId:actor.actorId,code:'LH'}]},randomUUID());
   const isReservation=(r:Response)=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith('/sources/numbered-drafts');
   const sourceWrite=(r:Response)=>r.request().method()==='PUT'&&/\/sources\/[a-f0-9-]+\/development$/.test(new URL(r.url()).pathname);
   const chooseYear=async(page:Page)=>{await page.getByRole('combobox',{name:/^销售年份/}).click();await page.getByRole('option',{name:/^\d{4}(?:\s|$)/}).first().click();};
   const pure=await h.open(actor.actorId,1165,{},entry);
   try{
    const {page}=pure;
    await openNewWizard(page,'纯开发','裤子');
    const orderId=page.getByRole('textbox',{name:'订单ID',exact:true});
    expect(await orderId.inputValue()).toBe('待生成');
    expect(await page.getByRole('textbox',{name:'设计款号',exact:true}).count()).toBe(0);
    const reserved=page.waitForResponse(isReservation),draft=page.waitForResponse(sourceWrite);
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const opened=await reserved;
    expect(opened.request().postDataJSON()).toMatchObject({numbering:{kind:'development',customerCode:null,salesSeries:null}});
    const {sourceId,orderNumber}=await opened.json();
    expect(orderNumber).toBeNull();
    expect((await draft).status()).toBe(200);
    await page.getByText(/^开发资料与订购草稿已保存/).waitFor();
    await page.reload();await orderId.waitFor();expect(await orderId.inputValue()).toBe('待生成');
    await chooseYear(page);
    const bind=page.waitForResponse(r=>r.request().method()==='POST'&&r.url().endsWith(`/sources/${sourceId}/draft-number`));
    const saved=page.waitForResponse(sourceWrite);
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const issued=await bind;
    expect(issued.request().postDataJSON()).toMatchObject({kind:'development',customerCode:null,salesSeries:null});
    const issuedModel=await issued.json();
    expect(issuedModel).toMatchObject({sourceId,orderNumber:expect.stringMatching(/^DEVMLH\d{4}P00-\d+$/)});
    const stored=await saved;expect(stored.status(),await stored.text()).toBe(200);
    expect(await stored.json()).toMatchObject({sourceId,status:'draft',document:{customerOrderDraft:{withOrder:false,order:{designStyleNo:issuedModel.orderNumber}}}});
    expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
    expect(h.requests.filter(request=>request.session===pure.session&&request.method==='POST'&&request.path.endsWith('/sources/numbered-drafts'))).toHaveLength(1);
   }finally{await pure.context.close();}
   const formal=await h.open(actor.actorId,1165,{},entry);
   try{
    const {page}=formal;
    await openNewWizard(page,'已确认订单');
    expect(await page.getByRole('textbox',{name:'订单ID',exact:true}).inputValue()).toBe('待生成');
    await page.locator('#development-create-customer').getByRole('button',{name:/^客户/}).click();
    await page.getByRole('listbox',{name:'客户',exact:true}).getByRole('option',{name:/^PD ·/}).click();
    await chooseYear(page);
    await page.getByRole('combobox',{name:/^销售系列/}).click();await page.getByRole('option',{name:/^P02 ·/}).click();
    await page.getByRole('combobox',{name:'辅料是否需要对色',exact:true}).click();
    await page.getByRole('option',{name:'无需对色（B路线）',exact:true}).click();
    await formal.context.route('https://private.example.test/**',async route=>{
     const request=route.request();
     if(request.method()!=='POST')return route.abort();
     const form=await new Response(request.postDataBuffer(),{headers:{'content-type':request.headers()['content-type']!}}).formData();
     const key=String(form.get('key')),file=form.get('file') as File,bytes=new Uint8Array(await file.arrayBuffer());
     const sha256=createHash('sha256').update(bytes).digest('hex');
     expect(h.f.storage.signed.some(grant=>grant.method==='POST'&&grant.objectKey===key)).toBe(true);
     expect(sha256).toBe(form.get('x-oss-meta-sha256'));
     await h.f.storage.writeImmutable(key,bytes,{mimeType:file.type,sha256});
     await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
    });
    await page.locator('#development-images input[type="file"]').setInputFiles({
     name:'TEST-G2-formal-style.png',mimeType:'image/png',
     buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),
    });
    await page.getByRole('button',{name:'主款图（1）',exact:true}).waitFor();
    await wizardNext(page);
    await page.getByLabel('建单步骤').getByRole('heading',{name:'开发需求',exact:true}).waitFor();
    const sewing=page.getByRole('table',{name:'颜色尺码与制作件数',exact:true});
    if(await sewing.isVisible()){
     await page.getByRole('button',{name:'添加颜色尺码行',exact:true}).click();
     await sewing.getByRole('textbox',{name:'第 1 行 颜色',exact:true}).fill('黑');
     await sewing.getByRole('textbox',{name:'第 1 行 尺码',exact:true}).fill('M');
     await sewing.getByRole('spinbutton',{name:'第 1 行 件数',exact:true}).fill('2');
    }
    const category=page.locator('.development-pattern-preparation [aria-haspopup="listbox"]').filter({visible:true});
    await category.click();
    await page.getByRole('listbox').getByRole('option').first().click();
    await page.getByText(/^执行单价：/).waitFor();
    await wizardNext(page);
    await page.getByRole('textbox',{name:'PO 1 正式款号 / PO',exact:true}).fill('TEST-G2-FORMAL-PO');
    await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).fill('黑');
    await page.getByRole('textbox',{name:'尺码列 1',exact:true}).fill('M');
    const quantity=page.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true});
    await quantity.fill('1.5');
    await page.locator('#development-quantity-error-0-0').waitFor();
    const invalid=await inspectCreationControl(page,'.development-quantity-field input[aria-invalid="true"]');
    expect(invalid.native).toMatchObject({invalid:'true',focused:true});
    expect(invalid.computed['border-top-width']).toBe('0px');
    expect(invalid.computed['outline-style']).toBe('none');
    await writeFile(join(evidence,'ui01-astryx-invalid-control.json'),JSON.stringify(invalid,null,2));
    await quantity.fill('2');
    await page.locator('#development-po-date-1').fill('2027-04-30');
    await page.getByRole('combobox',{name:'大货工艺是否确定',exact:true}).selectOption('known');
    await page.getByRole('combobox',{name:'大货是否预缩',exact:true}).selectOption('no');
    const reserve=page.waitForResponse(isReservation);
    const saved=page.waitForResponse(sourceWrite);
    const publish=page.waitForResponse(r=>r.request().method()==='POST'&&/\/sources\/[a-f0-9-]+\/development\/publish$/.test(new URL(r.url()).pathname));
    const confirm=page.waitForResponse(r=>r.request().method()==='POST'&&/\/sources\/[a-f0-9-]+\/confirm$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'提交并确认订单',exact:true}).click();
    const opened=await reserve;
    expect(opened.request().postDataJSON()).toMatchObject({numbering:{kind:'formal',customerCode:'PD',salesSeries:'P02'}});
    const {sourceId,orderNumber}=await opened.json();
    expect(orderNumber).toMatch(/^PDMLH\d{4}P02-\d+$/);
    const draft=await saved;expect(draft.status(),await draft.text()).toBe(200);
    expect(await draft.json()).toMatchObject({sourceId,document:{files:[{kind:'款图',attachmentId:expect.stringMatching(/^[a-f0-9-]{36}$/)}],customerOrderDraft:{withOrder:true,stage:'formal',order:{designStyleNo:orderNumber}}}});
    const publication=await publish;expect(publication.status(),await publication.text()).toBe(200);
    const response=await confirm;
    expect(response.url()).toContain(`/sources/${sourceId}/confirm`);
    expect(response.request().postDataJSON()).toMatchObject({designStyleNo:orderNumber,lines:[{formalPoNo:'TEST-G2-FORMAL-PO'}]});
    expect(response.status(),await response.text()).toBe(200);
    const {productionOrderId}=await response.json();
    expect((await h.db.query('SELECT production_order_id,design_style_no FROM digital_production_orders WHERE source_id=$1',[sourceId])).rows)
      .toEqual([{production_order_id:productionOrderId,design_style_no:orderNumber}]);
    const prints=await page.evaluate(async sourceId=>{
     const path='/api/digital-production/sources/'+sourceId+'/development';
     const live=await fetch(path),current=await live.json();
     const exact=await fetch(path+'/versions/'+current.version+'?round='+current.roundNumber),history=await exact.json();
     return {live:live.status,exact:exact.status,current,history};
    },sourceId);
    expect(prints.live).toBe(200);expect(prints.exact).toBe(200);
    expect(prints.current).toMatchObject({sourceId,designStyleNo:orderNumber,numberedIdentity:{orderNumber}});
    expect(prints.history).toMatchObject({sourceId,roundNumber:prints.current.roundNumber,documentVersion:prints.current.version,
     designStyleNo:orderNumber,numberedIdentity:prints.current.numberedIdentity});
    const workbench=`/ui/digital-production?workspace=designer&section=workspace&development=${sourceId}`;
    const basicsPath=`/api/digital-production/sources/${sourceId}/development/workbench-basics`;
    const loadOriginal=()=>page.request.get(`${h.base}/api/digital-production/sources/${sourceId}/development/versions/${prints.current.version}?round=${prints.current.roundNumber}`);
    const snapshot=JSON.stringify(await (await loadOriginal()).json());
    const clockBefore=await orderTimeCreated(h.db,{kind:'order',id:productionOrderId});
    const fullOrder=()=>h.db.query('SELECT to_jsonb(t) AS record FROM digital_production_orders AS t WHERE production_order_id=$1',[productionOrderId]);
    const originalFormal=(await fullOrder()).rows;
    await page.goto(new URL(workbench,page.url()).href);
    const summary=page.locator('.designer-order-identity');
    const edit=summary.getByRole('button',{name:'编辑基础信息',exact:true});
    await edit.waitFor();
    expect(await summary.getByText(orderNumber,{exact:true}).count()).toBeGreaterThan(0);
    expect(await summary.getByText('P02',{exact:true}).isVisible()).toBe(true);
    expect(await summary.getByText('TEST-G2-FORMAL-PO',{exact:true}).isVisible()).toBe(true);
    await edit.click();
    const dialog=page.getByRole('dialog',{name:'编辑基础信息',exact:true});
    await dialog.getByRole('textbox',{name:'品牌',exact:true}).fill('TEST 基础品牌已更正');
    await dialog.getByRole('textbox',{name:'参考款 / 版型说明',exact:true}).fill('TEST 基础备注原便签');
    expect(await dialog.getByRole('textbox').count()).toBe(2);
    const update=page.waitForResponse(r=>r.request().method()==='PUT'&&new URL(r.url()).pathname===basicsPath);
    await dialog.getByRole('button',{name:'保存基础信息',exact:true}).click();
    const outcome=await update;expect(outcome.status(),await outcome.text()).toBe(200);
    const request=outcome.request(),idempotencyKey=request.headers()['idempotency-key']!,input=request.postDataJSON();
    expect(await outcome.json()).toEqual({brand:'TEST 基础品牌已更正',referenceNote:'TEST 基础备注原便签',revision:1});
    await dialog.waitFor({state:'hidden'});
    expect(await summary.getByText('TEST 基础品牌已更正',{exact:true}).isVisible()).toBe(true);
    const replay=await page.request.put(h.base+basicsPath,{headers:{'idempotency-key':idempotencyKey},data:input});
    expect(replay.status()).toBe(200);expect(await replay.json()).toEqual(await outcome.json());
    const stale=await page.request.put(h.base+basicsPath,{headers:{'idempotency-key':randomUUID()},data:{...input,brand:'TEST stale edit'}});
    expect(stale.status()).toBe(409);
    for(const extra of [{orderDate:'2028-01-01'},{actualReceived:200},{materialUnitPrice:'1'},{expectedCost:'9'}]){
     const forbidden=await page.request.put(h.base+basicsPath,{headers:{'idempotency-key':randomUUID()},data:{...input,expectedRevision:1,...extra}});
     expect(forbidden.status()).toBe(400);
    }
    const unrelated=await h.open(h.f.people.warehouse!.actorId,1165,{},workbench);
    try{
     const denial=await unrelated.page.request.put(h.base+basicsPath,{headers:{'idempotency-key':randomUUID()},data:{...input,expectedRevision:1}});
     expect([403,404]).toContain(denial.status());
    }finally{await unrelated.close();}
    await page.reload();await summary.getByText('TEST 基础备注原便签',{exact:true}).waitFor();
    const nativeHistory=await loadOriginal();expect(nativeHistory.status()).toBe(200);expect(JSON.stringify(await nativeHistory.json())).toBe(snapshot);
    expect(await orderTimeCreated(h.db,{kind:'order',id:productionOrderId})).toEqual(clockBefore);
    expect((await fullOrder()).rows).toEqual(originalFormal);
    expect((await h.db.query("SELECT count(*)::int AS n FROM audit_events WHERE entity_id=$1 AND action='development_workbench_basics_saved'",[sourceId])).rows[0]?.n).toBe(1);
    await page.screenshot({path:join(evidence,'c5-workbench-basics.png'),fullPage:true});
    expect(h.requests.filter(request=>request.session===formal.session&&request.method==='POST'&&request.path.endsWith('/sources/numbered-drafts'))).toHaveLength(1);
   }catch(error){await writeFile(join(evidence,'formal-numbering-failure.txt'),await formal.page.locator('body').innerText());throw error;}
   finally{await formal.context.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
});

(url?describe:describe.skip)('UI-01 upgrade of the exact legacy empty creation shell',()=>{
 it('recovers only the original eligible shell across 0316 to 0317 from the designer draft box',async()=>{
  const h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-ui01-draft-upgrade-')),{fullApp:true,throughVersion:'0316_sourcing_contract_generation_attempts'});
  try{
   const designer=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
   const forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),style='TEST-UI01-SHELL-'+randomUUID();
   // Match the original pre-0296 insertion, which omitted this field and
   // therefore retains NULL after the migration sets a default for new sources.
   // Never edit a source row or its evidence to force historical eligibility.
   await h.db.query('ALTER TABLE digital_production_sources ALTER COLUMN draft_reserved DROP DEFAULT');
   let legacy:Awaited<ReturnType<typeof identity.createSource>>;
   try{legacy=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:null},randomUUID());}
   finally{await h.db.query('ALTER TABLE digital_production_sources ALTER COLUMN draft_reserved SET DEFAULT false');}
   const sourceId=legacy.sourceId;
   const draft=await forms.save(designer,sourceId,{expectedVersion:0,document:initialDevelopmentDocument()},randomUUID());
   const original=async()=>(await h.db.query(`SELECT e.id,e.actor_id,l.is_draft,a.adoption_id,p.revision,p.route_nodes,p.plan_json->'anchors' AS anchors
    FROM digital_production_sources s JOIN digital_development_source_lifecycle l USING(source_id)
    JOIN audit_events e ON e.entity_id=s.source_id::text AND e.action='digital_source_created'
    JOIN digital_preparation_rule_adoptions a ON a.resource_kind='source' AND a.resource_id=s.source_id
    JOIN digital_development_sla_plans p ON p.source_id=s.source_id AND p.event_key=e.id::text
    WHERE s.source_id=$1`,[sourceId])).rows;
   const before=await original();
   expect(before).toEqual([{id:expect.any(String),actor_id:designer.actorId,is_draft:true,adoption_id:expect.any(String),revision:1,route_nodes:[],anchors:{}}]);
   const eligible=async()=>(await h.db.query('SELECT digital_development_draft_discardable($1,$2,$3) AS eligible',[sourceId,designer.actorId,draft.version])).rows[0]?.eligible;
   expect(await eligible()).toBe(false);
   const version='0317_development_draft_discard_ownership';
   const sql=await readFile(new URL('../../apps/api/migrations/'+version+'.sql',import.meta.url),'utf8');
   const client=await h.db.connect();
   try{await client.query('BEGIN');await client.query(sql);await client.query('INSERT INTO schema_migrations(version,checksum) VALUES($1,$2)',[version,createHash('sha256').update(sql).digest('hex')]);await client.query('COMMIT');}
   catch(error){await client.query('ROLLBACK');throw error;}finally{client.release();}
   expect(await eligible()).toBe(true);
   const tab=await h.open(designer.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
   try{
    const box=tab.page.getByRole('region',{name:'开发草稿箱',exact:true});
    await box.getByRole('textbox',{name:'搜索草稿款号',exact:true}).fill(style);
    await box.getByRole('button',{name:`删除草稿 ${style}`,exact:true}).click();
    const response=tab.page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().endsWith(`/sources/${sourceId}/draft`));
    await tab.page.getByRole('alertdialog',{name:'删除开发草稿',exact:true}).getByRole('button',{name:'删除',exact:true}).click();
    const deleted=await response;expect(deleted.status(),await deleted.text()).toBe(200);
    await tab.page.getByText('开发草稿已删除。',{exact:true}).waitFor();
   }finally{await tab.close();}
   expect(await original()).toEqual(before);
   expect(await eligible()).toBe(false);
   await writeFile(join(h.evidence,'ui01-legacy-draft-facts.json'),JSON.stringify({sourceId,draftVersion:draft.version,owner:designer.actorId,
    lifecycle:'draft',historicalEvidence:['source_creation','initial_preparation_rule','sla_revision_1_no_route_no_anchors'],beforeEligible:false,afterMigrationEligible:true,deleteResult:200,originalRecordsUnchanged:true},null,2));
  }finally{await h.writeEvidence();await h.dispose();}
 });
});

(url?describe:describe.skip)('UI-02 effective development record can be corrected without inventing a clerk task',()=>{
 it('uses actual craft stations and one sewing input, retaining a saved two-by-two form',async()=>{
  const h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-ui02-craft-stations-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true,workbenchNumberedCreation:true});
  try{
   await prepareRewashSettings(h.f);
   const actor=h.f.people['sample-designer']!,tab=await h.open(actor.actorId,1280,{},'/ui/digital-production?workspace=designer&section=create');
   try{
    const {page}=tab;await openNewWizard(page,'纯开发','裤子');
    await page.getByRole('combobox',{name:/^板类/}).click();
    expect(await page.getByRole('option',{name:'复版',exact:true}).count()).toBe(0);
    await page.getByRole('option',{name:'头版',exact:true}).click();
    await wizardNext(page);
    await page.getByLabel('建单步骤').getByRole('heading',{name:'开发需求',exact:true}).waitFor();
    await page.getByRole('checkbox',{name:'印花',exact:true}).check();
    await page.getByRole('checkbox',{name:'绣花',exact:true}).check();
    const station1=page.getByRole('combobox',{name:/^第 1 站工艺/}),station2=page.getByRole('combobox',{name:/^第 2 站工艺/});
    expect(await station1.innerText()).toContain('请选择');expect(await station2.innerText()).toContain('请选择');
    const making=page.getByRole('table',{name:'颜色尺码与制作件数',exact:true});
    await page.getByRole('button',{name:'添加颜色尺码行',exact:true}).click();
    await making.getByRole('textbox',{name:'第 1 行 颜色',exact:true}).fill('黑');
    await making.getByRole('textbox',{name:'第 1 行 尺码',exact:true}).fill('M');
    await making.getByRole('spinbutton',{name:'第 1 行 件数',exact:true}).fill('4');
    expect(await page.getByLabel('本轮打板总数量',{exact:true}).textContent()).toBe('4');
    expect(await page.getByRole('textbox',{name:'本轮打板数量',exact:true}).count()).toBe(0);
    const crop=page.locator('.development-making-grid > section');
    const positions=await crop.evaluateAll(cards=>cards.map(card=>{const box=card.getBoundingClientRect();return [box.x,box.y,box.width];}));
    expect(positions).toHaveLength(4);
    expect(positions[0]![0]).toBeLessThan(positions[1]![0]!);expect(positions[0]![1]).toBe(positions[1]![1]);
    expect(positions[2]![1]).toBe(positions[3]![1]);expect(positions[2]![1]).toBeGreaterThan(positions[0]![1]!);
    await station1.click();await page.getByRole('option',{name:'印花',exact:true}).click();
    await station2.click();await page.getByRole('option',{name:'绣花',exact:true}).click();
    const saving=page.waitForResponse(r=>r.request().method()==='PUT'&&/\/sources\/[a-f0-9-]+\/development$/.test(new URL(r.url()).pathname));
    await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
    const response=await saving;expect(response.status(),await response.text()).toBe(200);
    expect(await response.json()).toMatchObject({status:'draft',document:{craftOrderConfirmed:true,
     craftSteps:[{craftKind:'printing',sequence:1},{craftKind:'embroidery',sequence:2}],workbenchSheet:{sewingRows:[{color:'黑',size:'M',quantity:4}]}}});
    await page.getByText(/^开发资料与订购草稿已保存/).waitFor();
    await page.reload();await station1.waitFor();
    expect(await station1.innerText()).toContain('印花');expect(await station2.innerText()).toContain('绣花');
    expect(await making.getByRole('spinbutton',{name:'第 1 行 件数',exact:true}).inputValue()).toBe('4');
    await page.screenshot({path:join(h.evidence,'ui02-actual-craft-and-sewing.png'),fullPage:true});
   }catch(error){await writeFile(join(h.evidence,'ui02-craft-stations-failure.txt'),await tab.page.locator('body').innerText());throw error;}
   finally{await tab.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
 it('fills missing procurement quantity from the original customer-order confirmation before submitting',async()=>{
  const h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-ui02-original-conversion-')),{fullApp:true,workbenchNumberedCreation:true});
  try{
   const designer=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true);
   const style='TEST-UI02-CONVERT-'+randomUUID(),{sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,
    temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const doc=initialDevelopmentDocument(),materialId=randomUUID();
   Object.assign(doc,{templateConfirmed:true,sizeTableInitialized:true,quantity:2,documentFormatVersion:2,sizes:['M'],sizeQuantities:[2],measurements:[],
    workbenchSheet:{version:1,styleName:'TEST 开发品名',brand:'TEST 原品牌',gender:'男装',boardType:'头版',processingSelected:true,referenceNote:'',
     sewingRows:[{rowId:randomUUID(),color:'黑',size:'M',quantity:2}]},files:[{attachmentId:await h.f.image(designer),kind:'款图'}]});
   doc.materials=[{...doc.materials[0]!,materialId,name:'TEST 原主料',specification:'40支',supplier:'原供应商',width:'150',composition:'棉'}];
   const saved=await forms.save(designer,sourceId,{expectedVersion:0,document:doc},randomUUID());
   const published=await forms.publish(designer,sourceId,saved.version,randomUUID());
   await forms.saveWorkbenchBasics(designer,sourceId,{roundNumber:1,documentVersion:published.version,expectedRevision:0,brand:'TEST 原品牌',referenceNote:'TEST 原参考说明'},randomUUID());
   const tab=await h.open(designer.actorId,1165,{},`/ui/digital-production?workspace=designer&section=workspace&development=${sourceId}`);
   try{
    const {page}=tab;
    await page.getByRole('button',{name:'客户确认下单',exact:true}).click();
    const form=page.getByRole('region',{name:'客户意见',exact:true}),submit=form.getByRole('button',{name:'确认下单',exact:true});
    const correction=form.getByRole('group',{name:'转正前补齐原开发资料',exact:true});
    await correction.waitFor();expect(await submit.isDisabled()).toBe(true);
    await correction.getByRole('textbox',{name:/TEST 原主料 备料数量/}).fill('500');
    await correction.getByRole('textbox',{name:/本次订正理由/}).fill('TEST 同一原材料补齐真实数量');
    const updated=page.waitForResponse(r=>r.request().method()==='PUT'&&r.url().endsWith('/designer-correction'));
    await correction.getByRole('button',{name:'保存本轮资料订正',exact:true}).click();
    const response=await updated;expect(response.status(),await response.text()).toBe(200);
    expect(response.request().postDataJSON()).toMatchObject({expectedDocumentVersion:published.version,materialQuantities:[{materialId,quantity:'500',quantityUnit:'米'}]});
    await correction.waitFor({state:'hidden'});
    await form.getByRole('textbox',{name:'PO 1 正式款号 / PO',exact:true}).fill(style+'-PO');
    await form.getByRole('textbox',{name:'PO 1 颜色',exact:true}).fill('黑');
    await form.getByRole('textbox',{name:'尺码列 1',exact:true}).fill('M');
    await form.getByRole('textbox',{name:'PO 1 订购数量 1',exact:true}).fill('2');
    await form.locator('#development-po-date-1').fill('2027-04-30');
    await form.getByLabel('辅料是否需要对色',{exact:true}).selectOption('no');
    if(await form.getByRole('combobox',{name:'大货工艺是否确定',exact:true}).isVisible()){
     await form.getByRole('combobox',{name:'大货工艺是否确定',exact:true}).selectOption('known');
     await form.getByRole('combobox',{name:'大货是否预缩',exact:true}).selectOption('no');
    }
    const confirmation=page.waitForResponse(r=>r.request().method()==='POST'&&new URL(r.url()).pathname.endsWith(`/sources/${sourceId}/confirm`));
    await submit.click();
    const confirmed=await confirmation;expect(confirmed.status(),await confirmed.text()).toBe(200);
    expect((await h.db.query('SELECT count(*)::int AS n FROM digital_production_orders WHERE source_id=$1',[sourceId])).rows[0]?.n).toBe(1);
    const exact=await forms.publishedVersion(designer,sourceId,1,published.version);
    expect(exact.document).toEqual(published.document);
    const current=await forms.read(designer,sourceId);
    expect(current).toMatchObject({roundNumber:1,version:published.version+1,document:{workbenchSheet:{referenceNote:'TEST 原参考说明'},
     materials:[{materialId,quantity:'500',quantityUnit:'米'}]}});
   }catch(error){await writeFile(join(h.evidence,'ui02-original-conversion-failure.txt'),await tab.page.locator('body').innerText());throw error;}
   finally{await tab.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
 it('uses the signed original development routes for precise same-round correction and retained old versions',async()=>{
  const h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-ui02-native-correction-')),{fullApp:true,workbenchNumberedCreation:true});
  try{
   const designer=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
   const forms=new DigitalDevelopmentService(h.db,true),style='TEST-UI02-ORIGINAL-'+randomUUID();
   const {sourceId}=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style,temporaryStyleNo:null,customerCode:'PD'},randomUUID());
   const original=initialDevelopmentDocument(),materialId=randomUUID();
   original.quantity=1;original.files=[{attachmentId:await h.f.image(designer),kind:'款图'}];
   original.materials=[{...original.materials[0]!,materialId,name:'TEST 原主料',specification:'40支',supplier:'原供应商'}];
   const saved=await forms.save(designer,sourceId,{expectedVersion:0,document:original},randomUUID());
   const published=await forms.publish(designer,sourceId,saved.version,randomUUID());
   const taskCount=async()=>(await h.db.query('SELECT count(*)::int AS count FROM digital_production_task_access WHERE source_id=$1',[sourceId])).rows[0]!.count;
   const taskBefore=await taskCount(),tab=await h.open(designer.actorId,1165,{},'/ui/digital-production?workspace=designer&section=workspace&development='+sourceId);
   try{
    const base=h.base+`/api/digital-production/sources/${sourceId}/development`,path=base+'/designer-correction';
    const args={roundNumber:1,expectedDocumentVersion:published.version,styleName:'TEST 新品名',brand:'TEST 真实品牌',
     materialQuantities:[{materialId,quantity:'500.25',quantityUnit:'米'}],reason:'TEST 原位补齐真实备料资料'};
    const other=await h.open((await h.dedicated('sample_designer')).id,1165);
    try{expect([403,404]).toContain((await other.page.request.put(path,{data:args,headers:{'idempotency-key':randomUUID()}})).status());}
    finally{await other.close();}
    const key=randomUUID(),request=async(data= args,operation=key)=>tab.page.request.put(path,{data,headers:{'idempotency-key':operation}});
    const exact=await request();expect(exact.status(),await exact.text()).toBe(200);
    const reply=await exact.json();expect(reply).toEqual({sourceId,roundNumber:1,version:published.version+1});
    expect(await (await request()).json()).toEqual(reply);
    expect((await request({...args,brand:'TEST 冲突变更'},randomUUID())).status()).toBe(409);
    const current=await tab.page.request.get(base+'?round=1');
    expect(current.status(),await current.text()).toBe(200);
    expect(await current.json()).toMatchObject({status:'published',version:reply.version,document:{workbenchSheet:{styleName:args.styleName,brand:args.brand},
     materials:[{materialId,quantity:'500.25',quantityUnit:'米'}]}});
    const history=await tab.page.request.get(base+'/versions/'+published.version+'?round=1');
    expect(history.status(),await history.text()).toBe(200);
    expect((await history.json()).document).toEqual(published.document);
    const revised=await tab.page.request.get(base+'/versions/'+reply.version+'?round=1');
    expect(revised.status(),await revised.text()).toBe(200);
    expect((await revised.json()).document.workbenchSheet.brand).toBe(args.brand);
    expect((await h.db.query(`SELECT amendment_kind,task_id,draft_version,base_document_version,document_version,published_by FROM digital_development_amendments
     WHERE source_id=$1`,[sourceId])).rows).toEqual([{amendment_kind:'designer_correction',task_id:null,draft_version:null,
     base_document_version:published.version,document_version:reply.version,published_by:designer.actorId}]);
    expect(await taskCount()).toBe(taskBefore);
   }finally{await tab.close();}
  }finally{await h.writeEvidence();await h.dispose();}
 });
});

(url?describe.sequential:describe.skip)('original designer workspace parent and pure child draft across actual browser reload',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,await mkdtemp(join(tmpdir(),'dx-pure-create-reload-')),{fullApp:true,orderTimeFlow:true,orderTimeModel:true});await prepareRewashSettings(h.f);});
 afterAll(async()=>{if(h){await h.writeEvidence();await h.dispose();}});
 it('keeps one creation draft panel and the old designer URL opens the work list',async()=>{
  const tab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;
   await page.getByRole('heading',{name:'开发草稿箱',exact:true}).waitFor();
   expect(await page.getByRole('heading',{name:'开发草稿箱',exact:true}).count()).toBe(1);
   expect(await page.getByRole('button',{name:'新建开发订单',exact:true}).count()).toBe(1);
   expect(h.requests.filter(row=>row.session===tab.session&&row.path==='/api/digital-production/workspaces/designer')).toHaveLength(0);
   const drafts=page.getByRole('region',{name:'开发草稿箱',exact:true}),entry=page.getByRole('region',{name:'新建开发订单入口',exact:true});
   const bounds=async()=>{const [left,right]=await Promise.all([drafts.boundingBox(),entry.boundingBox()]);return {left:left!,right:right!};};
   const wide=await bounds();
   expect(wide.left.x+wide.left.width).toBeLessThan(wide.right.x);
   expect(Math.abs(wide.left.y-wide.right.y)).toBeLessThan(2);
   const search=page.getByRole('textbox',{name:'搜索草稿款号',exact:true});
   await search.focus();
   expect(await search.evaluate(input=>input===document.activeElement)).toBe(true);
   const cdp=await tab.context.newCDPSession(page);
   try{
    await cdp.send('DOM.enable');await cdp.send('CSS.enable');
    const doc=await cdp.send('DOM.getDocument');
    const {nodeId}=await cdp.send('DOM.querySelector',{nodeId:doc.root.nodeId,selector:'.development-search-field input'});
    const [matching,computed]=await Promise.all([cdp.send('CSS.getMatchedStylesForNode',{nodeId}),cdp.send('CSS.getComputedStyleForNode',{nodeId})]);
    const matched=matching.matchedCSSRules?.map(rule=>rule.matchingSelectors.map(index=>rule.rule.selectorList.selectors[index]?.text))?.flat()??[];
    expect(matched.some(selector=>selector?.includes('dx-production-refined')&&selector.includes('.development-create-wizard'))).toBe(false);
    const read=(name:string)=>computed.computedStyle.find(item=>item.name===name)?.value;
    const control=await search.evaluate(input=>{
      const owner=input.closest('.dx-development-astryx-control')!;
      const read=(element:Element)=>{const style=getComputedStyle(element);return {classes:element.className,border:style.borderTopWidth,boxShadow:style.boxShadow,outline:style.outlineStyle};};
      return {owner:read(owner),input:read(input),label:owner.parentElement?.textContent};
    });
    expect(read('border-top-width')).toBe('0px');
    expect(control.owner.boxShadow!=='none'||control.owner.outline!=='none'||control.owner.border!=='0px').toBe(true);
    expect(JSON.stringify(control)).not.toMatch(/Required|Select a date|Choose file/);
    await writeFile(join(h.evidence,'ui01-creation-home-style.json'),JSON.stringify({wide,matched,control},null,2));
    await page.screenshot({path:join(h.evidence,'ui01-creation-home-wide.png')});
   }finally{await cdp.detach();}
   await page.setViewportSize({width:700,height:860});
   const narrow=await bounds();
   expect(narrow.left.y+narrow.left.height).toBeLessThan(narrow.right.y);
   await page.screenshot({path:join(h.evidence,'ui01-creation-home-narrow.png')});
   await page.setViewportSize({width:1165,height:900});
   const trigger=page.getByRole('button',{name:'新建开发订单',exact:true});
   await trigger.click();
   const types=page.getByRole('dialog',{name:'请选择创建类型'});
   await types.waitFor();
   expect(await types.getByRole('button',{name:/^(纯开发|已确认订单|预下单)$/}).allTextContents()).toEqual(['纯开发','已确认订单','预下单']);
   expect(await types.getByRole('button',{name:'进入建单',exact:true}).isDisabled()).toBe(true);
   await types.getByRole('button',{name:'纯开发',exact:true}).click();
   const disabledRush=types.getByRole('combobox',{name:/^急单/});
   expect(await disabledRush.isDisabled()).toBe(true);
   const disabled=await inspectCreationControl(page,`[id=${JSON.stringify(await disabledRush.getAttribute('id'))}]`);
   expect(disabled.native).toMatchObject({disabled:'true',focused:false});
   await writeFile(join(h.evidence,'ui01-astryx-disabled-control.json'),JSON.stringify(disabled,null,2));
   await types.getByRole('combobox',{name:/^衣类/}).click();
   await page.getByRole('option',{name:'下装',exact:true}).click();
   expect(await types.getByRole('button',{name:'进入建单',exact:true}).isDisabled()).toBe(true);
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
   expect(await page.getByRole('heading',{name:'开发草稿箱',exact:true}).count()).toBe(0);
   expect(await page.getByRole('button',{name:'新建开发订单',exact:true}).count()).toBe(0);
   expect(await page.getByRole('columnheader',{name:'操作',exact:true}).count()).toBe(0);
  }finally{await tab.context.close();}
 });
 it('keeps explicit creation types and two local drafts separate through real workbench navigation as a designer',async()=>{
  const actor=h.f.people['sample-designer']!,entry='/ui/digital-production?workspace=designer&section=create';
  const tab=await h.open(actor.actorId,1165,{},entry),page=tab.page;
  const first='TEST-R1-PREORDER-'+randomUUID(),second='TEST-R1-DEVELOPMENT-'+randomUUID();
  const code=page.getByRole('textbox',{name:'设计款号',exact:true});
  try{
   await openNewWizard(page,'预下单');
   await code.fill(first);
   const material=page.locator('#development-materials .development-materials-inline');
   const images=page.locator('#development-images');
   const label=page.locator('#development-create-style');
   const check=page.getByRole('button',{name:'检查业务ID',exact:true});
   for(const width of [1165,1366,1440,1920]){
    await page.setViewportSize({width,height:900});
    const measurements=await Promise.all([images.boundingBox(),material.boundingBox(),label.boundingBox(),check.boundingBox()]);
    const [picture,table,input,button]=measurements;
    expect(picture&&table&&input&&button).toBeTruthy();
    expect(table!.y).toBeGreaterThan(picture!.y+picture!.height);
    expect(table!.x-picture!.x).toBeLessThan(40);
    expect(Math.abs((input!.y+input!.height/2)-(button!.y+button!.height/2))).toBeLessThan(3);
   }
   await page.setViewportSize({width:390,height:747});
   const rootFont=await page.evaluate(()=>{
    const size=parseFloat(getComputedStyle(document.documentElement).fontSize);
    document.documentElement.style.fontSize=(size*2)+'px';return size;
   });
   const saveDraft=page.getByRole('button',{name:'保存预下单备料资料',exact:true});
   await saveDraft.focus();
   const accessible=await saveDraft.evaluate(button=>({
    width:button.getBoundingClientRect().width,visible:button.scrollWidth<=button.clientWidth+1,
    pageFits:document.documentElement.scrollWidth<=innerWidth+1,focused:document.activeElement===button,
    rootFont:parseFloat(getComputedStyle(document.documentElement).fontSize),
    theme:!!button.closest('.dx-designer-astryx'),lang:document.documentElement.lang,
   }));
   expect(accessible).toMatchObject({visible:true,pageFits:true,focused:true,rootFont:rootFont*2,theme:true,lang:'zh-CN'});
   expect(accessible.width).toBeGreaterThan(0);
   await page.screenshot({path:join(h.evidence,'preorder-handovers-390-200pct.png'),fullPage:true});
   await page.evaluate(()=>document.documentElement.style.removeProperty('font-size'));
   await page.setViewportSize({width:1165,height:747});
   expect(await page.getByRole('group',{name:'附件分类'}).getByRole('button',{name:/菲林/}).count()).toBe(0);
   const firstView=new URL(page.url()).searchParams.get('creationDraft');
   expect(firstView).toMatch(/^[a-f0-9-]{36}$/);
   await page.getByRole('link',{name:'开发工作区',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   await page.locator('.development-list-panel').waitFor();
   expect(await code.count()).toBe(0);
   await page.getByRole('link',{name:'创建开发单',exact:true}).click();
   await page.getByRole('heading',{name:'开发草稿箱',exact:true}).waitFor();
   expect(await code.count()).toBe(0);
   await openNewWizard(page,'纯开发');
   expect(await code.inputValue()).toBe('');
   await code.fill(second);
   const secondView=new URL(page.url()).searchParams.get('creationDraft');
   expect(secondView).not.toBe(firstView);
   await page.getByRole('button',{name:'返回列表',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   const draftList=page.getByRole('region',{name:'开发草稿箱',exact:true}),draftSearch=page.getByRole('textbox',{name:'搜索草稿款号',exact:true});
   const firstDraft=draftList.getByRole('button',{name:`继续预下单草稿 · ${first}`,exact:true});
   const secondDraft=draftList.getByRole('button',{name:`继续纯开发草稿 · ${second}`,exact:true});
   await firstDraft.waitFor();await secondDraft.waitFor();
   expect(await page.locator('[aria-label="此标签页的草稿"]').count()).toBe(0);
   expect(await draftSearch.count()).toBe(1);
   const searched=page.waitForResponse(response=>{
    const url=new URL(response.url());return response.ok()&&url.pathname.endsWith('/sources/drafts')&&url.searchParams.get('search')===first;
   });
   await draftSearch.fill(first);await searched;
   await secondDraft.waitFor({state:'hidden'});
   expect(await firstDraft.isVisible()).toBe(true);
   await draftSearch.fill('');await secondDraft.waitFor();
   await firstDraft.click();
   expect(await code.inputValue()).toBe(first);
   expect(new URL(page.url()).searchParams.get('creationDraft')).toBe(firstView);
   await page.getByRole('button',{name:'返回列表',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   await page.getByRole('button',{name:`继续纯开发草稿 · ${second}`,exact:true}).click();
   await page.reload();
   expect(await code.inputValue()).toBe(second);
   await page.getByRole('button',{name:'更换订单类型',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   await chooseDevelopmentCreation(page,'已确认订单');
   expect(await code.inputValue()).toBe('');
   expect(await page.getByLabel('建单步骤').getByText('客户与交货',{exact:true}).count()).toBe(1);
   await page.getByRole('button',{name:'返回列表',exact:true}).click();
   await page.getByRole('button',{name:`继续纯开发草稿 · ${second}`,exact:true}).click();
   expect(await code.inputValue()).toBe(second);
   await page.goto(h.base+entry+'&creationDraft=wrong&creationDraft='+firstView);
   await page.getByText('草稿链接无效，请从草稿列表重新选择',{exact:true}).waitFor();
   expect(await code.count()).toBe(0);
   expect(h.requests.filter(row=>row.session===tab.session&&['POST','PUT'].includes(row.method)&&row.path.startsWith('/api/digital-production/sources'))).toEqual([]);
  }finally{await tab.context.close();}
 });
 it('restores both garments after a real designer server save, including original values and an intentional deletion',async()=>{
  const actor=h.f.people['sample-designer']!,style='TEST-GARMENT-DRAFT-'+randomUUID(),entry='/ui/digital-production?workspace=designer&section=create';
  const first=await h.open(actor.actorId,1165,{},entry);
  async function openSizes(page:Page){
   await page.getByLabel('建单步骤').getByRole('heading',{name:'开发需求',exact:true}).waitFor();
   const section=page.locator('#development-sizes');
   await section.waitFor({state:'attached'});
   if(!await section.isVisible())await page.locator('summary').filter({hasText:/^尺寸资料/}).click();
   await section.waitFor();
   return section;
  }
  try{
   const page=first.page;
   await openNewWizard(page,'纯开发','上衣',true);
   await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   await wizardNext(page);
   let table=await openSizes(page);
   const rows=table.getByRole('textbox',{name:/^尺寸项目 /});
   expect(await rows.evaluateAll(elements=>elements.map(element=>(element as HTMLInputElement).value))).toEqual(DEVELOPMENT_MEASUREMENTS.上衣);
   await table.getByRole('button',{name:/^(?:＋\s*)?添加尺码列$/}).click();
   await table.getByRole('textbox',{name:'制作尺码列 1',exact:true}).fill('MT');
   await table.getByRole('textbox',{name:'衫长 MT',exact:true}).fill('62.5');
   await table.getByRole('button',{name:/^(?:＋\s*)?添加尺寸行$/}).click();
   await rows.last().fill('自定义袖口');
   await table.getByRole('textbox',{name:'自定义袖口 MT',exact:true}).fill('17.3');
   await page.getByRole('button',{name:'上一步',exact:true}).click();
   await changeGarment(page,'裤子',false);
   expect(await page.getByRole('combobox',{name:/^衣类/}).innerText()).toContain('上装');
   await changeGarment(page,'裤子',true);
   await wizardNext(page);
   table=await openSizes(page);
   const pantsRows=table.getByRole('textbox',{name:/^尺寸项目 /});
   expect(await pantsRows.evaluateAll(elements=>elements.map(element=>(element as HTMLInputElement).value))).toEqual(DEVELOPMENT_MEASUREMENTS.裤子);
   await table.getByRole('button',{name:'删除尺寸行 1',exact:true}).click();
   await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();
   const put=page.waitForResponse(response=>response.request().method()==='PUT'&&
    /\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname));
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const saved=await put;
   expect(saved.status(),await saved.text()).toBe(200);
   const {document:snapshot}=await saved.json();
   expect(snapshot).toMatchObject({template:'裤子',templateConfirmed:true,sizeTableInitialized:true,rush:true,sizes:[],customerOrderDraft:{wizardStep:2},
    alternateSizeDraft:{template:'上衣',sizes:['MT'],measurements:expect.arrayContaining([{name:'自定义袖口',values:['17.3']}])}});
   expect(snapshot.measurements.map((row:{name:string})=>row.name)).toEqual(DEVELOPMENT_MEASUREMENTS.裤子.slice(1));
  }finally{await first.context.close();}
  const resumed=await h.open(actor.actorId,1165,{},entry);
  try{
   const page=resumed.page;
   await page.getByRole('button',{name:style,exact:true}).click();
   let table=await openSizes(page);
   expect(await table.getByRole('textbox',{name:/^尺寸项目 /}).evaluateAll(elements=>elements.map(element=>(element as HTMLInputElement).value))).toEqual(DEVELOPMENT_MEASUREMENTS.裤子.slice(1));
   await page.getByRole('button',{name:'上一步',exact:true}).click();
   expect(await page.getByRole('combobox',{name:'急单',exact:true}).innerText()).toContain('是');
   await changeGarment(page,'上衣',true);
   await wizardNext(page);
   table=await openSizes(page);
   expect(await table.getByRole('textbox',{name:'制作尺码列 1',exact:true}).inputValue()).toBe('MT');
   expect(await table.getByRole('textbox',{name:'衫长 MT',exact:true}).inputValue()).toBe('62.5');
   expect(await table.getByRole('textbox',{name:'自定义袖口 MT',exact:true}).inputValue()).toBe('17.3');
   expect(h.requests.filter(request=>request.session===resumed.session&&['POST','PUT'].includes(request.method)&&request.path.includes('/sources'))).toEqual([]);
  }finally{await resumed.context.close();}
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
   let rowId:string|null=null;
   const step=page.locator('.development-creation-steps [aria-current="step"]');
   if(mode==='preorder'){
    expect(await page.getByLabel('尺寸模板',{exact:true}).count()).toBe(0);
    expect(await page.getByLabel('PO 1 颜色',{exact:true}).count()).toBe(0);
    await page.locator('#development-materials .development-material-inline-row').first().locator('input[id$="-quantity"]').fill('7.5米');
   }else{
    expect(await step.innerText()).toContain('版单');
    expect(await page.locator('#development-sizes').count()).toBe(0);
    await wizardNext(page);
    expect(await step.innerText()).toContain('开发需求');
    rowId=await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id');
    expect(rowId).toBeTruthy();
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
    const validation=page.getByRole('dialog',{name:'提交并确认订单',exact:true});
    await validation.getByText(/填写有误|请选择客户/).waitFor();
    await validation.getByRole('button',{name:'关闭',exact:true}).click();
    await page.getByRole('button',{name:'上一步',exact:true}).click();
   }
   if(mode!=='preorder'){
    await step.waitFor();expect(await step.innerText()).toContain('开发需求');
    expect(await page.getByRole('textbox',{name:'尺寸项目 1',exact:true}).getAttribute('id')).toBe(rowId);
    await page.getByRole('button',{name:'上一步',exact:true}).click();
   }else expect(await page.locator('#development-materials .development-material-inline-row').first().locator('input[id$="-quantity"]').inputValue()).toBe('7.5米');
   await style.waitFor();expect(await style.inputValue()).toBe(raw);expect(await instructions.inputValue()).toBe(text);
   // Two original debounce periods must not turn hydration, quotes or other
   // readonly option refreshes into source/save/publish/confirm commands.
   await page.waitForTimeout(2700);const current=await page.evaluate(()=>Object.entries(sessionStorage).filter(([key])=>key.startsWith('dx:development-creation:')).map(([,value])=>JSON.parse(value)));expect(current[0].viewId).toBe(original[0].viewId);expect(current[0].phase).toBe('draft');
   expect(h.requests.filter(row=>row.session===tab.session&&!['GET','HEAD'].includes(row.method)&&!row.path.includes('/notifications/'))).toEqual([]);expect(Number((await h.db.query('SELECT count(*) FROM digital_production_sources')).rows[0].count)).toBe(before);
   await page.screenshot({path:join(h.evidence,'pure-create-reload-'+mode+'.png'),fullPage:true});
  }catch(error){await writeFile(join(h.evidence,'pure-create-reload-'+mode+'-failure.txt'),await tab.page.locator('body').innerText());throw error;}finally{await tab.context.close();}
 });
 it('discards ordinary drafts only for their owner or Root without deleting original evidence',async()=>{
  const actor=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true);
  const forms=new DigitalDevelopmentService(h.db,true,h.patternOrders),style='TEST-DRAFT-DISCARD-'+randomUUID();
  const input={developmentType:'头版' as const,designStyleNo:style,temporaryStyleNo:null,customerCode:null};
  const key=randomUUID(),{sourceId}=await identity.createSource(actor,input,key,true);
  const attachmentId=await h.f.image(actor);
  const saved=await forms.save(actor,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),files:[{attachmentId,kind:'款图'}]}},randomUUID());
  const crossDraft=await identity.createSource(actor,{...input,designStyleNo:style+'-ROOT'},randomUUID(),true);
  const foreign=await h.dedicated('sample_designer');
  const stranger=await h.open(foreign.id,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const denied=await stranger.context.request.delete(h.base+`/api/digital-production/sources/${crossDraft.sourceId}/draft`,
    {headers:{'idempotency-key':randomUUID()},data:{expectedVersion:0}});
   expect([403,404],await denied.text()).toContain(denied.status());
  }finally{await stranger.context.close();}
  const rootTab=await h.open(h.f.root.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   await rootTab.page.getByRole('button',{name:`删除草稿 ${style}-ROOT`,exact:true}).click();
   const deleting=rootTab.page.waitForResponse(response=>response.request().method()==='DELETE'&&new URL(response.url()).pathname.endsWith(`/sources/${crossDraft.sourceId}/draft`));
   await rootTab.page.getByRole('alertdialog',{name:'删除开发草稿',exact:true}).getByRole('button',{name:'删除',exact:true}).click();
   const deleted=await deleting;expect(deleted.status(),await deleted.text()).toBe(200);
   await rootTab.page.getByText('开发草稿已删除。',{exact:true}).waitFor();
   const evidence=(await h.db.query(`SELECT x.actor_id,e.actor_id AS audit_actor,e.after_state->>'ownerId' AS owner
     FROM digital_development_draft_discards x JOIN audit_events e ON e.id=x.audit_event_id WHERE x.source_id=$1`,[crossDraft.sourceId])).rows[0];
   expect(evidence).toEqual({actor_id:h.f.root.actorId,audit_actor:h.f.root.actorId,owner:actor.actorId});
  }finally{await rootTab.context.close();}
  await expect(identity.discardDevelopmentDraft(actor,sourceId,0,randomUUID())).rejects.toMatchObject({statusCode:409});
  const another=await identity.createSource(actor,{...input,designStyleNo:style+'-PUBLISHED'},randomUUID());
  await expect(identity.discardDevelopmentDraft(actor,another.sourceId,0,randomUUID())).rejects.toMatchObject({statusCode:409});
  const oldStyle=style+'-LEGACY-PREORDER',merch=h.f.people.merchandiser!,old=await identity.createSource(actor,{...input,designStyleNo:oldStyle,customerCode:'PD'},randomUUID(),true);
  const raw=initialDevelopmentDocument(),fabric={...raw.materials[0]!,materialId:randomUUID(),name:'TEST 备料棉布',supplier:'TEST 布行',quantity:'100米',available:false};
  const preorder=await forms.save(actor,old.sourceId,{expectedVersion:0,document:{...raw,materials:[fabric],customerOrderDraft:{withOrder:true,stage:'preorder',order:InitialCustomerOrderDraftSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:oldStyle,temporaryStyleNo:null,orderDate:'',contractDeliveryDate:null,lines:[{color:'',deliveryDate:null,sizes:[{size:'',quantity:''}]}]})}}},randomUUID());
  const readiness=new ProductionReadinessService(h.db),resource={kind:'source' as const,id:old.sourceId};
  await readiness.record(actor,resource,{kind:'design_handover',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:new Date().toISOString(),note:'TEST 真交接',quantities:[],evidenceIds:[],sourceDocumentVersion:preorder.version,recipientId:merch.actorId},randomUUID());
  const invested=await readiness.record(merch,resource,{kind:'material_investment',scopeRef:'whole',expectedVersion:0,state:'ready',occurredAt:new Date().toISOString(),note:'TEST 真投料',quantities:[{lineId:null,materialId:fabric.materialId,name:fabric.name,quantity:100,unit:'米'}],evidenceIds:[],sourceDocumentVersion:null,recipientId:null},randomUUID());
  expect(invested.facts.find(fact=>fact.kind==='material_investment')).toMatchObject({state:'ready',valid:true});
  await expect(identity.discardDevelopmentDraft(actor,old.sourceId,preorder.version,randomUUID())).rejects.toMatchObject({statusCode:409});
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create'),page=tab.page;
  try{
   const open=page.getByRole('button',{name:style,exact:true}),remove=page.getByRole('button',{name:`删除草稿 ${style}`,exact:true});
   await open.waitFor();
   expect(await page.getByRole('button',{name:`删除草稿 ${oldStyle}`,exact:true}).count()).toBe(0);
   // Lose only the browser acknowledgement, not the actual signed DELETE.
   const path=`/api/digital-production/sources/${sourceId}/draft`,keys:string[]=[];
   await page.route('**'+path,async route=>{
    keys.push(route.request().headers()['idempotency-key']!);
    const response=await route.fetch();expect(response.status(),await response.text()).toBe(200);
    if(keys.length===1)await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:'TEST_DISCARD_ACK_LOST',message:'TEST 原删除回执丢失'}})});
    else await route.fulfill({response});
   });
   const confirmDiscard=async()=>{
    await remove.click();
    await page.getByRole('alertdialog',{name:'删除开发草稿',exact:true}).getByRole('button',{name:'删除',exact:true}).click();
   };
   await confirmDiscard();
   await page.getByText('删除结果待核对，请刷新或重试原草稿删除。',{exact:true}).waitFor();
   expect(await open.isVisible()).toBe(true);
   await confirmDiscard();
   await page.getByText('开发草稿已删除。',{exact:true}).waitFor();
   await open.waitFor({state:'hidden'});
   expect(keys).toHaveLength(2);expect(keys[0]).toBe(keys[1]);
   expect((await h.db.query('SELECT source_id,draft_version FROM digital_development_draft_discards WHERE source_id=$1',[sourceId])).rows).toEqual([{source_id:sourceId,draft_version:saved.version}]);
   expect((await h.db.query('SELECT id FROM audit_events WHERE entity_id=$1 AND action=$2',[sourceId,'digital_development_draft_discarded'])).rowCount).toBe(1);
   expect((await h.db.query('SELECT source_id FROM digital_design_code_registry WHERE source_id=$1',[sourceId])).rowCount).toBe(1);
   expect((await h.db.query('SELECT attachment_id FROM digital_development_attachment_bindings WHERE source_id=$1',[sourceId])).rows).toEqual([{attachment_id:attachmentId}]);
   expect((await h.db.query('SELECT version FROM digital_development_documents WHERE source_id=$1',[sourceId])).rows).toEqual([{version:saved.version}]);
   await expect(forms.read(actor,sourceId)).rejects.toMatchObject({statusCode:404});
   const attemptDelete=(target:string,expectedVersion:number)=>page.evaluate(async({target,expectedVersion,key})=>{
    const response=await fetch(`/api/digital-production/sources/${target}/draft`,{method:'DELETE',headers:{'content-type':'application/json','idempotency-key':key},body:JSON.stringify({expectedVersion})});
    return {status:response.status,body:await response.text()};
   },{target,expectedVersion,key:randomUUID()});
   const racing=await identity.createSource(actor,{...input,designStyleNo:style+'-RACE'},randomUUID(),true);
   // This direct transaction fixture needs the same persisted capabilities as
   // the signed web actor. It does not grant another role or elevate to Root.
   const capabilities=(await h.db.query<{capability:string}>(`SELECT DISTINCT c.capability FROM user_role_assignments a
    JOIN role_capabilities c USING(role_code) WHERE a.user_id=$1 AND a.revoked_at IS NULL`,[actor.actorId])).rows;
   const publishActor={...actor,authorizationCapabilities:capabilities.map(row=>row.capability)};
   const category=(await h.db.query("SELECT price_id FROM pattern_room_prices WHERE kind='category' AND enabled ORDER BY price_id LIMIT 1")).rows[0]!;
   const {version:priceVersion}=await new PatternRoomPriceService(h.db).quote(publishActor,'category',category.price_id);
   const raceDraft=await forms.save(actor,racing.sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),quantity:1,patternCategoryId:category.price_id,
    files:[{attachmentId:await h.f.image(actor),kind:'款图'}]}},randomUUID());
   const publisher=await h.db.connect();let racingDelete:ReturnType<typeof attemptDelete>|undefined;
   try{
    await publisher.query('BEGIN');
    const processId=(await publisher.query('SELECT pg_backend_pid() AS id')).rows[0]!.id;
    const published=await forms.inTransaction(publisher).publish(publishActor,racing.sourceId,raceDraft.version,randomUUID(),{categoryId:category.price_id,priceVersion});
    expect(published.status).toBe('published');
    racingDelete=attemptDelete(racing.sourceId,raceDraft.version);
    await expect.poll(async()=>Boolean((await h.db.query(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity
      WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting`,[processId])).rows[0]?.waiting),{timeout:8000}).toBe(true);
    await publisher.query('COMMIT');
    const conflict=await racingDelete;expect(conflict.status,conflict.body).toBe(409);
    expect((await forms.read(actor,racing.sourceId)).status).toBe('published');
   }finally{await publisher.query('ROLLBACK');publisher.release();if(racingDelete)await Promise.allSettled([racingDelete]);}
   const revokeDraft=await identity.createSource(actor,{...input,designStyleNo:style+'-REVOKED'},randomUUID(),true);
   const assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='sample_designer' AND revoked_at IS NULL",[actor.actorId])).rows[0]!;
   await h.f.access.revokeRole(h.f.root,assignment.assignment_id,'TEST 同一登录会话撤销设计师权限');
   try{
    const forbidden=await attemptDelete(revokeDraft.sourceId,0);
    expect([401,403,404],forbidden.body).toContain(forbidden.status);
   }finally{await h.f.access.assignRole(h.f.root,{userId:actor.actorId,roleCode:'sample_designer',reason:'TEST 恢复后续独立夹具资格'});}
   expect((await h.db.query('SELECT source_id FROM digital_development_draft_discards WHERE source_id=ANY($1::uuid[])',[[racing.sourceId,revokeDraft.sourceId]])).rowCount).toBe(0);
  }finally{await page.unrouteAll({behavior:'wait'});await tab.context.close();}
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
    await page.getByRole('heading',{name:'开发草稿箱',exact:true}).waitFor();
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
   await page.getByRole('region',{name:'开发草稿箱',exact:true}).getByRole('button',{name:style,exact:true}).click();
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
   await openNewWizard(page,'已确认订单','裤子',true);
   const rail=page.getByRole('list',{name:'建单进度',exact:true});
   const firstStep=rail.getByRole('button',{name:/版单资料/}),orderStep=rail.getByRole('button',{name:/客户与交货/});
   expect(await orderStep.isDisabled()).toBe(true);
   const styleField=page.getByRole('textbox',{name:'设计款号',exact:true});
   await styleField.fill(style);
   await wizardNext(page);
   await wizardNext(page);
   await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).fill('TEST 蓝');
   await firstStep.press('Enter');
   await styleField.fill('');
   await orderStep.click();
   const missing=page.getByRole('dialog',{name:'下一步',exact:true});
   await missing.getByText('缺项 · 请填写设计款号',{exact:true}).waitFor();
   expect(await rail.locator('[aria-current="step"]').innerText()).toContain('版单资料');
   await missing.getByRole('button',{name:'关闭',exact:true}).click();
   await styleField.fill(style);
   await orderStep.click();
   expect(await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).inputValue()).toBe('TEST 蓝');
   const receipt=page.waitForResponse(response=>/\/sources\/[^/]+\/development$/.test(new URL(response.url()).pathname)&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const response=await receipt;
   expect(response.status(),await response.text()).toBe(200);
   const draft=await response.json();
   sourceId=draft.sourceId;
   expect(draft).toMatchObject({status:'draft',publishedAt:null,productionOrderId:null,version:1,document:{
    template:'裤子',templateConfirmed:true,sizeTableInitialized:true,rush:true,sizes:['M'],
    measurements:DEVELOPMENT_MEASUREMENTS.裤子.map(name=>({name,values:['']})),
    customerOrderDraft:{withOrder:true,stage:'formal',wizardStep:3,order:{lines:[expect.objectContaining({color:'TEST 蓝'})]}},
   }});
  }finally{await start.context.close();}
  const resumed=await h.open(designer.actorId,1165,{},url);
  let releaseCalendar!:()=>void;
  const calendarHeld=new Promise<void>(resolve=>{releaseCalendar=resolve;});
  try{
   const page=resumed.page,step=page.locator('.development-creation-steps [aria-current="step"]');
   const optionsPath=`/api/digital-production/options?sourceId=${sourceId!}`;
   await page.route('**'+optionsPath,async route=>{await calendarHeld;await route.continue();});
   await page.getByRole('button',{name:style,exact:true}).click();
   expect(await step.innerText()).toContain('客户与交货');
   const poDate=page.locator('#development-po-date-1');
   expect(await poDate.getAttribute('min')).toBeNull();
   expect(await poDate.inputValue()).toBe('');
   const calendar=page.waitForResponse(response=>response.url().endsWith(optionsPath)&&response.ok());
   releaseCalendar();
   const {minimumInitialCustomerDate}=await (await calendar).json();
   await expect.poll(()=>poDate.getAttribute('min')).toBe(minimumInitialCustomerDate);
   expect(await poDate.inputValue()).toBe('');
   expect(await page.getByRole('textbox',{name:'PO 1 颜色',exact:true}).inputValue()).toBe('TEST 蓝');
   expect(await page.getByRole('dialog',{name:'请选择创建类型'}).count()).toBe(0);
   await page.getByRole('button',{name:'上一步',exact:true}).click();
   expect(await step.innerText()).toContain('开发需求');
   expect(h.requests.filter(row=>row.session===resumed.session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'))).toEqual([]);
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId!})).toBeNull();
   expect((await h.db.query('SELECT version FROM digital_development_documents WHERE source_id=$1',[sourceId!])).rows).toEqual([{version:1}]);
  }finally{releaseCalendar();await resumed.context.close();}
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
  const sewingRows=(template==='上衣'?['藏青','黄']:['藏青','米白','灰']).map((color,i)=>({rowId:randomUUID(),color,size:sizes[i]!,quantity:1}));
  const making=sizes.map((_,i)=>i<sewingRows.length?1:0);
  const files=await Promise.all(Array.from({length:6},async(_,index)=>({
   attachmentId:await h.f.image(actor),kind:index===0?'款图' as const:'局部图' as const,
  })));
  const order=InitialCustomerOrderDraftSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:style,orderDate:'2026-11-19',temporaryStyleNo:null,contractDeliveryDate:null,
   lines:[{formalPoNo:style+'-1',color:'藏青',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-16',sizes:[{size:'M',quantity:'2'}]},
    {formalPoNo:style+'-2',color:'米白',deliveryDate:null,customerWarehouseArrivalDate:'2027-03-22',sizes:[{size:'XL',quantity:'3'}]}],
  });
  const before=await forms.save(actor,sourceId,{expectedVersion:0,document:{
   ...garment,template,quantity:sewingRows.length,sizes,sizeQuantities:making,
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
   const docs=page.getByRole('heading',{name:'版单资料',exact:true});
   await docs.waitFor();
   expect(await page.getByRole('searchbox',{name:'查找字段'}).count()).toBe(0);
   await changeGarment(page,template,true);
   const designCode=page.getByRole('textbox',{name:'设计款号',exact:true});
   const quantity=page.getByRole('spinbutton',{name:'第 1 行 件数',exact:true});
   const materials=page.locator('#development-materials .development-material-inline-row');
   for(const [width,height] of [[1165,747],[1440,900]] as const){
    await page.setViewportSize({width,height});
    expect(await designCode.evaluate(input=>[getComputedStyle(input).borderTopWidth,getComputedStyle(input.parentElement!).borderTopWidth])).toEqual(['0px','1px']);
    expect(await materials.count()).toBe(fabricCount+accessoryCount);
    expect(await materials.last().getByRole('textbox',{name:/品名/}).isVisible()).toBe(true);
    await page.screenshot({path:join(h.evidence,`c1-order-sheet-${template}-${width}.png`),fullPage:true});
   }
   await page.setViewportSize({width:1165,height:747});
   expect(await quantity.count()).toBe(0);
   const firstRow=page.locator('#development-'+bad.materialId+'-supplier');
   expect(await firstRow.count()).toBe(1);
   const next=page.getByRole('button',{name:'下一步',exact:true});
   await next.click();
   const validation=page.getByRole('dialog',{name:'下一步',exact:true});
   await validation.getByRole('button',{name:/^去填写 .*供应方/}).click();
   await validation.waitFor({state:'hidden'});
   await expect.poll(()=>firstRow.evaluate(el=>document.activeElement===el)).toBe(true);
   await firstRow.fill('补齐供应商');
   const sample=page.getByRole('combobox',{name:bad.label+' 实样图片',exact:true});
   await sample.press('Enter');
   await page.getByRole('option',{name:/^局部图 1(?: · |$)/}).click();
   await wizardNext(page);
   expect(await quantity.evaluate((input:HTMLInputElement)=>{
    const field=input.getBoundingClientRect(),cell=input.closest('td')!.getBoundingClientRect();
    return {frame:getComputedStyle(input).borderTopWidth,inside:field.left>=cell.left&&field.right<=cell.right+1,min:input.min,max:input.max};
   })).toEqual({frame:'1px',inside:true,min:'1',max:'100000'});
   expect(await page.getByRole('textbox',{name:/^针距/}).inputValue()).toBe('12针');
   await wizardNext(page);
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
   expect(updatedSheet).toEqual({...originalSheet,templateConfirmed:true,sizeTableInitialized:true});
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
   workbenchSheet:{version:1,styleName:'工艺定位',brand:'TEST 原品牌',gender:'男装',boardType:'头版',processingSelected:true,referenceNote:'',sewingRows:[{rowId:randomUUID(),color:'黑',size:'M',quantity:1}]},
  }},randomUUID());
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page,steps=page.getByLabel('建单步骤');
   await page.getByRole('button',{name:style,exact:true}).click();
   expect(await page.locator('#development-craft-requirements').count()).toBe(0);
   const next=page.getByRole('button',{name:'下一步',exact:true});
   await next.click();
   const garmentValidation=page.getByRole('dialog',{name:'下一步',exact:true});
   await garmentValidation.getByText(/请在基本资料明确选择衣类$/).waitFor();
   await garmentValidation.getByRole('button',{name:'去填写 衣类',exact:true}).click();
   await garmentValidation.waitFor({state:'hidden'});
   await changeGarment(page,'上衣',true);
   await next.click();
   await steps.getByRole('heading',{name:'开发需求',exact:true}).waitFor();
   expect(await page.evaluate(()=>{
    const groups=['development-basic','development-craft-requirements','development-sizes','development-craft'].map(id=>document.getElementById(id));
    return groups.every((current,index)=>Boolean(current?.getClientRects().length)&&(!index||Boolean((groups[index-1]?.compareDocumentPosition(current!)??0)&Node.DOCUMENT_POSITION_FOLLOWING)));
   })).toBe(true);
   await page.getByText(/^执行单价：/).waitFor();
   const submit=page.getByRole('button',{name:'提交开发单',exact:true});
   const writes=()=>h.requests.filter(row=>row.session===tab.session&&['POST','PUT'].includes(row.method)&&row.path.includes('/sources'));
   const beforeSubmit=writes().length;
   await submit.click();
   const validation=page.getByRole('dialog',{name:'提交开发单',exact:true});
   await validation.getByText(/工艺开发板仅适用于印花或绣花/).waitFor();
   await page.keyboard.press('Escape');
   await validation.waitFor({state:'hidden'});
   await expect.poll(()=>submit.evaluate(el=>document.activeElement===el)).toBe(true);
   expect(writes()).toHaveLength(beforeSubmit);
   await submit.click();
   await validation.getByRole('button',{name:'去填写 工艺',exact:true}).click();
   const issue=page.getByRole('button',{name:'工艺：工艺开发板仅适用于印花或绣花',exact:true});
   await steps.getByRole('heading',{name:'开发需求',exact:true}).waitFor();
   const checkbox=page.getByRole('checkbox',{name:'绣花',exact:true}),native=await checkbox.isVisible();
   const craft=native?checkbox:page.getByRole('combobox',{name:'工艺',exact:true});
   await expect.poll(()=>craft.evaluate(el=>document.activeElement===el)).toBe(true);
   if(native)await craft.check();else if(await craft.evaluate(element=>element.tagName==='SELECT'))await craft.selectOption('绣花');
   else {await craft.press('Enter');await page.getByRole('option',{name:'绣花',exact:true}).click();}
   await issue.waitFor({state:'hidden'});
   const embroidery=page.getByRole('group',{name:'绣花',exact:true});
   await embroidery.getByRole('textbox',{name:'绣花部位',exact:true}).fill('左胸');
   await embroidery.getByRole('textbox',{name:'绣花规格 / 效果',exact:true}).fill('宽 6 cm');
   const existingBoard=embroidery.getByRole('combobox',{name:'绣花引用已有工艺开发板'});
   expect(await existingBoard.evaluate(element=>element.tagName)).toBe('BUTTON');
   await existingBoard.press('Enter');
   await page.getByRole('option',{name:/^(?:TEST\.png|工艺开发板 1)$/}).click();
   expect((await embroidery.getByRole('link',{name:'查看绣花附件 1原件'}).getAttribute('href'))).toContain('/'+file.attachmentId);
   await tab.context.route('https://private.example.test/**',async route=>{
    const request=route.request();
    if(request.method()!=='POST')return route.abort();
    // Substitute only the fixture's private object transport, using its signed key and real bytes.
    const form=await new Response(request.postDataBuffer(),{headers:{'content-type':request.headers()['content-type']!}}).formData();
    const key=String(form.get('key')),material=form.get('file') as File,bytes=new Uint8Array(await material.arrayBuffer());
    const sha256=createHash('sha256').update(bytes).digest('hex');
    expect(h.f.storage.signed.some(grant=>grant.method==='POST'&&grant.objectKey===key)).toBe(true);
    expect(sha256).toBe(form.get('x-oss-meta-sha256'));
    await h.f.storage.writeImmutable(key,bytes,{mimeType:material.type,sha256});
    await route.fulfill({status:204,headers:{'access-control-allow-origin':'*'}});
   });
   await embroidery.locator('input[type="file"]').setInputFiles({
    name:'TEST-embroidery-board.png',mimeType:'image/png',
    buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64'),
   });
   await embroidery.getByText('TEST-embroidery-board.png',{exact:true}).first().waitFor();
   const saved=page.waitForResponse(response=>response.url().endsWith('/sources/'+sourceId+'/development')&&response.request().method()==='PUT');
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   const result=await saved;expect(result.status(),await result.text()).toBe(200);
   const persisted=await result.json(),uploaded=persisted.document.files[1];
   expect(uploaded).toMatchObject({kind:'工艺开发板',attachmentId:expect.stringMatching(/^[a-f0-9-]{36}$/)});
   expect(uploaded.attachmentId).not.toBe(file.attachmentId);
   expect(persisted).toMatchObject({sourceId,status:'draft',document:{craft:'绣花',files:[file,uploaded],
    craftRequirements:[{stepKey:'embroidery',part:'左胸',specification:'宽 6 cm',instructions:'',attachmentIds:[file.attachmentId,uploaded.attachmentId]}],
   }});
   await page.reload();
   expect(await embroidery.getByRole('textbox',{name:'绣花部位',exact:true}).inputValue()).toBe('左胸');
   expect(await embroidery.getByRole('link',{name:'查看绣花附件 1原件'}).getAttribute('href')).toContain('/'+file.attachmentId);
   expect(await embroidery.getByRole('link',{name:'查看绣花附件 2原件'}).getAttribute('href')).toContain('/'+uploaded.attachmentId);
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
   await forms.save(actor,sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),templateConfirmed:true,sizeTableInitialized:true,instructions:`TEST independent ${index}`,
    customerOrderDraft:{withOrder:true,stage:'formal',order,wizardStep:3},files:index===0?attachments.map(attachmentId=>({attachmentId,kind:'款图' as const})):[]}},randomUUID());
  }
  const initialTab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  await initialTab.context.close();
  const {context,page,session}=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   await page.getByRole('heading',{name:'开发草稿箱',exact:true}).waitFor();
   for(const index of [0,1,0]){
    await page.getByRole('button',{name:styles[index]!,exact:true}).click();
    expect(await page.getByLabel('设计款号',{exact:true}).inputValue()).toBe(styles[index]);
    await page.getByLabel('建单步骤').getByRole('heading',{name:'客户与交货',exact:true}).waitFor();
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
  const returnedBasis=await h.f.runtime.run(scene,actor,async()=>{
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
   expect((await identity.developmentDrafts(actor,1,designStyleNo)).items).toEqual([]);
   expect((await identity.developmentDrafts(actor,1,designStyleNo,false,'followup')).items[0]).toMatchObject({sourceId,approvalState:'pending',canDiscard:false});
   expect(await orderTimeCreated(h.db,{kind:'source',id:sourceId})).toBeNull();
   const returned=await requests.close(actor,pending.requestId,{expectedVersion:pending.version,reason:'TEST return before original publication'},randomUUID(),'returned');
   expect(returned.state).toBe('returned');
   expect((await identity.developmentDrafts(actor,1,designStyleNo)).items).toEqual([]);
   expect((await identity.developmentDrafts(actor,1,designStyleNo,false,'followup')).items[0]).toMatchObject({sourceId,approvalState:'returned',canDiscard:false});
   return {sheet,category,price};
  });
  h.setCollectionScene(scene);
   const returnedTab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
   try{
    await returnedTab.page.getByText('审批与原档案核对',{exact:true}).click();
    const row=returnedTab.page.getByRole('listitem').filter({hasText:designStyleNo});
    await row.getByText('时效申请已退回',{exact:false}).waitFor();
    await row.getByRole('link',{name:'查看原时效申请',exact:true}).waitFor();
    expect(await row.getByRole('button',{name:/删除/}).count()).toBe(0);
    await row.getByRole('button',{name:'编辑原开发草稿',exact:true}).click();
    const field=returnedTab.page.getByRole('textbox',{name:'设计款号',exact:true});
    await field.waitFor();expect(await field.inputValue()).toBe(designStyleNo);
    expect(await returnedTab.page.getByRole('button',{name:'保存开发资料草稿',exact:true}).count()).toBe(1);
   }finally{await returnedTab.close();h.setCollectionScene(undefined);}
  const saved=await h.f.runtime.run(scene,actor,async()=>{
   const {sheet,category,price}=returnedBasis;
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
   await page.getByRole('heading',{name:'开发草稿箱',exact:true}).waitFor();
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
   const checkReceipt=page.getByRole('button',{name:'只读核对原提交结果',exact:true});
   expect(await checkReceipt.evaluate(button=>{
    const scope=button.closest('.dx-designer-astryx');
    return Boolean(scope?.querySelector('style[data-designer-style="astryx-v0.7.16"]')&&
      getComputedStyle(button).getPropertyValue('--font-family-body').trim()&&document.documentElement.lang==='zh-CN');
   })).toBe(true);
   await checkReceipt.focus();
   await checkReceipt.press('Enter');
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
  let sheet=await forms.save(actor,source.sourceId,{expectedVersion:0,document:{...initialDevelopmentDocument(),templateConfirmed:true,sizeTableInitialized:true,quantity:1,files:[{attachmentId:await h.f.image(actor),kind:'款图'}],patternCategoryId:category.price_id,...(order?{productionPlanning:{craftSteps:[],preshrink:false},customerOrderDraft:{withOrder:true,stage:'formal',order}}:{})}},randomUUID());
  if(operation==='confirm')sheet=await forms.publish(actor,source.sourceId,sheet.version,randomUUID(),{categoryId:category.price_id,priceVersion:price.version});
  const tab=await h.open(actor.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;page.on('dialog',dialog=>void dialog.accept());await openNewWizard(page);await page.getByRole('textbox',{name:'设计款号',exact:true}).fill(style);
   // Isolated restoration fixture: the source/document are prepared by their
   // real services, and this is the same bound state following an acknowledged
   // original draft save. Publication and receipt lookup below are unmocked.
   await page.evaluate(({sheet,categoryId,priceVersion,order})=>{
    const key=Object.keys(sessionStorage).find(key=>key.startsWith('dx:development-creation:'))!,draft=JSON.parse(sessionStorage.getItem(key)!);
    draft.phase='bound';draft.sourceId=sheet.sourceId;draft.version=sheet.version;
    draft.snapshot.document=sheet.document;draft.snapshot.quantityInput='1';draft.snapshot.patternChoice={categoryId,priceVersion};
    draft.snapshot.measurementIds=sheet.document!.measurements.map(()=>crypto.randomUUID());
    if(order){draft.snapshot.intent='certain_order';draft.snapshot.form=order;draft.snapshot.poSizeIds=Array.from({length:Math.max(...order.lines.map(line=>line.sizes.length))},()=>crypto.randomUUID());}
    sessionStorage.setItem(key,JSON.stringify(draft));
   },{sheet,categoryId:category.price_id,priceVersion:price.version,order});
   await page.reload();await page.getByRole('textbox',{name:'设计款号',exact:true}).waitFor();await wizardNext(page);
   if(operation==='publish'){
    await page.getByText(/^执行单价：/).waitFor();
    await fillRequiredCraft(page);
    const making=page.getByRole('table',{name:'颜色尺码与制作件数',exact:true});
    expect(await making.count()).toBe(0);
   }else await wizardNext(page);
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
