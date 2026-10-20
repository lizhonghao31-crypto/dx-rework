import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-amendment-')),evidence=process.env.AMENDMENT_EVIDENCE,results=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/development-amendment.tsx'),name:'AmendmentFixture',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 for(const [width,supplyOnly,legacy,legacyDraft] of [[1440,false,false],[390,false,false],[1440,true,false],[390,true,false],[1440,true,true],[390,true,true],[1440,true,true,true]]){
  const page=await browser.newPage({viewport:{width,height:900}}),errors=[],writes=[],reads=[];page.on('pageerror',error=>errors.push(error.message));
  const sourceId='00000000-0000-4000-8000-000000000001',taskId='00000000-0000-4000-8000-000000000002',materialId='00000000-0000-4000-8000-000000000003';
  const document={template:'上衣',quantity:1,sampleSize:'M',orderDate:'2026-10-20',returnDate:null,unit:'cm',sizes:['M'],measurements:[],interlining:'',placketInterlining:'',sewingThread:'',buttonholeThread:'',stitchDensity:'',washingIroning:'',packaging:'',formalSizes:'',casualSizes:'',mainLabel:false,mainLabelMethod:'',sizeLabel:false,careLabel:false,instructions:'TEST原说明',craft:'无',washing:'免洗',materials:[{materialId,category:'主布',label:'TEST主布',name:'TEST棉布',specification:legacy?'':'40支',quantity:'1',color:'黑',supplier:'',width:'',weight:'',composition:'',consumption:'',requiredThisRound:false,available:true,expectedDate:null}],files:[{attachmentId:'00000000-0000-4000-8000-000000000004',kind:'款图'}]};
  let saved=false,committed=false,receiptReads=0;
  await page.route('**/digital-production/**',async route=>{
   const request=route.request(),url=new URL(request.url()),method=request.method();
   if(method==='GET'){
    reads.push(url.pathname);
    if(url.pathname.endsWith('/amendment/receipt')){assert.equal(url.searchParams.get('taskId'),taskId);assert.equal(url.searchParams.get('operation'),'submit');assert.equal(url.searchParams.get('key'),writes.at(-1).key);receiptReads++;await route.fulfill({json:{receipt:receiptReads===1?null:{documentVersion:supplyOnly?2:3,originatingTaskId:taskId}}});return;}
    assert.ok(url.pathname.endsWith('/amendment'));await route.fulfill({json:{sourceId,taskId,roundNumber:1,documentVersion:2,document,directSupplyMode:legacy?'legacy':supplyOnly?'structured':null,issues:legacy?[]:[{materialId,field:supplyOnly?'physical':'specification',need:supplyOnly?'supply':'document',reason:supplyOnly?'TEST实物未到':'TEST规格写错'}],note:'TEST请补正规格',draft:legacyDraft?{version:1,document:structuredClone(document),reason:''}:null}});return;
   }
   const body=request.postDataJSON(),key=request.headers()['idempotency-key'];writes.push({method,body,key});assert.ok(key);assert.equal(body.taskId,taskId);assert.equal(body.roundNumber,1);assert.equal(body.expectedDocumentVersion,2);
   if(method==='PUT'){if(!saved){saved=true;await route.fulfill({status:409,json:{error:{message:'TEST其他窗口修改，请核对差异'}}});return;}await route.fulfill({json:{draftVersion:1,documentVersion:2,originatingTaskId:taskId}});return;}
   assert.equal(method,'POST');assert.ok(url.pathname.endsWith('/amendment/submit'));assert.equal(body.expectedDraftVersion,legacyDraft?1:supplyOnly?0:1);committed=true;await route.abort('failed');
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const spec=page.getByRole('textbox',{name:'补正 TEST主布 规格',exact:true});await spec.waitFor();
  if(!supplyOnly){await spec.fill('42支');await page.getByRole('textbox',{name:'本次具体补正 / 澄清说明'}).fill('TEST已核实规格为42支');}
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'editable form stays within viewport');if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,`amendment-edit-${width}-${legacy?'legacy':supplyOnly?'supply':'document'}.png`),fullPage:true});}
  if(!supplyOnly){
   await page.getByRole('button',{name:'保存补正草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST其他窗口修改'}).waitFor();assert.equal(await spec.inputValue(),'42支');
   await page.getByRole('button',{name:'保存补正草稿',exact:true}).click();await page.getByRole('status').filter({hasText:'草稿已保存'}).waitFor();assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);
  }
  await page.getByRole('button',{name:supplyOnly?'补料已记录，交文员复核':'提交补正并交文员复核',exact:true}).click();await page.getByText('本次操作结果未知，暂时保留输入与原操作，核对完成前不能另存或另提。').waitFor();assert.equal(committed,true);assert.equal(await spec.isDisabled(),true);const count=writes.length;
  await page.getByRole('button',{name:'核对本次操作回执',exact:true}).click();await page.getByRole('alert').filter({hasText:'不能据此认定没有提交'}).waitFor();assert.equal(writes.length,count);assert.equal(await spec.isDisabled(),true);
  await page.getByRole('button',{name:'核对本次操作回执',exact:true}).click();await page.getByRole('status').filter({hasText:'本次补正 / 补料已提交'}).waitFor();await page.getByRole('alert').filter({hasText:'无需重复提交补正'}).waitFor();assert.equal(writes.length,count);assert.equal(await page.getByRole('button',{name:supplyOnly?'补料已记录，交文员复核':'提交补正并交文员复核',exact:true}).count(),0);
  assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  if(evidence){await mkdir(evidence,{recursive:true});await page.screenshot({path:join(evidence,`amendment-${width}-${legacy?'legacy':supplyOnly?'supply':'document'}.png`),fullPage:true});}results.push({width,supplyOnly,legacy,legacyDraft:Boolean(legacyDraft),writes:writes.length,receiptReads,checks:[...(supplyOnly?['physical-only sends one submit and zero draft PUTs']:['409 retains input','same frozen command/key on retry']),'unknown write locks edits','read-only receipt lookup never resubmits','missing receipt remains unknown','committed receipt and failed refresh do not reissue mutation'],limits:'Actual React component with synthetic TEST HTTP responses; real PostgreSQL/service integration tested separately, no site/ECS acceptance.'});await page.close();
 }
}finally{if(evidence){await mkdir(evidence,{recursive:true});await writeFile(join(evidence,'result.json'),JSON.stringify({results},null,2));}await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,results}));
