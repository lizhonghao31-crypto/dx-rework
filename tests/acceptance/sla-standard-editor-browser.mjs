import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const input={};
async function editNode(page,label,value,unit){
 await page.getByPlaceholder('例如：印花、装箱').fill(label);
 await page.getByRole('button',{name:'调整'+label,exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'调整'+label,exact:true});
 if(unit)await dialog.getByLabel(label+'单位',{exact:true}).selectOption(unit);
 await dialog.getByLabel(label+'数值',{exact:true}).fill(value);
 await dialog.getByRole('button',{name:'暂存到本次草稿',exact:true}).click();
}
async function ready(page){try{await page.locator('.sla-calculation-summary').filter({hasText:'开发本轮标准窗口'}).waitFor();}catch(error){console.log('TEST settings read failure',await page.locator('body').innerText(),await page.evaluate(()=>window.slaReads));throw error;}}

const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-sla-settings-ui-')),evidence=process.env.SLA_SETTINGS_UI_EVIDENCE,results=[],errors=[];
let browser,server;
const passed=[];const done=name=>{passed.push(name);console.log(`ok ${passed.length} - ${name}`);};
console.log('TAP version 13');
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/sla-standard-editor-ui.tsx'),name:'SampleUi',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.factoryInput=${JSON.stringify(input).replace(/</g,'\\u003c')};${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:'/usr/bin/chromium',args:['--no-sandbox']});await mkdir(evidence,{recursive:true});
 for(const width of [1440,390]){
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  const base=`http://127.0.0.1:${server.address().port}/`;
  await page.goto(base);await ready(page);await editNode(page,'节点临期比例','80');
  await page.getByLabel('调整原因',{exact:true}).fill('新单统一调整，保留历史');
  await page.getByRole('button',{name:'预览新单标准',exact:true}).click();await page.getByRole('heading',{name:'确认发布 1 项变化'}).waitFor();
  assert.equal(await page.getByText('节点临期比例：70% → 80%').count(),1);
  await page.getByRole('button',{name:'确认发布新单标准',exact:true}).click();await page.getByText('已发布 v2',{exact:false}).waitFor();
  await page.getByPlaceholder('例如：印花、装箱').fill('印花');
  await editNode(page,'开发印花','120');
  await page.getByPlaceholder('例如：印花、装箱').fill('印花');
  await page.getByRole('checkbox').nth(0).check();await page.getByRole('checkbox').nth(1).check();
  await page.getByRole('button',{name:'统一为“开发印花”的数值'}).click();assert.ok((await page.locator('[data-sla-node=bulk_printing]').innerText()).includes('5天'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  await page.screenshot({path:join(evidence,`settings-${width}.png`),fullPage:true});
  const writes=await page.evaluate(()=>window.slaWrites);assert.equal(writes.filter(w=>w.url.endsWith('/publish')).length,1);assert.ok(writes.find(w=>w.url.endsWith('/publish')).key);
  page.on('dialog',d=>d.accept());await page.goto(base+'?readonly');await page.getByText('当前岗位无权访问生产管理设置。').waitFor();assert.equal(await page.getByRole('button',{name:'预览新单标准'}).count(),0);
  await page.goto(base+'?conflict');await ready(page);await editNode(page,'节点临期比例','80');await page.getByLabel('调整原因',{exact:true}).fill('冲突反例');await page.getByRole('button',{name:'预览新单标准',exact:true}).click();await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('button',{name:'确认发布新单标准',exact:true}).count(),0);

  for(const mode of ['partial','unknown']){
   await page.goto(base+'?'+mode);await page.getByRole('button',{name:'大货产前准备',exact:true}).click();await page.getByLabel('选择预缩参与批量调整',{exact:true}).check();
   await page.getByText('指定在途订单应用现行标准',{exact:true}).click();await page.getByRole('button',{name:'查找',exact:true}).click();await page.getByText('TEST-订单1 · TEST-PD').getByRole('checkbox').check();await page.getByText('TEST-订单2 · TEST-PD').getByRole('checkbox').check();
   await page.getByLabel('本次应用原因').fill('TEST specific selected orders');await page.getByRole('button',{name:'预览选定订单（2）'}).click();await page.getByText('TEST-订单2 · 可应用').waitFor();
   await page.getByRole('button',{name:'确认逐单应用'}).click();
   if(mode==='partial'){await page.getByText('已应用 1 单；未应用或未确认 1 单。').waitFor();await page.getByText('TEST-订单2 · 未应用').waitFor();}
   else{await page.getByText('TEST-订单2 · 结果待确认').waitFor();assert.equal(await page.getByLabel('本次应用原因').isDisabled(),true);await page.getByRole('button',{name:'用原命令确认未明结果'}).click();await page.getByText('已应用 2 单；未应用或未确认 0 单。').waitFor();
    const applies=(await page.evaluate(()=>window.slaWrites)).filter(w=>w.url.endsWith('/orders/apply'));assert.equal(applies.filter(w=>w.body.orderId==='a').length,1);const b=applies.filter(w=>w.body.orderId==='b');assert.equal(b.length,2);assert.equal(b[0].key,b[1].key);assert.deepEqual(b[0].body,b[1].body);
   }
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(evidence,`application-${mode}-${width}.png`),fullPage:true});
  }
  await page.goto(base+'ui/digital-cockpit?workspace=settings');await page.getByRole('heading',{name:'生产管理设置',exact:true}).waitFor();await page.getByRole('heading',{name:'时效标准',exact:true}).waitFor().catch(async e=>{console.log('SLA settings shell failure:',await page.locator('body').innerText(),await page.evaluate(()=>window.slaReads),errors);throw e;});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await page.screenshot({path:join(evidence,`settings-shell-${width}.png`),fullPage:true});
  done(`original settings component publication, batch type, scope denial, conflict, partial/unknown apply, shell and overflow width${width}`);
  results.push({width,fullAppSettingsEntry:true,publication:true,batchSameType:true,readonly:true,stalePreview:true,partialApplication:true,unknownRetry:true,overflow:false});await page.close();
 }
 assert.deepEqual(errors,[]);await writeFile(join(evidence,'results.json'),JSON.stringify(results,null,2));console.log(`# tests ${passed.length}\n# pass ${passed.length}\n# fail 0\n# skipped 0`);
}finally{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
