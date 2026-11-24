import type {CraftStepChoice} from '@dx-rework/contracts/digital-craft';
import type {JourneyNode} from '@dx-rework/contracts/digital-production-journey';
import {OrderTimeSettingsService} from '../../apps/api/src/production-platform/order-time-settings-service.js';
import {prepareTimeFrameworkConfiguration} from '@dx-rework/contracts/order-time-settings';
import {r5OneHourConfiguration} from '../helpers/r5-order-time-fixture.js';
import {arrangementInput} from '../helpers/development-arrangement-fixture.js';
import {DevelopmentExecutionService} from '../../apps/api/src/production-platform/development-execution-service.js';
import {exerciseDevelopmentSlaNative} from '../helpers/development-sla-native-fixture.js';
import {TodoProjectionService} from '../../apps/api/src/todos/projection-service.js';
import {TodoService} from '../../apps/api/src/todos/service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {productionReadinessFixture} from '../helpers/production-readiness-fixture.js';
import {DigitalOrderCreateSchema} from '@dx-rework/contracts/digital-production';
import {businessNow} from '../../apps/api/src/acceptance-clock/business-time.js';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {configureTimelineAdoption} from '../../apps/api/src/production-platform/fixed-timeline-mode.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {beforeAll,afterAll,describe,it,expect} from 'vitest';
import type {Page} from 'playwright-core';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import {SpecialCraftLibraryService} from '../../apps/api/src/production-platform/special-craft-library.js';
import {bindFixtureCraftApprover} from '../helpers/secondary-craft-approval-fixture.js';
const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;

async function saveDraftAndReadReceipt(page:Page,sourceId:string,expectedVersion:number){
 const path=`/api/digital-production/sources/${sourceId}/development`;
 const [receipt]=await Promise.all([
  page.waitForResponse(response=>response.request().method()==='PUT'&&new URL(response.url()).pathname===path),
  page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click(),
 ]);
 const result=await receipt.json();
 expect(receipt.status(),result.error?.code).toBe(200);
 expect(receipt.request().postDataJSON()).toMatchObject({expectedVersion});
 expect(result).toMatchObject({sourceId,version:expectedVersion+1});
}

async function quotationWriteReceipt(page:Page,path:string,method:'PUT'|'POST',click:()=>Promise<void>){
 const [receipt]=await Promise.all([
  page.waitForResponse(response=>response.request().method()===method&&new URL(response.url()).pathname===path),
  click(),
 ]);
 const result=await receipt.json();
 expect(receipt.status(),result.error?.code).toBe(200);
 return {result,body:receipt.request().postDataJSON()};
}

async function submitCraftFromOriginalQuote(page:Page,name:string,amount:string,path:string){
 await page.getByRole('link',{name:`${name}报价与选厂`,exact:true}).click();
 await page.getByRole('textbox',{name:'工艺单价',exact:true}).fill(amount);
 return quotationWriteReceipt(page,path,'POST',()=>page.getByRole('button',{name:'提交伍云峰审批',exact:true}).click());
}

