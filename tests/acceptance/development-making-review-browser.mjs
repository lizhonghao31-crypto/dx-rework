import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'dx-making-review-')),evidence=process.env.MAKING_REVIEW_EVIDENCE,results=[],errors=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/development-making-review.tsx'),name:'MakingReview',formats:['iife']}}});
 const names=await readdir(out),js=await readFile(join(out,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(out,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(evidence)await mkdir(evidence,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const mode of ['tail','native','update']){
  const page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
  if(mode==='update'){
   await page.getByLabel('系统制作摘要',{exact:true}).waitFor();assert.equal(await page.getByLabel('尺码与颜色',{exact:true}).count(),0);
   await page.getByLabel('要求完成日期',{exact:true}).fill('2026-12-01');await page.locator('.pattern-form-note textarea').fill('TEST只改日期备注');await page.getByLabel(/^变更原因/).fill('TEST保留生成摘要');
   if(evidence)await page.screenshot({path:join(evidence,`fields-${mode}-${viewport.width}.png`),fullPage:true});
   await page.getByRole('button',{name:'保存资料',exact:true}).click();await page.getByText('TEST已取得保存回执',{exact:true}).waitFor();
   const writes=await page.evaluate(()=>window.makingReviewFixture.requests.filter(r=>r.method==='POST'));assert.equal(writes.length,1);assert.ok(writes[0].body.sizeColor.length>200);assert.equal(writes[0].body.requiredDate,'2026-12-01');
  }else{
   if(mode==='tail')await page.locator('select[name=result]').selectOption('退回',{timeout:5000}).catch(async error=>{if(evidence)await writeFile(join(evidence,`failure-${mode}-${viewport.width}.txt`),await page.locator('body').innerText());throw error;});
   const m=page.getByLabel('M新轮制作数量',{exact:true}),l=page.getByLabel('L新轮制作数量',{exact:true});await m.waitFor();assert.equal(await m.inputValue(),'');assert.equal(await l.inputValue(),'');
   await page.getByRole('checkbox',{name:'车板',exact:true}).check();await page.getByRole('checkbox',{name:'尺寸',exact:true}).check();
   await page.getByLabel(mode==='tail'?'办理备注':'返工内容 / 原因（必填）',{exact:true}).fill('TEST真实录入新轮数量');
   await m.fill(viewport.width===390?'0':'2');await l.fill(viewport.width===390?'3':'1');
   if(mode==='tail'){await page.locator('select[name=result]').selectOption('通过');await page.locator('select[name=result]').selectOption('退回');assert.equal(await m.inputValue(),viewport.width===390?'0':'2');assert.equal(await l.inputValue(),viewport.width===390?'3':'1');}
   if(evidence)await page.screenshot({path:join(evidence,`fields-${mode}-${viewport.width}.png`),fullPage:true});
   await page.getByRole('button',{name:mode==='tail'?'退回修改':'发起原单返工',exact:true}).click();
   await page.waitForFunction(()=>window.makingReviewFixture.saved);
   const state=await page.evaluate(()=>structuredClone(window.makingReviewFixture)),writes=state.requests.filter(r=>r.method==='POST');assert.equal(writes.length,1);
   const upgrade=mode==='tail'?writes[0].body.making:writes[0].body.developmentMaking;
   assert.deepEqual(upgrade,{expectedDocumentVersion:2,quantities:viewport.width===390?[0,3]:[2,1]});assert.equal(state.original.documentFormatVersion,undefined);assert.equal(state.original.sizeQuantities,undefined);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${viewport.width}.png`),fullPage:true});
  results.push({viewport,mode,checks:mode==='update'?['generated long summary read-only','ordinary date/note update retains full value']:['empty counts never inferred','explicit new round count payload and basis','zero retained on narrow screen','old fixture remains unchanged']});await page.close();
 }
 assert.deepEqual(errors,[]);
}finally{if(evidence)await writeFile(join(evidence,'result.json'),JSON.stringify({results,errors,limits:['Actual React initiating forms with synthetic HTTP; real entry commands tested separately in PostgreSQL. No deployment/real data.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,errors}));
