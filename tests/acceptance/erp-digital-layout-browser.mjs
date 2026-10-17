import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-digital-layout-')),directory=process.env.DIGITAL_LAYOUT_EVIDENCE;
const baseline=Boolean(process.env.DIGITAL_LAYOUT_BASELINE),focused=Boolean(process.env.DIGITAL_LAYOUT_FOCUSED);
const results=[],errors=[],external=[],interactions=[];
const original=process.env.DIGITAL_LAYOUT_COMPARE?JSON.parse(await readFile(process.env.DIGITAL_LAYOUT_COMPARE,'utf8')).results:null;
const contexts=[
 {name:'development',path:'digital-pattern-room',query:'section=development&state=all',needle:'workspaces/pattern?',root:'.pattern-workspace'},
 {name:'bulk',path:'digital-pattern-room',query:'section=bulk',needle:'workspaces/bulk-pattern?',root:'.pattern-workspace'},
 {name:'misc',path:'digital-pattern-room',query:'section=legacy',needle:'pattern-room/orders?',root:'.pattern-workspace'},
 {name:'task-workbench',path:'digital-pattern-room',query:'task=00000000-0000-4000-8000-000000000900&fixtureTask=1',needle:'/execution',root:'.task-workbench-sample'},
 {name:'analysis',path:'digital-analysis',query:'',needle:'/analysis?',root:'.digital-analysis'},
 {name:'cockpit-overview',path:'digital-cockpit',query:'',needle:'/journeys?',root:'.digital-journey-cockpit'},
 {name:'cockpit-order',path:'digital-cockpit',query:'selected=00000000-0000-4000-8000-000000000500',needle:'/journeys/',root:'.digital-journey-cockpit'},
];
const variants=[...contexts.map(c=>({...c,state:'normal'})),{...contexts[4],name:'analysis-note-entry',query:'fixtureCanRecord=1',state:'normal'},{...contexts[6],name:'cockpit-documents',query:contexts[6].query+'&fixtureDocuments=1',state:'normal'}];
let browser,server,caseDeadline;
async function collect(page,root){return page.locator(root).evaluate(element=>{
 const rect=e=>{if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height};};
 const visible=e=>Boolean(e.getClientRects().length)&&e.clientHeight>0;
 return {bodyWidth:document.documentElement.scrollWidth,text:element.textContent.replaceAll('分布与分析口径','').replace(/\s+/g,' ').trim(),
  links:[...element.querySelectorAll('a')].map(e=>({text:e.textContent,href:e.getAttribute('href')})),
  buttons:[...element.querySelectorAll('button')].map(e=>({text:e.textContent,disabled:e.disabled,label:e.getAttribute('aria-label')})),
  scrolls:[element,...element.querySelectorAll('*')].filter(e=>{const s=getComputedStyle(e);return visible(e)&&['auto','scroll'].includes(s.overflowY)&&e.scrollHeight>e.clientHeight+2;}).map(e=>({class:e.className,client:e.clientHeight,scroll:e.scrollHeight,rect:rect(e)})),
  cards:[...element.querySelectorAll('.pattern-task-card')].map(e=>({text:e.textContent,height:e.clientHeight,scroll:e.scrollHeight,rect:rect(e)})),
  tables:[...element.querySelectorAll('table')].map(e=>({rows:e.rows.length,rect:rect(e)})),
  layout:{headings:[...element.querySelectorAll('h1,h2')].map(rect),firstInput:rect(element.querySelector('input')),footer:rect(element.querySelector('footer'))},
  firstDetailY:rect(element.querySelector('.analysis-detail-panel'))?.y,
  progress:element.querySelector('.journey-progress-panel')?.textContent??null};
 });}
