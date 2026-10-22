// Real App -> designer board -> document -> original confirmation form.
// Synthetic localhost responses only; this runner does not prove server authorization.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {build} from 'vite';
import {DigitalOrderCreateSchema} from '../../packages/contracts/dist/digital-production.js';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-designer-confirm-')),evidence=process.env.DESIGNER_CONFIRM_EVIDENCE;
const sourceId='10000000-0000-4000-8000-000000000001',orderId='10000000-0000-4000-8000-000000000002',actorId='10000000-0000-4000-8000-000000000003';
const today='2026-10-22',shipDate='2099-12-30',style='TEST-CONFIRM-ENTRY';
const customer={code:'TEST',name:'TEST 客户',productGroups:['男装'],defaultMerchandiserId:null,defaultMerchandiserName:null};
const draftOrder={customerCode:'TEST',productGroup:'男装',designStyleNo:style,temporaryStyleNo:null,primaryMerchandiserId:null,orderDate:today,contractDeliveryDate:null,lines:[{formalPoNo:'TEST-PO-SAVED',poNumber:null,formalStyleNo:null,temporaryStyleNo:null,color:'TEST 已保存蓝',colorForeign:null,deliveryDate:null,customerWarehouseArrivalDate:shipDate,sizes:[{size:'M',quantity:'19'}]}]};
const document=()=>({documentFormatVersion:2,sizeQuantities:[1,1],template:'上衣',quantity:2,sampleSize:'',orderDate:'2026-10-20',returnDate:shipDate,unit:'cm',sizes:['M','L'],measurements:[{name:'衫长',values:['60','62']}],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',washingMethod:'',ironing:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST 本轮原制作说明',craft:'无',washing:'免洗',materials:[],files:[]});
const rows=[],errors=[],external=[];let current,browser,server;
const delay=ms=>new Promise(done=>setTimeout(done,ms));
try{
 await build({configFile:false,logLevel:'warn',esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('apps/web/src/main.tsx'),name:'DesignerConfirmActualApp',formats:['iife']}}});
 const files=await readdir(output),js=await readFile(join(output,files.find(f=>f.endsWith('.js'))),'utf8'),css=await Promise.all(files.filter(f=>f.endsWith('.css')).map(f=>readFile(join(output,f),'utf8')));
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css.join('\n')}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost'),path=url.pathname,run=current;
  if(!path.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);return;}
  let raw='';for await(const chunk of req)raw+=chunk;
  const record={path,search:url.search,method:req.method,key:req.headers['idempotency-key']??null,body:raw?JSON.parse(raw):null};run.requests.push(record);
  const send=(value,status=200)=>{if(!res.destroyed){res.writeHead(status,{'content-type':'application/json','x-dx-rework-actor-id':actorId});res.end(JSON.stringify(value));}};
  const ordered=Boolean(run.order),published=run.scenario!=='draft',root=run.scenario==='root',create=run.scenario!=='no-create',own=run.scenario!=='other-designer';
  const sheet={sourceId,productionOrderId:ordered?orderId:null,designStyleNo:style,temporaryStyleNo:null,customerCode:'TEST',developmentType:'头版',designerName:'TEST 设计师',version:2,status:published?'published':'draft',publishedAt:published?'2026-10-20T00:00:00Z':null,taskId:sourceId,canEdit:own||root,canRevise:false,roundNumber:2,latestRoundNumber:2,document:{...document(),...(run.scenario==='saved-draft'?{customerOrderDraft:{withOrder:true,order:draftOrder}}:{})},materialEvents:[]};
  const journey={id:sourceId,sourceId,orderId:ordered?orderId:null,designStyleNo:style,temporaryStyleNo:null,customer:'TEST',category:'TEST 上衣',designer:'TEST 设计师',styleName:'TEST 入口',merchandisers:[],orderNumbers:ordered?['TEST-PO']:[],createdAt:'2026-10-20T00:00:00Z',deliveryDate:ordered?shipDate:null,selectedRound:2,adoptedRound:null,sourceVersion:2,instructionVersion:null,lines:ordered?run.order.lines.map(line=>({id:line.lineId,po:line.formalPoNo,color:line.color,formalStyleNo:line.formalPoNo,temporaryStyleNo:null,orderedQuantity:line.sizes.reduce((n,s)=>n+s.quantity,0)})):[],links:[],stages:[],progress:{development:null,bulk:null},hitReasons:[]};
  if(path==='/api/auth/me'){send({status:'authorized',user:{id:actorId,displayName:'TEST 设计师',isRoot:root,businessRoles:root?['root_superuser']:run.scenario==='forbidden'?['order_merchandiser']:['sample_designer'],capabilities:['digital_production:view','pattern_room:orders:create','todo:view']}});return;}
  if(path.endsWith('/indicator')){send({pendingCount:0,unreadCount:0});return;}
  if(path.includes('/notifications/')){send({notification:null,remainingCount:0});return;}
  if(path==='/api/pattern-room/category-options'){send([]);return;}
  const base='/api/digital-production';
  if(path===base+'/options'){send({creationEnabled:run.scenario!=='disabled',customers:[customer],minimumInitialCustomerDate:'2026-11-05',serverToday:today});return;}
  if(path===base+'/access/options'){send({manage:root,customers:false,approveDelivery:false,create,actorId,roles:root?[]:['sample_designer']});return;}
  if(path===base+'/workspaces/designer'){
   if(run.scenario==='forbidden'){send({error:{code:'FORBIDDEN',message:'当前身份无权读取设计师档案'}},403);return;}
   const view=ordered?'ordered':published?'awaiting_order':'draft',items=ordered&&url.searchParams.get('view')==='awaiting_order'?[]:[{journey,view,canConfirm:!ordered&&(own||root)}];
   send({asOf:'2026-10-22T05:30:00Z',page:2,pageSize:15,total:30,counts:{all:30,draft:0,developing:0,awaiting_order:ordered?0:1,ordered:ordered?1:0},customers:['TEST'],designers:['TEST 设计师'],items});return;
  }
  if(path===base+`/document-directory/source/${sourceId}`){send({development:{state:'available',id:sourceId},instruction:{state:ordered?'missing':'not_applicable'},budget:{state:ordered?'missing':'not_applicable'}});return;}
  if(path===base+`/sources/${sourceId}/development`&&req.method==='GET'){send(sheet);return;}
  if(path===base+`/sources/${sourceId}/development/rounds`){send({rounds:[{roundNumber:2,origin:'客户新增要求',customerComment:'TEST',internalProblem:'',explanation:'TEST 第2轮',affectedNodes:['纸样'],inherited:{}}],draft:null});return;}
  if(path===base+`/orders/${orderId}`&&req.method==='GET'){
   if(run.scenario==='order-read-fail'&&!run.recovered){send({error:{code:'TEST_READ_FAILED',message:'TEST 关联订单读取暂不可用'}},503);return;}
   send(run.order);return;
  }
  if(path===base+`/sources/${sourceId}/confirm`&&req.method==='POST'){
   if(run.scenario==='rejected'&&!run.recovered){send({error:{code:'VALIDATION_ERROR',message:'TEST 客户资料已停用，请核对客户'}},409);return;}
   const input=DigitalOrderCreateSchema.parse(record.body);
   if(run.commands.has(record.key)){assert.deepEqual(run.commands.get(record.key),input,'same key retains original body');}
   else{run.commands.set(record.key,input);if(!run.order){run.order={...input,productionOrderId:orderId,sourceId,createdBy:actorId,version:1,createdAt:'2026-10-22T05:30:00Z',lines:input.lines.map((line,index)=>({...line,lineId:`10000000-0000-4000-8000-${String(index+10).padStart(12,'0')}`}))};run.created++;}}
   if(run.scenario==='unknown'&&!run.lost){run.lost=true;res.writeHead(200,{'content-type':'application/json','x-dx-rework-actor-id':actorId});res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),25);return;}
   await delay(120);send(run.order);return;
  }
  if(req.method!=='GET')run.unexpectedWrites.push(record);
  send({error:{code:'TEST_UNMAPPED',message:'TEST 未连接的只读资料'}},404);
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));const origin='http://127.0.0.1:'+server.address().port;
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const scenario of ['normal','saved-draft','already-confirmed','draft','other-designer','no-create','disabled','forbidden','root','rejected','unknown','unknown-refresh','order-read-fail']){
  console.log('START '+scenario);const run=current={scenario,requests:[],commands:new Map(),order:null,created:0,unexpectedWrites:[],recovered:false,lost:false};
  if(scenario==='already-confirmed')run.order={...DigitalOrderCreateSchema.parse({...draftOrder,lines:draftOrder.lines.map(line=>({...line,sizes:[{size:'M',quantity:19}]}))}),productionOrderId:orderId,sourceId,lines:[]};
  // unknown-refresh uses the same dropped-response branch, then a full browser reload.
  if(scenario==='unknown-refresh')run.scenario='unknown';
  const context=await browser.newContext({viewport:{width:scenario==='normal'?390:1440,height:960}}),page=await context.newPage();
  page.setDefaultTimeout(15000);page.setDefaultNavigationTimeout(15000);page.on('pageerror',error=>errors.push({scenario,message:error.message}));
  await context.route('**/*',route=>{if(route.request().url().startsWith(origin))return route.continue();external.push(route.request().url());return route.abort();});
  const query=new URLSearchParams({workspace:'designer',page:'2',search:style,customer:'TEST',designer:'TEST 设计师',view:scenario==='normal'?'awaiting_order':'all',startDate:'2026-10-01',endDate:'2026-10-31',selected:sourceId});
  const board=origin+'/ui/digital-production?'+query;
  try{
   await page.goto(board,{waitUntil:'domcontentloaded'});console.log(scenario+' board loaded');
   const button=()=>page.getByRole('button',{name:'客户确定订单',exact:true});
   if(scenario==='forbidden'){
    await page.getByRole('alert').filter({hasText:'当前身份无权读取设计师档案'}).waitFor();assert.equal(await button().count(),0);assert.equal(run.created,0);rows.push({scenario,result:'pass',requests:run.requests});continue;
   }
   await page.getByRole('link',{name:'打开开发单',exact:true}).waitFor();assert.equal(await button().count(),0,'old archive has no confirmation entry');
   const firstOpen=await page.getByRole('link',{name:'打开开发单',exact:true}).getAttribute('href');await page.getByRole('link',{name:'打开开发单',exact:true}).click({noWaitAfter:true});
   await page.locator('.order-document-container>header').waitFor();console.log(scenario+' detail opened');const detailUrl=page.url();
   for(const key of query.keys())assert.equal(new URL(detailUrl).searchParams.get(key),query.get(key));assert.equal(new URL(detailUrl).searchParams.get('round'),'2');
   if(['already-confirmed','draft','other-designer','no-create','disabled'].includes(scenario)){
    await page.waitForFunction(()=>!document.body.innerText.includes('正在核对资料权限'));
    await delay(120);assert.equal(await button().count(),0);assert.equal(run.created,0);if(scenario==='draft')await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).waitFor();rows.push({scenario,result:'pass',firstOpen,requests:run.requests});continue;
   }
   await page.locator('.order-document-container>header').getByRole('button',{name:'客户确定订单',exact:true}).click();
   await page.getByRole('heading',{name:'客户确定订单 · 补订购信息',exact:true}).waitFor();console.log(scenario+' confirm opened');assert.equal(page.url(),detailUrl,'confirmation remains in the original detail route');
   assert.equal(await page.getByLabel('PO 1 出货日期',{exact:true}).count(),1);
   const fill=async()=>{await page.getByLabel('PO 1 正式款号 / PO',{exact:true}).fill('TEST-PO-ENTRY');await page.getByLabel('PO 1 颜色',{exact:true}).fill('TEST 蓝');await page.getByLabel('尺码列 1',{exact:true}).fill('M');await page.getByLabel('PO 1 订购数量 1',{exact:true}).fill('19');await page.getByLabel('PO 1 出货日期',{exact:true}).fill(shipDate);};
   if(scenario==='saved-draft'){
    assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST 已保存蓝');assert.equal(await page.getByLabel('PO 1 订购数量 1',{exact:true}).inputValue(),'19');assert.equal(await page.getByLabel('PO 1 出货日期',{exact:true}).inputValue(),shipDate);assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).isDisabled(),true);
   }else await fill();
   if(scenario==='normal'){
    await page.getByRole('button',{name:'返回开发单',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'取消',exact:true}).click();assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST 蓝');
    await page.getByRole('button',{name:'返回开发单',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'确认',exact:true}).click();await button().waitFor();assert.equal(page.url(),detailUrl);assert.equal(run.created,0);
    await button().click();await page.getByRole('heading',{name:'客户确定订单 · 补订购信息',exact:true}).waitFor();await fill();
   }
   const form=page.getByRole('button',{name:'确认下单',exact:true}).locator('xpath=ancestor::form');
   await form.evaluate(node=>{node.requestSubmit();node.requestSubmit();});
   if(scenario==='rejected'){
    await page.getByRole('alert').filter({hasText:'TEST 客户资料已停用'}).waitFor();assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST 蓝');assert.equal(run.created,0);run.recovered=true;await page.getByRole('button',{name:'确认下单',exact:true}).click();
   }
   if(['unknown','unknown-refresh'].includes(scenario)){
    await page.getByRole('status').filter({hasText:'本次客户订单确认未取得成功回执'}).waitFor();assert.equal(run.created,1);assert.equal(await page.getByLabel('PO 1 颜色',{exact:true}).inputValue(),'TEST 蓝');
    if(scenario==='unknown-refresh'){await page.reload();await page.locator('.order-document-container>header').waitFor();await delay(150);assert.equal(await button().count(),0);assert.equal(run.requests.filter(r=>r.path.endsWith('/confirm')).length,1);rows.push({scenario,result:'pass',created:run.created,requests:run.requests});continue;}
    await page.getByRole('button',{name:'确认下单',exact:true}).click();
   }
   await page.getByRole('status').filter({hasText:'客户订单已确认。'}).waitFor();if(scenario==='unknown'){const writes=run.requests.filter(r=>r.path.endsWith('/confirm'));assert.equal(writes.length,2);assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);}await page.locator('.order-document-container>header').waitFor();assert.equal(page.url(),detailUrl);assert.equal(await button().count(),0);assert.equal(run.created,1);assert.equal(run.unexpectedWrites.length,0);assert.equal(run.requests.filter(r=>r.path.endsWith('/confirm')).length,['unknown','rejected'].includes(scenario)?2:1,'duplicate submit is suppressed and retries are bounded');
   if(scenario==='order-read-fail'){await page.getByRole('alert').filter({hasText:'订单确认已成功，关联订单读取失败'}).waitFor();run.recovered=true;await page.getByRole('button',{name:'重试读取关联订单',exact:true}).click();}
   await page.getByRole('status').filter({hasText:`已读取关联订单：${style}`}).waitFor();assert.ok(run.requests.filter(r=>r.path.endsWith('/document-directory/source/'+sourceId)).length>=2,'directory re-read after success');
   assert.ok(run.requests.some(r=>r.path.endsWith('/orders/'+orderId)&&r.method==='GET'),'linked customer order explicitly re-read');
   if(evidence)await page.screenshot({path:join(evidence,scenario+'-confirmed.png'),fullPage:true});
   await page.getByRole('button',{name:'返回来源',exact:true}).click();await page.getByRole('link',{name:'打开开发单',exact:true}).waitFor({state:scenario==='normal'?'hidden':'visible'});
   const back=new URL(page.url());for(const key of query.keys())assert.equal(back.searchParams.get(key),query.get(key));assert.equal(await button().count(),0,'archive entry remains removed');
   rows.push({scenario,result:'pass',created:run.created,firstOpen,requests:run.requests});
  }catch(error){console.log(JSON.stringify({scenario,url:page.url(),errors,requestCount:run.requests.length,lastRequests:run.requests.slice(-15)}));if(evidence){await writeFile(join(evidence,scenario+'-requests.json'),JSON.stringify(run.requests,null,2));await writeFile(join(evidence,scenario+'-failure.txt'),await page.locator('body').innerText());await page.screenshot({path:join(evidence,scenario+'-failure.png'),fullPage:true});}throw error;}
  finally{await context.close();}
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{
 if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({actualEntry:'apps/web/src/main.tsx',results:rows,errors,external,limits:['Localhost synthetic HTTP with real App/workspace/container/form; no live order or Acceptance session.','Original confirmation endpoint and permission/idempotency server code unchanged; this is UI interaction evidence.']},null,2));
 await browser?.close();server?.closeAllConnections();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:rows.length,scenarios:rows.map(row=>row.scenario),errors,external}));
