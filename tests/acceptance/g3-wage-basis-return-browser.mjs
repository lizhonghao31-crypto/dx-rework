import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {execFileSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const out=await mkdtemp(join(tmpdir(),'g3-wage-')),dir=process.env.WAGE_REPAIR_EVIDENCE,results=[],errors=[];
let browser,server;
try {
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:out,lib:{entry:resolve('tests/fixtures/g3-wage-basis-return.tsx'),name:'WageBasis',formats:['iife']}}});
 const files=await readdir(out),js=await readFile(join(out,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(out,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});
 await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 if(dir)await mkdir(dir,{recursive:true});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const failure of ['none','403','503','network','invalid','unfinished403','direct403']) {
  const page=await browser.newPage({viewport});
  await page.addInitScript(value=>sessionStorage.setItem('g3-history-failure',value),failure);
  page.on('pageerror',e=>errors.push({failure,width:viewport.width,error:e.message}));
  await page.goto(`${origin}/acceptance/ui/wages?from=2026-10-01&to=2026-10-19&q=TEST`);
  const row=page.locator('.wage-detail-table tbody tr').first();await row.waitFor();
  assert.ok((await row.innerText()).includes('1,001 件 × 0.01 元/件 × 临时工系数 1.2'));
  await row.locator('details > summary').click();const basisText=await row.innerText();
  assert.ok(basisText.includes('12.012')&&basisText.includes('12.01'));
  await row.locator('details > summary').click();
  if(dir&&failure==='none')await page.screenshot({path:join(dir,`wage-basis-${viewport.width}.png`),fullPage:true});
  const link=row.getByRole('link',{name:'TEST-WAGE-1',exact:true}),href=await link.getAttribute('href');
  const returnTo=new URL(href,origin).searchParams.get('returnTo');
  assert.ok(returnTo.includes('from=2026-10-01')&&returnTo.includes('q=TEST'));
  if(failure==='unfinished403'||failure==='direct403') {
   const target=new URL(href,origin);target.searchParams.set('node','initiation');
   if(failure==='direct403')target.searchParams.set('view','node-history');
   await page.goto(target.href);
  } else await link.click();
  const back=page.getByRole('link',{name:'返回工资管理',exact:true});await back.waitFor();
  let errorText=null;
  if(failure!=='none') {
   const error=page.locator('.rework-history div[aria-busy="false"] > p[role="status"]');await error.waitFor();errorText=await error.innerText();
   assert.ok(errorText.includes(failure==='invalid'?'历史资料加载失败':'TEST 隔离历史读取失败'));
  } else await page.locator('.rework-history-navigation').waitFor();
  const current=page.getByRole('link',{name:'返回当前节点',exact:true});
  assert.equal(await current.count(),failure==='unfinished403'?1:0,'completed or unknown-history failures have no current-node loop; known unfinished work keeps its current route');
  if(failure==='unfinished403') {
   const target=new URL(await current.getAttribute('href'),origin);
   assert.equal(target.searchParams.has('node')||target.searchParams.has('view'),false,'unfinished recovery opens the current route');
  }
  if(dir)await page.screenshot({path:join(dir,`history-${failure}-${viewport.width}.png`),fullPage:true});
  await back.click();await page.locator('.wage-detail-table tbody tr').first().waitFor();
  assert.equal(new URL(page.url()).searchParams.get('q'),'TEST');
  assert.deepEqual(await page.evaluate(()=>window.wageBasisFixture.requests.filter(r=>r.method!=='GET')),[]);
  results.push({viewport,failure,href,returnTo,basisText,errorText});await page.close();
 }
 assert.deepEqual(errors,[]);
 if(dir)await writeFile(join(dir,'results.json'),JSON.stringify({status:'passed',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommitted:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',results,errors,limitation:'Synthetic wage/finishing data. Historical form snapshot deliberately incomplete; validates return and error recovery, not the full historical form or actual field-record cause.'},null,2));
 console.log(JSON.stringify({status:'passed',cases:results.length,evidence:dir}));
} finally {await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(out,{recursive:true,force:true});}
