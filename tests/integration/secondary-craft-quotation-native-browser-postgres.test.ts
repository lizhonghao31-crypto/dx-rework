import {randomUUID} from 'node:crypto';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {expect,it} from 'vitest';
import {beijingCalendarDate,DigitalOrderCreateSchema,minimumInitialCustomerDate} from '@dx-rework/contracts/digital-production';
import {DevelopmentDocumentSchema} from '@dx-rework/contracts/digital-development';
import {DigitalProductionIdentityService} from '../../apps/api/src/production-platform/identity-service.js';
import {DigitalDevelopmentService} from '../../apps/api/src/production-platform/development-service.js';
import {DigitalQuotationService} from '../../apps/api/src/production-platform/quotation-service.js';
import {assembleQuotation} from '../../apps/api/src/production-platform/quotation-assembly.js';
import {MemberModuleBindingService} from '../../apps/api/src/access/member-module-binding-service.js';
import {initialDevelopmentDocument} from '../../apps/web/src/digital-development-editing.js';
import {supplychainSettingsBrowser} from '../acceptance/supplychain-settings-browser.js';
import type {APIRequestContext} from 'playwright-core';

const url=process.env.ACCEPTANCE_CLOCK_TEST_DATABASE_URL??process.env.TEST_DATABASE_URL;
const check=(url?it:it.skip);
const key=()=>randomUUID();
type Session=Awaited<ReturnType<Awaited<ReturnType<typeof supplychainSettingsBrowser>>['open']>>;

