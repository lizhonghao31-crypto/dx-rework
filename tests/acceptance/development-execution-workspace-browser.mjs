import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-execution-workspace-')),evidence=process.env.EXECUTION_WORKSPACE_EVIDENCE,results=[],errors=[];let browser,server,currentPage;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/development-execution-workspace.tsx'),name:'ExecutionWorkspace',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390])for(const mode of ['initial','rework','receipt','retry','later']){
  const page=await browser.newPage({viewport:{width,height:900}});currentPage=page;page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  // The digital round is numeric; it must never become a native round UUID query.
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&round=2&arrangement=00000000-0000-4000-8000-000000000001`);
  await page.getByRole('heading',{name:'原执行特殊办理',exact:true}).waitFor();
  if(mode==='initial'){assert.equal(await page.getByRole('button',{name:'确认分配',exact:true}).count(),0);assert.equal(await page.getByRole('link',{name:'打开总委派'}).count(),0);}
  else if(mode==='rework'){
   const amount=page.getByLabel('本轮返工金额（元）',{exact:true});await amount.waitFor();assert.equal(await amount.inputValue(),'');
   await page.getByRole('combobox',{name:'板房师傅',exact:true}).click();await page.getByRole('option',{name:'TEST接手师傅',exact:true}).click();
   assert.equal(await page.getByRole('button',{name:'确认分配',exact:true}).isDisabled(),true);await amount.fill('0');await page.getByRole('button',{name:'确认分配',exact:true}).click();await page.waitForFunction(()=>window.executionWorkspaceFixture.changed===1);
   const state=await page.evaluate(()=>window.executionWorkspaceFixture);assert.equal(state.commits,1);assert.equal(state.requests.find(r=>r.method==='POST').body.amount,'0');
  }else{
   await page.getByRole('button',{name:'原单换人',exact:true}).click();await page.getByRole('combobox',{name:'接手师傅',exact:true}).click();await page.getByRole('option',{name:'TEST接手师傅',exact:true}).click();
   await page.getByLabel('原工人应得部分（元，无实际制作填0）',{exact:true}).fill('0');await page.getByRole('textbox',{name:/^操作说明（必填）/}).fill('TEST原工人未制作');
   await page.getByRole('button',{name:'原单换人',exact:true}).click();await page.getByText('尚未确认换人是否成功。',{exact:false}).waitFor();
   assert.equal(await page.getByRole('button',{name:'原单换人',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('textbox',{name:/^操作说明（必填）/}).isDisabled(),true);
   await page.getByRole('button',{name:mode==='retry'?'沿原标识重试换人':'核对原换人回执',exact:true}).click();await page.waitForFunction(()=>window.executionWorkspaceFixture.changed===1);
   const state=await page.evaluate(()=>window.executionWorkspaceFixture),writes=state.requests.filter(r=>r.method==='POST');assert.equal(state.commits,1);assert.equal(state.receiptReads,1);assert.equal(writes.length,mode==='retry'?2:1);
   assert.equal(writes[0].body.expectedArrangementVersion,4);assert.equal(writes[0].body.roundNumber,2);assert.ok(writes[0].key);
   if(mode==='retry'){assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);}if(mode==='later')await page.getByText('本次换人已有回执，之后又有新的办理；当前显示最新人员和执行段。',{exact:true}).waitFor();
  }
  const state=await page.evaluate(()=>window.executionWorkspaceFixture);assert.ok(state.requests.filter(r=>r.method==='GET'&&r.path.includes('/orders/')).every(r=>!r.path.includes('?')));
  assert.equal(await page.getByRole('button',{name:'报完工',exact:true}).count(),0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({width,mode,requests:state.requests});await page.close();
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&currentPage){await currentPage.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await currentPage.locator('body').innerText());}throw error;}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual React workspace with synthetic HTTP; transaction and role behavior separately tested against PostgreSQL. No site/ECS acceptance.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