async function keyboardScroll(page,region,label){
 await region.focus();await region.locator('tbody tr:last-child td:last-child a:last-of-type').scrollIntoViewIfNeeded();await region.evaluate(e=>{e.scrollLeft=0;e.focus({preventScroll:true});});const max=await region.evaluate(e=>e.scrollWidth-e.clientWidth);
 if(max>0){await region.press('ArrowRight');await page.waitForTimeout(100);assert.ok(await region.evaluate(e=>e.scrollLeft>0),label+' actual keyboard movement');
  for(let step=0;step<100;step++){if(await region.evaluate(e=>e.scrollLeft>=e.scrollWidth-e.clientWidth))break;await region.press('ArrowRight');await page.waitForTimeout(25);}
  const result=await region.evaluate(e=>{const last=e.querySelector('tbody tr:last-child td:last-child a:last-of-type'),range=document.createRange();range.selectNodeContents(last);range.setStart(last.firstChild,last.firstChild.textContent.length-1);const b=e.getBoundingClientRect(),r=range.getBoundingClientRect();return {left:e.scrollLeft,max:e.scrollWidth-e.clientWidth,lastCharacterVisible:r.left>=b.left-1&&r.right<=b.right+1&&r.top>=0&&r.bottom<=innerHeight&&last.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))};});
  assert.equal(result.left,result.max);assert.equal(result.lastCharacterVisible,true);interactions.push({label,keyboard:result});
 }
 await region.evaluate(e=>{e.scrollLeft=0;e.blur();});
}
async function analysisChecks(page,variant,viewport){
 const table=page.getByRole('region',{name:'节点明细，可横向滚动',exact:true});
 assert.ok(await table.evaluate(e=>e.scrollHeight<=e.clientHeight+1),'all current-page rows use page vertical flow');
 const label=page.locator('.digital-analysis-filters label').filter({hasText:'当前主办'});
 const labelGeometry=await label.evaluate(e=>{const range=document.createRange();range.selectNodeContents(e.firstChild);const r=range.getBoundingClientRect();return {height:r.height,width:r.width,lineCount:new Set([...range.getClientRects()].filter(b=>b.width>0).map(b=>Math.round(b.y))).size,nodeType:e.firstChild.nodeType,text:e.firstChild.textContent,labelWidth:e.clientWidth,lineHeight:getComputedStyle(e).lineHeight};});interactions.push({label:'assignee-'+viewport.width,geometry:labelGeometry});assert.equal(labelGeometry.lineCount,1,JSON.stringify(labelGeometry));
 const summary=page.locator('.analysis-context>summary');await summary.focus();await summary.press('Space');assert.equal(await summary.locator('..').evaluate(e=>e.open),true);
 assert.ok(await page.locator('.analysis-insights>section').evaluateAll(items=>items.every(e=>e.scrollHeight<=e.clientHeight+1)),'expanded analysis has no short vertical scrollers');
 await summary.press('Space');assert.equal(await summary.locator('..').evaluate(e=>e.open),false);
 await keyboardScroll(page,table,variant.name+'-'+viewport.width);
 const last=page.locator('.digital-analysis-table tbody tr').last();await last.scrollIntoViewIfNeeded();assert.match(await last.innerText(),/外套-15/);
 if(variant.name==='analysis'){
  await page.locator('.analysis-detail-panel .dx-production-pagination').getByRole('button',{name:'下一页',exact:true}).click();
  await page.locator('[data-analysis-ready=true]').waitFor();await page.waitForFunction(()=>document.querySelectorAll('.digital-analysis-table tbody tr').length===9);
  assert.match(await page.locator('.digital-analysis-table tbody tr').last().innerText(),/外套-24/);
  await page.locator('.analysis-detail-panel .dx-production-pagination').getByRole('button',{name:'上一页',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('.digital-analysis-table tbody tr').length===15);
  const selector=label.getByRole('combobox');await selector.click();await page.getByRole('option',{name:'TEST 张师傅（板房制作）',exact:true}).click();
  await page.waitForFunction(()=>new URL(location.href).searchParams.get('assigneeId')==='00000000-0000-4000-8000-000000000001');
  assert.equal(new URL(page.url()).searchParams.get('page'),'1');
 }
 interactions.push({label:variant.name+'-'+viewport.width,checks:['native disclosure keyboard open/close','all current-page rows reachable','original pagination reaches record24 and original assignee query for primary case']});
}
async function journeyChecks(page,variant,viewport,metrics){
 assert.ok(await page.locator('.journey-parallel-nodes button').count()>=2,'parallel fixture includes multiple current choices');
 assert.ok(await page.locator('.journey-parallel-nodes button').evaluateAll(items=>items.every(e=>e.getBoundingClientRect().width>=Math.min(160,e.parentElement.clientWidth)-1)),'parallel choices do not become single-character columns');
 assert.ok(await page.locator('.journey-current-panel,.journey-current-body,.journey-documents-viewport,.journey-activities').evaluateAll(items=>items.every(e=>e.scrollHeight<=e.clientHeight+1)),'current work and records avoid nested vertical scroll');
 if(viewport.width<=800)assert.ok(await page.locator('.journey-parallel-nodes button,.journey-activities li,.journey-activities time,.journey-activities button').evaluateAll(items=>items.every(e=>parseFloat(getComputedStyle(e).fontSize)>=16)),'mobile business copy keeps the16px baseline');
 if(viewport.width<=800)assert.ok(await page.locator('.journey-node-tabs').evaluate(e=>e.scrollHeight<=e.clientHeight+1),'node controls fit their vertical bounds');
 const progress=metrics.progress;const stages=page.locator('.journey-flow-panel .dx-production-stage');assert.equal(await stages.count(),7);
 for(let index=0;index<7;index++){await stages.nth(index).click();assert.equal(await page.locator('.journey-progress-panel').textContent(),progress,'stage selection keeps whole-order progress denominator');}
 const rows=page.locator('.journey-activities li');await rows.last().scrollIntoViewIfNeeded();assert.ok(await rows.last().isVisible());
 if(variant.name==='cockpit-documents')assert.ok(await page.locator('.journey-documents-viewport a').count()>=3,'existing nonempty original documents stay available');
 interactions.push({label:variant.name+'-'+viewport.width,checks:['seven stages retain whole-order progress','all parallel choices and last record accessible','original document links retained']});
}
try{
 const changed=['digital-analysis-page.tsx','digital-analysis.css','digital-journey-cockpit.css'];
 await build({configFile:false,plugins:baseline?[{name:'fixed-original-digital-layout',load(file){if(changed.some(name=>file===resolve(`apps/web/src/${name}`)))return execFileSync('git',['show',`${process.env.DIGITAL_LAYOUT_BASELINE_SHA||'0e198f0989050d7fd7a400b7a6a9453bde71cbfd'}:apps/web/src/${file.split('/').at(-1)}`],{encoding:'utf8'});}}]:[],esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/erp-digital-layout.tsx'),name:'DigitalLayout',formats:['iife']}}});
 const names=await readdir(output),js=await readFile(join(output,names.find(n=>n.endsWith('.js'))),'utf8'),css=await readFile(join(output,names.find(n=>n.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});if(directory)await mkdir(directory,{recursive:true});
 const viewports=process.env.DIGITAL_LAYOUT_ONLY_VIEWPORT?[{width:Number(process.env.DIGITAL_LAYOUT_ONLY_VIEWPORT.split('x')[0]),height:Number(process.env.DIGITAL_LAYOUT_ONLY_VIEWPORT.split('x')[1])}]:focused?[{width:1440,height:900},{width:390,height:844}]:[{width:1440,height:900},{width:1366,height:768},{width:1366,height:480},{width:720,height:450},{width:390,height:844},{width:375,height:812}];
 for(const viewport of viewports){let cases=[...variants];if(viewport.width===1440||viewport.width===390)for(const state of ['empty','failure'])for(const context of contexts.filter(c=>c.name!=='task-workbench'))cases.push({...context,state,name:context.name+'-'+state});
 if(process.env.DIGITAL_LAYOUT_ONLY_CASE)cases=cases.filter(c=>c.name===process.env.DIGITAL_LAYOUT_ONLY_CASE);
 for(const variant of cases){console.log('START '+variant.name+' '+viewport.width+'x'+viewport.height);caseDeadline=setTimeout(()=>{errors.push({name:variant.name,error:'local case exceeded30s'});void browser.close();},30000);const page=await browser.newPage({viewport,hasTouch:viewport.width<500});page.setDefaultTimeout(7000);page.on('pageerror',e=>errors.push({name:variant.name,error:e.message}));
  await page.route('**/*',route=>{if(route.request().isNavigationRequest()&&new URL(route.request().url()).hostname==='127.0.0.1')return route.continue();external.push(route.request().url());return route.abort();});
  try{await page.goto(`http://127.0.0.1:${server.address().port}/acceptance/ui/${variant.path}?${variant.query}&fixtureState=${variant.state}`);
   await page.waitForFunction(needle=>window.digitalLayoutFixture?.requests.some(r=>r.path.includes(needle)),variant.needle);
   await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
   await page.locator(variant.root).first().waitFor();if(variant.state==='failure')await page.getByRole('alert').first().waitFor();
   if(variant.name.startsWith('analysis')&&variant.state!=='failure')await page.locator('[data-analysis-ready=true]').waitFor();
   if(variant.name==='task-workbench')await page.locator('.task-workbench-sample textarea').waitFor();
   const metrics=await collect(page,variant.root);assert.ok(!metrics.text.includes('Unexpected synthetic'),'no unmapped synthetic read');assert.ok(metrics.bodyWidth<=viewport.width+1,'no whole-page horizontal overflow');
   if(original){const previous=original.find(r=>r.name===variant.name&&r.viewport.width===viewport.width&&r.viewport.height===viewport.height);assert.ok(previous,'recorded original counterpart');for(const key of ['text','links','buttons','progress'])assert.deepEqual(metrics[key],previous.metrics[key],variant.name+' original '+key+' retained');
    if(['development','bulk','misc','task-workbench','cockpit-overview'].includes(variant.name)){assert.deepEqual(metrics.layout,previous.metrics.layout,'unchanged host geometry');assert.deepEqual(metrics.cards,previous.metrics.cards,'unchanged original board cards');}
   }
   assert.deepEqual(await page.evaluate(()=>window.digitalLayoutFixture.requests.filter(r=>r.method!=='GET')),[]);
   if(directory){await page.screenshot({path:join(directory,`${variant.name}-${viewport.width}x${viewport.height}.png`),fullPage:variant.name!=='task-workbench'});if(variant.state==='normal')await page.screenshot({path:join(directory,`${variant.name}-${viewport.width}x${viewport.height}-viewport.png`)});}
   results.push({name:variant.name,state:variant.state,viewport,metrics});
   if(!baseline&&variant.state==='normal'){if(variant.name.startsWith('analysis'))await analysisChecks(page,variant,viewport);if(variant.name==='cockpit-order'||variant.name==='cockpit-documents')await journeyChecks(page,variant,viewport,metrics);}
  }catch(error){if(directory&&!page.isClosed()){try{await page.screenshot({path:join(directory,`${variant.name}-${viewport.width}-failure.png`),fullPage:false,timeout:3000});await writeFile(join(directory,`${variant.name}-${viewport.width}-failure.txt`),await page.locator('body').innerText());}catch{/* Preserve the original assertion if failure evidence cannot be captured. */}}throw error;}finally{clearTimeout(caseDeadline);await page.close();}console.log('DONE '+variant.name+' '+viewport.width+'x'+viewport.height);
 }}
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{if(directory)await writeFile(join(directory,'result.json'),JSON.stringify({results,errors,external,interactions,baseline,limitations:['Synthetic intercepted GETs render actual seven digital contexts; current workbench plus normal/empty/failure and document/registration contexts, not live business/role acceptance.','720×450 is reduced CSS viewport simulation; touch is browser emulation, not physical-device or real-zoom evidence.','No business POST, real production/Acceptance or deployment operation.']},null,2));await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
console.log(JSON.stringify({frames:results.length,interactions:interactions.length,baseline,errors,external}));
