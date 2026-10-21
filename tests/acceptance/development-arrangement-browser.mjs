import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-arrangement-')),evidence=process.env.ARRANGEMENT_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/development-arrangement.tsx'),name:'Arrangement',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(name=>name.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(name=>name.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?task=00000000-0000-4000-8000-000000000002`);
  for(const field of ['实物已到','数量相符','颜色相符','规格相符'])await page.getByRole('checkbox',{name:`TEST主布 ${field}`}).check();
  await page.getByRole('button',{name:'核对完成并提交'}).click();
  await page.getByRole('heading',{name:'第 1 轮 · 安排本轮师傅'}).waitFor();assert.match(page.url(),/arrangement=00000000-0000-4000-8000-000000000001&round=1/);
  await page.getByText('核料已完成。本页可一次安排本轮师傅。',{exact:true}).waitFor();assert.equal(await page.getByRole('dialog').count(),0);
  for(const label of ['纸样','裁板','车板','尾查']){await page.getByRole('combobox',{name:`安排${label}`,exact:true}).click();await page.getByRole('option',{name:label==='尾查'?'TEST尾查':'TEST师傅',exact:true}).click();}
  await page.getByRole('button',{name:'保存本轮安排',exact:true}).click();await page.getByText(/尚未确认本次提交是否成功/).waitFor();
  await page.getByRole('button',{name:'重新读取已提交结果'}).click();await page.getByText(/本次安排操作已保存/).waitFor();
  const state=await page.evaluate(()=>structuredClone(window.unifiedDispatch));assert.equal(state.checks,1);assert.equal(state.commits,1);assert.equal(state.arrangementWrites.length,2);assert.equal(state.arrangementWrites[0].key,state.arrangementWrites[1].key);assert.deepEqual(state.arrangementWrites[0].body,state.arrangementWrites[1].body);assert.equal(state.saved.arrangement.rows.every(row=>row.valid),true);assert.deepEqual(state.unexpected,[]);
  await page.getByText('主管接管 / 交回文员',{exact:true}).click();await page.getByRole('textbox',{name:'接管或交回原因'}).fill('TEST接管原因');await page.getByRole('button',{name:'接管本轮安排',exact:true}).click();await page.getByText('本轮由TEST主管接管安排。',{exact:true}).waitFor();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'no viewport overflow');
  if(evidence)await page.screenshot({path:join(evidence,`arrangement-${viewport.width}.png`),fullPage:true});results.push({viewport,checks:['material success auto navigates same source/round without dirty prompt','single total assignment uses existing select components','lost write response retries identical command exactly once','takeover reason remains usable','no document overflow']});await page.close();
 }
 const savePage=await browser.newPage({viewport:{width:1440,height:900}});await savePage.goto(`http://127.0.0.1:${server.address().port}/?task=00000000-0000-4000-8000-000000000002&saveFailure=read`);
 await savePage.getByRole('checkbox',{name:'TEST主布 颜色相符',exact:true}).check();await savePage.getByRole('button',{name:'保存核料输入',exact:true}).click();
 await savePage.getByText(/保存已确认，最新资料尚未读回/).waitFor();assert.equal(await savePage.getByRole('button',{name:'保存核料输入',exact:true}).isDisabled(),true);
 await savePage.getByRole('button',{name:'核对原核料提交结果',exact:true}).click();await savePage.getByText('输入已保存为草稿；提交后才成为本轮核料记录。',{exact:true}).waitFor();
 assert.equal(await savePage.evaluate(()=>window.unifiedDispatch.materialWrites),1);assert.equal(await savePage.evaluate(()=>window.unifiedDispatch.checks),0);assert.doesNotMatch(savePage.url(),/arrangement=/);
 results.push({failure:'saved-readback',checks:['confirmed save reread sends no mutation','draft receipt restored after successful reread','no formal check or navigation']});await savePage.close();
 for(const failure of ['navigation','reject','unknown','read']){
  const page=await browser.newPage({viewport:{width:1440,height:900}});page.on('pageerror',error=>errors.push(error.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?task=00000000-0000-4000-8000-000000000002&${failure==='navigation'?'navigationFailure=1':`checkFailure=${failure}`}`);
  for(const field of ['实物已到','数量相符','颜色相符','规格相符'])await page.getByRole('checkbox',{name:`TEST主布 ${field}`,exact:true}).check();
  await page.getByRole('button',{name:'核对完成并提交',exact:true}).click();
  if(failure==='navigation'){
   await page.getByText(/委派页暂未打开，请重新打开/).waitFor();assert.doesNotMatch(page.url(),/arrangement=/);
   await page.evaluate(()=>{window.unifiedDispatch.navigationBlocked=false;});await page.getByRole('link',{name:'打开本轮委派页',exact:true}).click();
  }else if(failure==='unknown'){
   await page.getByRole('button',{name:'核对原核料提交结果',exact:true}).waitFor();assert.doesNotMatch(page.url(),/arrangement=/);
   assert.equal(await page.getByRole('button',{name:'核对完成并提交',exact:true}).isDisabled(),true);
   await page.getByRole('button',{name:'核对原核料提交结果',exact:true}).click();
  }else if(failure==='reject'){
   await page.getByText(/输入已保存，本次核料尚未取得完成回执/).waitFor();assert.doesNotMatch(page.url(),/arrangement=/);
   assert.equal(await page.evaluate(()=>window.unifiedDispatch.checks),0);assert.equal(await page.evaluate(()=>window.unifiedDispatch.saved.materialVerification.version),1);
   results.push({failure,checks:['saved draft survives definite check rejection','no navigation or formal fact']});await page.close();continue;
  }
  await page.getByRole('heading',{name:'第 1 轮 · 安排本轮师傅'}).waitFor();
  const state=await page.evaluate(()=>structuredClone(window.unifiedDispatch));assert.equal(state.checks,1);
  assert.equal(state.checkRequests.length,failure==='unknown'?2:1);
  if(failure==='unknown'){assert.equal(state.checkRequests[0].key,state.checkRequests[1].key);assert.deepEqual(state.checkRequests[0].body,state.checkRequests[1].body);}
  results.push({failure,checks:['same source/round navigation','one formal check',...(failure==='navigation'?['navigation retry sends no write']:failure==='unknown'?['unknown retry retains original command and key']:['confirmed check navigates even readback fails'])]});await page.close();
 }
 assert.deepEqual(errors,[]);
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:'Actual React components with synthetic TEST responses; no business data or deployment.'},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,results,errors}));