(url?describe:describe.skip)('special craft library original App settings',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'special-craft-ui-'+randomUUID()),{fullApp:true,orderTimeModel:true});});
 afterAll(async()=>{if(h){configureTimelineAdoption(h.db,'legacy');await h.writeEvidence();await h.dispose();}});
 it('saves independent stage settings and retains edits when switching tabs at1165px',async()=>{
  const {page,context}=await h.open(undefined,1165);try{
   await page.getByRole('tab',{name:'特殊工艺库',exact:true}).click();
   const panel=page.getByRole('tabpanel',{name:'特殊工艺库',exact:true});
   await panel.getByRole('button',{name:'新增工艺',exact:true}).click();
   await panel.getByLabel('工艺名称',{exact:true}).fill('TEST 激光及烫钻独立时效');
   await panel.getByLabel('开发样板允许用时（小时）',{exact:true}).fill('2');
   await panel.getByLabel('开发样板哪些天计时',{exact:true}).selectOption('continuous');
   await panel.getByLabel('大货允许用时（小时）',{exact:true}).fill('8');
   await panel.getByLabel('大货哪些天计时',{exact:true}).selectOption('beijing_sunday_excluded');
   await panel.getByRole('group',{name:'大货',exact:true}).getByLabel('提醒',{exact:true}).uncheck();
   await page.getByRole('tab',{name:'时效设置',exact:true}).click();
   await page.getByRole('tab',{name:'特殊工艺库',exact:true}).click();
   expect(await panel.getByLabel('大货允许用时（小时）',{exact:true}).inputValue()).toBe('8');
   await page.screenshot({path:join(h.evidence,'special-craft-edit-1165.png'),fullPage:true});
   await panel.getByRole('button',{name:'保存',exact:true}).click();
   await panel.getByText('已保存，已生效订单保持原设置。',{exact:true}).waitFor();
   const saved=await new SpecialCraftLibraryService(h.db).list(h.f.root);
   expect(saved.items).toHaveLength(1);expect(saved.items[0]!.definition).toMatchObject({development:{minutes:120,calendar:'continuous'},bulk:{minutes:480,calendar:'beijing_sunday_excluded',reminder:{enabled:false}}});
   await panel.getByRole('button',{name:'调整',exact:true}).click();await page.setViewportSize({width:650,height:900});
   expect(await panel.getByLabel('开发样板允许用时（小时）',{exact:true}).inputValue()).toBe('2');
   await page.screenshot({path:join(h.evidence,'special-craft-edit-650.png'),fullPage:true});
   // Existing mobile navigation expands the supply-chain group at650px.
   // Preserve its screenshot as a known shell limitation; do not force-click through it.
   await page.setViewportSize({width:1165,height:900});
   await panel.getByRole('button',{name:'取消',exact:true}).click();expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });
 it('selects several special crafts with printing and retains their explicit order in the original source editor',async()=>{
  configureTimelineAdoption(h.db,'fixed_v2');
  const library=new SpecialCraftLibraryService(h.db),standard={minutes:120,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
  const items=[];
  for(const name of ['TEST UI激光','TEST UI烫钻'])items.push(await library.save(h.f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:standard,bulk:standard}},randomUUID()));
  const designer=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true);
  const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-SPECIAL-UI-'+randomUUID(),temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  await forms.save(designer,source.sourceId,{expectedVersion:0,document:initialDevelopmentDocument()},randomUUID());
  const {page,context}=await h.open(designer.actorId,1165,{},'/ui/digital-production?development='+source.sourceId);
  try{
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).waitFor();
   const selector=page.getByLabel('工艺特殊工艺',{exact:true});
   await selector.selectOption(items[0]!.id);await selector.selectOption(items[1]!.id);
   const group=page.getByRole('group',{name:'工艺',exact:true});await group.getByLabel('印花',{exact:true}).check();
   await page.getByRole('button',{name:'TEST UI烫钻前移',exact:true}).click();
   await saveDraftAndReadReceipt(page,source.sourceId,1);
   const reopened=await forms.read(designer,source.sourceId);
   expect(reopened.version).toBe(2);
   const saved=reopened.document!.craftSteps!;
   expect(saved.map(step=>step.specialCraft?.definition.name??step.craftKind)).toEqual(['TEST UI烫钻','TEST UI激光','printing']);
   expect(saved.map(step=>step.sequence)).toEqual([1,2,3]);
   await page.screenshot({path:join(h.evidence,'special-craft-source-order-1165.png'),fullPage:true});
   expect(h.errors).toEqual([]);
  }finally{await context.close();}
 });

 it('keeps the same printing session authorized after another artisan starts a special craft',async()=>{
  configureTimelineAdoption(h.db,'fixed_v2');
  const f=h.f,worker=f.people['pattern-room-worker']!,other=await h.dedicated('pattern_room_worker');
  const approver=await bindFixtureCraftApprover(f),quotes=new DigitalQuotationService(f.db,true);
  const standard={minutes:60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
  const craft=await new SpecialCraftLibraryService(h.db).save(f.root,{id:null,expectedVersion:0,definition:{name:'TEST session special',enabled:true,development:standard,bulk:standard}},randomUUID());
  let session:Awaited<ReturnType<typeof h.open>>|undefined,foreign:Awaited<ReturnType<typeof h.open>>|undefined,dispatches=0,rowId='';
  try{
   await exerciseDevelopmentSlaNative(h.db,new TodoProjectionService(new TodoService(h.db)),f.root,worker.actorId,undefined,[['特殊工艺','免洗']],{automaticQuotation:true,fixedCraftSteps:[{craftKind:'printing',sequence:1},{craftKind:'special',sequence:2,specialCraft:craft}],onRouteComplete:async(sourceId,kind)=>{
    if(kind!=='development_craft_dispatch')return;dispatches++;
    const path='/ui/digital-quotation?kind=source&id='+sourceId,api=h.base+'/api/digital-production/sources/'+sourceId+'/quotation';
    const resource={kind:'source' as const,id:sourceId};
    if(dispatches===1){
     session=await h.open(worker.actorId,1165,{},path);
     const q=await (await session.page.request.get(api)).json();
     rowId=q.rows.find((r:{name:string})=>r.name==='印花').rowId;
     const receipt=await submitCraftFromOriginalQuote(session.page,'印花','5',new URL(api+'/secondary-craft/'+rowId+'/submit').pathname);
     expect(receipt.result).toMatchObject({state:'submitted',receipt:{action:'submit',appliedVersion:1}});
     await quotes.writeSecondaryCraft(approver,resource,rowId,'decision',{expectedVersion:1,decision:'approved'},randomUUID());
     await expect.poll(async()=>{const current=await (await session!.page.request.get(api)).json();return current.rows.find((r:{rowId:string})=>r.rowId===rowId).unitPrice;}).toBe('5');
    }else{
     const pending=(await h.db.query("SELECT t.task_id FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) WHERE a.source_id=$1 AND a.task_kind='development_printing' AND t.state='ready'",[sourceId])).rows[0];
     const execution=new DevelopmentExecutionService(h.db,true),input=await arrangementInput(h.db,execution,f.root,sourceId,worker.actorId);
     input.entries=input.entries.map(entry=>entry.expectedTask?.taskId===pending.task_id?{...entry,assigneeId:other.id,reason:'TEST separate special artisan'}:entry);
     await execution.arrange(f.root,sourceId,input,randomUUID());
     const q=await (await session!.page.request.get(api)).json();
     expect(q.rows.find((r:{rowId:string})=>r.rowId===rowId)).toMatchObject({unitPrice:'5',canEditPrice:false,secondaryCraftEntry:true});
     const priceInput={expectedVersion:1,mode:'in_house',supplierId:null,unitPrice:'6',unit:'件',applicableQuantity:null,note:'',attachmentIds:[]};
     const write=await session!.page.request.post(api+'/secondary-craft/'+rowId+'/submit',{headers:{'idempotency-key':randomUUID()},data:priceInput});
     expect(write.status(),await write.text()).toBe(200);
     foreign=await h.open(other.id,1165,{},path);
     await foreign.page.getByRole('link',{name:'TEST session special报价与选厂',exact:true}).waitFor();
     expect(await foreign.page.getByRole('link',{name:'印花报价与选厂',exact:true}).count()).toBe(0);
     const denied=await foreign.page.request.post(api+'/secondary-craft/'+rowId+'/submit',{headers:{'idempotency-key':randomUUID()},data:{...priceInput,expectedVersion:2,unitPrice:'99'}});
     expect(denied.status()).toBe(403);
    }
   }});expect(dispatches).toBe(2);
  }finally{await session?.context.close();await foreign?.context.close();}
 });

 it('keeps ordered frozen craft labels and each selected task cutoff in the original cockpit',async()=>{
  configureTimelineAdoption(h.db,'fixed_v2');
  const f=h.f,library=new SpecialCraftLibraryService(h.db),standard={minutes:60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}},steps:CraftStepChoice[]=[{craftKind:'embroidery',sequence:1}];
  for(const [index,name] of ['TEST 座舱激光','TEST 座舱烫钻'].entries()){const saved=await library.save(f.root,{id:null,expectedVersion:0,definition:{name,enabled:true,development:{...standard,minutes:60*(index+1)},bulk:standard}},randomUUID());steps.push({craftKind:'special',sequence:index+2,specialCraft:saved});}
  const created=await exerciseDevelopmentSlaNative(h.db,new TodoProjectionService(new TodoService(h.db)),f.root,f.people['pattern-room-worker']!.actorId,undefined,[['特殊工艺','免洗']],{fixedCraftSteps:steps}),sid=created[0]!.sourceId;
  const original=(await h.db.query(`SELECT t.task_id,p.step_id,p.route_position,r.entered_at,r.due_at FROM digital_production_tasks t JOIN digital_production_task_access a USING(task_id) JOIN digital_timeline_task_positions p USING(task_id) JOIN LATERAL(SELECT entered_at,due_at FROM digital_production_deadline_revisions WHERE task_id=t.task_id ORDER BY revision_id DESC LIMIT 1)r ON true WHERE a.source_id=$1 AND p.phase='dispatch' ORDER BY p.route_position`,[sid])).rows;
  expect(original).toHaveLength(3);expect(new Set(original.map(r=>r.entered_at.toISOString())).size).toBe(3);
  const tab=await h.open(f.root.actorId,1165,{},'/ui/digital-cockpit?selected='+sid+'&expanded=development&focus='+original[0]!.task_id);
  try{
   for(const [index,native] of original.entries()){
    if(index)await tab.page.goto(h.base+'/ui/digital-cockpit?selected='+sid+'&expanded=development&focus='+native.task_id);
    await tab.page.locator('[data-view="order"][aria-busy="false"]').waitFor();
    const response=await tab.page.request.get(h.base+'/api/digital-production/journeys/'+sid+'?view=cockpit');expect(response.status()).toBe(200);
    const dto=await response.json(),node=dto.stages.flatMap((stage:{nodes:JourneyNode[]})=>stage.nodes).find((n:JourneyNode)=>n.instanceId===native.task_id);
    expect(node).toMatchObject({label:index===0?'发绣花（工艺1）':`发${steps[index]!.specialCraft!.definition.name}（工艺${index+1}）`,timing:{actualStart:native.entered_at.toISOString(),target:{at:native.due_at.toISOString()}}});
    const current=tab.page.locator('.journey-current-panel');await current.getByRole('heading',{level:2}).waitFor();expect(await current.getByRole('heading',{level:2}).innerText()).toContain('当前节点：'+node.label);
    expect(await tab.page.locator('.cockpit-current-summary').innerText()).not.toContain('自身截止');
    const currentDates=current.locator('.cockpit-node-current');
    const cutoff=new Date(native.due_at);
    expect(await currentDates.evaluate((panel, value)=>panel.innerText.includes(value.label)||[...panel.querySelectorAll('time')].some(time=>time.dateTime===value.at),
     {at:cutoff.toISOString(),label:cutoff.toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})})).toBe(true);
    const link=current.getByRole('link',{name:'查看节点记录',exact:true});expect(await link.count()).toBe(1);expect(await link.getAttribute('href')).toContain(native.task_id);
   }
   await tab.page.screenshot({path:join(h.evidence,'craft-instance-cockpit-1165.png'),fullPage:true});expect(h.errors).toEqual([]);
  }finally{await tab.context.close();}
 });

 it('assigns a bulk-only craft and fills only that price through the original authenticated quotation page',async()=>{
  configureTimelineAdoption(h.db,'fixed_v2');
  const f=h.f,worker=f.people['pattern-room-worker']!,quotes=new DigitalQuotationService(h.db,true);
  const created=await exerciseDevelopmentSlaNative(h.db,new TodoProjectionService(new TodoService(h.db)),f.root,worker.actorId,undefined,[['无','免洗']],{automaticQuotation:true});
  const resource={kind:'source' as const,id:created[0]!.sourceId};
  let q=await quotes.read(f.root,resource);
  q=await quotes.save(f.root,resource,{expectedVersion:q.version,document:q.document!,assignments:q.assignments.map(a=>q.rows.find(row=>row.rowId===a.rowId)?.name==='IE加工单价'?{...a,priceAssigneeId:f.people.ie!.actorId}:a)},randomUUID());
  for(const row of q.rows)q=await quotes.fillRow(f.root,resource,row.rowId,{expectedVersion:q.version,...(row.section!=='外发工序'?{consumption:'1.5'}:{}),unitPrice:row.section==='外发工序'?'10':'20'},randomUUID());
  await quotes.confirm(f.root,resource,{expectedVersion:q.version,customerCode:'PD',customerConfirmedTotal:'50',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST bulk-only UI',confirmedAt:businessNow().toISOString()},randomUUID());
  const source=(await h.db.query('SELECT design_style_no FROM digital_production_sources WHERE source_id=$1',[resource.id])).rows[0];
  const order=await new DigitalProductionIdentityService(h.db,true).createOrder(f.root,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:source.design_style_no,orderDate:'2026-11-13',primaryMerchandiserId:f.people.merchandiser!.actorId,lines:[{color:'黑',customerWarehouseArrivalDate:'2027-03-01',sizes:[{size:'M',quantity:100}]}]}),randomUUID(),resource.id);
  const standard={minutes:120,calendar:'continuous' as const,reminder:{enabled:true,percent:70}};
  const craft=await new SpecialCraftLibraryService(h.db).save(f.root,{id:null,expectedVersion:0,definition:{name:'TEST 仅大货压花',enabled:true,development:standard,bulk:standard}},randomUUID());
  const instructions=new ProductionInstructionService(h.db,true),seed=await instructions.read(f.root,order.productionOrderId);
  const saved=await instructions.save(f.root,order.productionOrderId,{expectedVersion:0,orderVersion:seed.currentOrderVersion,sourceRound:1,document:{...seed.document,secondaryCraft:'特殊工艺',craftSteps:[{craftKind:'special',sequence:1,specialCraft:craft}],styleName:'TEST bulk only UI',category:'上衣',preshrink:'不需预缩',date:'2026-11-13'}},randomUUID());
  const ready=await productionReadinessFixture(h.db,f.root,order.productionOrderId,worker.actorId,f.people.warehouse!);
  await instructions.publish(f.root,order.productionOrderId,{expectedVersion:saved.version,orderVersion:saved.currentOrderVersion,expectedReadinessRevision:ready.revision},randomUUID());
  const bulk={kind:'order' as const,id:order.productionOrderId},path='/ui/digital-quotation?kind=order&id='+order.productionOrderId;
  const api=`/api/digital-production/orders/${order.productionOrderId}/quotation`;
  const admin=await h.open(f.root.actorId,1165,{},path);
  try{
   await admin.page.getByLabel('TEST 仅大货压花价格负责人',{exact:true}).selectOption('pattern_room_worker:'+worker.actorId);
   const assigned=await quotationWriteReceipt(admin.page,api,'PUT',()=>admin.page.getByRole('button',{name:'保存报价',exact:true}).click());
   expect(assigned.result.commandReceipt).toMatchObject({action:'save',appliedVersion:assigned.body.expectedVersion+1});
   const stored=await quotes.read(f.root,bulk),row=stored.rows.find(value=>value.name==='TEST 仅大货压花');
   expect(row?.assignment.priceAssigneeId).toBe(worker.actorId);
   expect(row?.craftBasis).toMatchObject({stage:'bulk',libraryId:craft.id,libraryVersion:craft.version,stepId:null});
   const rowId=row!.rowId;
   const own=await h.open(worker.actorId,1165,{},path);
   try{
    expect(await own.page.getByLabel('IE加工单价负责单价',{exact:true}).count()).toBe(0);
    const priced=await submitCraftFromOriginalQuote(own.page,'TEST 仅大货压花','8',`${api}/secondary-craft/${rowId}/submit`);
    expect(priced.body).toMatchObject({expectedVersion:0,mode:'in_house',unitPrice:'8',unit:'件'});
    expect(priced.result).toMatchObject({target:{rowId,stage:'bulk',scopeId:bulk.id,sourceVersion:saved.version},state:'submitted',receipt:{action:'submit',appliedVersion:1}});
    await quotes.writeSecondaryCraft(await bindFixtureCraftApprover(f),bulk,rowId,'decision',{expectedVersion:1,decision:'approved'},randomUUID());
    expect((await quotes.read(f.root,bulk)).rows.find(value=>value.rowId===rowId)?.unitPrice).toBe('8');
    await own.page.screenshot({path:join(h.evidence,'special-craft-bulk-price-1165.png'),fullPage:true});
    const assignment=(await h.db.query("SELECT assignment_id FROM user_role_assignments WHERE user_id=$1 AND role_code='pattern_room_worker' AND revoked_at IS NULL",[worker.actorId])).rows[0];
    await f.access.assignRole(h.admin,{userId:worker.actorId,roleCode:'finance_read',reason:'TEST keep same session after craft role withdrawal'});
    await f.access.revokeRole(h.admin,assignment.assignment_id,'TEST bulk special craft current role withdrawal');
    const response=await own.page.request.get(h.base+api);
    expect([403,404]).toContain(response.status());
    expect([403,404]).toContain((await own.page.request.get(h.base+`${api}/secondary-craft/${rowId}`)).status());

   }finally{await own.context.close();}
   expect(h.errors).toEqual([]);
  }finally{await admin.context.close();}
 });

 it('keeps new managed drafts on the independent craft editor before plan adoption, after save and reopen',async()=>{
  const designer=h.f.people['sample-designer']!,identity=new DigitalProductionIdentityService(h.db,true),forms=new DigitalDevelopmentService(h.db,true);
  configureTimelineAdoption(h.db,'legacy');
  const old=await identity.createSource(designer,{developmentType:'头版',designStyleNo:'TEST-OLD-DRAFT-'+randomUUID(),temporaryStyleNo:null,customerCode:null},randomUUID());
  await forms.save(designer,old.sourceId,{expectedVersion:0,document:initialDevelopmentDocument()},randomUUID());
  const settings=new OrderTimeSettingsService(h.db),current=await settings.read(h.f.root);
  await settings.save(h.f.root,{expectedVersion:current.version,values:prepareTimeFrameworkConfiguration(r5OneHourConfiguration())},randomUUID());
  expect((await forms.read(designer,old.sourceId)).timelineSchemaVersion).toBeUndefined();
  const standard={minutes:60,calendar:'continuous' as const,reminder:{enabled:false,percent:70}};
  const craft=await new SpecialCraftLibraryService(h.db).save(h.f.root,{id:null,expectedVersion:0,definition:{name:'TEST managed draft special',enabled:true,development:standard,bulk:standard}},randomUUID());
  const style='TEST-MANAGED-DRAFT-'+randomUUID(),tab=await h.open(designer.actorId,1165,{},'/ui/digital-production?workspace=designer&section=create');
  try{
   const page=tab.page;
   await page.getByRole('button',{name:'新建开发订单',exact:true}).click();
   await page.getByRole('dialog',{name:'请选择创建类型'}).getByRole('button',{name:'纯开发',exact:true}).click();
   await page.getByLabel('设计款号',{exact:true}).fill(style);
   await page.getByRole('group',{name:'工艺',exact:true}).getByLabel('印花',{exact:true}).check();
   await page.getByRole('combobox',{name:'工艺特殊工艺',exact:true}).press('Enter');
   await page.getByRole('option',{name:craft.definition.name,exact:true}).click();
   await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();
   let id='';
   await expect.poll(async()=>{id=(await h.db.query('SELECT source_id FROM digital_production_sources WHERE design_style_no=$1',[style])).rows[0]?.source_id??'';return id?(await forms.read(designer,id)).version:0;}).toBe(1);
   const first=await forms.read(designer,id);
   expect(first.timelineSchemaVersion).toBe(2);expect(first.independentRevisions).toBe(false);
   expect(first.document!.craft).toBe('特殊工艺');
   expect(first.document!.craftSteps!.map(s=>s.craftKind)).toEqual(['printing','special']);
   expect((await h.db.query('SELECT 1 FROM digital_development_sla_plans WHERE source_id=$1',[id])).rowCount).toBe(0);
   await expect.poll(()=>page.getByRole('combobox',{name:'工艺特殊工艺',exact:true}).count()).toBe(1);
   expect(await page.getByRole('group',{name:'工艺',exact:true}).getByLabel('印花',{exact:true}).isChecked()).toBe(true);
   await page.goto(h.base+'/ui/digital-production?development='+id);
   await page.getByRole('combobox',{name:'工艺特殊工艺',exact:true}).waitFor();
   await page.getByRole('heading',{name:'工艺要求',exact:true}).waitFor();
   expect(await page.getByRole('navigation',{name:'单据章节',exact:true}).count()).toBe(0);
   expect(await page.getByLabel('设计款号',{exact:true}).inputValue()).toBe(style);
   expect(await page.getByRole('group',{name:'工艺',exact:true}).getByLabel('印花',{exact:true}).isChecked()).toBe(true);
   await page.getByRole('button',{name:craft.definition.name+'前移',exact:true}).click();
   await saveDraftAndReadReceipt(page,id,1);
   const reopened=await forms.read(designer,id);
   expect(reopened.version).toBe(2);
   expect(reopened.document!.craftSteps!.map(s=>s.craftKind)).toEqual(['special','printing']);
   expect(reopened.document!.craftSteps![0]!.specialCraft).toEqual(craft);
   // Copying specifications creates a new source; it does not inherit an old editor/version.
   const copy=await identity.createSource(designer,{developmentType:'头版',designStyleNo:style+'-COPY',temporaryStyleNo:null,customerCode:null},randomUUID());
   const copied=await forms.save(designer,copy.sourceId,{expectedVersion:0,document:{...reopened.document!,orderDate:null}},randomUUID());
   expect(copied.timelineSchemaVersion).toBe(2);expect(copied.document!.craftSteps).toEqual(reopened.document!.craftSteps);
   const worker=h.f.people['pattern-room-worker']!;
   await expect(forms.read(worker,id)).rejects.toMatchObject({statusCode:404});
   await expect(forms.save(worker,id,{expectedVersion:2,document:reopened.document!},randomUUID())).rejects.toMatchObject({statusCode:404});
   const afterDeniedSave=await forms.read(designer,id);
   expect(afterDeniedSave.version).toBe(reopened.version);
   expect(afterDeniedSave.document?.craftSteps).toEqual(reopened.document!.craftSteps);
   expect((await forms.read(designer,old.sourceId)).timelineSchemaVersion).toBeUndefined();
   await page.screenshot({path:join(h.evidence,'managed-draft-reopened.png'),fullPage:true});
   expect(h.errors).toEqual([]);
  }finally{await tab.context.close();}
 });

});
