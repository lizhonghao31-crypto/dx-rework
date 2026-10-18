import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-report-wage-layout-')),directory=process.env.REPORT_WAGE_EVIDENCE;
const baseline=Boolean(process.env.REPORT_WAGE_BASELINE),results=[],errors=[],external=[],interactions=[];
const original=process.env.REPORT_WAGE_COMPARE?JSON.parse(await readFile(process.env.REPORT_WAGE_COMPARE,'utf8')):null;
const primary=[...['rework_overview','wages','responsibilities','own_factory','external_deductions','exceptions'].map(type=>({name:'report-'+type,path:'reports?type='+type,host:'report',root:'.reporting-table-surface',type})),{name:'wage-list',path:'wages',host:'wage-list',root:'.wage-detail-table'},{name:'wage-detail',path:'wages/00000000-0000-4000-8000-000000000900',host:'wage-detail',root:'.wage-grid'}];
const variants=[...primary,...[primary[0],primary[6],primary[7]].flatMap(c=>['empty','failure'].map(state=>({...c,name:c.name+'-'+state,state,focused:true}))),
 ...[primary[6],primary[7]].map(c=>({...c,name:c.name+'-worker-denied',query:'fixtureRole=worker',deny:true,focused:true})),
 {...primary[1],name:'report-wages-denied',query:'fixtureRole=report-reader',blocked:true,focused:true},
 {...primary[0],name:'report-reader-no-wage',query:'fixtureRole=report-reader',focused:true},
 ...[primary[6],primary[7]].map(c=>({...c,name:c.name+'-root',query:'fixtureRole=root',focused:true})),
 ...[primary[0],primary[6]].map(c=>({...c,name:c.name+'-no-export',query:'fixtureExport=0',noExport:true,focused:true})),
 {...primary[6],name:'wage-list-settlement-visible',query:'fixtureSettle=1',settle:true,focused:true},
 {name:'price-table-sentinel',path:'pattern-room/prices',query:'fixtureRole=root',host:'prices',root:'.pattern-price-table',sentinel:true,focused:true},
 {name:'node-queue-sentinel',path:'process-configuration',query:'fixtureRole=root',host:'queue',root:'.workflow-order-grid',sentinel:true,focused:true}];
const viewports=process.env.REPORT_WAGE_FOCUSED?[{width:1440,height:900},{width:375,height:812},{width:320,height:812}]:[{width:1440,height:900},{width:1366,height:768},{width:1366,height:480},{width:720,height:450},{width:390,height:844},{width:375,height:812},{width:320,height:812}];
let browser,server,deadline;
async function collect(page){return page.evaluate(()=>{
 const box=e=>{const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};},main=document.querySelector('main')??document.body,table=main.querySelector('table'),wrap=main.querySelector('.reporting-table-wrap');
 return {documentWidth:document.documentElement.scrollWidth,viewport:innerWidth,text:main.textContent.replace(/\s+/g,' ').trim(),links:[...main.querySelectorAll('a')].map(e=>({text:e.textContent,href:e.getAttribute('href')})),buttons:[...main.querySelectorAll('button')].map(e=>({text:e.textContent,disabled:e.disabled})),table:table?{rect:box(table),rows:[...table.querySelectorAll('tbody tr')].map(e=>[...e.querySelectorAll('td')].map(c=>c.textContent)),headVisible:getComputedStyle(table.querySelector('thead')).display,headings:[...table.querySelectorAll('thead th')].map(e=>e.textContent),wrap:box(wrap),scrollHeight:wrap.scrollHeight,clientHeight:wrap.clientHeight}:null,scrollers:[...main.querySelectorAll('*')].filter(e=>['auto','scroll'].includes(getComputedStyle(e).overflowY)&&e.scrollHeight>e.clientHeight+2).map(e=>({class:e.className,client:e.clientHeight,scroll:e.scrollHeight})),inputs:[...main.querySelectorAll('input,select')].map(e=>({name:e.closest('label')?.textContent,value:e.value,rect:box(e),fontSize:getComputedStyle(e).fontSize})),cards:[...main.querySelectorAll('.wage-item-card,.workflow-order-card')].map(e=>({text:e.textContent,rect:box(e)})),layout:{headings:[...main.querySelectorAll('h1,h2')].map(box),firstInput:main.querySelector('input')?box(main.querySelector('input')):null}};
 });}
