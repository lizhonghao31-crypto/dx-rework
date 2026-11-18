import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
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
   await d.page.goto(h.base+path);
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
    await d.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).click();
    await expect.poll(async()=>(await quotes.read(designer,resource)).confirmedVersion).not.toBeNull();
    const frozen=(await quotes.read(designer,resource)).confirmedVersion!;
    await d.page.getByLabel('TEST棉布负责单价',{exact:true}).fill('22');
    await d.page.locator('.quotation-row-input').filter({has:d.page.getByLabel('TEST棉布负责单价',{exact:true})}).getByRole('button',{name:'保存本行负责字段',exact:true}).click();
    await expect.poll(async()=>(await quotes.read(designer,resource)).status).toBe('draft');
    expect((await quotes.read(designer,resource,undefined,frozen)).document!.rows.find(r=>r.rowId===materialId)!.unitPrice).toBe('20');
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
