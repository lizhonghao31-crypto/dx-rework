import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input=JSON.parse(await readFile(process.env.PREPARATION_UI_INPUT,'utf8'));
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-readiness-ui-')),evidence=process.env.PREPARATION_UI_EVIDENCE,results=[],errors=[];
let browser,server,page;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/production-readiness-ui.tsx'),name:'PreparationUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.preparationInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of [1280,1440])for(const mode of ['normal','conflict','uncertain','refreshfail','readonly','instruction','range','loadfail','empty']){
  page=await browser.newPage({viewport:{width,height:900}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
  if(mode==='instruction'){
   await page.getByText('制单草稿 · 到仓后24小时',{exact:true}).waitFor();await page.getByRole('button',{name:'采用当前技术尺寸表'}).click();await page.getByText('未保存修改',{exact:true}).waitFor();
  }else if(mode==='loadfail'||mode==='empty'){
   if(mode==='loadfail'){await page.getByRole('alert').filter({hasText:'TEST初次读取失败'}).waitFor();await page.getByRole('button',{name:'重新读取',exact:true}).click();}
   const details=page.locator('.preparation-readiness>details');await details.locator(':scope>summary').waitFor();assert.equal(await details.getAttribute('open'),null);await details.locator(':scope>summary').click();
   if(mode==='empty')assert.equal(await details.locator('.preparation-readiness-facts>div').getByText('未登记',{exact:true}).count(),6);
   else{await details.getByText('指定仓管和对色确认人',{exact:true}).click();assert.ok(await details.getByLabel('本单收料仓管',{exact:true}).locator('option').count()>1);}
  }else if(mode==='range'){
   const scope=page.locator('.preparation-range-action');await scope.locator('summary').first().click();await scope.getByLabel('本项全部适用款色均已完成，且不再欠本项物料').check();
   await page.evaluate(()=>{window.preparationLeaveAttempt=window.preparationCanLeave();});await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'取消',exact:true}).click();
   assert.equal(await page.evaluate(()=>window.preparationLeaveAttempt),false);assert.equal(await scope.getByLabel('本项全部适用款色均已完成，且不再欠本项物料').isChecked(),true);
  }else{
   const details=page.locator('.preparation-readiness>details');await details.locator('summary').first().waitFor();assert.equal(await details.getAttribute('open'),null);
   await page.screenshot({path:join(evidence,`${mode}-${width}-collapsed.png`),fullPage:true});
   await details.locator(':scope>summary').focus();await page.keyboard.press('Space');assert.notEqual(await details.getAttribute('open'),null);
   if(mode==='readonly')assert.equal(await details.getByRole('button',{name:'保存本项记录'}).count(),0);
   else{
    const fact=details.locator('.preparation-readiness-facts>div').filter({has:page.getByText('面料实际到仓',{exact:true})});await fact.getByRole('button',{name:'追加订正'}).click();
    await details.getByLabel('本次情况 / 订正原因').fill('TEST现场说明 · 长物料名称'.repeat(12));
    await details.getByRole('button',{name:'保存本项记录'}).dblclick();
    const recorded=await page.evaluate(()=>window.preparationRequests.filter(r=>r.path.includes('/materials')));assert.equal(recorded[0].body.quantities.length,2);assert.equal(recorded[0].body.quantities[1].materialId,'00000000-0000-4000-8000-000000000012');assert.equal(recorded[0].body.quantities[0].materialId,'00000000-0000-4000-8000-000000000011');
    if(mode==='conflict'){await page.getByRole('alert').filter({hasText:'资料已更新'}).waitFor();assert.equal(await details.getByLabel('本次情况 / 订正原因').inputValue(),'TEST现场说明 · 长物料名称'.repeat(12));assert.equal(await page.evaluate(()=>window.preparationWriteCount??0),0);}
    else if(mode==='uncertain'){
     await details.getByRole('button',{name:'保存本项记录'}).waitFor();await page.getByRole('button',{name:'使用原内容核对提交结果'}).click();await page.getByRole('status').filter({hasText:'已保存原业务记录'}).waitFor();
     const requests=await page.evaluate(()=>window.preparationRequests.filter(r=>r.path.includes('/materials')));assert.equal(requests.length,2);assert.equal(requests[0].key,requests[1].key);assert.deepEqual(requests[0].body,requests[1].body);assert.equal(await page.evaluate(()=>window.preparationWriteCount),1);
    }else{await page.getByRole('status').filter({hasText:'已保存原业务记录'}).waitFor();assert.equal(await page.evaluate(()=>window.preparationWriteCount),1);if(mode==='refreshfail')await page.getByRole('alert').filter({hasText:'保存成功后刷新失败'}).waitFor();}
   }
   await details.locator(':scope>summary').focus();await page.keyboard.press('Space');assert.equal(await details.getAttribute('open'),null);await page.keyboard.press('Tab');assert.equal(await page.evaluate(()=>Boolean(document.activeElement?.closest('.preparation-readiness fieldset'))),false);
   await details.locator(':scope>summary').click();
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${mode} ${width} overflow`);
  await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({mode,width,passed:true});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}finally{await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual existing React components; PostgreSQL-captured TEST response data and deterministic synthetic HTTP faults. Not authenticated full-site or live-business acceptance.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({cases:results.length,errors}));