async function keyboardEnd(page,region,key){
 const cell=region.locator('tbody tr:last-child td:last-child');await cell.scrollIntoViewIfNeeded();await region.evaluate(e=>{e.scrollLeft=0;e.focus({preventScroll:true});});const max=await region.evaluate(e=>e.scrollWidth-e.clientWidth);
 if(max>0){await region.press('ArrowRight');await page.waitForTimeout(80);assert.ok(await region.evaluate(e=>e.scrollLeft>0),key+' keyboard movement');
  for(let n=0;n<150;n++){if(await region.evaluate(e=>e.scrollLeft>=e.scrollWidth-e.clientWidth))break;await region.press('ArrowRight');await page.waitForTimeout(20);}
  const end=await region.evaluate(e=>{
   const cell=e.querySelector('tbody tr:last-child td:last-child'),walker=document.createTreeWalker(cell,NodeFilter.SHOW_TEXT);let node,last;
   while((node=walker.nextNode())){if(!node.textContent.trim())continue;const closed=node.parentElement.closest('details:not([open])');if(closed&&!closed.querySelector('summary').contains(node))continue;const r=document.createRange();r.selectNodeContents(node);if(r.getBoundingClientRect().width)last=node;}
   const range=document.createRange();range.setStart(last,last.textContent.length-1);range.setEnd(last,last.textContent.length);const r=range.getBoundingClientRect(),b=e.getBoundingClientRect();return {left:e.scrollLeft,max:e.scrollWidth-e.clientWidth,lastCharacter:last.textContent.slice(-1),parent:last.parentElement.tagName,lastText:last.textContent,range:{x:r.x,y:r.y,width:r.width,height:r.height},region:{x:b.x,y:b.y,width:b.width,height:b.height},hit:document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,160),visible:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=0&&r.bottom<=innerHeight&&last.parentElement.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};
  });assert.equal(end.left,end.max,key+' reaches exact maxScroll');assert.equal(end.visible,true,key+' last character visible and unobscured '+JSON.stringify(end));interactions.push({key,keyboard:end});
 }
 await region.evaluate(e=>{e.scrollLeft=0;e.blur();});
}
async function businessChecks(page,c,key){
 const checks=[];
 if(c.host==='report'){
  const exportLink=page.locator('.report-center-filters a');if(c.noExport)assert.equal(await exportLink.count(),0);
  if(c.name==='report-reader-no-wage')assert.equal(await page.locator('.report-center-filters select').first().locator('option[value=wages]').count(),0);
  if(c.name==='report-rework_overview'||c.name==='report-wages'){
   const href=await exportLink.getAttribute('href');await page.getByRole('navigation',{name:'财务报表分页',exact:true}).getByRole('button',{name:'2',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('main tbody tr').length===9);assert.match(await page.locator('main tbody tr').last().innerText(),/24/);assert.equal(await exportLink.getAttribute('href'),href);await page.getByRole('navigation',{name:'财务报表分页',exact:true}).getByRole('button',{name:'1',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('main tbody tr').length===15);checks.push('original report pagination24 and unchanged export range');
  }
 }
 if(c.host==='wage-list'){
  if(c.noExport)assert.equal(await page.getByRole('button',{name:'导出当前工资明细',exact:true}).count(),0);
  assert.equal(await page.getByRole('button',{name:'登记结算状态',exact:true}).count(),c.settle?1:0);
  const basis=page.locator('.wage-detail-table tbody tr').first().locator('details');await basis.locator('summary').focus();await basis.locator('summary').press('Space');assert.equal(await basis.evaluate(e=>e.open),true);const text=await basis.innerText();assert.match(text,/单价快照/);assert.match(text,/12\.345/);interactions.push({key,expandedBasis:text});await basis.locator('summary').press('Space');
  if(c.name==='wage-list'){
   const link=page.locator('.wage-query-actions a'),href=await link.getAttribute('href');await page.getByRole('navigation',{name:'工资明细分页',exact:true}).getByRole('button',{name:'2',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wage-detail-table tbody tr').length===9);assert.match(await page.locator('.wage-detail-table tbody tr').last().innerText(),/师傅-24/);assert.equal(await link.getAttribute('href'),href);await page.getByRole('navigation',{name:'工资明细分页',exact:true}).getByRole('button',{name:'1',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.wage-detail-table tbody tr').length===15);
   await page.getByRole('navigation',{name:'工人工资汇总分页',exact:true}).getByRole('button',{name:'2',exact:true}).click();assert.match(await page.locator('.wage-person-grid article').last().innerText(),/师傅-24/);assert.equal(await page.locator('.wage-detail-table tbody tr').count(),15);checks.push('independent person/detail pagination and unchanged full-filter export');
  }
  checks.push('original basis precision and existing settlement visibility; no settlement clicked');
 }
 if(c.host==='wage-detail'){
  const card=page.locator('.wage-item-card').nth(6),summary=card.locator('summary');await summary.focus();await summary.press('Space');assert.equal(await card.locator('details').evaluate(e=>e.open),true);const text=await card.innerText();assert.match(text,/925\.875/);interactions.push({key,expandedShare:text});await summary.press('Space');await page.locator('.wage-item-card').last().scrollIntoViewIfNeeded();assert.match(await page.locator('.wage-item-card').last().innerText(),/工人-18/);checks.push('native calculation disclosure preserves original raw share and final card18 reachable');
 }
 if(!baseline&&(c.host==='report'||c.host==='wage-list')){const region=page.getByRole('region',{name:c.host==='report'?'财务报表明细，可横向滚动':'工资明细，可横向滚动',exact:true});assert.ok(await region.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'current-page rows use page vertical flow');assert.notEqual(await region.locator('thead').evaluate(e=>getComputedStyle(e).display),'none');const numeric=await region.locator('td.reporting-money,td.wage-money').evaluateAll(cells=>cells.map(e=>{const r=document.createRange();r.selectNodeContents(e);const b=e.getBoundingClientRect(),t=r.getBoundingClientRect();return {text:e.textContent,lines:new Set([...r.getClientRects()].filter(x=>x.width).map(x=>Math.round(x.y))).size,withinCell:t.left>=b.left-1&&t.right<=b.right+1};}));assert.ok(numeric.every(x=>x.lines===1&&x.withinCell),key+' money stays on one line inside its original cell');interactions.push({key,numeric});await keyboardEnd(page,region,key);}
 if(original){for(const name of ['expandedBasis','expandedShare']){const current=interactions.find(i=>i.key===key&&name in i);if(current){const before=original.interactions.find(i=>i.key===key&&name in i);assert.ok(before,key+' original expanded counterpart');assert.equal(current[name],before[name],key+' original expanded precision/text retained');}}}
 if(checks.length)interactions.push({key,checks});
}
try{
 const originals=new Map();if(baseline||process.env.REPORT_WAGE_REVIEW_BASELINE)for(const file of ['apps/web/src/reporting/report-center-page.tsx','apps/web/src/reporting/reporting.css','apps/web/src/wages/wage-period-list.tsx','apps/web/src/wages/wage-period-list.css','apps/web/src/wages/wage-period-detail.tsx'])originals.set(resolve(file),execFileSync('git',['show',`${process.env.REPORT_WAGE_BASELINE_SHA||'90673b6342dafcd9130a5939f4c4a81f7cb84121'}:${file}`],{encoding:'utf8'}));
 await build({configFile:false,plugins:[{name:'report-wage-fixed-baseline',enforce:'pre',load(id){return originals.get(id)??null;}}],esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/erp-report-wage-layout.tsx'),name:'ReportWageLayout',formats:['iife']}}});
 const names=await readdir(output),js=await readFile(join(output,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,names.find(n=>n.endsWith('.css'))),'utf8'),html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(directory)await mkdir(directory,{recursive:true});
 for(const viewport of viewports)for(const c of variants){
  if(c.focused&&![1440,375].includes(viewport.width))continue;if(process.env.REPORT_WAGE_ONLY_CASE&&c.name!==process.env.REPORT_WAGE_ONLY_CASE)continue;if(process.env.REPORT_WAGE_ONLY_VIEWPORT&&`${viewport.width}x${viewport.height}`!==process.env.REPORT_WAGE_ONLY_VIEWPORT)continue;
  const key=`${c.name}-${viewport.width}x${viewport.height}`;console.log('START '+key);deadline=setTimeout(()=>void browser.close(),30000);const page=await browser.newPage({viewport});page.on('pageerror',e=>errors.push({key,message:e.message}));
  try{
   await page.route('**/*',route=>{const u=new URL(route.request().url());if(route.request().isNavigationRequest()&&u.hostname==='127.0.0.1')return route.continue();external.push(u.href);return route.abort();});await page.goto(`http://127.0.0.1:${server.address().port}/ui/${c.path}${c.path.includes('?')?'&':'?'}platform_module=rework&from=2026-10-01&to=2026-10-17&fixtureState=${c.state??'normal'}&${c.query??''}`);
   if(c.deny)await page.getByRole('heading',{name:'无权访问此页面',exact:true}).waitFor();else if(c.blocked)await page.getByText('当前账号无权查看工资明细',{exact:true}).waitFor();else if(c.state==='failure')await page.getByText(c.host==='wage-detail'?'TEST 本地合成工资详情读取失败':'TEST 本地合成报表读取失败',{exact:true}).waitFor();else await page.locator(c.root).waitFor({state:'attached',timeout:10000});await page.evaluate(()=>document.fonts.ready);
   const metrics=await collect(page);if(c.deny||c.blocked)assert.equal(await page.evaluate(()=>window.reportWageFixture.requests.filter(r=>r.path.includes('management/reports/wages')||r.path.includes('wage-periods/')).length),0);
   if(original){const prev=original.results.find(r=>r.key===key);assert.ok(prev,'fixed baseline counterpart');for(const name of ['text','links','buttons'])assert.deepEqual(metrics[name],prev.metrics[name],key+' preserves original '+name);if(metrics.table)for(const name of ['rows','headings'])assert.deepEqual(metrics.table[name],prev.metrics.table[name],key+' original '+name);if(c.sentinel)assert.deepEqual(metrics,prev.metrics,key+' unchanged actual sharedCSS consumer');}
   if(!baseline&&!c.sentinel&&!c.deny&&!c.blocked){assert.ok(metrics.documentWidth<=viewport.width+1,key+' no document horizontal overflow '+JSON.stringify({width:metrics.documentWidth,viewport:viewport.width,inputs:metrics.inputs}));if(c.state!=='failure'&&c.host!=='wage-detail')assert.ok(metrics.inputs.every(i=>i.rect.x>=-1&&i.rect.x+i.rect.width<=viewport.width+1),key+' native filter controls fit viewport');}
   if(directory){await page.screenshot({path:join(directory,key+'.png'),fullPage:true});if(!c.state)await page.screenshot({path:join(directory,key+'-viewport.png')});}
   results.push({key,viewport,context:c.name,metrics});if(!c.state&&!c.deny&&!c.blocked&&!c.sentinel)await businessChecks(page,c,key);assert.equal(await page.evaluate(()=>window.reportWageFixture.requests.filter(r=>r.method!=='GET').length),0);
  }catch(error){if(directory&&!page.isClosed()){try{await page.screenshot({path:join(directory,key+'-failure.png'),timeout:3000});await writeFile(join(directory,key+'-failure.txt'),await page.locator('body').innerText());}catch{/* Keep the original failure if evidence capture is unavailable. */}}throw error;}finally{clearTimeout(deadline);await page.close();}console.log('DONE '+key);
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{clearTimeout(deadline);if(directory)await writeFile(join(directory,'result.json'),JSON.stringify({baseline,results,interactions,errors,external,limitations:['Actual App routes with synthetic intercepted reads; no live data, payments, export download or settlement.','Original UI allows/denies are checked; server permission enforcement remains unchanged and is not proven by mocks.','Geometry is local browser evidence, not human usability, physical device or deployed Acceptance.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,interactions:interactions.length,errors,external}));
