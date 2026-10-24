import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input={};
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-factory-qc-ui-')),evidence=process.env.SLA_SETTINGS_UI_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/sla-standard-editor-ui.tsx'),name:'SampleUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.factoryInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const base=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(base);await page.getByLabel('节点临期比例数值').fill('80');
  await page.getByLabel('调整原因',{exact:true}).fill('新单统一调整，保留历史');
  await page.getByRole('button',{name:'预览新单标准',exact:true}).click();await page.getByRole('heading',{name:'确认发布 1 项变化'}).waitFor();
  assert.equal(await page.getByText('节点临期比例：70% → 80%').count(),1);
  await page.getByRole('button',{name:'确认发布新单标准',exact:true}).click();await page.getByText('已发布 v2',{exact:false}).waitFor();
  await page.getByPlaceholder('例如：印花、装箱').fill('印花');
  await page.getByLabel('开发印花数值').fill('120');
  await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button',{name:'统一为“开发印花”的数值'}).click();assert.equal(await page.getByLabel('大货印花数值').inputValue(),'120');
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(evidence,`settings-${width}.png`),fullPage:true});
  const writes=await page.evaluate(()=>window.slaWrites);assert.equal(writes.filter(w=>w.url.endsWith('/publish')).length,1);assert.ok(writes.find(w=>w.url.endsWith('/publish')).key);
  page.on('dialog',d=>d.accept());await page.goto(base+'?readonly');await page.getByText('当前岗位无权访问生产管理设置。').waitFor();assert.equal(await page.getByRole('button',{name:'预览新单标准'}).count(),0);
  await page.goto(base+'?conflict');await page.getByLabel('节点临期比例数值').fill('80');await page.getByLabel('调整原因',{exact:true}).fill('冲突反例');await page.getByRole('button',{name:'预览新单标准',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'确认发布新单标准',exact:true}).count(),0);
  results.push({width,publication:true,batchSameType:true,readonly:true,stalePreview:true,overflow:false});await page.close();
 }
 assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results));
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