check('enforces the joint R4/R6 workflow on actual signed roles and original confirmation and budget routes',async()=>{
 const h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'r6-joint-'+key()),{fullApp:true,accessCatalog:true,orderTimeFlow:true});
 const sessions:Session[]=[];
 const sign=async(id:string)=>{const session=await h.open(id,1165,{},'/ui/home');sessions.push(session);return session.page.request;};
 try{
  const {db,f}=h,designer=f.people['sample-designer']!,maker=f.people['pattern-room-worker']!,ie=f.people.ie!,merch=f.people.merchandiser!,wu=f.people.owner!;
  const otherOwner=await h.dedicated('owner_group','TEST 同名审批人');
  await f.access.ensureOrganizationPolicy();
  await new MemberModuleBindingService(db).run(f.root.actorId,{li_zhonghao:otherOwner.id,wu_yunfeng:wu.actorId,li_junyue:f.root.actorId},true);
  const identity=new DigitalProductionIdentityService(db,true),forms=new DigitalDevelopmentService(db,true),quotes=new DigitalQuotationService(db,true);
  const styleNo='TEST R6 '+key();
  const source=await identity.createSource(designer,{developmentType:'头版',designStyleNo:styleNo,temporaryStyleNo:null,customerCode:'PD'},key());
  const board=await f.image(designer),photo=await f.image(designer);
  const draft=await forms.save(designer,source.sourceId,{expectedVersion:0,document:DevelopmentDocumentSchema.parse({
   ...initialDevelopmentDocument(),quotationMode:'automatic_v1',documentFormatVersion:2,rush:true,
   craft:'印绣花',craftSteps:[{craftKind:'embroidery',sequence:1},{craftKind:'printing',sequence:2}],
   quantity:1,sizes:['M'],sampleSize:'M',sizeQuantities:[1],measurements:[{name:'胸围',values:['50']}],
   files:[{attachmentId:photo,kind:'款图'},{attachmentId:board,kind:'工艺开发板'}],
   craftRequirements:[{stepKey:'embroidery',part:'袖口',specification:'左侧',instructions:'测试',attachmentIds:[board]}],
  })},key());
  const published=await forms.publish(designer,source.sourceId,draft.version,key());
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:styleNo,orderDate:beijingCalendarDate(new Date()),
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}],
  }),key(),source.sourceId);
  // Seed existing assignment facts on this new fixture. The real quotation
  // command refreshes the actual assembly and original authorizations.
  await db.query(`INSERT INTO digital_development_round_arrangements(source_id,round_number,version,entries,changed_by,document_version)
   VALUES($1,1,1,$2,$3,$4)`,[source.sourceId,JSON.stringify({
    development_embroidery:maker.actorId,development_printing:maker.actorId,
   }),f.root.actorId,published.version]);
  const client=await db.connect();
  try{
   await assembleQuotation(client,source.sourceId,designer.actorId);
  }finally{client.release();}
  const resource={kind:'order' as const,id:order.productionOrderId};
  let sheet=await quotes.read(designer,resource);
  const ieRow=sheet.rows.find(row=>row.category==='IE加工')!;
  sheet=await quotes.save(designer,resource,{expectedVersion:sheet.version,document:sheet.document!,
   assignments:sheet.assignments.map(value=>value.rowId===ieRow.rowId?{...value,priceAssigneeId:ie.actorId}:value)},key());
  await quotes.fillRow(ie,resource,ieRow.rowId,{expectedVersion:sheet.version,unitPrice:'5'},key());
  sheet=await quotes.read(designer,resource);
  const embroidery=sheet.rows.find(row=>row.name==='绣花')!,printing=sheet.rows.find(row=>row.name==='印花')!;
  expect([embroidery.assignment.priceAssigneeId,printing.assignment.priceAssigneeId]).toEqual([maker.actorId,maker.actorId]);
  const [designSession,makerSession,approvalSession,otherSession,rootSession,budgetSession]=await Promise.all(
   [designer.actorId,maker.actorId,wu.actorId,otherOwner.id,f.root.actorId,merch.actorId].map(sign));
  const makerPage=sessions.find(session=>session.page.request===makerSession)!.page;
  const makerTab=sessions.find(session=>session.page.request===makerSession)!;
  const ownerPage=sessions.find(session=>session.page.request===approvalSession)!.page;
  const base=`${h.base}/api/digital-production/orders/${resource.id}`,quotation=base+'/quotation',budget=base+'/budget';
  const craft=(rowId:string)=>`${quotation}/secondary-craft/${rowId}`;
  const center=h.base+'/ui/secondary-craft-quotation';
  const directory=h.base+'/api/digital-production/secondary-craft-quotations';
  const currentDirectory=async(request:APIRequestContext)=>{
   const response=await request.get(directory);
   expect(response.status(),await response.text()).toBe(200);
   return (await response.json()).items;
  };
  const write=async(request:APIRequestContext,status:number,path:string,data:unknown,idem=key(),method:'POST'|'PUT'='POST')=>{
   const result=await request.fetch(path,{method,data,headers:{'idempotency-key':idem}});
   expect(result.status(),await result.text()).toBe(status);
   return result.json();
  };
  const confirm=async(status:number,extra:object={})=>{
   const latest=await quotes.read(designer,resource);
   return write(designSession,status,quotation+'/confirm',{expectedVersion:latest.version,customerCode:'PD',
    customerConfirmedTotal:'20',amountScope:'per_piece',quantity:null,quantityUnit:'件',currency:'人民币',
    taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',sourceField:'customerConfirmedTotal',
    templateVersion:'online-quotation-v1',evidenceNote:'TEST 客户确认',confirmedAt:new Date().toISOString(),...extra});
  };
  const external=craft(embroidery.rowId),internal=craft(printing.rowId);
  const options=await makerSession.get(external+'?supplierSearch=');
  expect(options.status()).toBe(200);
  const factories=(await options.json()).items;
  expect(factories).toContainEqual(expect.objectContaining({supplierId:f.supplierId}));
  expect(Object.keys(factories[0]).sort()).toEqual(['code','name','supplierId']);
  expect(await currentDirectory(approvalSession)).toEqual([]);
  const makerDirectory=await currentDirectory(makerSession);
  expect(new Set(makerDirectory.map((item:{rowId:string})=>item.rowId))).toEqual(new Set([embroidery.rowId,printing.rowId]));
  expect(makerDirectory).toMatchObject([{resource,orderRush:true},{resource,orderRush:true}]);
  const quoteList=h.base+'/api/digital-production/quotations';
  expect((await (await makerSession.get(quoteList)).json()).items).toContainEqual(expect.objectContaining({resource,orderRush:true}));
  expect((await makerSession.get(external+'/attachments/'+board,{maxRedirects:0})).status()).toBe(302);
  expect((await makerSession.get(external+'/attachments/'+photo,{maxRedirects:0})).status()).toBe(404);
  await write(makerSession,403,h.base+'/api/master-data/suppliers',{supplierCode:'TEST-R6-DENIED'});
  await write(makerSession,403,h.base+`/api/master-data/suppliers/${f.supplierId}/versions`,{active:false});
  const terms={expectedVersion:0,unitPrice:'2.125',unit:'件',applicableQuantity:null,note:'',attachmentIds:[board],
   mode:'outsourced',supplierId:f.supplierId};
  await write(makerSession,409,quotation+`/rows/${embroidery.rowId}`,{expectedVersion:sheet.version,unitPrice:'2'});
  await write(makerSession,403,external+'/draft',{...terms,attachmentIds:[photo]},key(),'PUT');
  await makerPage.goto(center);
  await makerPage.getByRole('row').filter({has:makerPage.getByRole('link',{name:/ · 绣花$/})}).getByText('急单',{exact:true}).waitFor();
  await makerPage.getByRole('link',{name:/ · 绣花$/}).click();
  await makerPage.getByRole('heading',{name:'绣花报价',exact:true}).waitFor();
  await makerPage.getByRole('combobox',{name:'制作方式'}).click();
  await makerPage.getByRole('option',{name:'外发',exact:true}).click();
  await makerPage.getByRole('combobox',{name:'加工厂',exact:true}).click();
  await makerPage.getByRole('option',{name:new RegExp(factories.find((item:{supplierId:string})=>item.supplierId===f.supplierId).code)}).click();
  await makerPage.getByRole('textbox',{name:'工艺单价'}).fill(terms.unitPrice);
  const draftReceipt=makerPage.waitForResponse(response=>response.url()===external+'/draft'&&response.request().method()==='PUT');
  await makerPage.getByRole('button',{name:'保存工艺报价草稿'}).click();
  const saved=await draftReceipt;
  expect(saved.status(),await saved.text()).toBe(200);
  expect(await saved.json()).toMatchObject({state:'draft',receipt:{action:'draft',appliedVersion:1}});
  expect(await currentDirectory(approvalSession)).toEqual([]);
  await confirm(409);
  await write(budgetSession,409,budget,{expectedVersion:0,document:sheet.document},key(),'PUT');
  await write(makerSession,400,internal+'/submit',{...terms,mode:'in_house',attachmentIds:[]});
  h.faults.get(makerTab.session)!.losePath=new URL(external+'/submit').pathname;
  await makerPage.getByRole('button',{name:'提交伍云峰审批'}).click();
  await makerPage.getByRole('button',{name:'重试原请求'}).waitFor();
  const recovered=makerPage.waitForResponse(response=>response.url()===external+'/submit'&&response.status()===200);
  await makerPage.getByRole('button',{name:'重试原请求'}).click();
  expect(await (await recovered).json()).toMatchObject({state:'submitted',receipt:{action:'submit',appliedVersion:2}});
  const sends=h.requests.filter(request=>request.path===new URL(external+'/submit').pathname);
  expect(sends).toHaveLength(2);
  expect(sends[0]?.key).toBeTruthy();
  expect(sends[0]?.key).toBe(sends[1]?.key);
  expect(sends[0]?.bodyHash).toBe(sends[1]?.bodyHash);
  const approvalItem=(await currentDirectory(approvalSession))[0];
  expect(approvalItem).toMatchObject({resource,rowId:embroidery.rowId,version:2,canDecide:true,state:'submitted',orderRush:true});
  expect(await currentDirectory(otherSession)).toEqual([]);
  const notice=await db.query(`SELECT e.todo_id,r.recipient_id FROM digital_production_notification_events e
   JOIN digital_production_notification_receipts r USING(event_id) WHERE event_kind='secondary_craft_approval'`);
  expect(notice.rows).toEqual([{todo_id:approvalItem.approvalTodoId,recipient_id:wu.actorId}]);
  await expect(db.query(`INSERT INTO digital_production_notification_receipts(event_id,source_event_id,recipient_id)
   SELECT event_id,event_id,$2 FROM digital_production_notification_events WHERE todo_id=$1`,
  [approvalItem.approvalTodoId,otherOwner.id])).rejects.toMatchObject({code:'23514'});
  const todo=await approvalSession.get(h.base+`/api/todos/mine/${approvalItem.approvalTodoId}`);
  expect(todo.status(),await todo.text()).toBe(200);
  expect((await otherSession.get(h.base+`/api/todos/mine/${approvalItem.approvalTodoId}`)).status()).toBe(404);
  await write(makerSession,200,internal+'/submit',{...terms,mode:'in_house',supplierId:null,attachmentIds:[],unitPrice:'3'});
  for(const no of [makerSession,rootSession,otherSession])await write(no,403,external+'/decision',{decision:'approved',expectedVersion:2});
  await write(approvalSession,409,external+'/decision',{decision:'approved',expectedVersion:1});
  await expect(db.query(`INSERT INTO digital_secondary_craft_quote_decisions(decision_id,quote_id,row_id,revision,actor_id,decision,reason,decided_at)
   VALUES($1,$2,$3,2,$4,'approved','',CURRENT_TIMESTAMP)`,[key(),sheet.quoteId,embroidery.rowId,otherOwner.id]))
   .rejects.toMatchObject({code:'23514'});
  await ownerPage.goto(center);
  await ownerPage.getByRole('link',{name:/ · 绣花$/}).click();
  await ownerPage.getByRole('heading',{name:'绣花报价',exact:true}).waitFor();
  expect(await ownerPage.getByRole('button',{name:'提交伍云峰审批'}).count()).toBe(0);
  const decision=ownerPage.waitForResponse(response=>response.url()===external+'/decision'&&response.request().method()==='POST');
  await ownerPage.getByRole('button',{name:'批准本版工艺报价'}).click();
  const decisionResult=await decision;
  expect(decisionResult.status(),await decisionResult.text()).toBe(200);
  expect(await decisionResult.json()).toMatchObject({state:'approved',receipt:{action:'decision',appliedVersion:2}});
  await write(approvalSession,200,internal+'/decision',{decision:'returned',expectedVersion:1,reason:'核对原要求'});
  await confirm(409);
  await write(makerSession,200,internal+'/submit',{...terms,expectedVersion:1,mode:'in_house',supplierId:null,attachmentIds:[],unitPrice:'3'});
  await write(approvalSession,200,internal+'/decision',{decision:'approved',expectedVersion:2});
  await confirm(400,{secondaryCraftApprovals:[key()]});
  await confirm(409,{workbenchPricing:{field:'customerUnitPrice',value:'19'}});
  await confirm(200,{workbenchPricing:{field:'customerUnitPrice',value:'20.000000'}});
  const frozen=(await db.query('SELECT secondary_craft_approvals,workbench_pricing FROM digital_quotation_versions WHERE quote_id=$1',[sheet.quoteId])).rows[0];
  expect(frozen.secondary_craft_approvals).toEqual(expect.arrayContaining([
   expect.objectContaining({rowId:embroidery.rowId,revision:2,actorId:wu.actorId}),
   expect.objectContaining({rowId:printing.rowId,revision:2,actorId:wu.actorId}),
  ]));
  expect(frozen.workbench_pricing.customerUnitPrice).toBe('20.000000');
  const bud=await budgetSession.get(budget);expect(bud.status(),await bud.text()).toBe(200);
  const oldBudget=await bud.json();expect(oldBudget.canEdit).toBe(true);
  const updated=await write(budgetSession,200,budget,{expectedVersion:oldBudget.version,document:oldBudget.document},key(),'PUT');
  await write(makerSession,200,external+'/draft',{...terms,expectedVersion:2,unitPrice:'4'},key(),'PUT');
  expect(await (await budgetSession.get(budget)).json()).toMatchObject({canEdit:false,canPublish:false});
  const historical=await designSession.get(external+'?version=2');
  expect(historical.status(),await historical.text()).toBe(200);
  expect(await historical.json()).toMatchObject({historical:true,state:'approved',version:2,canEdit:false,canDecide:false,
   draft:{unitPrice:'2.125',supplierId:f.supplierId},target:{attachmentIds:[board]}});
  expect((await designSession.get(external+'/attachments/'+board+'?version=2',{maxRedirects:0})).status()).toBe(302);
  expect((await otherSession.get(external+'?version=2')).status()).toBe(404);
  await write(budgetSession,409,budget,{expectedVersion:updated.version,document:updated.document},key(),'PUT');
  expect((await db.query('SELECT secondary_craft_approvals FROM digital_quotation_versions WHERE quote_id=$1',[sheet.quoteId])).rows[0].secondary_craft_approvals).toEqual(frozen.secondary_craft_approvals);

  const manual=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:'TEST R6 MANUAL '+key(),orderDate:beijingCalendarDate(new Date()),
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}],
  }),key());
  const manualResource={kind:'order' as const,id:manual.productionOrderId},manualRow=key();
  const manualDocument={...sheet.document!,rows:[{rowId:manualRow,section:'外发工序' as const,category:'工艺',name:'手工印花报价',
   specification:'按原报价单位',unit:'米',supplier:'',unitPrice:'',consumption:''}]};
  let manualQuote=await quotes.save(designer,manualResource,{expectedVersion:0,document:manualDocument,assignments:[
   {rowId:manualRow,technicalAssigneeId:maker.actorId,priceAssigneeId:maker.actorId,priceRole:'pattern_room_worker'},
  ]},key());
  manualQuote=await quotes.fillRow(maker,manualResource,manualRow,{expectedVersion:manualQuote.version,consumption:'1.5'},key());
  const manualBase=`${h.base}/api/digital-production/orders/${manual.productionOrderId}/quotation`;
  const manualCraft=manualBase+'/secondary-craft/'+manualRow;
  expect((await currentDirectory(makerSession)).map((item:{rowId:string})=>item.rowId)).toContain(manualRow);
  await write(makerSession,409,manualBase+'/rows/'+manualRow,{expectedVersion:manualQuote.version,unitPrice:'7'});
  const manualConfirmation={expectedVersion:manualQuote.version,customerCode:'PD',customerConfirmedTotal:'30',amountScope:'per_piece',
   quantity:null,quantityUnit:'件',currency:'人民币',taxBasis:'excludes_tax',sourceKind:'explicit_customer_confirmation',
   sourceField:'customerConfirmedTotal',templateVersion:'online-quotation-v1',evidenceNote:'TEST 手工报价原单',confirmedAt:new Date().toISOString()};
  await write(designSession,409,manualBase+'/confirm',manualConfirmation);
  await write(makerSession,200,manualCraft+'/submit',{mode:'in_house',supplierId:null,expectedVersion:0,unit:'米',unitPrice:'7',
   applicableQuantity:null,note:'按原材料用量报价',attachmentIds:[]});
  await write(approvalSession,200,manualCraft+'/decision',{expectedVersion:1,decision:'approved'});
  manualQuote=await quotes.read(designer,manualResource);
  expect(manualQuote.rows).toEqual(expect.arrayContaining([expect.objectContaining({rowId:manualRow,unit:'米',unitPrice:'7',consumption:'1.5'})]));
  await write(designSession,200,manualBase+'/confirm',{...manualConfirmation,expectedVersion:manualQuote.version});
  expect((await db.query('SELECT secondary_craft_approvals FROM digital_quotation_versions WHERE quote_id=$1',[manualQuote.quoteId])).rows[0])
   .toMatchObject({secondary_craft_approvals:[{rowId:manualRow,revision:1,actorId:wu.actorId}]});
 }finally{
  await Promise.all(sessions.map(session=>session.close()));
  await h.writeEvidence();
  await h.dispose();
 }
},100000);

