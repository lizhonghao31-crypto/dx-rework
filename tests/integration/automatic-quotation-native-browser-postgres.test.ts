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
import {DigitalBudgetService} from '../../apps/api/src/production-platform/budget-service.js';
import {ProductionInstructionService} from '../../apps/api/src/production-platform/production-instruction-service.js';
import {ProductionReadinessService} from '../../apps/api/src/production-platform/production-readiness-service.js';
import {testExecutionConfig} from '../../scripts/test-execution-config.mjs';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
(url?describe:describe.skip)('PR03 automatic quotation through original authenticated App and real PG',()=>{
 let h:Awaited<ReturnType<typeof supplychainSettingsBrowser>>;
 beforeAll(async()=>{h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'automatic-quotation-ui-'+randomUUID()),{fullApp:true,orderTimeFlow:true});});
 afterAll(async()=>{await h?.writeEvidence();await h?.dispose();});
 it('keeps R4 commercial writes unrouted while real staged row reviews and prices use the exact stored version',async()=>{
  const {f,db}=h,designer=f.people['sample-designer']!,worker=f.people['pattern-room-worker']!,merch=f.people.merchandiser!;
  const identity=new DigitalProductionIdentityService(db,true),quotes=new DigitalQuotationService(db,true);
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',
   designStyleNo:'TEST-R4-STAGED-'+randomUUID(),orderDate:beijingCalendarDate(new Date()),primaryMerchandiserId:merch.actorId,
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}]}),randomUUID());
  const id=order.productionOrderId,resource={kind:'order' as const,id},rowId=randomUUID();
  const document:BudgetDocument={fabricType:'针织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'2',cm:'4',
   rows:[{rowId,section:'主料',category:'',name:'TEST 面料',specification:'40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:'30'}],
   salePrice:'',outsourcingScope:'车缝',outsourcingUnitPrice:'5',imageAttachmentIds:[]};
  const draft=await quotes.save(designer,resource,{expectedVersion:0,document,
   assignments:[{rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},randomUUID());
  const first=await quotes.fillRow(worker,resource,rowId,{expectedVersion:draft.version,consumption:'1'},randomUUID());
  const quoteId=first.quoteId!;
  const tab=await h.open(designer.actorId,1165,{},'/ui/digital-quotation?kind=order&id='+id);
  const follow=await h.open(merch.actorId,1165,{},'/ui/digital-production?budget='+id);
  const base=h.base+'/api/digital-production/orders/'+id;
  const read=async()=>{const response=await tab.page.request.get(base+'/quotation/workbench-pricing');expect(response.status()).toBe(200);return response.json();};
  const businessState=async()=>(await db.query(`SELECT
    (SELECT count(*)::int FROM digital_quotation_versions WHERE quote_id=$1) AS confirmations,
    (SELECT count(*)::int FROM digital_budget_documents WHERE production_order_id=$2) AS budgets,
    (SELECT count(*)::int FROM digital_budget_quote_conversions WHERE production_order_id=$2) AS adoptions`,[quoteId,id])).rows[0];
  try{
   expect(await read()).toMatchObject({resource,quoteId,version:first.version,unitCost:'30',confirmation:'awaiting_joint_release',saved:null});
   expect((await follow.page.request.get(base+'/quotation/workbench-pricing')).status()).toBe(404);
   const preview={field:'customerUnitPrice',value:'49.123456'} as const;
   expect((await tab.page.request.put(base+'/quotation/workbench-pricing',{data:{expectedVersion:first.version,input:preview}})).status()).toBe(404);
   expect((await tab.page.request.post(base+'/quotation/line-reviews',{data:{action:'return'}})).status()).toBe(404);
   const newConfirmation={customerCode:'PD',expectedVersion:first.version,customerConfirmedTotal:preview.value,amountScope:'per_piece',
    quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',
    sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST 本次新口径尚未联验',
    confirmedAt:new Date(Date.now()-1000).toISOString(),pricing:preview};
   expect((await tab.page.request.post(base+'/quotation/confirm',{headers:{'idempotency-key':randomUUID()},data:newConfirmation})).status()).toBe(400);
   await follow.page.getByRole('region',{name:'客户报价对照'}).getByText('等待客户确认报价与正式下单，不能发布预算',{exact:false}).waitFor();
   expect(await follow.page.getByRole('button',{name:'保存预算',exact:true}).count()).toBe(0);
   expect(await businessState()).toEqual({confirmations:0,budgets:0,adoptions:0});

   const pricingKey=randomUUID(),pricing={expectedVersion:first.version,input:preview};
   await quotes.saveWorkbenchPricingDraft(designer,resource,pricing,pricingKey);
   await quotes.saveWorkbenchPricingDraft(designer,resource,pricing,pricingKey);
   expect((await db.query('SELECT quote_version,pricing FROM digital_quotation_pricing_drafts WHERE quote_id=$1',[quoteId])).rows).toEqual([
    {quote_version:first.version,pricing:{input:preview,cost:'30',status:'calculated',customerUnitPrice:preview.value,multiplierPercent:'163.7449',
     exactMultiplierPercent:{numerator:'4912345600000000',denominator:'30000000000000'}}},
   ]);
   await expect(quotes.saveWorkbenchPricingDraft(merch,resource,pricing,randomUUID())).rejects.toMatchObject({statusCode:403});
   const reason='TEST 复核单件用量',returned={action:'return',rowId,field:'consumption',expectedRound:1,
    expectedFieldVersion:first.version,reason} as const,returnKey=randomUUID();
   await quotes.reviewWorkbenchLine(designer,resource,returned,returnKey);
   await quotes.reviewWorkbenchLine(designer,resource,returned,returnKey);
   await expect(quotes.reviewWorkbenchLine(designer,resource,returned,randomUUID())).rejects.toMatchObject({statusCode:409});
   await quotes.reviewWorkbenchLine(designer,resource,{...returned,field:'unitPrice',expectedFieldVersion:draft.version,reason:'TEST 复核材料单价'},randomUUID());
   const open=await read();
   expect(open).toMatchObject({status:'awaiting_correction',counts:{returned:2,resubmitted:0},saved:{input:preview,version:first.version}});
   const review=open.reviews.find((item:{field:string})=>item.field==='consumption');
   expect(review).toMatchObject({rowId,field:'consumption',reason,status:'returned'});
   const changed=await quotes.fillRow(worker,resource,rowId,{expectedVersion:first.version,consumption:'2'},randomUUID());
   expect((await read()).counts.returned).toBe(2);
   await expect(quotes.saveWorkbenchPricingDraft(designer,resource,pricing,randomUUID())).rejects.toMatchObject({statusCode:409});
   const resubmit={action:'resubmit',reviewId:review.reviewId,expectedFieldVersion:changed.version} as const;
   await expect(quotes.reviewWorkbenchLine(designer,resource,resubmit,randomUUID())).rejects.toMatchObject({statusCode:403});
   await quotes.reviewWorkbenchLine(worker,resource,resubmit,randomUUID());
   expect(await read()).toMatchObject({unitCost:'60',status:'awaiting_correction',counts:{returned:1,resubmitted:1}});
   await quotes.reviewWorkbenchLine(designer,resource,{...resubmit,action:'resolve'},randomUUID());
   expect(await read()).toMatchObject({status:'awaiting_correction',counts:{returned:1,resubmitted:0},reviews:[{field:'unitPrice'}]});
   const events=await db.query('SELECT field,recipient_id,resubmit_actor,resolve_actor FROM digital_quotation_line_reviews WHERE quote_id=$1 ORDER BY field',[quoteId]);
   expect(events.rows).toEqual([{field:'consumption',recipient_id:worker.actorId,resubmit_actor:worker.actorId,resolve_actor:designer.actorId},
    {field:'unitPrice',recipient_id:designer.actorId,resubmit_actor:null,resolve_actor:null}]);
   expect(await businessState()).toEqual({confirmations:0,budgets:0,adoptions:0});
  }finally{await follow.close();await tab.close();}
 });
 it('distinguishes manual IE processing from a craft approval and an unfinished quote',async()=>{
  const {f,db}=h,designer=f.people['sample-designer']!,worker=f.people['pattern-room-worker']!,ie=f.people.ie!;
  const identity=new DigitalProductionIdentityService(db,true),quotes=new DigitalQuotationService(db,true);
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',
   designStyleNo:'TEST-R4-IE-AND-CRAFT-'+randomUUID(),orderDate:beijingCalendarDate(new Date()),
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}]}),randomUUID());
  const resource={kind:'order' as const,id:order.productionOrderId};
  const ieRow={rowId:randomUUID(),section:'外发工序' as const,category:'',name:'TEST IE 加工',specification:'',unit:'件',supplier:'',consumption:'',unitPrice:''};
  const document:BudgetDocument={fabricType:'针织',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'0',cm:'0',
   rows:[ieRow],salePrice:'',outsourcingScope:'车缝',outsourcingUnitPrice:'5',imageAttachmentIds:[]};
  const ieAssignment={rowId:ieRow.rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:ie.actorId,priceRole:'ie_reviewer' as const};
  const saved=await quotes.save(designer,resource,{expectedVersion:0,document,assignments:[ieAssignment]},randomUUID());
  expect(await quotes.workbenchPreview(designer,resource)).toMatchObject({status:'incomplete',counts:{incomplete:1,pendingCraftApproval:0},unitCost:null});
  const withUsage=await quotes.fillRow(worker,resource,ieRow.rowId,{expectedVersion:saved.version,consumption:'1'},randomUUID());
  const withPrice=await quotes.fillRow(ie,resource,ieRow.rowId,{expectedVersion:withUsage.version,unitPrice:'9'},randomUUID());
  expect(withPrice.document).toBeNull();
  expect(await quotes.workbenchPreview(designer,resource)).toMatchObject({
   status:'awaiting_customer_confirmation',counts:{incomplete:0,pendingCraftApproval:0},unitCost:'9',confirmation:'awaiting_joint_release',
  });
  const craftRow={...ieRow,rowId:randomUUID(),name:'TEST 单项工艺'};
  const designerCopy=await quotes.read(designer,resource);
  expect(designerCopy.version).toBe(withPrice.version);
  const withCraft=await quotes.save(designer,resource,{expectedVersion:designerCopy.version,
   document:{...designerCopy.document!,rows:[...designerCopy.document!.rows,craftRow]},
   assignments:[ieAssignment,{rowId:craftRow.rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:worker.actorId,priceRole:'pattern_room_worker'}],
  },randomUUID());
  await quotes.fillRow(worker,resource,craftRow.rowId,{expectedVersion:withCraft.version,consumption:'1',unitPrice:'6'},randomUUID());
  expect(await quotes.workbenchPreview(designer,resource)).toMatchObject({
   status:'awaiting_craft_approval',counts:{incomplete:0,pendingCraftApproval:1},unitCost:'15',confirmation:'awaiting_joint_release',
  });
 });
 it('paginates real assigned IE processing rows after authorization without changing the original quote readers',async()=>{
  const f=h.f,designer=f.people['sample-designer']!,ie=f.people.ie!,identities=new DigitalProductionIdentityService(h.db,true);
  const forms=new DigitalDevelopmentService(h.db,true),quotes=new DigitalQuotationService(h.db,true);
  const prefix=`TEST-IE-DIR-${randomUUID()}`;
  const create=(suffix:string)=>identities.createSource(designer,{developmentType:'头版',designStyleNo:`${prefix}-${suffix}`,
   temporaryStyleNo:null,customerCode:'PD'},randomUUID());
  const source=await create('target');
  const document=DevelopmentDocumentSchema.parse({...initialDevelopmentDocument(),quotationMode:'automatic_v1',template:'上衣',
   quantity:1,sizes:['M'],sampleSize:'M',sizeQuantities:[1],measurements:[{name:'胸围',values:['50']}],
   files:[{attachmentId:await f.image(designer),kind:'款图'}]});
  const saved=await forms.save(designer,source.sourceId,{expectedVersion:0,document},randomUUID());
  await forms.publish(designer,source.sourceId,saved.version,randomUUID());
  const resource={kind:'source' as const,id:source.sourceId},unassigned=await quotes.read(designer,resource);
  const original=unassigned.rows.find(row=>row.assignment.priceRole==='ie_reviewer')!;
  const assigned=await quotes.save(designer,resource,{expectedVersion:unassigned.version,document:unassigned.document!,
   assignments:unassigned.assignments.map(assignment=>assignment.rowId===original.rowId?{...assignment,priceAssigneeId:ie.actorId}:assignment)},randomUUID());
  const fill=(id:string,assignee:string|null)=>h.db.query(`INSERT INTO digital_quotation_documents(quote_id,source_id,version,document,assignments,assembly,updated_by,updated_at)
   SELECT $1,$2,1,document,(SELECT jsonb_agg(CASE WHEN node->>'rowId'=$3::text THEN jsonb_set(node,'{priceAssigneeId}',coalesce(to_jsonb($4::text),'null'::jsonb)) ELSE node END)
    FROM jsonb_array_elements(assignments) node), assembly,updated_by,updated_at
   FROM digital_quotation_documents WHERE source_id=$5`,[randomUUID(),id,original.rowId,assignee,source.sourceId]);
  // Native identity and a template generated by the original assembler keep this pagination fixture on the deployed schema.
  for(const assignee of [null,ie.actorId])for(let i=0;i<15;i++){
   const row=await create(`${assignee?'own':'unassigned'}-${i}`);await fill(row.sourceId,assignee);
  }
  const ieTab=await h.open(ie.actorId,1165,{},'/'),rootTab=await h.open(f.root.actorId,1165,{},'/'),designerTab=await h.open(designer.actorId,1165,{},'/');
  const url=(page:number,search=prefix,state='all')=>h.base+'/api/digital-production/quotations/ie-processing?'+new URLSearchParams({page:String(page),search,state});
  try{
   const first=await ieTab.page.request.get(url(1)),second=await ieTab.page.request.get(url(2)),empty=await ieTab.page.request.get(url(3));
   expect(first.ok(),await first.text()).toBe(true);expect(second.ok(),await second.text()).toBe(true);
   const firstPage=await first.json(),secondPage=await second.json();
   expect(firstPage).toMatchObject({page:1,pageSize:15,total:16});expect(firstPage.items).toHaveLength(15);
   expect(secondPage).toMatchObject({page:2,total:16,items:[{resource,quoteId:assigned.quoteId,rowId:original.rowId,
    version:assigned.version,assigneeId:ie.actorId,canEditPrice:true,state:'awaiting_price'}]});
   expect(new Set([...firstPage.items,...secondPage.items].map(item=>item.quoteId)).size).toBe(16);
   expect(await empty.json()).toMatchObject({page:3,total:16,items:[]});
   expect(await (await ieTab.page.request.get(url(1,prefix+'-target'))).json()).toMatchObject({total:1});
   expect(await (await ieTab.page.request.get(url(1,prefix,'needs_assignment'))).json()).toMatchObject({total:0,items:[]});
   expect(await (await rootTab.page.request.get(url(1,prefix,'needs_assignment'))).json()).toMatchObject({total:15});
   expect((await designerTab.page.request.get(url(1))).status()).toBe(403);
   const center=new URL('/ui/ie-processing',h.base);center.searchParams.set('page','2');center.searchParams.set('search',prefix);
   await ieTab.page.goto(center.href);
   const originalLink=ieTab.page.getByRole('link',{name:`${prefix}-target`,exact:true});
   await originalLink.click();
   const selected=new URL(ieTab.page.url());expect(selected.searchParams.get('id')).toBe(source.sourceId);
   const directoryDetail=h.base+`/api/digital-production/quotations/ie-processing/${assigned.quoteId}/${original.rowId}`;
   expect(await (await ieTab.page.request.get(directoryDetail)).json()).toMatchObject({resource,canEditPrice:true});
   expect((await ieTab.page.request.get(directoryDetail.replace(original.rowId,randomUUID()))).status()).toBe(404);
   expect((await designerTab.page.request.get(directoryDetail)).status()).toBe(403);
   const price=ieTab.page.getByRole('textbox',{name:'加工单价',exact:true});await price.fill('8');
   const submit=`**/sources/${source.sourceId}/quotation/rows/${original.rowId}`;
   const attempts:{key:string;body:unknown}[]=[];
   await ieTab.page.route(submit,async route=>{
    attempts.push({key:route.request().headers()['idempotency-key']!,body:route.request().postDataJSON()});
    if(attempts.length!==1){await route.continue();return;}
    const real=await route.fetch();expect(real.status()).toBe(200);
    await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{message:'TEST 原回执暂时不可得'}})});
   });
   await ieTab.page.getByRole('button',{name:'保存加工单价',exact:true}).click();
   await ieTab.page.getByRole('button',{name:'知道了',exact:true}).click();
   expect(await price.isDisabled()).toBe(true);
   await ieTab.page.getByRole('button',{name:'核对上次提交结果',exact:true}).click();
   await ieTab.page.getByText(`本行报价已保存 · v${assigned.version+1}`,{exact:true}).waitFor();
   expect(attempts).toHaveLength(2);expect(attempts[0]?.key).toBeTruthy();expect(attempts[1]).toEqual(attempts[0]);
   expect(attempts[0]?.body).toEqual({expectedVersion:assigned.version,unitPrice:'8'});
   const savedPrice=await quotes.read(ie,resource);
   expect(savedPrice.version).toBe(assigned.version+1);
   expect(savedPrice.rows.find(row=>row.rowId===original.rowId)?.unitPrice).toBe('8');
   expect(await (await ieTab.page.request.get(url(1,prefix,'priced'))).json()).toMatchObject({total:1,items:[{resource,state:'priced'}]});
   await ieTab.page.getByRole('link',{name:'返回报价列表',exact:true}).click();await originalLink.waitFor();
   expect(new URL(ieTab.page.url()).searchParams.get('page')).toBe('2');
   expect(new URL(ieTab.page.url()).searchParams.get('search')).toBe(prefix);
  }finally{await Promise.all([ieTab.context.close(),rootTab.context.close(),designerTab.context.close()]);}
 });
 it('opens exact saved quotation, budget and instruction originals through the real authorized App without writes or latest substitution',async()=>{
  const f=h.f,designer=f.people['sample-designer']!,merch=f.people.merchandiser!,worker=f.people['pattern-room-worker']!,identity=new DigitalProductionIdentityService(h.db,true),quotes=new DigitalQuotationService(h.db,true),budgets=new DigitalBudgetService(h.db,true),instructions=new ProductionInstructionService(h.db,true);
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-ORIGINAL-COMMERCIAL-'+randomUUID(),orderDate:beijingCalendarDate(new Date()),primaryMerchandiserId:merch.actorId,lines:[{formalPoNo:'TEST-ORIGINAL-PO',color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}]}),randomUUID());
  const id=order.productionOrderId,resource={kind:'order' as const,id},rowId=randomUUID();
  const qImages=[await f.image(designer),await f.image(designer)],iImages=[await f.image(merch),await f.image(merch)],quoteVersions:number[]=[],budgetVersions:number[]=[],instructionVersions:number[]=[];
  for(let index=0;index<2;index++){
   const old=await quotes.read(designer,resource),document:BudgetDocument={fabricType:'针织',productCategory:index?'TEST-QUOTE-NEW':'TEST-QUOTE-OLD',monthSeries:'',date:beijingCalendarDate(new Date()),currency:'人民币',freight:'0',cm:'0',salePrice:'',outsourcingScope:'车缝',outsourcingUnitPrice:'5',rows:[{rowId,section:'主料',category:'面料',name:index?'TEST-NEW-MATERIAL':'TEST-OLD-MATERIAL',specification:'40支',unit:'米',supplier:'TEST',consumption:'',unitPrice:index?'12':'10'}],imageAttachmentIds:[]};
   const saved=await quotes.save(designer,resource,{expectedVersion:old.version,document,assignments:[{rowId,technicalAssigneeId:worker.actorId,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},randomUUID());
   const filled=await quotes.fillRow(worker,resource,rowId,{expectedVersion:saved.version,consumption:'1'},randomUUID());
   const confirmed=await quotes.confirm(designer,resource,{expectedVersion:filled.version,customerCode:'PD',customerConfirmedTotal:index?'40':'30',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:index?'TEST CONFIRM NEW':'TEST CONFIRM OLD',confirmedAt:new Date(Date.now()-1000).toISOString()},randomUUID());quoteVersions.push(confirmed.version);
   let budget=await budgets.read(merch,id);if(index)budget=await budgets.adoptQuotation(merch,id,{expectedVersion:budget.version,sourceQuoteVersion:confirmed.version},randomUUID());
   const budgetDocument={...budget.document!,productCategory:index?'TEST-BUDGET-NEW':'TEST-BUDGET-OLD',date:beijingCalendarDate(new Date()),imageAttachmentIds:[qImages[index]!]};
   budget=await budgets.save(designer,id,{expectedVersion:budget.version,document:budgetDocument},randomUUID());budget=await budgets.publish(merch,id,budget.version,randomUUID(),confirmed.version);budgetVersions.push(budget.version);

  }
  // Real additional confirmations put both chosen originals off page one.
  // The selector must search the complete authorized history, not just 15 rows.
  for(let index=0;index<15;index++){
   const current=await quotes.read(designer,resource),saved=await quotes.save(designer,resource,{expectedVersion:current.version,document:{...current.document!,productCategory:'TEST-LATER-'+index},assignments:current.assignments},randomUUID());
   await quotes.confirm(designer,resource,{expectedVersion:saved.version,customerCode:'PD',customerConfirmedTotal:'40',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST LATER '+index,confirmedAt:new Date(Date.now()-1000).toISOString()},randomUUID());
  }
  const instructionOrder=await f.bulkReady('无',undefined,1,f.sourcing,{stopBeforeCompletion:true}),instructionId=instructionOrder.id;
  for(let index=0;index<2;index++){
   const prior=await instructions.read(merch,instructionId),doc={...prior.document,styleName:index?'TEST-INSTRUCTION-NEW':'TEST-INSTRUCTION-OLD',images:[{attachmentId:iImages[index]!,kind:'款图' as const,description:index?'TEST NEW IMAGE':'TEST OLD IMAGE'}]};
   const draft=await instructions.save(merch,instructionId,{expectedVersion:prior.version,orderVersion:prior.currentOrderVersion,sourceRound:prior.sourceRound,document:doc},randomUUID());
   const readiness=await new ProductionReadinessService(h.db).read(merch,{kind:'order',id:instructionId});
   const published=await instructions.publish(merch,instructionId,{expectedVersion:draft.version,orderVersion:draft.currentOrderVersion,expectedReadinessRevision:readiness.revision},randomUUID());instructionVersions.push(published.version);
  }
  const quoteId=(await quotes.read(designer,resource)).quoteId!,before=(await h.db.query(`WITH saved AS (SELECT 'budget' AS kind,to_jsonb(v) AS value FROM digital_budget_versions v WHERE production_order_id=$1 UNION ALL SELECT 'instruction',to_jsonb(v) FROM digital_instruction_versions v WHERE production_order_id=$3 UNION ALL SELECT 'quotation',to_jsonb(v) FROM digital_quotation_versions v WHERE quote_id=$2) SELECT * FROM saved ORDER BY kind,value->>'version'`,[id,quoteId,instructionId])).rows;
  expect(await quotes.originalVersions(designer,resource,1,'')).toMatchObject({total:17,items:expect.any(Array)});
  expect((await quotes.originalVersions(designer,resource,1,'')).items).toHaveLength(15);
  expect(await quotes.originalVersions(designer,resource,2,'')).toMatchObject({total:17,items:[{version:quoteVersions[1]},{version:quoteVersions[0]}]});
  expect(await quotes.originalVersions(designer,resource,1,'已确认版本 '+quoteVersions[0])).toMatchObject({total:1,items:[{version:quoteVersions[0]}]});
  expect(await budgets.originalVersions(merch,id,2,'')).toMatchObject({total:2,items:[]});
  expect(await instructions.originalVersions(merch,instructionId,1,'已发布版本 '+instructionVersions[0])).toMatchObject({total:1,items:[{version:instructionVersions[0]}]});
  const originalOrder=(await instructions.originalVersion(merch,instructionId,instructionVersions[0]!)).order;
  const currentOrder=await identity.read(merch,instructionId);
  await new DigitalProductionIdentityService(h.db,true,f.sourcing).correctNumbers(merch,instructionId,currentOrder.lines[0]!.lineId,{expectedVersion:currentOrder.version,formalPoNo:'TEST-CURRENT-ALIAS'},randomUUID());
  expect((await instructions.read(merch,instructionId,undefined,instructionVersions[0]!)).order.lines[0]!.poNumber).toBe('TEST-CURRENT-ALIAS');
  expect((await instructions.originalVersion(merch,instructionId,instructionVersions[0]!)).order).toEqual(originalOrder);
  const tab=await h.open(merch.actorId,1165,{},'/');
  // Playwright routes redirected requests only at their initial URL. Fetch the
  // real authorized 302, then replace only its external object-storage hop.
  await tab.context.route('**/original-versions/*/attachments/*',async route=>{
   const response=await route.fetch({maxRedirects:0});if(response.status()!==302){await route.fulfill({response});return;}
   const target=new URL(response.headers().location!);expect(target.origin).toBe('https://private.example.test');
   const key=decodeURIComponent(target.pathname.slice(1)),bytes=f.storage.objectBytes.get(key);
   expect(f.storage.signed.some(grant=>grant.method==='GET'&&grant.objectKey===key)).toBe(true);expect(bytes).toBeDefined();
   await route.fulfill({status:200,contentType:f.storage.objects.get(key)!.mimeType,body:Buffer.from(bytes!)});
  });
  const path=(kind:string,version:number)=>'/ui/digital-production?'+new URLSearchParams(kind==='quotation'?{quotationOrder:id,quoteId,quoteVersion:String(version)}:{[kind]:kind==='instruction'?instructionId:id,[kind+'Version']:String(version),originalDocument:kind});
  try{
   for(const [kind,versions,imageIds,field,expected] of [['budget',budgetVersions,qImages,'#budget-productCategory','TEST-BUDGET-OLD'],['instruction',instructionVersions,iImages,'#instruction-styleName','TEST-INSTRUCTION-OLD'],['quotation',quoteVersions,qImages,'#quote-confirmed-basis','TEST CONFIRM OLD']] as const){
    await tab.page.goto(h.base+path(kind,versions[0]!));const reader=tab.page.getByRole('region',{name:'完整原单只读查看',exact:true});await reader.waitFor();await expect.poll(()=>tab.page.locator(field).textContent()).toContain(expected);
    if(kind!=='quotation'){const image=reader.locator(`img[src*="/original-versions/${versions[0]}/attachments/${imageIds[0]}"]`).first();await expect.poll(()=>image.evaluate(element=>(element as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);expect(await reader.locator(`img[src*="${imageIds[1]}"]`).count()).toBe(0);}
    else{await expect.poll(()=>tab.page.locator('#quote-confirmed-basis').textContent()).toContain('30');expect(await tab.page.getByText('TEST-OLD-MATERIAL',{exact:true}).count()).toBeGreaterThan(0);}
    expect(await reader.locator('input[type=file]').count()).toBe(0);
    for(const name of ['保存预算','最终发布','保存草稿','发布制单','记录客户报价确认并检查预算生成条件'])expect(await reader.getByRole('button',{name,exact:true}).count()).toBe(0);
    const entityId=kind==='instruction'?instructionId:id,suffix=kind==='quotation'?`?quoteId=${quoteId}`:'',api=`${h.base}/api/digital-production/orders/${entityId}/${kind}/original-versions/${versions[0]}`;
    if(kind!=='quotation'){const denied=await tab.page.request.get(`${api}/attachments/${imageIds[1]}${suffix}`);expect([403,404]).toContain(denied.status());}expect((await tab.page.request.get(`${h.base}/api/digital-production/orders/${entityId}/${kind}/original-versions/999999${suffix}`)).status()).toBe(404);
    await tab.page.getByRole('button',{name:'切换单据',exact:true}).click();const chooser=tab.page.getByRole('dialog',{name:'切换单据',exact:true});await chooser.waitFor();
    if(kind==='quotation')await chooser.getByLabel('搜索原单与版本',{exact:true}).fill('已确认版本 '+versions[1]);
    const label={budget:'成本预算表',instruction:'大货制单',quotation:'客户报价'}[kind]+` · ${kind==='quotation'?'已确认':'已发布'}版本 ${versions[1]}`;
    await chooser.getByRole('button',{name:label,exact:true}).click();await chooser.waitFor({state:'hidden'});await expect.poll(()=>tab.page.locator(field).textContent()).toContain(expected.replace('OLD','NEW'));
    await tab.page.goBack();await expect.poll(()=>tab.page.locator(field).textContent()).toContain(expected);
   }
   const writes=h.requests.filter(row=>row.session===tab.session&&!['GET','HEAD','OPTIONS'].includes(row.method)&&new RegExp(`/digital-production/orders/(${id}|${instructionId})/(budget|instruction|quotation)`).test(row.path));expect(writes).toEqual([]);
   expect((await h.db.query(`WITH saved AS (SELECT 'budget' AS kind,to_jsonb(v) AS value FROM digital_budget_versions v WHERE production_order_id=$1 UNION ALL SELECT 'instruction',to_jsonb(v) FROM digital_instruction_versions v WHERE production_order_id=$3 UNION ALL SELECT 'quotation',to_jsonb(v) FROM digital_quotation_versions v WHERE quote_id=$2) SELECT * FROM saved ORDER BY kind,value->>'version'`,[id,quoteId,instructionId])).rows).toEqual(before);
   await expect(budgets.originalVersion(f.people['worker-b']!,id,budgetVersions[0]!)).rejects.toMatchObject({statusCode:404});
   await expect(instructions.read(f.people['worker-b']!,instructionId)).rejects.toMatchObject({statusCode:403});
   await expect(instructions.originalVersion(f.people['worker-b']!,instructionId,instructionVersions[0]!)).rejects.toMatchObject({statusCode:403});
   await expect(quotes.originalVersion(f.people['worker-b']!,resource,quoteId,quoteVersions[0]!)).rejects.toMatchObject({statusCode:404});
  }finally{await tab.close();}
 },testExecutionConfig.correctnessTimeoutMs);
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
   const workbenchPath='/ui/digital-production?workspace=designer&section=workspace&area=customer&development='+source.sourceId;
   await d.page.goto(h.base+workbenchPath);
   const customerArea=d.page.getByRole('region',{name:'客户与报价'});
   await customerArea.getByRole('heading',{name:'客户报价表',exact:true}).waitFor();
   await customerArea.locator('.quotation-editor').getByText('客户当前确认版：尚未确认',{exact:true}).waitFor();
   expect(await customerArea.getByLabel('TEST棉布用量负责人',{exact:true}).count()).toBe(0);
   expect(await customerArea.getByLabel('IE加工单价价格负责人',{exact:true}).count()).toBe(0);
   await d.page.goto(h.base+path);
   await d.page.getByRole('heading',{name:'客户报价表',exact:true}).waitFor();
   await d.page.getByLabel('TEST棉布用量负责人').selectOption(worker.actorId);
   await d.page.getByLabel('IE加工单价价格负责人').selectOption('ie_reviewer:'+ie.actorId);
   await d.page.getByRole('button',{name:'保存报价',exact:true}).click();
   await expect.poll(async()=>(await quotes.read(designer,resource)).assignments.some(a=>a.priceAssigneeId===ie.actorId)).toBe(true);
   await d.page.goto(h.base+workbenchPath);
   await customerArea.locator('.quotation-editor').getByText('客户当前确认版：尚未确认',{exact:true}).waitFor();
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
    // The existing editor accepts a responsible worker's manual entry. The
    // staged R4 cost calculation needs an adopted published artifact.
    const previewRead=h.base+'/api/digital-production/sources/'+source.sourceId+'/quotation/workbench-pricing';
    await d.page.getByRole('button',{name:'重新读取报价',exact:true}).click();
    await expect.poll(()=>d.page.locator('#quote-cost-reference').innerText()).toContain('成本合计 待补齐');
    const form=await forms.read(designer,source.sourceId),technical=new DevelopmentTechnicalService(h.db,true);
    const initial=await publishedTechnicalFixture(h.db,h.f.root,source.sourceId,form.document!,form.version,worker.actorId);
    const published=(await technical.read(worker,source.sourceId)).artifacts.find(record=>record.artifactSetId===initial?.artifactSetId&&record.version===initial?.version)!;
    await technical.saveArtifact(worker,source.sourceId,{taskId:published.taskId,expectedDocumentVersion:form.version,
     expectedVersion:published.version,scopeRef:'整款',action:'publish',
     body:{...published.body,consumptionRows:[{materialId,unit:'米',consumption:'1.5'}]}},randomUUID());
    await d.page.getByRole('button',{name:'重新读取报价',exact:true}).click();
    await expect.poll(()=>d.page.getByRole('button',{name:'记录客户报价确认并检查预算生成条件',exact:true}).isEnabled()).toBe(true);
    await expect.poll(()=>d.page.locator('#quote-cost-reference').innerText()).toContain('成本合计 40.00 元/件');
    const rate=d.page.getByLabel('报价倍率（%）',{exact:true}),price=d.page.getByLabel('客户单件报价（元/件）',{exact:true});
    await rate.fill('130');
    expect(await price.inputValue()).toBe('52.00');
    await price.fill('49.123456');
    expect(await rate.inputValue()).toBe('122.8086');
    expect(await price.inputValue()).toBe('49.123456');
    expect(await d.page.getByLabel('客户确认金额',{exact:true}).inputValue()).toBe('');
    expect((await i.page.request.get(previewRead)).status()).toBe(404);
    const served=await d.page.request.get(previewRead);
    expect(served.status()).toBe(200);
    expect(served.headers()['cache-control']).toBe('no-store');
    expect((await quotes.read(designer,resource)).confirmedVersion).toBeNull();
    expect(await served.json()).toMatchObject({unitCost:'40',saved:null,confirmation:'awaiting_joint_release'});
    const panel=d.page.locator('#quote-cost-reference');
    for(const width of [1165,390]){
     await d.page.setViewportSize({width,height:960});
     expect(await panel.evaluate(node=>{
      const bounds=node.getBoundingClientRect();
      const fields=node.querySelector('.quotation-workbench-price-fields')!;
      const following=fields.nextElementSibling!;
      const separated=following.getBoundingClientRect().top-fields.getBoundingClientRect().bottom>=4;
      return separated&&Array.from(node.querySelectorAll('input')).every(input=>{
       const position=input.getBoundingClientRect();
       return position.width>0&&position.left>=bounds.left-1&&position.right<=bounds.right+1&&getComputedStyle(input).borderTopWidth==='0px';
      });
     })).toBe(true);
     await panel.screenshot({path:join(h.evidence,`r4-pricing-${width}.png`)});
    }
    await d.page.setViewportSize({width:1165,height:960});
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
     await d.page.getByRole('status').filter({hasText:'读取中，请稍候'}).waitFor();
     expect(historyRequests).toBe(1);
     expect(await oldSheet.innerText()).toContain('协作草稿');
     expect(await d.page.getByRole('button',{name:'保存报价',exact:true}).isDisabled()).toBe(true);
     releaseHistory();
     await expect.poll(()=>oldSheet.innerText()).toContain('客户已确认');
     await d.page.getByRole('status').filter({hasText:'读取中，请稍候'}).waitFor({state:'hidden'});
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
