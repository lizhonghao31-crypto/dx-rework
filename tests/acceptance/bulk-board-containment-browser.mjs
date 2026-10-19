// Read-only synthetic product hosts. No business service, database or Acceptance access.
import assert from 'node:assert/strict';
import {build} from 'vite';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdtemp,readFile,readdir,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {createServer} from 'node:http';

const baseline=process.argv.includes('--baseline'),composed=process.argv.includes('--composed-795');
assert.ok(process.argv.slice(2).every(x=>['--baseline','--composed-795'].includes(x))&&!(baseline&&composed));
const base='3a5605cc65b3e39e8b281bb79feeed0a1598ea1b',pr795='8c96b71a4ccc132b2cf6c18b988cd2f0bfb7c83d';
const mode=baseline?'baseline':composed?'composed-795':'candidate';
const frozenGit=(...args)=>execFileSync('git',args,{encoding:'utf8'}).trim();
const provenance={startedAtUtc:new Date().toISOString(),head:frozenGit('rev-parse','HEAD'),tree:frozenGit('rev-parse','HEAD^{tree}'),dirtyPaths:frozenGit('status','--porcelain').split('\n').filter(Boolean),productDiffSha256:createHash('sha256').update(frozenGit('diff','HEAD','--','apps','packages')).digest('hex')};
if(process.env.EXPECTED_HEAD_SHA){assert.equal(provenance.head,process.env.EXPECTED_HEAD_SHA);assert.deepEqual(provenance.dirtyPaths,[]);}
const directory=process.env.BULK_CARD_EVIDENCE;
const reference=process.env.BULK_CARD_COMPARE?JSON.parse(await readFile(process.env.BULK_CARD_COMPARE,'utf8')):null;
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const output=await mkdtemp(join(tmpdir(),'dx-bulk-card-test-'));
const results=[],failures=[],pageErrors=[],external=[],navigations=[];
const file='apps/web/src/digital-journey-cockpit.css';
const git=(...args)=>execFileSync('git',args,{encoding:'utf8',stdio:['ignore','pipe','pipe']});
let browser,server;
try{
 let combined;
 if(composed){
  const paths=['candidate','base','pr795'].map(name=>join(output,name+'.css'));
  await writeFile(paths[0],await readFile(file,'utf8'));await writeFile(paths[1],git('show',`${base}:${file}`));await writeFile(paths[2],git('show',`${pr795}:${file}`));
  combined=git('merge-file','-p',...paths);assert.ok(combined.includes('ERP PR09c: each parallel owner remains readable'));
 }
 const replacements=new Map();
 if(baseline)replacements.set(resolve(file),git('show',`${base}:${file}`));
 if(composed){
  replacements.set(resolve(file),combined);
  for(const name of ['digital-analysis-page.tsx','digital-analysis.css'])replacements.set(resolve('apps/web/src/'+name),git('show',`${pr795}:apps/web/src/${name}`));
 }
 await build({configFile:false,plugins:[{name:'frozen-containment-comparison',enforce:'pre',load(id){return replacements.get(id);}}],esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:join(output,'build'),lib:{entry:resolve('tests/fixtures/bulk-board-containment.tsx'),name:'BulkContainment',formats:['iife']}}});
 const files=await readdir(join(output,'build'));
 const js=await readFile(join(output,'build',files.find(x=>x.endsWith('.js'))),'utf8'),css=await readFile(join(output,'build',files.find(x=>x.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((_req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
 if(directory)await mkdir(directory,{recursive:true});
 const viewports=[{width:1165,height:900},{width:1280,height:800},{width:1440,height:900},{width:720,height:900},{width:390,height:844},{width:360,height:800}];
 for(const viewport of viewports){
  const hosts=['bulk','development',...(!baseline&&[1165,390].includes(viewport.width)?['detail-preparing','detail-completed']:[]),...(composed&&[1165,390].includes(viewport.width)?['cockpit','analysis']:[])];
  for(const host of hosts){
   const page=await browser.newPage({viewport,hasTouch:viewport.width<500});page.setDefaultTimeout(7000);await page.clock.setFixedTime(new Date('2026-10-18T12:00:00Z'));
   page.on('pageerror',e=>pageErrors.push({host,viewport,message:e.message}));
   await page.route('**/*',async route=>{
    const req=route.request(),url=new URL(req.url());
    if(req.isNavigationRequest()&&url.hostname==='127.0.0.1'&&url.pathname==='/acceptance/ui/digital-production'){navigations.push(req.url());await route.abort();return;}
    if(req.isNavigationRequest()&&url.hostname==='127.0.0.1'){await route.continue();return;}
    external.push(req.url());await route.abort();
   });
   const isDetail=host.startsWith('detail-');
   const target=isDetail?'digital-pattern-room?fixtureHost=detail&fixtureOrderIndex='+(host==='detail-preparing'?0:3):host==='cockpit'?'digital-cockpit?selected=00000000-0000-4000-8000-000000000500':host==='analysis'?'digital-analysis':'digital-pattern-room?section='+host+'&scope=all&state=all';
   await page.goto(`http://127.0.0.1:${server.address().port}/acceptance/ui/${target}`);
   const needle=isDetail?'/bulk-preparation':host==='bulk'?'workspaces/bulk-pattern?':host==='development'?'workspaces/pattern?':host==='analysis'?'/analysis?':'/journeys/';
   await page.waitForFunction(needle=>window.boardContainmentFixture?.requests.some(r=>r.path.includes(needle)),needle);
   await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   const root=isDetail?'.bulk-preparation-reference':host==='analysis'?'.digital-analysis':host==='cockpit'?'.digital-journey-cockpit':'.pattern-workspace';
   await page.locator(root).first().waitFor();
   const snapshot=await page.locator(root).first().evaluate(e=>{
    const rect=x=>{const r=x.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height};};
    return {text:e.textContent.replace(/\s+/g,' ').trim(),cards:[...e.querySelectorAll('.pattern-task-card')].map(c=>({text:c.textContent,rect:rect(c)})),bodyWidth:document.documentElement.scrollWidth};
   });
   assert.ok(snapshot.bodyWidth<=viewport.width+1,'no document horizontal overflow');
   if(host==='development'&&reference){const before=reference.results.find(r=>r.host===host&&r.viewport.width===viewport.width);assert.deepEqual(snapshot,before.snapshot,'development host, text and all15 card geometries unchanged');}
   const result={host,viewport,snapshot,cards:[],clicks:0};
   if(host==='bulk'){
    const cards=page.locator('.bulk-pattern-columns .pattern-task-card'),expected=await page.evaluate(()=>window.boardContainmentFixture.expectedBulk);
    assert.equal(await cards.count(),15);assert.deepEqual(await page.locator('.bulk-pattern-columns .pattern-lane-cards').evaluateAll(items=>items.map(e=>e.querySelectorAll('.pattern-task-card').length)),[4,4,4,3]);
    for(let index=0;index<15;index++){
     const card=cards.nth(index);await card.scrollIntoViewIfNeeded();
     const m=await card.evaluate(e=>{
      const r=e.getBoundingClientRect(),lane=e.closest('.pattern-board-column'),l=lane.getBoundingClientRect(),s=getComputedStyle(lane),cs=getComputedStyle(e),list=e.parentElement;
      const left=l.left+parseFloat(s.borderLeftWidth)+parseFloat(s.paddingLeft),right=l.right-parseFloat(s.borderRightWidth)-parseFloat(s.paddingRight);
      const texts=[...e.querySelectorAll('strong,small,.dx-badge,.bulk-pattern-card__current,.bulk-pattern-card__reason,.bulk-pattern-card__single-po')].map(t=>({text:t.textContent,client:t.clientWidth,scroll:t.scrollWidth,height:t.clientHeight,scrollHeight:t.scrollHeight}));
      const y=Math.max(2,Math.min(innerHeight-2,r.top+5));
      const hits=[r.left+3,(r.left+r.right)/2,r.right-3].map(x=>{const target=document.elementFromPoint(x,y);return {x,y,hit:Boolean(target&&e.contains(target))};});
      return {style:e.querySelector('strong').textContent,cardWidth:r.width,listWidth:list.clientWidth,track:getComputedStyle(list).gridTemplateColumns,contentWidth:right-left,left:r.left,right:r.right,innerLeft:left,innerRight:right,bottom:r.bottom,columnBottom:l.bottom,overflow:cs.overflow,texts,hits};
     });
     result.cards.push(m);
     const inside=m.left>=m.innerLeft-1&&m.right<=m.innerRight+1&&m.bottom<=m.columnBottom+1;
     if(!inside){failures.push({host,viewport,check:'card-in-own-column',...m});continue;}
     if(baseline)continue;
     assert.ok(m.texts.every(t=>t.scroll<=t.client+2&&t.scrollHeight<=t.height+2),'card text wraps without clipping');
     assert.notEqual(m.overflow,'hidden');assert.ok(m.hits.every(p=>p.hit),'left/center/right of card unobstructed');
     const item=expected.find(x=>x.style===m.style);assert.ok(item);const text=await card.innerText();assert.ok(text.includes(item.style)&&text.includes('BO-IP'));assert.ok(!text.includes(item.orderId),'UUID moved off card');
     for(const placeholder of ['未设时限','无已记录阻断','查看 / 办理原任务','采用开发：','进入办理：'])assert.ok(!text.includes(placeholder));
     const terminal=item.task&&['completed','cancelled'].includes(item.task.state);
     assert.equal(await card.locator('.bulk-pattern-card__deadline').count(),item.task?.dueAt&&!terminal?1:0);
     if(item.task?.state==='cancelled')assert.ok(text.includes('已取消')&&!text.includes('当前：制作'));
     if(item.task?.state==='blocked')assert.ok(text.includes(item.task.blockedReason));
     if(item.reasons.includes('母单已特殊结案，原实绩及历史继续保留')){assert.ok(text.includes('已特殊结案')&&text.includes('原实绩及历史继续保留'));for(const action of ['当前：','待处理：','核对大货准备条件','负责人：','截止：'])assert.ok(!text.includes(action),'closed order is not actionable: '+action);}
     const disclosure=card.locator('details.bulk-pattern-card__po'),clicked=await page.evaluate(()=>window.boardContainmentFixture.clicked.length);
     if(item.poNumbers.length>1){
      const summary=disclosure.locator('summary');assert.equal(await disclosure.evaluate(e=>e.open),false);await summary.focus();await summary.press('Enter');assert.equal(await disclosure.evaluate(e=>e.open),true);
      for(const po of item.poNumbers)assert.ok((await disclosure.innerText()).includes(po));
      assert.ok(await disclosure.evaluate(e=>e.scrollWidth<=e.clientWidth+1),'expanded PO text fits');
      assert.ok(await card.evaluate(e=>{const r=e.getBoundingClientRect(),l=e.closest('.pattern-board-column').getBoundingClientRect();return r.left>=l.left-1&&r.right<=l.right+1&&r.bottom<=l.bottom+1;}),'expanded card stays inside lane');
      await summary.press('Enter');assert.equal(await disclosure.evaluate(e=>e.open),false);
      if(viewport.width<500)await summary.tap();else await summary.click();assert.equal(await disclosure.evaluate(e=>e.open),true);
      if(viewport.width<500)await summary.tap();else await summary.click();assert.equal(await disclosure.evaluate(e=>e.open),false);
      assert.equal(await page.evaluate(()=>window.boardContainmentFixture.clicked.length),clicked,'PO expansion never activates card link');
     }else for(const po of item.poNumbers)assert.ok(text.includes(po));
     const link=card.locator('a.bulk-pattern-card__link');await link.focus();await link.press('Enter');
     let url=new URL(await page.evaluate(()=>window.boardContainmentFixture.clicked.at(-1)));assert.equal(url.searchParams.get(item.targetKey),item.targetId);assert.ok(url.searchParams.get('returnTo')?.includes('digital-pattern-room'));
     assert.equal(await card.evaluate(e=>getComputedStyle(e).outlineStyle),'solid','full card keyboard focus');
     await card.scrollIntoViewIfNeeded();const point=await card.evaluate(e=>{const r=e.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+5};});await page.mouse.move(point.x,point.y);await page.mouse.click(point.x,point.y);
     url=new URL(await page.evaluate(()=>window.boardContainmentFixture.clicked.at(-1)));assert.equal(url.searchParams.get(item.targetKey),item.targetId);assert.equal(await page.evaluate(()=>window.boardContainmentFixture.clicked.length),clicked+2);result.clicks+=2;
    }
    const region=page.locator('.bulk-pattern-workspace .pattern-board-scroll');
    await region.scrollIntoViewIfNeeded();await region.evaluate(e=>{e.scrollLeft=0;e.focus({preventScroll:true});});
    const max=await region.evaluate(e=>e.scrollWidth-e.clientWidth);
    if(max>1){await region.press('ArrowRight');await page.waitForTimeout(100);assert.ok(await region.evaluate(e=>e.scrollLeft>0),'native keyboard horizontal scroll');for(let n=0;n<35;n++){if(await region.evaluate(e=>e.scrollLeft>=e.scrollWidth-e.clientWidth-1))break;await region.press('ArrowRight');await page.waitForTimeout(35);}assert.ok(await region.evaluate(e=>e.scrollLeft>=e.scrollWidth-e.clientWidth-1),'last column reachable by keyboard');}
    result.horizontal={max,position:await region.evaluate(e=>e.scrollLeft)};
   }else if(isDetail){
    const item=await page.evaluate(()=>window.boardContainmentFixture.detailItem),info=page.locator('.bulk-preparation-identifiers');
    assert.ok(snapshot.text.includes('采用开发轮次')&&snapshot.text.includes('当前开发轮次')&&snapshot.text.includes('有效制单')&&snapshot.text.includes('版本 1')&&snapshot.text.includes('本轮事实'));
    assert.equal(await info.evaluate(e=>e.open),false);await info.locator('summary').focus();await info.locator('summary').press('Enter');assert.equal(await info.evaluate(e=>e.open),true);
    assert.ok((await info.innerText()).includes(item.orderId));for(const task of item.sheet.tasks){const text=await info.innerText();assert.ok(text.includes(task.taskId)&&text.includes('进入办理')&&text.includes('实际完成'));}
    for(const fact of item.sheet.facts)assert.ok((await page.locator(root).innerText()).includes(fact.kind));
    result.detail={identifierPresent:true,versionsPresent:true,factsRetained:true};
   }else if(host==='development'){
    assert.equal(snapshot.cards.length,15);const first=page.locator('.pattern-task-card').first();await first.focus();assert.ok(await first.evaluate(e=>document.activeElement===e),'original development card remains keyboard focusable');
   }else if(host==='cockpit'){
    result.pr795=await page.locator('.journey-current-panel').evaluate(e=>({max:getComputedStyle(e).maxHeight,body:getComputedStyle(e.querySelector('.journey-current-body')).maxHeight,parallel:getComputedStyle(document.querySelector('.journey-parallel-nodes')).flexWrap}));
    assert.deepEqual(result.pr795,{max:'none',body:'none',parallel:'wrap'});
   }else{
    const context=page.locator('details.analysis-context');await context.locator('summary').click();assert.ok(await context.evaluate(e=>e.open));
    assert.equal(await page.locator('.digital-analysis-table').evaluate(e=>getComputedStyle(e).maxHeight),'none');result.pr795={contextOpens:true,tableMaxHeight:'none'};
   }
   assert.deepEqual(await page.evaluate(()=>window.boardContainmentFixture.requests.filter(r=>r.method!=='GET')),[],'no business writes');
   if(directory){await page.mouse.move(0,0);await page.evaluate(()=>{document.activeElement?.blur();document.querySelectorAll('.pattern-board-scroll').forEach(e=>{e.scrollLeft=0;});window.scrollTo(0,0);});await page.screenshot({path:join(directory,`${host}-${viewport.width}.png`),fullPage:false});}
   results.push(result);await page.close();console.log(`${mode} ${host} ${viewport.width}: checked`);
  }
 }
 assert.deepEqual(pageErrors,[]);assert.deepEqual(external,[]);
 if(failures.length){console.error(`CARD_CONTAINMENT_FAILED ${failures.length} cards; first=${JSON.stringify(failures[0])}`);process.exitCode=1;}
}finally{
 if(directory)await writeFile(join(directory,'result.json'),JSON.stringify({mode,base,provenance:{...provenance,finishedAtUtc:new Date().toISOString()},pr795:composed?pr795:null,results,failures,pageErrors,external,navigations,limits:['Synthetic intercepted GETs and local aborted navigation use actual product components/CSS, not deployed Acceptance or real orders.','Composition loads frozen PR795 modules only into this test bundle; no branch merge or product source copy.']},null,2));
 await browser?.close();if(server)await new Promise(done=>server.close(done));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({mode,frames:results.length,checkedCards:results.filter(r=>r.host==='bulk').reduce((n,r)=>n+r.cards.length,0),clicks:results.reduce((n,r)=>n+r.clicks,0),containmentFailures:failures.length,pageErrors,external}));
