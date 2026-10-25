import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'sla-policy-ui-')),evidence=process.env.SLA_UI_EVIDENCE,results=[],errors=[];
let browser,server;
try {
 await build({configFile:false,esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/sla-policy-settings-ui.tsx'),name:'PolicyUi',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 if(evidence)await mkdir(evidence,{recursive:true});
 for(const width of [1440,390]) for(const mode of ['save','conflict','readonly']) {
  const page=await browser.newPage({viewport:{width,height:960}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}/?mode=${mode}`);
  if(mode==='readonly') {
   await page.getByText('当前岗位无权访问生产管理设置。').waitFor();
   assert.equal(await page.getByRole('button',{name:/编辑/}).count(),0);
  } else {
   await page.getByRole('button',{name:/编辑开发纸样/}).click();
   await page.getByText('仅新订单采用；在途订单保持原标准。',{exact:true}).waitFor();
   assert.equal(await page.locator('input[name="ratio"]').getAttribute('readonly'),'');
   await page.locator('input[name="hours"]').fill('60');
   if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}-editor.png`),fullPage:true});
   await page.getByRole('button',{name:'保存新单标准',exact:true}).click();
   if(mode==='save')await page.getByRole('status').filter({hasText:'仅新订单采用'}).waitFor();
   else await page.getByRole('alert').filter({hasText:'参数已被其他人更新'}).waitFor();
   const writes=await page.evaluate(()=>window.slaPolicyEvidence.writes);
   assert.equal(writes.length,1);assert.equal(writes[0].slaHours,60);assert.equal(writes[0].warningRatio,0.7);
  }
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false,`${mode} ${width}: overflow`);
  if(evidence)await page.screenshot({path:join(evidence,`${mode}-${width}.png`),fullPage:true});
  results.push({mode,width});await page.close();
 }
 assert.deepEqual(errors,[]);
 if(evidence)await writeFile(join(evidence,'results.json'),JSON.stringify({scope:'actual components, synthetic HTTP; not end-to-end API acceptance',results,errors},null,2));
 console.log(JSON.stringify({passed:results.length,errors}));
} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(out,{recursive:true,force:true});}
