import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import type {BudgetDocument} from '@dx-rework/contracts/digital-budget';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {beijingCalendarDate,DigitalOrderCreateSchema,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import type {Page} from 'playwright-core';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {DevelopmentTechnicalService} from '../../apps/api/src/production-platform/development-technical-service.js';
import {publishedTechnicalFixture} from '../helpers/development-technical-fixture.js';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('PR03 automatic quotation through original authenticated App and real PG',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'automatic-quotation-ui-'+randomUUID()),{fullApp:true,orderTimeFlow:true});});
 afterAll(async()=>{await h?.writeEvidence();await h?.dispose();});
 it('explains a current published unit mismatch on only the authorized material row without adopting or rounding its quantity',async()=>{
  const designer=h.f.people['sample-designer']!,worker=h.f.people['pattern-room-worker']!,manager=h.f.people['production-management']!;
  const forms=new DigitalDevelopmentService(h.db,true),quotes=new DigitalQuotationService(h.db,true),technical=new DevelopmentTechnicalService(h.db,true);
  const source=await new DigitalProductionIdentityService(h.db,true).createSource(designer,{developmentType:'头版',designStyleNo:'TEST-UNIT-MISMATCH-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const resource={kind:'source' as const,id:source.sourceId},path='/ui/digital-quotation?kind=source&id='+source.sourceId;
  const materialId=randomUUID(),otherId=randomUUID(),draft=initialDevelopmentDocument();
  draft.quantity=1;draft.sizes=['M'];draft.sampleSize='M';draft.sizeQuantities=[1];draft.measurements=[{name:'胸围',values:['50']}];
  const main={...draft.materials[0]!,materialId,category:'主布' as const,label:'主布',name:'TEST冲突主料',supplier:'TEST',specification:'40支',width:'150',weight:'200',composition:'棉',color:'黑',requiredThisRound:true,available:true,pricingUnit:'米',unitPrice:'20'};
  draft.materials=[main,{...main,materialId:otherId,category:'辅料',label:'辅料',name:'TEST匹配辅料',unitPrice:'19.75'}];
  draft.files=[{attachmentId:await h.f.image(designer),kind:'款图'}];
  const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document:DevelopmentDocumentSchema.parse(draft)},randomUUID());
  await forms.publish(designer,source.sourceId,saved.version,randomUUID());
  const publish=await forms.read(designer,source.sourceId);
  const blank=await quotes.read(designer,resource);expect(blank.rows.find(row=>row.rowId===materialId)?.technicalConsumptionIssue).toBeUndefined();
  const initial=await publishedTechnicalFixture(h.db,h.f.root,source.sourceId,publish.document!,publish.version,worker.actorId);
  const artifact=(await technical.read(h.f.root,source.sourceId)).artifacts.find(row=>row.artifactSetId===initial?.artifactSetId&&row.version===initial?.version)!;
  const write=(version:number,consumptionRows:typeof artifact.body.consumptionRows)=>technical.saveArtifact(h.f.root,source.sourceId,{taskId:artifact.taskId,expectedDocumentVersion:publish.version,expectedVersion:version,scopeRef:'整款',action:'publish',body:{...artifact.body,consumptionRows}},randomUUID());
  const mismatch=await write(artifact.version,[{materialId,unit:'码',consumption:'1.5'},{materialId:otherId,unit:'米',consumption:'1'}]);
  const current=await quotes.read(designer,resource);
  expect(current.rows.find(row=>row.rowId===materialId)).toMatchObject({unit:'米',unitPrice:'20',consumption:'',consumptionSource:null,technicalConsumptionIssue:'unit_mismatch'});
  expect(current.rows.find(row=>row.rowId===otherId)).toMatchObject({unit:'米',unitPrice:'19.75',consumption:'1',consumptionSource:{kind:'technical_artifact'}});
  expect(current.rows.filter(row=>row.technicalConsumptionIssue).map(row=>row.rowId)).toEqual([materialId]);
  expect(current.technicalConsumptionOptions).toEqual([]);
  const technicalChoices=(await quotes.read(h.f.root,resource)).technicalConsumptionOptions;
  expect(technicalChoices).toEqual(expect.arrayContaining([expect.objectContaining({materialId:otherId,unit:'米',consumption:'1'})]));
  const neutral=await quotes.read(manager,resource);expect(neutral.rows).toHaveLength(current.rows.length);
  expect(neutral.rows.every(row=>row.technicalConsumptionIssue===undefined)).toBe(true);expect(neutral.technicalConsumptionOptions).toEqual([]);
  expect(current).toMatchObject({complete:false,confirmedVersion:null,budget:{state:'waiting_formal_order'}});
  const tab=await h.open(designer.actorId,1165,{},path),hint='已发布技术用量单位与本行计价单位不符，请核对。';
  try{
   const mainRow=tab.page.getByRole('row').filter({hasText:'TEST冲突主料'}),otherRow=tab.page.getByRole('row').filter({hasText:'TEST匹配辅料'});
   await mainRow.getByText(hint,{exact:true}).waitFor();expect(await mainRow.getByRole('cell',{name:'—',exact:true}).count()).toBe(1);
   expect(await otherRow.getByText(hint,{exact:true}).count()).toBe(0);
   expect(await tab.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).isDisabled()).toBe(true);
   expect(await tab.page.locator('#quote-cost-reference').innerText()).toContain('19.75');
   await write(mismatch.version,[{materialId:otherId,unit:'米',consumption:'1'}]);
   await tab.page.getByRole('button',{name:'重新读取报价',exact:true}).click();
   await mainRow.waitFor();await expect.poll(()=>mainRow.getByText(hint,{exact:true}).count()).toBe(0);
   expect((await quotes.read(designer,resource)).rows.find(row=>row.rowId===materialId)).toMatchObject({consumption:'',unitPrice:'20',consumptionSource:null});
  }finally{await tab.context.close();}
 });
 it('unlocks only the confirmed order in the original merchandiser budget after two tabs and a lost confirmation receipt',async()=>{
  const designer=h.f.people['sample-designer']!,merch=h.f.people.merchandiser!,worker=h.f.people['pattern-room-worker']!;
  const identity=new DigitalProductionIdentityService(h.db,true),quotes=new DigitalQuotationService(h.db,true);
  const createOrder=(name:string)=>identity.createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:`TEST-BUDGET-${name}-${randomUUID()}`,
   orderDate:beijingCalendarDate(new Date()),
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}],
  }),randomUUID());
  const order=await createOrder('A'),sibling=await createOrder('B'),id=order.productionOrderId,other=sibling.productionOrderId;
  expect(order.primaryMerchandiserId).toBe(merch.actorId);
  expect(sibling.primaryMerchandiserId).toBe(merch.actorId);
  const resource={kind:'order' as const,id},rowId=randomUUID();
  const document:BudgetDocument={fabricType:'针织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'0',cm:'0',
   rows:[{rowId,section:'主料',category:'',name:'TEST 面料',specification:'40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:'10'}],
   salePrice:'',outsourcingScope:'车缝',outsourcingUnitPrice:'5',imageAttachmentIds:[]};
  const draft=await quotes.save(designer,resource,{expectedVersion:0,document,
   assignments:[{rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},randomUUID());
  const quote=await quotes.fillRow(worker,resource,rowId,{expectedVersion:draft.version,consumption:'1'},randomUUID());
  const quotePage=`/ui/digital-quotation?kind=order&id=${id}`;
  const budgetApi=(orderId:string)=>`${h.base}/api/digital-production/orders/${orderId}/budget`;
  const confirmationUrl=`${h.base}/api/digital-production/orders/${id}/quotation/confirm`;
  const confirmationButton='记录客户报价确认并检查预算生成条件';
  const operator=await h.open(merch.actorId,1165,{},quotePage);
  const first=await h.open(designer.actorId,1165,{},quotePage);
  const second=await first.context.newPage();
  let releaseFirst!:()=>void;
  const held=new Promise<void>(resolve=>{releaseFirst=resolve;});
  try{
   await operator.page.getByText('等待客户确认报价与正式下单，不能发布预算',{exact:true}).waitFor();
   expect(await operator.page.getByRole('button',{name:confirmationButton,exact:true}).count()).toBe(0);
   const budgetLink=operator.page.getByRole('link',{name:'打开本单预算',exact:true});
   expect(new URL((await budgetLink.getAttribute('href'))!,h.base).searchParams.get('budget')).toBe(id);
   await budgetLink.click();
   const assertLocked=async(page:Page,orderId:string)=>{
    await page.getByRole('region',{name:'客户报价对照',exact:true}).getByText('等待客户确认报价与正式下单，不能发布预算',{exact:false}).waitFor();
    expect(await page.getByRole('button',{name:'保存预算',exact:true}).count()).toBe(0);
    expect(await page.getByRole('button',{name:'最终发布',exact:true}).count()).toBe(0);
    expect(await page.locator('input[type=file]').count()).toBe(0);
    const result=await page.request.get(budgetApi(orderId));
    expect(result.status()).toBe(200);
    expect(await result.json()).toMatchObject({productionOrderId:orderId,version:0,document:null,canEdit:false,canPublish:false});
    expect((await page.request.put(budgetApi(orderId),{headers:{'idempotency-key':randomUUID()},data:{expectedVersion:0,document}})).status()).toBe(409);
    const publish=await page.request.post(budgetApi(orderId)+'/publish',{headers:{'idempotency-key':randomUUID()},data:{expectedVersion:1}});
    expect(publish.status()).toBe(409);
    expect(await publish.json()).toMatchObject({error:{code:'BUDGET_CONFLICT'}});
    expect((await page.request.get(budgetApi(orderId)+'/upload-limits')).status()).toBe(403);
   };
   await assertLocked(operator.page,id);
   const fillConfirmation=async(page:Page)=>{
    await page.getByLabel('客户确认金额',{exact:true}).fill('20');
    await page.getByLabel('客户真实确认时间',{exact:true}).fill('2026-10-20T09:00');
    await page.getByLabel('客户确认依据',{exact:true}).fill('TEST客户确认单件20元');
   };
   await second.goto(h.base+quotePage);
   await fillConfirmation(first.page);
   await fillConfirmation(second);
   const attempts:Array<{key:string|undefined;body:string|null}>=[];
   let committedStatus:number|undefined;
   await first.page.route(confirmationUrl,async route=>{
    attempts.push({key:route.request().headers()['idempotency-key'],body:route.request().postData()});
    if(attempts.length>1)return route.continue();
    committedStatus=(await route.fetch()).status();
    await held;
    return route.abort('failed');
   });
   const submit=first.page.getByRole('button',{name:confirmationButton,exact:true});
   await submit.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
   await expect.poll(()=>committedStatus).toBe(200);
   expect(attempts).toHaveLength(1);
   const [collision]=await Promise.all([
    second.waitForResponse(confirmationUrl),
    second.getByRole('button',{name:confirmationButton,exact:true}).click(),
   ]);
   expect(collision.status()).toBe(409);
   expect(collision.request().headers()['idempotency-key']).not.toBe(attempts[0]!.key);
   releaseFirst();
   const recover=first.page.getByRole('button',{name:'使用原内容核对报价提交',exact:true});
   await recover.waitFor();
   const [receipt]=await Promise.all([first.page.waitForResponse(confirmationUrl),recover.click()]);
   expect(receipt.status()).toBe(200);
   await recover.waitFor({state:'hidden'});
   expect(attempts).toHaveLength(2);
   expect(attempts[0]?.key).toBeTruthy();
   expect(attempts[1]).toEqual(attempts[0]);
   expect((await h.db.query('SELECT version FROM digital_quotation_versions WHERE quote_id=$1',[quote.quoteId])).rows)
    .toEqual([{version:quote.version}]);
   expect((await h.db.query('SELECT production_order_id,created_budget_version FROM digital_budget_quote_conversions WHERE production_order_id=ANY($1::uuid[])',[[id,other]])).rows)
    .toEqual([{production_order_id:id,created_budget_version:1}]);

   await operator.page.reload();
   await operator.page.getByRole('button',{name:'保存预算',exact:true}).waitFor();
   await operator.page.getByRole('textbox',{name:'产品类别',exact:true}).fill('TEST 跟单编辑本单');
   const [saved]=await Promise.all([
    operator.page.waitForResponse(response=>response.url()===budgetApi(id)&&response.request().method()==='PUT'),
    operator.page.getByRole('button',{name:'保存预算',exact:true}).click(),
   ]);
   expect(saved.status()).toBe(200);
   expect(await saved.json()).toMatchObject({productionOrderId:id,version:2,canEdit:true,document:{productCategory:'TEST 跟单编辑本单'}});
   await operator.page.goto(h.base+`/ui/digital-production?budget=${other}`);
   await assertLocked(operator.page,other);
   expect((await h.db.query('SELECT production_order_id,version FROM digital_budget_documents WHERE production_order_id=ANY($1::uuid[])',[[id,other]])).rows)
    .toEqual([{production_order_id:id,version:2}]);
  }finally{
   releaseFirst();
   await first.context.close();
   await operator.context.close();
  }
 });
 it('edits original source prices, assigns existing roles, fills only own rows, freezes confirmation and rejects revoked session',async()=>{
  const designer=h.f.people['sample-designer']!,worker=h.f.people['pattern-room-worker']!,ie=h.f.people['ie']!;
  const source=await new DigitalProductionIdentityService(h.db,true).createSource(designer,{developmentType:'头版',designStyleNo:'TEST-PR03-UI-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const forms=new DigitalDevelopmentService(h.db,true),quotes=new DigitalQuotationService(h.db,true),materialId=randomUUID();
  const doc=DevelopmentDocumentSchema.parse({quotationMode:'automatic_v1',documentFormatVersion:2,template:'上衣',quantity:1,sizeQuantities:[],sampleSize:'',orderDate:null,returnDate:null,unit:'cm',sizes:[],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST原App自动报价',craft:'无',washing:'免洗',materials:[{materialId,category:'主布',label:'主布',name:'TEST棉布',supplier:'TEST',width:'150',weight:'200',composition:'棉',consumption:'',color:'黑',specification:'TEST40支',quantity:'1',requiredThisRound:true,available:true,expectedDate:null,pricingUnit:'米',unitPrice:'19'}],files:[]});
  await forms.save(designer,source.sourceId,{expectedVersion:0,document:doc},randomUUID());
  const path='/ui/digital-quotation?kind=source&id='+source.sourceId,resource={kind:'source' as const,id:source.sourceId};
  const d=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+source.sourceId);
  try{
   await d.page.getByRole('button',{name:'保存开发资料草稿',exact:true}).waitFor();
   await d.page.getByRole('button',{name:'面辅料',exact:true}).click();
   await d.page.getByText('技术详情',{exact:true}).click();
   await d.page.getByLabel('主布材料单价',{exact:true}).fill('20');
   await d.page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   await expect.poll(async()=>(await forms.read(designer,source.sourceId)).version).toBe(2);
   const edited=await forms.read(designer,source.sourceId);
   const publication=await forms.save(designer,source.sourceId,{expectedVersion:edited.version,
    document:DevelopmentDocumentSchema.parse({...edited.document,sizes:['M'],sampleSize:'M',sizeQuantities:[1],
     measurements:[{name:'胸围',values:['50']}],files:[{attachmentId:await h.f.image(designer),kind:'款图'}]})},randomUUID());
   await forms.publish(designer,source.sourceId,publication.version,randomUUID());
   await d.page.goto(h.base+'/ui/digital-production?workspace=designer&section=workspace&area=customer&development='+source.sourceId);
   const customerArea=d.page.getByRole('region',{name:'客户与报价'});
   await customerArea.getByText('客户报价协作',{exact:true}).click();
   await d.page.getByRole('heading',{name:'客户报价表',exact:true}).waitFor();
   await d.page.getByLabel('TEST棉布用量负责人').selectOption(worker.actorId);
   await d.page.getByLabel('IE加工单价价格负责人').selectOption('ie_reviewer:'+ie.actorId);
   await d.page.getByRole('button',{name:'保存报价',exact:true}).click();
   await expect.poll(async()=>(await quotes.read(designer,resource)).assignments.some(a=>a.priceAssigneeId===ie.actorId)).toBe(true);
   expect(await d.page.getByRole('button',{name:'添加主料',exact:true}).count()).toBe(0);
   expect(await d.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).isDisabled()).toBe(true);
   expect(await d.page.locator('.quotation-editor').innerText()).not.toContain('[object Object]');
   expect(await d.page.locator('.quotation-editor').innerText()).not.toContain('sheet.status');
   const w=await h.open(worker.actorId,1165,{},path),i=await h.open(ie.actorId,1165,{},path);
   try{
    await w.page.getByLabel('TEST棉布单件用量',{exact:true}).fill('1.5');
    expect(await w.page.getByLabel('TEST棉布负责单价',{exact:true}).count()).toBe(0);
    await w.page.getByRole('button',{name:'保存本行负责字段',exact:true}).click();
    await expect.poll(async()=>(await quotes.read(designer,resource)).document!.rows.find(r=>r.rowId===materialId)!.consumption).toBe('1.5');
    await i.page.getByRole('button',{name:'重新读取报价',exact:true}).click();
    await i.page.getByLabel('IE加工单价负责单价',{exact:true}).fill('10');
    expect(await i.page.getByLabel('IE加工单价单件用量',{exact:true}).count()).toBe(0);
    await i.page.getByRole('button',{name:'保存本行负责字段',exact:true}).click();
    await expect.poll(async()=>(await quotes.read(designer,resource)).complete).toBe(true);
    await d.page.getByRole('button',{name:'重新读取报价',exact:true}).click();
    await expect.poll(()=>d.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).isEnabled()).toBe(true);
    expect(await d.page.locator('#quote-cost-reference').innerText()).toContain('40');
    await d.page.getByLabel('客户确认金额',{exact:true}).fill('42');
    await d.page.getByLabel('客户真实确认时间',{exact:true}).fill('2026-10-20T09:00');
    await d.page.getByLabel('客户确认依据',{exact:true}).fill('TEST真实确认42，成本40不是客户售价');
    const confirmationPath=`${h.base}/api/digital-production/sources/${source.sourceId}/quotation/confirm`;
    const attempts:Array<{key:string|undefined;body:string|null}>=[];
    let committedStatus:number|undefined;
    await d.page.route(confirmationPath,async route=>{
     const request=route.request();
     attempts.push({key:request.headers()['idempotency-key'],body:request.postData()});
     if(attempts.length>1)return route.continue();
     committedStatus=(await route.fetch()).status();
     return route.abort('failed');
    });
    try{
     await d.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).click();
     const recover=d.page.getByRole('button',{name:'使用原内容核对报价提交',exact:true});
     await recover.waitFor();
     expect(committedStatus).toBe(200);
     expect((await quotes.read(designer,resource)).confirmedVersion).not.toBeNull();
     await expect.poll(()=>d.page.getByLabel('客户确认金额',{exact:true}).inputValue()).toBe('42');
     const [receipt]=await Promise.all([d.page.waitForResponse(confirmationPath),recover.click()]);
     expect(receipt.ok()).toBe(true);
     await recover.waitFor({state:'hidden'});
     expect(attempts).toHaveLength(2);
     expect(attempts[0]?.key).toBeTruthy();
     expect(attempts[1]).toEqual(attempts[0]);
    }finally{await d.page.unroute(confirmationPath);}
    const confirmed=await quotes.read(designer,resource),frozen=confirmed.confirmedVersion!;
    expect(confirmed.versions).toEqual([frozen]);
    const confirmedBasis=customerArea.locator('#quote-confirmed-basis');
    const designerName=(await h.db.query('SELECT display_name FROM app_users WHERE id=$1',[designer.actorId])).rows[0].display_name;
    await confirmedBasis.getByText(`确认登记人：${designerName}`,{exact:false}).waitFor();
    expect(await confirmedBasis.innerText()).toContain(new Date(confirmed.confirmation!.confirmedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}));
    expect(await confirmedBasis.innerText()).toContain('客户确认单件金额：42 元');
    await customerArea.getByText('等待正式下单；纯开发和预下单不强制生成预算',{exact:true}).waitFor();
    expect(new URL(d.page.url()).searchParams.get('development')).toBe(source.sourceId);
    expect(confirmed).toMatchObject({productionOrderId:null,budget:{state:'waiting_formal_order'}});
    expect((await h.db.query('SELECT 1 FROM digital_production_orders WHERE source_id=$1',[source.sourceId])).rowCount).toBe(0);
    expect(h.requests.filter(request=>request.session===d.session&&request.method==='POST'
     &&request.path===`/api/digital-production/sources/${source.sourceId}/confirm`)).toEqual([]);
    await d.page.getByLabel('TEST棉布负责单价',{exact:true}).fill('22');
    await d.page.locator('.quotation-row-input').filter({has:d.page.getByLabel('TEST棉布负责单价',{exact:true})}).getByRole('button',{name:'保存本行负责字段',exact:true}).click();
    await expect.poll(async()=>(await quotes.read(designer,resource)).status).toBe('draft');
    expect((await quotes.read(designer,resource,undefined,frozen)).document!.rows.find(r=>r.rowId===materialId)!.unitPrice).toBe('20');

    const oldSheet=d.page.locator('.quotation-editor');
    await expect.poll(()=>oldSheet.innerText()).toContain('协作草稿');
    const historyURL=h.base+'/api/digital-production/sources/'+source.sourceId+'/quotation?version='+frozen;
    let releaseHistory!:()=>void;
    const holdHistory=new Promise<void>(resolve=>{releaseHistory=resolve;});
    let historyRequests=0;
    await d.page.route(historyURL,async route=>{
     historyRequests++;
     await holdHistory;
     await route.continue();
    });
    try{
     await d.page.getByLabel('查看报价版本',{exact:true}).selectOption(String(frozen));
     await d.page.getByRole('status').filter({hasText:'请稍等'}).waitFor();
     expect(historyRequests).toBe(1);
     expect(await oldSheet.innerText()).toContain('协作草稿');
     expect(await d.page.getByRole('button',{name:'保存报价',exact:true}).isDisabled()).toBe(true);
     releaseHistory();
     await expect.poll(()=>oldSheet.innerText()).toContain('客户已确认');
     await d.page.getByRole('status').filter({hasText:'请稍等'}).waitFor({state:'hidden'});
     expect((await quotes.read(designer,resource)).status).toBe('draft');
    }finally{
     releaseHistory();
     await d.page.unroute(historyURL);
    }
    await d.page.getByLabel('查看报价版本',{exact:true}).selectOption('');
    await expect.poll(()=>oldSheet.innerText()).toContain('协作草稿');
    await d.page.screenshot({path:join(h.evidence,'designer-1165.png'),fullPage:true});
    await w.page.screenshot({path:join(h.evidence,'worker-1165.png'),fullPage:true});
    // Same authenticated session after native role revocation, not a Lab role switch.
    const assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='ie_reviewer' AND revoked_at IS NULL",[ie.actorId])).rows[0];
    await h.f.access.assignRole(h.admin,{userId:ie.actorId,roleCode:'finance_read',reason:'TEST retain login after quote-role revocation'});
    await h.f.access.revokeRole(h.admin,assignment.assignment_id,'TEST PR03 live quotation revocation');
    const result=await i.page.request.get(h.base+'/api/digital-production/sources/'+source.sourceId+'/quotation');
    expect([403,404]).toContain(result.status());
   }finally{await w.context.close();await i.context.close();}
   expect(h.errors).toEqual([]);
  }finally{await d.page.screenshot({path:join(h.evidence,'last-page.png'),fullPage:true});await d.context.close();}
 });
 it('supplements a published material unit in the original row, recovers the original lost receipt and rechecks same-session authority',async()=>{
  const designer=h.f.people['sample-designer']!,forms=new DigitalDevelopmentService(h.db,true),quotes=new DigitalQuotationService(h.db,true);
  const source=await new DigitalProductionIdentityService(h.db,true).createSource(designer,{developmentType:'头版',designStyleNo:'TEST-UNIT-UI-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const doc=initialDevelopmentDocument(),materialId=randomUUID();doc.quantity=1;doc.materials=[{...doc.materials[0]!,materialId,category:'主布',label:'主布',name:'TEST单位棉布',supplier:'TEST',specification:'40支',width:'150',weight:'200',composition:'棉',color:'黑',requiredThisRound:true,available:true,pricingUnit:'',unitPrice:'20'}];doc.files=[{attachmentId:await h.f.image(designer),kind:'款图'}];
  const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document:DevelopmentDocumentSchema.parse(doc)},randomUUID());await forms.publish(designer,source.sourceId,saved.version,randomUUID());
  const before=await forms.read(designer,source.sourceId),resource={kind:'source' as const,id:source.sourceId},path='/ui/digital-quotation?kind=source&id='+source.sourceId;
  const d=await h.open(designer.actorId,1165,{},path);let lost=true;const writes:Array<{key:string|undefined;body:unknown}>=[];
  await d.context.route('**/api/digital-production/sources/'+source.sourceId+'/quotation/rows/'+materialId,async route=>{
   const request=route.request();if(request.method()!=='POST')return route.continue();writes.push({key:request.headers()['idempotency-key'],body:request.postDataJSON()});
   if(lost){lost=false;expect((await route.fetch()).status()).toBe(200);return route.abort('failed');}return route.continue();
  });
  try{
   await d.page.getByLabel('TEST单位棉布计价单位',{exact:true}).fill('米');
   const own=d.page.locator('.quotation-row-input').filter({has:d.page.getByLabel('TEST单位棉布计价单位',{exact:true})});await own.getByRole('button',{name:'保存本行负责字段',exact:true}).click();
   await d.page.getByRole('button',{name:'使用原内容核对报价提交',exact:true}).waitFor();const committed=await quotes.read(designer,resource);expect(committed.rows.find(row=>row.rowId===materialId)).toMatchObject({unit:'米',unitPrice:'20',consumption:''});
   await d.page.getByRole('button',{name:'使用原内容核对报价提交',exact:true}).click();await expect.poll(()=>d.page.getByRole('button',{name:'使用原内容核对报价提交',exact:true}).count()).toBe(0);
   expect(writes).toHaveLength(2);expect(writes[1]).toEqual(writes[0]);expect((await quotes.read(designer,resource)).version).toBe(committed.version);
   expect((await forms.read(designer,source.sourceId)).document).toEqual(before.document);expect((await forms.read(designer,source.sourceId)).version).toBe(before.version);
   await d.page.screenshot({path:join(h.evidence,'material-unit-1165.png'),fullPage:true});await d.page.setViewportSize({width:390,height:844});await d.page.screenshot({path:join(h.evidence,'material-unit-390.png'),fullPage:true});
   const assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='sample_designer' AND revoked_at IS NULL",[designer.actorId])).rows[0];
   await h.f.access.assignRole(h.admin,{userId:designer.actorId,roleCode:'finance_read',reason:'TEST keep same authenticated login after designer revocation'});await h.f.access.revokeRole(h.admin,assignment.assignment_id,'TEST deny commercial unit write after revocation');
   const denied=await d.page.request.post(h.base+'/api/digital-production/sources/'+source.sourceId+'/quotation/rows/'+materialId,{headers:{'idempotency-key':writes[0]!.key!},data:writes[0]!.body});expect([403,404]).toContain(denied.status());
   expect((await quotes.read(h.f.root,resource)).version).toBe(committed.version);
  }finally{await d.context.close();}
 });

});
