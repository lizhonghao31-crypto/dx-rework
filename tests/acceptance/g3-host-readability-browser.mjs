import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const dir=process.env.HOST_REPAIR_EVIDENCE,out=await mkdtemp(join(tmpdir(),'g3-hosts-')),docs={},results=[],errors=[];
let browser,server;
try{
 for(const family of ['supplier','digital','report-wage']){
  const target=join(out,family);await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:target,lib:{entry:resolve(`tests/fixtures/erp-${family}-layout.tsx`),name:'HostRepair',formats:['iife']}}});
  const names=await readdir(target),js=await readFile(join(target,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(target,names.find(n=>n.endsWith('.css'))),'utf8');docs[family]=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 }
 server=createServer((req,res)=>{const family=req.url.includes('/suppliers')?'supplier':req.url.includes('digital-cockpit')?'digital':'report-wage';res.setHeader('content-type','text/html;charset=utf-8');res.end(docs[family]);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(dir)await mkdir(dir,{recursive:true});
 const origin=`http://127.0.0.1:${server.address().port}`;
 for(const viewport of [{width:1440,height:900},{width:1180,height:900},{width:390,height:844}])for(const [name,path,root] of [
  ['supplier-long-name','suppliers?supplierId=00000000-0000-4000-8000-000000000001&fixtureLongName=1','.supplier-profile__sections'],
  ['supplier-maintenance','suppliers/manage?fixtureRole=root&supplierId=00000000-0000-4000-8000-000000000001&fixtureLongName=1','.supplier-profile-form'],
  ['supplier-restricted','suppliers?supplierId=00000000-0000-4000-8000-000000000001&fixtureLongName=1&fixtureRestricted=1','.supplier-profile__sections'],
  ['cockpit-duplicates','digital-cockpit?selected=00000000-0000-4000-8000-000000000500&fixtureDocuments=1&fixtureDuplicates=1','.journey-order-heading'],
  ['exceptions','reports?type=exceptions','.reporting-table-surface'],
 ]){
  if(process.env.HOST_REPAIR_ONLY && !process.env.HOST_REPAIR_ONLY.split(',').some(prefix=>name.startsWith(prefix)))continue;
  const page=await browser.newPage({viewport,hasTouch:viewport.width<500});page.on('pageerror',e=>errors.push({name,width:viewport.width,error:e.message}));
  await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(request.isNavigationRequest()&&url.origin===origin)return route.continue();throw Error('Unexpected external browser request: '+request.resourceType());});
  await page.goto(`${origin}/acceptance/ui/${path}`);await page.locator(root).waitFor();await page.evaluate(()=>document.fonts.ready);
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'no document overflow');
  const metrics={};if(name.startsWith('supplier')){
   const heading=page.locator('.supplier-profile__heading h2').first();metrics.heading=await heading.boundingBox();
   if(name==='supplier-long-name'||name==='supplier-restricted'){
    assert.ok(metrics.heading.height<=30,'default title is compact');const summary=page.locator('.supplier-directory-name > summary');assert.equal((await summary.getAttribute('title')).length,200);
    if(dir)await page.screenshot({path:join(dir,`${name}-${viewport.width}-default.png`),fullPage:true});
    await page.keyboard.press('Tab');await summary.focus();await summary.press('Enter');assert.equal((await page.locator('.supplier-directory-name__full').innerText()).length,200,'full legal name remains readable');
    if(name==='supplier-long-name'){
     assert.ok((await page.locator('.supplier-profile__sections').innerText()).includes('TEST0123456789'),'existing account data retained');
     const fields=page.locator('.supplier-directory-value > summary');assert.equal(await fields.count(),2);
     for(const field of await fields.all()){await page.keyboard.press('Tab');await field.focus();await field.press('Enter');const parent=field.locator('..');assert.equal(await parent.locator('p').innerText(),await field.getAttribute('title'),'complete authorized contract/account value retained');}
    }
    else assert.equal((await page.locator('.supplier-profile__sections').innerText()).includes('TEST0123456789'),false,'restricted account data absent');
   }else assert.equal(await page.locator('.supplier-directory-name').count(),0,'maintenance heading and form unchanged');
  }
  if(name==='cockpit-duplicates'){
   const stage=page.locator('.journey-flow .dx-production-stage').last(),title=stage.locator('h2');metrics.stage=await title.evaluate(e=>{const b=e.getBoundingClientRect(),range=document.createRange();range.selectNodeContents(e);const r=range.getBoundingClientRect();return {text:e.textContent,width:b.width,height:b.height,textRight:r.right,right:b.right,font:getComputedStyle(e).fontSize};});assert.ok(metrics.stage.textRight<=metrics.stage.right+1,'complete final-stage title fits');assert.ok(parseFloat(metrics.stage.font)>=13,'title was not shrunk');
   for(const selector of ['.journey-current-records a','.journey-document a']){const links=await page.locator(selector).evaluateAll(nodes=>nodes.map(a=>({href:a.getAttribute('href'),label:a.textContent})));assert.equal(new Set(links.map(l=>l.href)).size,links.length,'no duplicate exact links within host');metrics[selector]=links;}
   assert.equal(await page.locator('.journey-document a').filter({hasText:'外发审批 / 合同'}).count(),2,'separate contract versions retained');
   const nodeViewport=page.locator('.journey-node-viewport'),command=nodeViewport.getByRole('button',{name:/选择记录/}).first();
   await command.waitFor();metrics.nodeCommand=await command.evaluate(e=>{const r=e.getBoundingClientRect(),v=e.closest('.journey-node-viewport').getBoundingClientRect();return {left:r.left,right:r.right,viewportLeft:v.left,viewportRight:v.right};});assert.ok(metrics.nodeCommand.left>=metrics.nodeCommand.viewportLeft&&metrics.nodeCommand.right<=metrics.nodeCommand.viewportRight,'record command is visible before horizontal scrolling');
   await page.keyboard.press('Tab');await nodeViewport.focus();await page.keyboard.press('ArrowRight');await page.waitForTimeout(250);metrics.nodeScroll=await nodeViewport.evaluate(e=>({left:e.scrollLeft,width:e.clientWidth,scrollWidth:e.scrollWidth}));if(metrics.nodeScroll.scrollWidth>metrics.nodeScroll.width)assert.ok(metrics.nodeScroll.left>0,'keyboard can scroll all original node facts');
   await command.focus();await command.press('Enter');const records=page.locator('.journey-node-expanded .journey-node-records a');await records.first().waitFor();metrics.nodeRecords=await records.evaluateAll(nodes=>nodes.map(e=>e.getAttribute('href')));assert.ok(metrics.nodeRecords.every(h=>h.startsWith('/acceptance/ui/')),'record selection retains original local destinations');
   await records.first().focus();assert.ok(await records.first().evaluate(e=>e===document.activeElement),'expanded records are keyboard reachable');
  }
  if(name==='exceptions'){
   const text=await page.locator('.reporting-table-surface').innerText();assert.equal(text.includes('overdue_todo')||text.includes('sourcing_finance_reconcile'),false,'business captions replace technical values');assert.ok(text.includes('财务核对'));const links=page.locator('.reporting-table-surface a');assert.equal(await links.count(),15);metrics.links=await links.evaluateAll(nodes=>nodes.map(a=>a.getAttribute('href')));assert.ok(metrics.links.every(h=>/^\/acceptance\/ui\/tasks\/[0-9a-f-]+$/.test(h)),'only validated original task destinations');
   const link=links.first();await page.keyboard.press('Tab');await link.focus();metrics.linkStyle=await link.evaluate(e=>({decoration:getComputedStyle(e).textDecorationLine,outline:getComputedStyle(e).outlineStyle,focused:e===document.activeElement}));assert.ok(metrics.linkStyle.decoration.includes('underline')&&metrics.linkStyle.outline!=='none'&&metrics.linkStyle.focused,'record link is recognizable and keyboard focus is visible');
  }
  if(dir)await page.screenshot({path:join(dir,`${name}-${viewport.width}.png`),fullPage:true});
  const writes=await page.evaluate(()=>((window.supplierLayoutFixture||window.digitalLayoutFixture||window.reportWageFixture)?.requests??[]).filter(r=>r.method!=='GET'));assert.deepEqual(writes,[]);
  results.push({name,viewport,metrics});await page.close();
 }
 assert.deepEqual(errors,[]);
 if(dir)await writeFile(join(dir,'results.json'),JSON.stringify({status:'passed',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommitted:true,results,errors},null,2));console.log(JSON.stringify({status:'passed',cases:results.length,evidence:dir}));
}finally{await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(out,{recursive:true,force:true});}
