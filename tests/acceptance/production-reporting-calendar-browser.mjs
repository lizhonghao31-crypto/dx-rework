import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-production-calendar-')),results=[],errors=[],states=new Map(),id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let server,browser;
try{
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/production-reporting-calendar.tsx'),name:'CalendarFixture',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://localhost').pathname,scenario=req.headers['x-test-calendar'],state=states.get(scenario)??{reads:0,posts:[]};states.set(scenario,state);
  let raw='';for await(const chunk of req)raw+=chunk;
  const send=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','x-dx-rework-actor-id':id(1)});res.end(JSON.stringify(value));};
  if(!path.startsWith('/api/')){res.writeHead(200,{'content-type':'text/html;charset=utf-8'});res.end(html);return;}
  if(path==='/api/auth/me')return send({status:'authorized',user:{id:id(1),displayName:'TEST Root',isRoot:true,businessRoles:['root_superuser'],capabilities:['production-reporting','sourcing:view']}});
  if(path.endsWith('/notifications/claim'))return send({notification:null,remainingCount:0});
  if(path.endsWith('/todos/mine/indicator'))return send({pendingCount:0,unreadCount:0});
  const day=scenario==='past'?'2026-10-10':scenario==='current'?'2026-10-27':'2026-11-06';
  const detail=(metadata=true)=>({order:{productionOrderId:id(40),sourcingCaseId:id(41),factoryDecisionId:null,firstStyleNo:'TEST-CALENDAR',status:'in_production',dispatchedAt:day+'T00:00:00Z',dispatchedBy:id(1),sourceCaseArchived:false,decisionVersion:1,sourcingContractDocumentId:id(42),contractNumber:'TEST-CONTRACT',contractVersion:1,supplierId:id(43),supplierName:'TEST工厂',gender:'女装',styleName:'TEST款式',quantity:10,completedQuantity:0,processes:[],deliveryDate:null,firstReportedOn:null,reportingState:'pending_first_report',timeProgress:null,progressAlert:null,lines:[{position:1,styleNo:'TEST-CALENDAR',alternateStyleNo:null,color:'TEST蓝',quantity:10,completedQuantity:0}]},canReport:true,canCorrect:true,history:[{reportId:id(70),rootReportId:id(70),revision:1,position:1,businessDate:day,quantity:1,actorName:'TEST Root',createdAt:'2026-10-27T00:00:00Z',reason:null,effective:true}],transitions:[],shipment:null,...(metadata?{businessToday:day,asOf:day+'T09:00:00.000Z'}:{})});
  if(path===`/api/production-reporting/${id(40)}`){state.reads++;return send(detail(scenario!=='legacy-get'||state.reads>1));}
  if(path.startsWith(`/api/production-reporting/${id(40)}/`)&&req.method==='POST'){state.posts.push({path,key:req.headers['idempotency-key'],body:JSON.parse(raw)});return send(detail(scenario!=='legacy-receipt'));}
  return send({error:{message:'TEST unexpected path'}},404);
 });
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({executablePath:process.env.CHROMIUM_EXECUTABLE||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
 for(const scenario of ['past','current','future','legacy-get','legacy-receipt','correction']){
  const page=await browser.newPage({viewport:{width:1280,height:900}});page.setDefaultTimeout(8000);page.on('pageerror',error=>errors.push(error.message));
  await page.addInitScript(()=>{const RealDate=Date;window.Date=class extends RealDate{constructor(...args){super(...(args.length?args:['2001-01-01T00:00:00.000Z']));}static now(){return new RealDate('2001-01-01T00:00:00.000Z').getTime();}};});
  await page.goto(`http://127.0.0.1:${server.address().port}/?case=${scenario}`);
  const day=scenario==='past'?'2026-10-10':scenario==='current'?'2026-10-27':'2026-11-06',date=page.getByLabel('业务日期',{exact:true}),save=page.getByRole('button',{name:'保存上报',exact:true});
  await date.waitFor();await page.waitForFunction(()=>!document.body.innerText.includes('正在加载…'));
  if(scenario==='legacy-get'){
   assert.equal(await date.inputValue(),'');assert.equal(await date.isDisabled(),true);assert.equal(await save.isDisabled(),true);
   await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(day=>document.querySelector('input[type=date]')?.value===day,day);
  }
  assert.equal(await date.inputValue(),day);assert.equal(await date.getAttribute('max'),day);
  if(scenario==='correction'){
   await page.getByText('生产历史（1 条）',{exact:true}).click();await page.getByRole('button',{name:'Root 修正',exact:true}).click();
   const correction=page.getByLabel('业务日期 *',{exact:true});assert.equal(await correction.inputValue(),day);assert.equal(await correction.getAttribute('max'),day);
   await page.getByLabel('修正原因 *',{exact:true}).fill('TEST correction calendar');await page.getByRole('button',{name:'保存修正',exact:true}).click();
  }else{
   await date.fill(day.slice(0,8)+'01');await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes('正在加载…'));
   assert.equal(await date.inputValue(),day.slice(0,8)+'01'); // do not overwrite a selected historical date on refresh
   await date.fill(day);await page.getByLabel('本次新增数量 *',{exact:true}).fill('1');await save.click();
  }
  await page.getByRole('status').filter({hasText:scenario==='correction'?'修正已保存':'本次产量已保存'}).waitFor();
  const posts=states.get(scenario).posts;assert.equal(posts.length,1);assert.equal(posts[0].body.businessDate,day);assert.ok(posts[0].key);
  if(scenario==='legacy-receipt'){
   assert.equal(await save.isDisabled(),true);assert.equal(await page.getByRole('alert').count(),0);
   await page.getByRole('button',{name:'刷新',exact:true}).click();await page.waitForFunction(()=>!document.body.innerText.includes('本单业务日期上限尚未读取'));
   assert.equal(await date.getAttribute('max'),day);assert.equal(states.get(scenario).posts.length,1);
  }
  results.push({scenario,day,realBrowserWall:'2001-01-01',posts:posts.length});await page.close();
 }
 assert.deepEqual(errors,[]);
 if(process.env.PRODUCTION_CALENDAR_EVIDENCE)await writeFile(process.env.PRODUCTION_CALENDAR_EVIDENCE,JSON.stringify({results,errors,limits:['Actual product page against isolated synthetic TEST HTTP; native APIs and SQL run separately. Not deployed Acceptance verification.']},null,2));
 console.log(JSON.stringify({passed:results.length,results,errors}));
}finally{await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(out,{recursive:true,force:true});}
