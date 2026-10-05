import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
const dir=process.env.V2_JOURNEY_EVIDENCE_DIR??'/tmp/v2-journey-routes';await mkdir(dir,{recursive:true});
const current=Number(process.env.V2_CURRENT_PORT??3208),baseline=Number(process.env.V2_BASELINE_PORT??3207);
const id='11111111-1111-4111-8111-111111111111',receipt='22222222-2222-4222-8222-222222222222',line='33333333-3333-4333-8333-333333333333';
const roles=['sample_designer','order_merchandiser','owner_group','warehouse_receiver','pattern_room_supervisor','system_admin'];
const caps=['todo:view','pattern_room:orders:create','pattern_room:orders:view','pattern_room:prices:read','sourcing:view','access:admin','admin:read','supplier_profile:read','sample:view_basic','sample:view_finance','report:view','cutting:orders:view','cutting:records:create','receiving:create'];
const doc={fabricType:'梭织',productCategory:'TEST外套',monthSeries:'10月',date:'2026-10-01',currency:'人民币',freight:'1',cm:'5',salePrice:'100',outsourcingScope:'TEST范围',outsourcingUnitPrice:'10',imageAttachmentIds:[],rows:[{rowId:line,section:'主料',category:'面料',name:'TEST面料',specification:'TEST规格',unit:'米',supplier:'TEST供应方',consumption:'2',unitPrice:'3'}]};
const order={productionOrderId:id,customerCode:'PD',productGroup:'男装',designStyleNo:'TEST-JOURNEY',temporaryStyleNo:null,version:1,canEdit:true,lines:[{lineId:line,poNumber:'TEST-PO1',color:'黑',sizes:[{size:'M',quantity:100}],totalQuantity:100}]};
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH??'/usr/bin/chromium',headless:true});
const requests=[];
async function pageFor(){
 const page=await browser.newPage({viewport:{width:1672,height:941}});
 await page.route('**/api/**',async route=>{
  const request=route.request(),url=new URL(request.url()),path=url.pathname.split('/api/')[1];if(path?.includes('notifications')){await route.fulfill({status:404,json:{}});return;}assert.equal(request.method(),'GET',url.pathname);requests.push(url.pathname+url.search);
  let body;
  if(path==='auth/me')body={status:'authorized',user:{id,displayName:'TEST Journey 路由',isRoot:true,businessRoles:roles,capabilities:caps}};
  else if(path==='todos/mine/indicator')body={pendingCount:0};
  else if(path?.startsWith('digital-production/options'))body={creationEnabled:false,customers:[]};
  else if(path?.startsWith('digital-production/access/options'))body={users:[],roles:[]};
  else if(path===`digital-production/orders/${id}`)body=order;
  else if(path===`digital-production/orders/${id}/budget`){const historic=url.searchParams.get('version')==='3';body={productionOrderId:id,version:historic?3:4,status:'published',document:{...doc,monthSeries:historic?'历史3':'当前4'},totals:null,canEdit:!historic,canSubmitSourcing:true,sourcingCaseId:null,publishedAt:'2026-10-01T10:00:00Z',designerName:'TEST设计师',merchandiserName:'TEST跟单'};}
  else if(path===`digital-production/orders/${id}/closure`)body={orderId:id,revision:'test',productionId:null,stage:'等待回货与装箱',lines:[{lineId:line,poNumber:'TEST-PO1',color:'黑',orderedQuantity:100,actualQuantity:40,documentQuantity:40,defectiveQuantity:0,receiptCount:1,packingQuantity:null,packingRevisionId:null,receivingResolution:null,packingResolution:null,receipts:[{receiptId:receipt,receivedAt:'2026-10-01T10:00:00Z',actualQuantity:40,defectiveQuantity:0}],reworks:[]}],outstanding:['TEST尚未到足量'],canClose:false,canOpenReceiving:true,canOpenRework:true,canOpenWages:false,closed:null,shipmentStatus:'未知',customerReceiptStatus:'未知'};
  else {await route.fulfill({status:path?.includes('notifications')?404:503,json:{error:{code:'TEST_SOURCE_UNAVAILABLE',message:'TEST 数据源不可用'}}});return;}
  await route.fulfill({json:body,headers:{'x-dx-rework-actor-id':id}});
 });return page;
}
try{
 const now=await pageFor(),old=await pageFor(),results=[];
 for(const path of ['/ui/sourcing/pending','/ui/cutting','/ui/orders','/ui/tasks','/ui/suppliers','/ui/samples','/ui/finance','/ui/pattern-room/orders','/ui/admin',`/ui/digital-production?budget=${id}`]){
  await old.goto(`http://127.0.0.1:${baseline}${path}`);await now.goto(`http://127.0.0.1:${current}${path}`);await old.locator('.current-user').waitFor();await now.locator('.current-user').waitFor();await old.waitForTimeout(150);await now.waitForTimeout(150);
  if(path.includes('budget=')){await old.getByRole('heading',{name:'成本预算表'}).waitFor();await now.getByRole('heading',{name:'成本预算表'}).waitFor();}
  assert.equal(await now.locator('.app-shell > main').innerText(),await old.locator('.app-shell > main').innerText(),path);results.push({path,mainTextEqual:true});
 }
 await now.screenshot({path:dir+'/1672-budget-current.png',fullPage:true});
 assert(await now.getByRole('button',{name:'保存预算',exact:true}).isVisible());
 await now.goto(`http://127.0.0.1:${current}/ui/digital-production?budget=${id}&budgetVersion=3`);
 await now.getByRole('heading',{name:'成本预算表'}).waitFor();await now.getByText('已发布 · 版本 3',{exact:true}).waitFor();
 assert.equal(await now.getByLabel('月份系列').inputValue(),'历史3');assert(await now.getByLabel('月份系列').isDisabled());
 assert.equal(await now.getByRole('button',{name:'保存预算',exact:true}).count(),0);assert.equal(await now.getByRole('link',{name:'核实并发起外发'}).count(),0);
 assert(requests.some(path=>path.endsWith('/budget?version=3')));await now.screenshot({path:dir+'/1672-budget-v3.png',fullPage:true});
 await now.goto(`http://127.0.0.1:${current}/ui/digital-production?closure=${id}#receipt-${receipt}`);
 const target=now.locator(`#receipt-${receipt}`);await target.waitFor({state:'visible'});assert(await target.evaluate(element=>element.closest('details').open));
 await now.screenshot({path:dir+'/1672-receipt.png',fullPage:true});
 await now.setViewportSize({width:390,height:844});await now.screenshot({path:dir+'/390-receipt.png',fullPage:true});
 await writeFile(dir+'/result.json',JSON.stringify({head:process.env.V2_EVIDENCE_HEAD??null,base:'5f91af8f2169e85d194e23b65ec3a4409f31f513',viewport:[1672,941],mobile:[390,844],legacy:results,historyBudget:'PASS',exactReceipt:'PASS',requests:'GET only, synthetic fixtures',acceptance:false},null,2));
 console.log('PASS 9 mature empty/error pages and current budget main text; historical budget v3 read-only; exact receipt opened; desktop/mobile screenshots. Synthetic read-only fixture, not UAT.');
}finally{await browser.close();}
