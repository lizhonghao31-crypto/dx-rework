import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-material-')),evidence=process.env.DOCUMENT_RECOVERY_EVIDENCE,results=[],errors=[];
let browser,server,activePage;
try{
 await build({configFile:false,esbuild:{jsx:'automatic',jsxDev:false},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/document-recovery-feedback.tsx'),name:'MaterialClosure',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390])for(const view of ['instruction','closure'])for(const mode of ['success','lost','malformed','denied','expired','stale','wrong-content']){
  const context=await browser.newContext({viewport:{width,height:1000}}),page=await context.newPage();activePage=page;page.on('pageerror',e=>errors.push(e.message));console.log(JSON.stringify({view,mode,width}));
  await page.goto(`http://127.0.0.1:${server.address().port}/ui/digital-production?view=${view}&mode=${mode}`);const writes=()=>page.evaluate(()=>window.documentRecoveryFixture.requests.filter(r=>r.method!=='GET'));
  if(view==='instruction'){await page.locator('#instruction-styleName').fill('TEST保留制单输入');await page.getByRole('button',{name:'保存草稿',exact:true}).click();}
  else{await page.getByRole('textbox',{name:/具体结案原因/}).fill('TEST保留原结案原因');await page.getByRole('checkbox',{name:/已核对原实绩/}).check();await page.getByRole('button',{name:'确认特殊结案',exact:true}).click();}
  if(view==='closure'&&['stale','wrong-content'].includes(mode)){await context.close();continue;}
  if(mode==='success'){if(view==='instruction')await page.getByText(/制单草稿已保存。/).waitFor();else await page.getByRole('heading',{name:'特殊结案记录',exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.documentRecoveryFixture.commits),1);}
  else if(mode==='denied')await page.getByText('TEST请原有权岗位在本单办理',{exact:true}).waitFor();
  else{const retry=page.getByRole('button',{name:view==='instruction'?'使用原内容核对制单提交':'使用原内容核对结案提交',exact:true});await retry.waitFor();const before=(await writes()).length;
   if(view==='instruction'){assert.match(await page.locator('#instruction-styleName').innerText(),/TEST保留制单输入/);assert.match(await page.locator('.dx-doc-toolbar').innerText(),/结果待确认/);assert.doesNotMatch(await page.locator('.dx-doc-toolbar').innerText(),/修改未保存/);await page.getByRole('button',{name:'重新载入最新版本',exact:true}).click();await page.getByText(/原提交回执仍未确认/).waitFor();}
   else{await page.getByRole('button',{name:'刷新原实绩',exact:true}).click();await page.getByRole('heading',{name:'特殊结案记录',exact:true}).waitFor();assert.equal(await retry.isVisible(),true);}
   assert.equal((await writes()).length,before);
   if(mode==='expired'){await page.evaluate(()=>window.documentRecoveryFixture.advance());await retry.click();await page.getByText(/超过安全恢复期限/).waitFor();assert.equal((await writes()).length,before);}
   else{await retry.click();await retry.waitFor({state:'detached'});const rows=await writes();assert.deepEqual(rows.at(-1),rows.at(-2));assert.equal(await page.evaluate(()=>window.documentRecoveryFixture.commits),1);}
  }
  if(evidence)await page.screenshot({path:join(evidence,`${view}-${mode}-${width}.png`),fullPage:true});results.push({width,view,mode,passed:true});await context.close();
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&activePage)await activePage.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>undefined);throw error;}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual components with synthetic TEST responses; API/transactions/notifications verified separately in isolated PostgreSQL. No real orders or deployment.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
