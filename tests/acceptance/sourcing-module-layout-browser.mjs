import assert from 'node:assert/strict';
import {build} from 'vite';
import {createServer} from 'node:http';
import {mkdtemp,mkdir,readFile,readdir,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||'playwright');
const evidence=process.env.SOURCING_MODULE_EVIDENCE,temporary=await mkdtemp('/tmp/sourcing-module-matrix-'),results=[],failures=[];
const nodes=['created','ie_quote','management','owner','finance'],roleFor={created:'merchandiser',ie_quote:'ie',management:'management',owner:'owner',finance:'finance'};
const reps=[{node:'owner',width:1440},{node:'owner',width:1180},{node:'ie_quote',width:1366},{node:'owner',width:1440,historical:true},{node:'owner',width:390}];
const baseline=nodes.flatMap(node=>[false,true].flatMap(historical=>[1440,1366,1180,390].map(width=>({node,historical,width}))));
const extra=[...[1440,390].flatMap(width=>[{node:'owner',width,role:'readonly'},{node:'finance',width,contract:'denied'},{node:'finance',width,role:'merchandiser'},{node:'owner',width,role:'denied'},{node:'owner',width,historical:true,variant:'missing'},{node:'owner',width,historical:true,older:true},{node:'management',width,historical:true,variant:'partial'}]),...[1440,1180,390].map(width=>({node:'finance',width,variant:'partial'})),...['ie_quote','management'].map(node=>({node,width:1440,role:'root'})),...[1357,1180,1165,500,390].map(width=>({node:'finance',width,height:width===1165?747:900,role:'owner',variant:'deployed'}))];
const key=c=>[c.node,c.width,c.historical?'history':'current',c.role||roleFor[c.node],c.variant||'',c.contract||'',c.older?'v1':''].join('-');
const cases=[...new Map((process.env.SOURCING_REPRESENTATIVES_ONLY==='1'?reps:[...reps,...baseline,...extra]).map(c=>[key(c),c])).values()];
const svg='<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="100%" height="100%" fill="#edf2f8"/><text x="160" y="120" text-anchor="middle" fill="#667b99" font-size="18">TEST 合成示意图</text></svg>';
let browser,server;
try{
 if(evidence)await mkdir(evidence,{recursive:true});
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'},build:{outDir:temporary,lib:{entry:resolve('tests/fixtures/sourcing-module-layout.tsx'),name:'SourcingModuleLayout',formats:['iife']}}});
 const files=await readdir(temporary),js=await readFile(join(temporary,files.find(f=>f.endsWith('.js'))),'utf8'),css=await readFile(join(temporary,files.find(f=>f.endsWith('.css'))),'utf8');
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
 server=createServer((req,res)=>{res.setHeader('content-type','text/html;charset=utf-8');res.end(html);});await new Promise(done=>server.listen(0,'127.0.0.1',done));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});const origin=`http://127.0.0.1:${server.address().port}`;
 for(let i=0;i<cases.length;i++){
  const c=cases[i],name=key(c),errors=[],page=await browser.newPage({viewport:{width:c.width,height:c.height??900},hasTouch:c.width<500});page.setDefaultTimeout(12000);page.on('pageerror',e=>errors.push(e.message));
  try{
   await page.route('**/*',route=>{const r=route.request(),u=new URL(r.url());if(r.isNavigationRequest()&&u.origin===origin)return route.continue();if(r.resourceType()==='image'&&u.origin===origin)return route.fulfill({contentType:'image/svg+xml',body:svg});throw Error('Unexpected native request: '+r.resourceType());});
   const q=new URLSearchParams({node:c.node,role:c.role||roleFor[c.node]});if(c.historical)q.set('view','node-history');if(c.variant)q.set('variant',c.variant);if(c.contract)q.set('contract',c.contract);if(c.older)q.set('entryId','00000000-0000-4000-8000-000000000401');
   await page.goto(`${origin}/acceptance/ui/sourcing/orders/00000000-0000-4000-8000-000000000100?${q}`);
   if(c.role==='denied'){await page.getByText('TEST 当前订单不可读',{exact:true}).waitFor();assert.equal(await page.locator('.sourcing-module-layout').count(),0);}
   else if(c.variant==='missing'){await page.getByText('该节点没有已提交的历史记录',{exact:true}).waitFor();assert.equal(await page.locator('.sourcing-module-layout').count(),0);}
   else{
    await page.locator('.sourcing-module-layout .sourcing-workflow-rail').waitFor();await page.evaluate(()=>document.fonts.ready);
    const metrics=await page.evaluate(()=>{const box=s=>{const el=document.querySelector(s),r=el.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom,folded:Boolean(el.closest('details:not([open])'))};};return {photo:box('.sourcing-order-photos'),flow:box('.sourcing-workflow-section'),main:box('.order-layout-main'),facts:box('.sourcing-key-facts'),factsRows:[...new Set([...document.querySelectorAll('.sourcing-key-facts>div')].map(e=>Math.round(e.getBoundingClientRect().top)))],overflow:document.documentElement.scrollWidth-innerWidth};});
    assert.ok(metrics.overflow<=1,'document has no horizontal overflow');assert.equal(metrics.flow.folded,false,'workflow visible by default');assert.equal(metrics.photo.folded,false);assert.ok(metrics.main.y>=metrics.flow.bottom+8,'work area below overview');assert.ok(Math.abs(metrics.main.width-metrics.facts.width)<2,'full width work area');
    metrics.factGroups=await page.locator('.sourcing-key-facts>div').evaluateAll(elements=>elements.map(e=>{const r=e.getBoundingClientRect(),dt=e.querySelector('dt'),dd=e.querySelector('dd'),divider=getComputedStyle(e,'::after');return {label:dt.textContent,value:dd.textContent,x:r.x,y:r.y,width:r.width,labelWeight:getComputedStyle(dt).fontWeight,valueWeight:getComputedStyle(dd).fontWeight,divider:divider.content!=='none'&&divider.display!=='none'&&divider.width==='1px'};}));
    assert.equal(metrics.factGroups.length,9,'all roles and current/history use nine independent fact groups');
    assert.match(metrics.factGroups[7].label,/^PO \/ /);assert.equal(metrics.factGroups[7].value.includes('加工厂交货日'),false,'customer and factory dates are separate groups');
    assert.match(metrics.factGroups[8].label,/加工厂交货日|要求交货日期/);
    if(c.width>800){assert.ok(metrics.factGroups.slice(0,4).every(g=>Math.abs(g.y-metrics.factGroups[0].y)<1),'first row has four groups');assert.ok(metrics.factGroups.slice(4).every(g=>Math.abs(g.y-metrics.factGroups[4].y)<1),'second row has five groups');assert.deepEqual(metrics.factGroups.map(g=>g.divider),[true,true,true,false,true,true,true,true,false],'fine vertical dividers follow actual row boundaries');assert.ok(Number(metrics.factGroups[2].valueWeight)>Number(metrics.factGroups[2].labelWeight),'values lead muted labels');}
    if(c.variant==='deployed'){assert.equal(await page.locator('h1').innerText(),'TEST-UX-20261016-V3-C01-P01');assert.deepEqual(metrics.factGroups.map(g=>g.value),['[UAT] 订单跟单','TEST-UAT-1006-FACTORY2','5 件','¥50.00','¥50.00','¥0.00','2026-10-20','2026-12-01','2026-11-20'],'same visible facts and owner role as deployed screenshot');}
    if(c.width>800){assert.ok(Math.abs(metrics.photo.y-metrics.flow.y)<2&&metrics.photo.right<metrics.flow.x,'photos left and real flow right');assert.equal(metrics.factsRows.length,2,'two logical desktop fact rows');}
    const summary=page.locator('.order-layout-main>.dx-decision-summary');
    if(await summary.count()){
     assert.equal(await summary.evaluate(e=>Boolean(e.closest('details:not([open])'))),false,'summary defaults visible');
     const layout=await summary.evaluate(e=>({width:e.getBoundingClientRect().width,content:e.querySelector('div').getBoundingClientRect().width,height:e.getBoundingClientRect().height,title:e.querySelector('h2').getBoundingClientRect().height}));
     assert.ok(layout.content>=layout.width-50&&layout.title<30,'summary content uses full width, no narrow empty grid column');assert.ok(layout.height<360,'summary does not stretch into a tall empty column');
    }
    if(c.historical){assert.equal(await page.locator('.sourcing-node-history input:not([readonly]),.sourcing-node-history textarea:not([readonly]),.sourcing-node-history input[type=file],.sourcing-node-history form').count(),0,'historical snapshots have no writable business inputs');assert.equal(metrics.factGroups[7].value,'当时日期不详','production history response omits customer dates; absence is not a missing-current-date claim');if(c.older){assert.ok((await page.locator('.sourcing-node-history').innerText()).includes('TEST 历史加工厂V1'));assert.equal((await page.locator('.sourcing-node-history').innerText()).includes('模拟工厂·南岭制衣'),false,'current supplier does not backfill old snapshot');}}
    if(c.role==='readonly')assert.equal(await page.locator('.sourcing-owner-actions').count(),0,'read-only role gets no approval actions');
    if(c.role==='merchandiser'&&c.node==='finance'){assert.equal(await page.locator('.sourcing-workflow-step').count(),4,'original merchandiser node scope retained');assert.equal(await page.locator('.sourcing-finance-confirmation').count(),0);}
    if(c.contract==='denied')for(const label of ['预览合同 PDF','下载合同'])assert.equal(await page.getByRole('link',{name:label,exact:true}).count(),0,'restricted contract links absent');
    if(!c.historical&&!c.role&&['ie_quote','management'].includes(c.node)){await page.locator('fieldset.sourcing-submission-fields').waitFor();assert.ok(await page.locator('fieldset.sourcing-submission-fields input').count()>=6,'real role price inputs retained');}
    if(!c.historical&&c.node==='ie_quote'&&(!c.role||['ie','root'].includes(c.role))){
     const inputs=page.locator('[aria-label="IE逐款价格"] input');const first=await inputs.first().boundingBox();metrics.firstQuoteInputY=first.y;
     assert.ok(first.y<metrics.main.y+250,'quote inputs lead the work area');
     if(c.width>800)assert.ok(first.y<850,'desktop quote starts within the first viewport');
     assert.equal(await page.locator('.sourcing-quote-context').getAttribute('open'),null,'duplicate reference table starts compact');
     await inputs.first().fill('1.25');await inputs.first().blur();assert.match(await page.locator('.sourcing-line-price-row').first().innerText(),/250\.00/,'original quantity and amount calculation retained');
     await page.locator('.sourcing-quote-context>summary').click();assert.equal(await page.locator('.sourcing-quote-context tbody tr').count(),6,'all original PO facts remain available');await page.locator('.sourcing-quote-context>summary').click();await page.reload();await page.locator('.sourcing-workflow-rail').waitFor();await page.locator('fieldset.sourcing-submission-fields').waitFor();await page.evaluate(()=>document.fonts.ready);
    }
    if(!c.historical&&c.node==='finance'&&!c.role&&c.contract!=='denied')await page.locator('.sourcing-finance-confirmation').waitFor();
    if(c.variant==='partial'){const text=await summary.innerText();assert.ok(text.includes('450')&&text.includes('16,900'),'partial decision quantity and amount retained');assert.ok((await page.locator('.sourcing-key-facts').innerText()).includes('1,950'),'parent order quantity stays distinct');}
    if(!c.historical&&c.node==='owner'&&!c.role){assert.equal(await page.getByText('请核对价格、加工厂及交期，确认后审批。',{exact:true}).count(),1,'approval reminder once');assert.equal(await page.locator('.sourcing-order-craft').count(),0,'crafts are not repeated below table');
     if(c.width>800){const bounds=await page.locator('.order-layout-line-items').boundingBox();const cells=await page.locator('.order-layout-line-items .dx-facts-table tbody tr').first().locator('td').evaluateAll(nodes=>nodes.map(n=>({text:n.textContent,left:n.getBoundingClientRect().left,right:n.getBoundingClientRect().right,font:parseFloat(getComputedStyle(n).fontSize),padding:parseFloat(getComputedStyle(n).paddingTop)})));for(const cell of cells){assert.ok(cell.left>=bounds.x-1&&cell.right<=bounds.x+bounds.width+1,'all default price/date columns visible');assert.ok(cell.font>=13&&cell.padding>=8,'readable table spacing');}metrics.cells=cells;}
    }
    if(evidence){await page.screenshot({path:join(evidence,`${name}.png`),fullPage:true});await page.screenshot({path:join(evidence,`${name}-viewport.png`)});}
    if(i===0||c.width===390&&c.node==='owner'&&!c.role&&!c.historical){const file=page.locator('.sourcing-order-photo-file').first(),caption=file.locator('summary'),fullName=await caption.getAttribute('title');await caption.hover();assert.equal(await file.locator('.sourcing-order-photo-file__peek').evaluate(e=>getComputedStyle(e).display),'block');await page.keyboard.press('Tab');await caption.focus();await caption.press('Enter');assert.equal(await file.locator('.sourcing-order-photo-file__full p').innerText(),fullName,'complete keyboard/touch filename');await file.getByRole('button',{name:'查看原附件',exact:true}).click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();await caption.press('Enter');}
    if(c.width<500){
     if(evidence&&c.node==='owner'&&!c.role&&!c.historical){
      await page.locator('.sourcing-workflow-section').evaluate(e=>e.scrollIntoView({block:'start'}));
      const flowVisible=await page.locator('.sourcing-workflow-section').evaluate(e=>{const r=e.getBoundingClientRect(),nav=document.querySelector('.mobile-primary-navigation')?.getBoundingClientRect();return r.top>=0&&r.bottom<=(nav?.top??innerHeight)-8;});assert.ok(flowVisible,'entire real workflow stays above fixed bottom navigation');
      await page.screenshot({path:join(evidence,'phone-flow.png')});
      await page.locator('.order-layout-main').evaluate(e=>e.scrollIntoView({block:'start'}));await page.screenshot({path:join(evidence,'phone-work-area.png')});
     }
     await page.evaluate(()=>scrollTo(0,document.documentElement.scrollHeight));
     if(evidence&&c.node==='owner'&&!c.role&&!c.historical){
      const target=page.locator('.sourcing-owner-reject__target');assert.equal(await target.innerText(),'供应链总监');const lines=await target.evaluate(e=>{const r=e.getBoundingClientRect();return {height:r.height,line:parseFloat(getComputedStyle(e).lineHeight)};});assert.ok(lines.height<=lines.line+1,'complete role name fits on one semantic line');
      await page.screenshot({path:join(evidence,'phone-bottom-actions.png')});
     }const clearance=await page.evaluate(()=>{const nav=document.querySelector('.mobile-primary-navigation'),main=document.querySelector('.order-layout-main');return nav?nav.getBoundingClientRect().top-main.getBoundingClientRect().bottom:100;});assert.ok(clearance>=8,'last work content can scroll above fixed navigation');}
    results.push({name,...c,metrics});

   }
   assert.deepEqual(await page.evaluate(()=>window.orderLayoutFixture.requests.filter(r=>r.method!=='GET')),[],'no business writes');assert.deepEqual(errors,[]);
   if(i===4&&evidence){await writeFile(join(evidence,'representatives-ready.json'),JSON.stringify({status:'passed',cases:results.slice(0,5)},null,2));console.log(JSON.stringify({representatives_ready:true,evidence}));}
  }catch(error){failures.push({name,error:String(error),pageErrors:errors,body:(await page.locator('body').innerText().catch(()=>'' )).slice(0,1800)});if(evidence){await page.screenshot({path:join(evidence,`FAILED-${name}.png`),fullPage:true});await writeFile(join(evidence,`FAILED-${name}.json`),JSON.stringify(failures.at(-1),null,2));}if(i<5||failures.length>=3)throw error;}
  finally{await page.close();}
 }
 assert.deepEqual(failures,[]);
 if(evidence)await writeFile(join(evidence,'results.json'),JSON.stringify({status:'passed',head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),uncommitted:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim()!=='',results,failures,limitation:'Real sourcing components; synthetic per-role/status/snapshot responses on loopback. No online Acceptance or production requests, no business writes, no human UAT claim.'},null,2));
 console.log(JSON.stringify({status:'passed',cases:results.length,evidence}));
}finally{await browser?.close();await new Promise(done=>server?server.close(done):done());await rm(temporary,{recursive:true,force:true});}
