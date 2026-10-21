import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-material-')),evidence=process.env.COMMERCIAL_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/commercial-feedback.tsx'),name:'MaterialClosure',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390])for(const mode of ['budget-save-lost','budget-save-malformed','budget-save-408','budget-save-denied','budget-save-expired','budget-publish-lost','contract-lost','contract-malformed','contract-408','contract-denied','contract-refresh','contract-missing','contract-expired','contract-success','contract-old-id','contract-other-case','contract-wrong-version']){
  const context=await browser.newContext({viewport:{width,height:900}}),page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
  const writes=()=>page.evaluate(()=>window.commercialFixture.requests.filter(r=>r.method!=='GET'));
  if(mode.startsWith('budget')){
   await page.locator('#budget-monthSeries').fill('TEST保留输入');await page.getByRole('button',{name:mode.includes('publish')?'发布预算':'保存预算',exact:true}).click();
   if(mode.endsWith('denied')){await page.getByText('TEST仅原有权岗位可办理，请回本单查看负责岗位',{exact:true}).waitFor();assert.equal(await page.locator('#budget-monthSeries').inputValue(),'TEST保留输入');assert.equal(await page.getByRole('button',{name:'使用原内容核对预算提交',exact:true}).count(),0);}
   else{
    const retry=page.getByRole('button',{name:'使用原内容核对预算提交',exact:true});await retry.waitFor();assert.match(await page.locator('.dx-doc-toolbar').innerText(),/结果待确认/);assert.doesNotMatch(await page.locator('.dx-doc-toolbar').innerText(),/修改未保存/);
    const before=(await writes()).length;await page.getByRole('button',{name:'仅核对当前预算版本',exact:true}).click();await page.getByText(/原提交回执仍未确认/).waitFor();assert.equal((await writes()).length,before);assert.equal(await retry.isVisible(),true);
    if(mode.endsWith('expired')){await page.evaluate(()=>window.commercialFixture.advance());await retry.click();await page.getByText(/原预算提交已超过安全恢复期限/).waitFor();assert.equal((await writes()).length,before);}
    else{await retry.click();await retry.waitFor({state:'detached'});const records=await writes();assert.deepEqual(records.at(-1),records.at(-2));assert.equal(await page.evaluate(()=>window.commercialFixture.commits),mode.includes('publish')?2:1);}
   }
  }else{
   await page.getByRole('button',{name:'更新合同信息',exact:true}).click();await page.getByRole('button',{name:'更新供应商以及合同信息',exact:true}).click();const confirm=page.getByRole('button',{name:'确认更新合同',exact:true});await confirm.waitFor();
   if(mode==='contract-missing'){await page.getByText(/供应商合同资料缺少：地址、银行账号/).waitFor();assert.equal(await confirm.isDisabled(),true);assert.equal((await writes()).length,0);}
   else{
    await confirm.click();
    if(mode.endsWith('denied')){await page.getByText('TEST仅原有权岗位可办理，请回本单查看负责岗位',{exact:true}).waitFor();assert.equal(await confirm.isEnabled(),true);}
    else if(mode==='contract-success'){await page.getByText('合同信息更新已保存，原合同与回签历史保留。',{exact:true}).waitFor();assert.equal((await writes()).length,1);assert.equal(await page.evaluate(()=>window.commercialFixture.commits),1);}
    else if(mode==='contract-refresh'){await page.getByText('合同信息更新已保存，原合同与回签历史保留。',{exact:true}).waitFor();const before=(await writes()).length;await page.getByRole('button',{name:'仅重新读取订单资料',exact:true}).click();await page.getByRole('button',{name:'仅重新读取订单资料',exact:true}).waitFor({state:'detached'});assert.equal((await writes()).length,before);}
    else{const retry=page.getByRole('button',{name:'使用原内容核对更新结果',exact:true});await retry.waitFor();assert.equal(await confirm.isDisabled(),true);assert.equal(await page.getByText('合同信息更新已保存，原合同与回签历史保留。',{exact:true}).count(),0);const before=(await writes()).length;
     if(mode.endsWith('expired')){await page.evaluate(()=>window.commercialFixture.advance());await retry.click();await page.getByText(/原更新已超过安全恢复期限/).waitFor();assert.equal((await writes()).length,before);}
     else{await retry.click();await page.getByText('合同信息更新已保存，原合同与回签历史保留。',{exact:true}).waitFor();const records=await writes();assert.deepEqual(records.at(-1),records.at(-2));assert.equal(await page.evaluate(()=>window.commercialFixture.commits),1);}
    }
   }
  }
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({width,mode,passed:true});await context.close();
 }
 assert.deepEqual(errors,[]);
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual components with synthetic TEST responses; API/transactions/notifications verified separately in isolated PostgreSQL. No real orders or deployment.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
