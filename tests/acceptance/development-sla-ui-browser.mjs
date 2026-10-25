import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-sla-ui-')),evidence=process.env.SLA_UI_EVIDENCE,results=[],errors=[];let browser,server,page;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/development-sla-ui.tsx'),name:'SlaUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 const modes=process.env.SLA_UI_MODES?.split(',')??['prewash','tail','nowash','cut','fixed','request','external','readonly','revision'];
 for(const width of [1440,390])for(const mode of modes){
  page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',error=>errors.push(`${mode}: ${error.message}`));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}&taskView=handle`);
  if(['prewash','tail'].includes(mode)){
   const phase=mode==='prewash'?'洗前':'洗后';await page.getByLabel(`${phase}胸围（平量一圈） S`,{exact:true}).waitFor();
   for(const input of await page.locator('input[name^="actual-size-"]').all())await input.fill('90');
   if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}-before.png`),fullPage:true});
   await page.getByRole('button',{name:mode==='prewash'?'完成并交出':'尾查合格，交给设计师',exact:true}).click();
   if(mode==='prewash')await page.waitForFunction(()=>window.slaUiEvidence.requests.some(row=>row.method==='POST'&&row.path.endsWith('/route')));
   else await page.getByRole('alert').filter({hasText:'尾查提交前请上传本任务实际照片'}).waitFor();
  }else if(mode==='nowash'){
   await page.getByRole('button',{name:'尾查合格，交给设计师',exact:true}).waitFor();assert.equal(await page.locator('input[name^="actual-size-"]').count(),0);
  }else if(mode==='cut'){
   await page.getByText('接收车板师傅：TEST 接收车板师傅（名字较长用于换行检查）',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:/签收|接收/}).count(),0);
  }else if(mode==='fixed'){
   await page.getByText('固定人员未设置',{exact:true}).waitFor();assert.equal(await page.getByRole('combobox',{name:'安排裁板'}).count(),0);
   await page.getByText('固定裁板：未设置',{exact:true}).click();await page.getByRole('button',{name:'保存固定人员',exact:true}).waitFor();
  }else if(mode==='request')await page.getByRole('button',{name:'记录请求已发出'}).waitFor();
  else if(mode==='external'){await page.getByRole('button',{name:'记录已收到'}).waitFor();assert.equal(await page.getByRole('button',{name:'记录已收到'}).isDisabled(),true);await page.getByText('此前请求（1）',{exact:true}).click();await page.getByText(/发出 2026\/10\/21.*收到 2026\/10\/22/).waitFor();}
  else if(mode==='readonly'){await page.getByRole('link',{name:'外部纸样附件 1'}).waitFor();assert.equal(await page.getByRole('button',{name:'记录已收到'}).count(),0);}
  else {await page.getByText('复版 2 · 原单与原因',{exact:true}).click();await page.getByRole('link',{name:'查看来源开发单'}).waitFor();}
  if(['prewash','tail'].includes(mode))assert.equal(await page.locator('.task-workbench-sample>main').evaluate(element=>element.scrollWidth>element.clientWidth+1),false,`${mode} ${width} workbench overflow`);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${mode} ${width} page overflow`);
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});results.push({width,mode,requests:await page.evaluate(()=>window.slaUiEvidence.requests)});await page.close();page=null;
 }
 assert.deepEqual(errors,[]);
}catch(error){if(evidence&&page){await page.screenshot({path:join(evidence,'failure.png'),fullPage:true});await writeFile(join(evidence,'failure.txt'),await page.locator('body').innerText());}throw error;}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual React components with synthetic HTTP. PostgreSQL transactions tested separately. Not a deployed full-application acceptance run.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