check('keeps the new commercial writes locked with the exact pre-R6 schema',async()=>{
 const h=await supplychainSettingsBrowser(url!,join(process.env.RUNNER_TEMP??tmpdir(),'r6-staged-'+key()),{
  fullApp:true,throughVersion:'0300_workbench_quotation_review',
 });
 try{
  const designer=h.f.people['sample-designer']!;
  const identity=new DigitalProductionIdentityService(h.db,true);
  const order=await identity.createOrder(designer,DigitalOrderCreateSchema.parse({
   customerCode:'PD',productGroup:'男装',designStyleNo:'TEST R6 staged '+key(),orderDate:beijingCalendarDate(new Date()),
   lines:[{color:'黑',customerWarehouseArrivalDate:minimumInitialCustomerDate(),sizes:[{size:'M',quantity:5}]}],
  }),key());
  const resource={kind:'order' as const,id:order.productionOrderId};
  const quotes=new DigitalQuotationService(h.db,true),rowId=key();
  const sheet=await quotes.save(designer,resource,{expectedVersion:0,document:{
   fabricType:'',productCategory:'上衣',monthSeries:'',date:null,currency:'人民币',freight:'',cm:'',salePrice:'',
   outsourcingScope:'',outsourcingUnitPrice:'',imageAttachmentIds:[],rows:[
    {rowId,section:'主料',category:'',name:'TEST 面料',specification:'',unit:'米',supplier:'',consumption:'',unitPrice:'10'},
   ],
  },assignments:[{rowId,technicalAssigneeId:null,priceAssigneeId:designer.actorId,priceRole:'sample_designer'}]},key());
  const tab=await h.open(designer.actorId,1165,{},'/ui/home');
  try{
   const base=`${h.base}/api/digital-production/orders/${resource.id}/quotation`;
   const preview=await tab.page.request.get(base+'/workbench-pricing');
   expect(preview.status(),await preview.text()).toBe(200);
   expect(await preview.json()).toMatchObject({confirmation:'awaiting_joint_release'});
   const blocked=await tab.page.request.put(base+'/workbench-pricing',{headers:{'idempotency-key':key()},
    data:{expectedVersion:sheet.version,input:{field:'customerUnitPrice',value:'12'}}});
   expect(blocked.status(),await blocked.text()).toBe(409);
   expect((await h.db.query('SELECT 1 FROM digital_quotation_pricing_drafts WHERE quote_id=$1',[sheet.quoteId])).rowCount).toBe(0);
  }finally{await tab.close();}
 }finally{await h.writeEvidence();await h.dispose();}
},100000);
