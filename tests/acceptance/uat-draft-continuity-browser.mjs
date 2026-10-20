import assert from 'node:assert/strict';
import {build} from 'vite';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-uat-draft-')),baseline=process.env.UAT_DRAFT_BASELINE==='1',evidence=process.env.UAT_DRAFT_EVIDENCE;
const results=[],errors=[],external=[];let browser,server,activePage;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},plugins:baseline?[{name:'frozen-before',load(file){if(file===resolve('apps/web/src/digital-development-create-form.tsx'))return execFileSync('git',['show','3253b83f105e6f2cb1a1d6207dc92f8a416b5bfb:apps/web/src/digital-development-create-form.tsx'],{encoding:'utf8'});}}]:[],define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/uat-draft-continuity.tsx'),name:'UatDraftContinuity',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});activePage=page;page.setDefaultTimeout(15000);page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>{
   const request=route.request();if(new URL(request.url()).hostname==='127.0.0.1'&&request.isNavigationRequest())return route.continue();
   if(request.url().includes('/development/attachments/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><rect width="20" height="20" fill="#daeafa"/></svg>'});
   external.push(request.url());return route.abort();
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.getByText('执行单价：40.000 元/件',{exact:true}).waitFor();
  const state=()=>page.evaluate(()=>structuredClone(window.uatDraftContinuity)),note=page.getByRole('textbox',{name:/制作说明/}),back=page.getByRole('button',{name:'返回列表',exact:true});
  await note.fill('TEST 保存成功后发布被拒绝');await page.getByRole('button',{name:'发布开发单并确认订单',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST 发布被拒绝'}).waitFor();
  let saved=await state();assert.equal(saved.saved.document.instructions,'TEST 保存成功后发布被拒绝');assert.equal(saved.saved.version,2);assert.equal(saved.requests.filter(r=>r.path.endsWith('/development/publish')).length,1);assert.equal(saved.requests.filter(r=>r.path.endsWith('/confirm')).length,0);
  if(evidence)await page.screenshot({path:join(evidence,`saved-publish-rejected-${viewport.width}.png`),fullPage:false});
  await back.click();
  if(baseline){await page.getByRole('dialog').waitFor();assert.match(await page.getByRole('dialog').innerText(),/有未保存开发资料/);results.push({viewport,reproduced:'PUT committed and publish rejected, but original return falsely warns unsaved'});await page.close();continue;}
  await page.getByText('TEST 来源列表',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByRole('button',{name:'TEST 重开草稿'}).click();await note.waitFor();assert.equal(await note.inputValue(),'TEST 保存成功后发布被拒绝');assert.equal((await state()).saved.document.customerOrderDraft.order.lines.length,3);
  await note.fill('TEST 目录未保存');await page.getByRole('button',{name:'TEST 切换资料目录'}).click();await page.getByRole('dialog').waitFor();await page.locator('[data-system-dialog-cancel]').click();assert.equal(await note.inputValue(),'TEST 目录未保存');
  await page.evaluate(()=>window.uatDraftContinuity.failSave=true);await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('alert').filter({hasText:'TEST 保存失败'}).waitFor();await back.click();await page.getByRole('dialog').waitFor();await page.locator('[data-system-dialog-cancel]').click();assert.equal((await state()).saved.document.instructions,'TEST 保存成功后发布被拒绝');
  await page.getByRole('button',{name:'保存开发资料草稿',exact:true}).click();await page.getByRole('status').filter({hasText:'开发资料与订购草稿已保存'}).waitFor();await back.click();await page.getByText('TEST 来源列表',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  await page.getByRole('button',{name:'TEST 重开草稿'}).click();await note.waitFor();assert.equal(await note.inputValue(),'TEST 目录未保存');
  await page.evaluate(()=>window.uatDraftContinuity.failPublish=false);await page.getByRole('button',{name:'发布开发单并确认订单',exact:true}).click();await page.getByText('TEST 来源列表',{exact:true}).waitFor();saved=await state();assert.equal(saved.saved.status,'published');assert.equal(saved.created,1);assert.equal(saved.requests.filter(r=>r.method==='POST'&&r.path.endsWith('/sources')).length,0);assert.deepEqual(saved.unexpected,[]);
  results.push({viewport,checks:['successful PUT followed by publish rejection is saved, not unsaved','reopen retains complete three-PO draft','directory switch respects existing dirty guard','failed save retains input and dirty protection','retry advances baseline and exits without prompt','successful publish confirms the original source once']});if(evidence)await page.screenshot({path:join(evidence,`completed-${viewport.width}.png`)});await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}catch(error){if(evidence&&activePage&&!activePage.isClosed())await writeFile(join(evidence,'failure.json'),JSON.stringify({message:error.message,body:await activePage.locator('body').innerText(),state:await activePage.evaluate(()=>window.uatDraftContinuity)},null,2));throw error;}
finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({baseline,results,errors,external,limits:'Actual components and synthetic TEST requests; no production or Acceptance data.'},null,2));await browser?.close();if(server)await new Promise(r=>server.close(r));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({baseline,passed:results.length,results,errors,external}));
