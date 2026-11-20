import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright'),out=await mkdtemp(join(tmpdir(),'dx-auxiliary-')),evidence=process.env.AUXILIARY_EVIDENCE,results=[],errors=[];let browser,server,current;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/auxiliary-catalog.tsx'),name:'AuxiliaryFixture',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.M01_SETTINGS_BROWSER_EXECUTABLE??'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 const scenarios=process.env.AUXILIARY_SCENARIOS?.split(',')??['select','create','unknown','timeout','retry','denied','wait'];
 for(const width of [1440,390])for(const mode of scenarios){
  const page=await browser.newPage({viewport:{width,height:900}});current=page;page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push(e.message));const origin=`http://127.0.0.1:${server.address().port}/?mode=${mode}`;await page.goto(origin);
  const trigger=page.getByRole('button',{name:'选择共享辅料 1',exact:true});await trigger.click();await page.getByRole('dialog',{name:'共享辅料',exact:true}).waitFor();
  if(mode==='wait'){
   const dialog=page.getByRole('dialog',{name:'共享辅料',exact:true}),feedback=dialog.getByRole('status').filter({hasText:'请稍等'});
   await feedback.waitFor();
   const position=await feedback.evaluate(element=>{
    const box=element.getBoundingClientRect();
    return {inModal:Boolean(element.closest('dialog:modal')),pointer:getComputedStyle(element).pointerEvents,
     x:Math.abs((box.left+box.right)/2-innerWidth/2),y:Math.abs((box.top+box.bottom)/2-innerHeight/2)};
   });
   assert.equal(position.inModal,true);assert.equal(position.pointer,'none');
   assert.ok(position.x<2&&position.y<2,JSON.stringify(position));
   await dialog.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill('扁机');
   await dialog.getByRole('button',{name:'选择此辅料',exact:true}).click();
   await dialog.waitFor({state:'hidden'});await page.evaluate(()=>window.releaseDirectory());
   assert.equal(await page.getByText('请稍等',{exact:true}).count(),0);
   assert.equal((await page.evaluate(()=>window.auxiliaryFixture)).parentSubmits,0);
  }else if(mode==='denied'){await page.getByText('TEST当前账号无目录权限',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'直接新增辅料',exact:true}).count(),0);await page.getByRole('button',{name:'关闭辅料选择',exact:true}).click();assert.equal((await page.evaluate(()=>window.auxiliaryFixture)).document.materials[0].name,'TEST原自由文本');}
  else if(mode==='select'){
   await page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill('扁机');await page.getByRole('button',{name:'选择此辅料',exact:true}).waitFor();await page.getByRole('button',{name:'选择此辅料',exact:true}).click();
   await page.getByRole('dialog').waitFor({state:'hidden'});assert.equal(await page.getByLabel('辅料品名（材料资料）',{exact:true}).inputValue(),'TEST扁机完整中文名称');await page.getByText('辅料类型：扁机',{exact:true}).waitFor();
   let state=await page.evaluate(()=>window.auxiliaryFixture);assert.equal(state.document.materials[0].requiredThisRound,false);assert.equal(state.document.materials[0].available,false);assert.equal(state.document.materials[0].auxiliaryCatalog.version,1);assert.equal(state.parentSubmits,0);
   await page.getByRole('button',{name:'TEST保存订单草稿',exact:true}).click();await page.reload();await trigger.waitFor();state=await page.evaluate(()=>window.auxiliaryFixture);assert.equal(state.document.materials[0].name,'TEST扁机完整中文名称');assert.equal(state.document.materials[0].auxiliaryCatalog.version,1);
   await trigger.click();await page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill('TEST找不到');await page.getByText('没有匹配的辅料。',{exact:false}).waitFor();await page.getByRole('button',{name:'关闭辅料选择',exact:true}).click();assert.equal((await page.evaluate(()=>window.auxiliaryFixture)).document.materials[0].name,'TEST扁机完整中文名称');
  }else{
   await page.getByRole('button',{name:'直接新增辅料',exact:true}).click();await page.getByRole('textbox',{name:'辅料品名',exact:true}).fill('TEST新扁机');await page.getByRole('textbox',{name:'规格',exact:true}).fill('TEST40cm');await page.getByRole('combobox',{name:'辅料分类',exact:true}).selectOption('扁机');await page.getByRole('button',{name:'保存共享目录',exact:true}).click();
   if(mode==='unknown'||mode==='timeout'||mode==='retry'){await page.getByText('目录操作结果尚未确认，',{exact:false}).waitFor();assert.equal(await page.getByRole('button',{name:'保存共享目录',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('textbox',{name:'辅料品名',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'直接新增辅料',exact:true}).isDisabled(),true);await page.getByRole('button',{name:mode==='retry'?'沿原标识重试目录操作':'核对原目录回执',exact:true}).click();}
   await page.getByText('订单资料尚未保存。',{exact:false}).waitFor();const state=await page.evaluate(()=>window.auxiliaryFixture);assert.equal(state.commits,1);assert.equal(state.parentSubmits,0,'portal form never submits the order');assert.equal(state.document.materials[0].name,'TEST原自由文本');const writes=state.requests.filter(r=>r.method==='POST');assert.equal(writes.length,mode==='retry'?2:1);if(mode==='retry'){assert.equal(writes[0].key,writes[1].key);assert.deepEqual(writes[0].body,writes[1].body);}
   await page.getByRole('textbox',{name:'搜索品名、规格或供应方',exact:true}).fill('TEST新扁机');await page.locator('.auxiliary-catalog-results article').filter({has:page.locator('strong',{hasText:'TEST新扁机'})}).getByRole('button',{name:'选择此辅料',exact:true}).click();assert.equal((await page.evaluate(()=>window.auxiliaryFixture)).document.materials[0].name,'TEST新扁机');
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({width,mode});await page.close();
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&current&&!current.isClosed()){await current.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await current.locator('body').innerText());}throw error;}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual shared DevelopmentDocumentFields and modal; synthetic HTTP and local browser draft reload only. Real service save/publication and directory/role invariants tested separately in PostgreSQL.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({passed:results.length,errors}));
