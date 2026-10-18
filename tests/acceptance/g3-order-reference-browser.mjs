import assert from 'node:assert/strict';
import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const evidence = process.env.ORDER_REFERENCE_EVIDENCE;
const draft = process.env.ORDER_REFERENCE_DRAFT === '1';
const handover = process.env.ORDER_REFERENCE_CASE === 'handover';
const base = process.env.ORDER_REFERENCE_BASE || 'b98f99e088008f3edad3a1ce3871c575c182cd63';
const output = await mkdtemp(join(tmpdir(), 'dx-order-reference-'));
const docs = {}, results = [], errors = [], external = [];
let server, browser;
const digest = data => createHash('sha256').update(data).digest('hex');
// The harness selector is carried through existing task URLs; exclude only that test parameter.
const linkIdentity = link => {const url=new URL(link.href,'http://fixture.invalid');url.searchParams.delete('version');return JSON.stringify({text:link.text,href:url.pathname+url.search+url.hash});};
try {
  for (const version of (draft ? ['candidate'] : ['before','candidate'])) for (const family of ['sourcing','rework']) {
    const outDir = join(output, `${version}-${family}`);
    await build({ configFile:false, logLevel:'error', plugins:version === 'before' ? [{ name:'frozen-release-source', load(file) {
      const local = file.split('?')[0];
      if (local.startsWith(resolve('apps/web/src') + '/')) return execFileSync('git',['show',`${base}:${local.slice(process.cwd().length + 1)}`],{encoding:'utf8'});
    }}] : [], esbuild:{jsx:'automatic'}, define:{'import.meta.env.BASE_URL':'"/acceptance/"','process.env.NODE_ENV':'"production"'}, build:{outDir,lib:{entry:resolve(`tests/fixtures/erp-order-layout-${family}.tsx`),name:'OrderReference',formats:['iife']}} });
    const names = await readdir(outDir), js = await readFile(join(outDir,names.find(name=>name.endsWith('.js'))),'utf8'), css = await readFile(join(outDir,names.find(name=>name.endsWith('.css'))),'utf8');
    docs[`${version}-${family}`] = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  }
  const reference = await readFile('tests/fixtures/approved-order-reference.html','utf8');
  server = createServer((req,res)=>{ const url = new URL(req.url,'http://localhost'); res.setHeader('content-type','text/html;charset=utf-8'); res.end(url.pathname === '/approved' ? reference : docs[`${url.searchParams.get('version') || 'candidate'}-${url.pathname.includes('sourcing')?'sourcing':'rework'}`]); });
  await new Promise(done=>server.listen(0,'127.0.0.1',done));
  browser = await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH || '/usr/bin/chromium',args:['--no-sandbox']});
  if (evidence) await mkdir(evidence,{recursive:true});
  const origin = `http://127.0.0.1:${server.address().port}`;
  const cases = handover ? [['owner-reference','sourcing','node=owner&role=owner&reference=1'],['finance-current','sourcing','node=finance&role=finance&reference=1'],['mobile-name-finishing-history','rework','view=node-history&node=initiation&kind=finishing']] : process.env.ORDER_REFERENCE_CASE === 'finance' ? [['finance-current','sourcing','node=finance&role=finance&reference=1']] : draft ? [['owner-reference','sourcing','node=owner&role=owner&reference=1'],['rework-nine-current-five','rework','stage=N05'],['finishing-six-current-five','rework','stage=N05&kind=finishing']] : [
    ['owner-reference','sourcing','node=owner&role=owner&reference=1'],['owner-readonly','sourcing','node=owner&role=readonly&reference=1'],['owner-history','sourcing','view=node-history&node=owner&role=owner&reference=1'],['finance-current','sourcing','node=finance&role=finance&reference=1'],['finance-contract-denied','sourcing','node=finance&role=finance&reference=1&contract=denied'],
    ['rework-nine-current-five','rework','stage=N05'],['finishing-six-current-five','rework','stage=N05&kind=finishing'],['rework-nine-history','rework','view=node-history&node=initiation'],['finishing-six-history','rework','view=node-history&node=initiation&kind=finishing']
  ];
  for (const viewport of (handover ? [{width:1440,height:900},{width:1180,height:900},{width:390,height:844}] : draft ? [{width:1440,height:900},{width:1180,height:900}] : [{width:1440,height:900},{width:1180,height:900},{width:1024,height:768},{width:390,height:844},{width:375,height:812}])) {
    const approved = await browser.newPage({viewport});
    await approved.goto(`${origin}/approved`); await approved.locator('.p-order-workspace').waitFor();
    if(evidence)await approved.screenshot({path:join(evidence,`approved-${viewport.width}.png`),fullPage:true});
    await approved.close();
    for (const [name,family,query] of cases) for (const version of (draft ? ['candidate'] : ['before','candidate'])) {
      if(handover && ((name.startsWith('mobile-name')&&viewport.width>800)||(!name.startsWith('mobile-name')&&viewport.width<800)))continue;
      const page = await browser.newPage({viewport,hasTouch:viewport.width<500});
      page.on('pageerror',error=>errors.push({name,version,error:error.message}));
      await page.route('**/*',route=>{const request=route.request(),url=new URL(request.url());if(request.isNavigationRequest()&&url.origin===origin)return route.continue();if(request.resourceType()==='image'&&url.origin===origin)return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="220" height="120"><rect width="220" height="120" fill="#f4f5f7"/><path d="M90 20l-35 20 18 30 17-10v45h40V60l17 10 18-30-35-20-20 10z" fill="#a4b6b4"/><text x="110" y="116" font-size="10" text-anchor="middle">隔离模拟款图</text></svg>'});external.push(request.url());return route.abort();});
      await page.goto(`${origin}/acceptance/ui/${family==='sourcing'?'sourcing/orders':'tasks'}/00000000-0000-4000-8000-000000000002?${query}&version=${version}`);
      await page.locator(family==='sourcing'?'.sourcing-key-facts':'.rework-detail-core-facts').waitFor(); await page.evaluate(()=>document.fonts.ready);
      if(version==='candidate'&&family==='sourcing'&&viewport.width>800)await page.waitForFunction(()=>{const c=document.querySelector('.sourcing-reference-layout'),p=document.querySelector('.sourcing-order-photos');return c&&p&&(c.clientWidth>1040||p.dataset.compact==='true');});
      if(name==='finance-current'){await page.getByRole('heading',{name:'05 · 财务核对',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'确认与合同一致',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'发现不一致',exact:true}).count(),1);assert.equal(await page.getByRole('button',{name:'批准方案',exact:true}).count(),0);}
      if(name.startsWith('finance-')){const allowed=name!=='finance-contract-denied';assert.equal(await page.getByRole('link',{name:'预览合同 PDF',exact:true}).count(),allowed?1:0,'contract preview permission retained');assert.equal(await page.getByRole('link',{name:'下载合同',exact:true}).count(),allowed?1:0,'contract download permission retained');assert.equal(await page.getByRole('button',{name:'上传回签合同',exact:true}).count(),allowed?1:0,'server upload permission retained');if(allowed){const [chooser]=await Promise.all([page.waitForEvent('filechooser'),page.getByRole('button',{name:'上传回签合同',exact:true}).click()]);assert.equal(chooser.isMultiple(),true,'original upload opens native chooser');}}
      const metrics=await page.evaluate(({family})=>{const root=document.querySelector(family==='sourcing'?'.sourcing-order-detail':'.rework-governed');const rect=e=>{if(!e)return null;const b=e.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,bottom:b.bottom};};const rail=root.querySelector('.rework-workflow__desktop-grid');return {documentWidth:document.documentElement.scrollWidth,summary:rect(root.querySelector(family==='sourcing'?'.sourcing-key-facts':'.rework-detail-core-facts')),main:rect(root.querySelector('.order-layout-main')),photos:rect(root.querySelector(family==='sourcing'?'.sourcing-order-photos,.sourcing-photo-section':'.rework-detail-images')),flow:rect(root.querySelector('.order-layout-flow')),contextOpen:root.querySelector('.sourcing-order-context')?.open,fields:[...root.querySelectorAll(family==='sourcing'?'.sourcing-key-facts > div':'.rework-detail-core-facts > div')].map(e=>({label:e.querySelector('dt')?.textContent,value:e.querySelector('dd')?.textContent,rect:rect(e)})),rail:rail?{rect:rect(rail),nodes:[...rail.querySelectorAll(':scope > .rework-workflow-step')].map(e=>({text:e.textContent,rect:rect(e),before:{left:getComputedStyle(e,'::before').left,right:getComputedStyle(e,'::before').right,width:getComputedStyle(e,'::before').width},span:getComputedStyle(e).gridColumn})),bridge:rect(rail.querySelector('.rework-workflow-row-bridge'))}:null,links:[...root.querySelectorAll('a')].map(e=>({text:e.textContent,href:e.getAttribute('href')})),buttons:[...root.querySelectorAll('button')].map(e=>({text:e.textContent,aria:e.getAttribute('aria-label'),disabled:e.disabled})),requests:window.orderLayoutFixture.requests};},{family});
      assert.equal(metrics.documentWidth<=viewport.width+1,true,`${version}/${name}: document overflow`);
      assert.equal(metrics.requests.some(r=>r.method!=='GET'),false,'initial view is read-only');
      const filename=`${version}-${name}-${viewport.width}.png`;if(evidence)await page.screenshot({path:join(evidence,filename),fullPage:true});
      if(handover && name==='owner-reference' && viewport.width===1180){
        const region=page.getByRole('group',{name:'款式明细横向滚动',exact:true});
        const prices=await region.evaluate(e=>{const bounds=e.getBoundingClientRect(),headers=[...e.querySelectorAll('th')].map(h=>h.textContent),rows=[...e.querySelectorAll('tbody tr')];return {bounds:{left:bounds.left,right:bounds.right},left:e.scrollLeft,max:e.scrollWidth-e.clientWidth,columns:['IE 单价','生产单价','本款金额'].map(label=>{const index=headers.indexOf(label);return {label,cells:rows.map(row=>{const cell=row.children[index],b=cell.getBoundingClientRect();return {text:cell.textContent,left:b.left,right:b.right,fontSize:getComputedStyle(cell).fontSize};})};})};});
        assert.equal(prices.left,0,'default not scrolled');for(const column of prices.columns)for(const cell of column.cells){assert.ok(cell.left>=prices.bounds.left-1&&cell.right<=prices.bounds.right+1,`${column.label}: directly readable at 1180`);assert.ok(parseFloat(cell.fontSize)>=13,'price text stays readable');}
        metrics.directPriceComparison=prices;
        await region.evaluate(e=>{e.scrollLeft=e.scrollWidth-e.clientWidth;});
        if(evidence)await page.screenshot({path:join(evidence,'r1-medium-owner-1180-rightmost.png'),fullPage:true});
        await page.getByRole('button',{name:'展开图片',exact:true}).click();assert.equal(await page.locator('.sourcing-order-photos__body').isVisible(),true,'medium photo disclosure remains usable');
      }
      if(handover&&name.startsWith('mobile-name')){
        const photo=page.locator('.rework-detail-image-card').first();await photo.focus();await page.locator('.rework-order-filename').waitFor();
        assert.equal(await page.locator('.rework-order-filename').innerText(),await photo.getAttribute('title'),'keyboard exposes exact complete filename');
        if(evidence)await page.screenshot({path:join(evidence,'r1-mobile-filename-keyboard.png')});
        await photo.click();await page.getByRole('dialog').waitFor();assert.equal(await page.locator('.rework-image-modal__heading strong').innerText(),await photo.getAttribute('title'),'touch/click opens original full name');await page.getByRole('button',{name:'关闭',exact:true}).click();
        await page.evaluate(()=>window.scrollTo(0,document.documentElement.scrollHeight));await page.waitForTimeout(100);
        const bottom=await page.evaluate(()=>{const nav=document.querySelector('.mobile-primary-navigation').getBoundingClientRect(),last=document.querySelector('.order-layout-main section dl > div:last-child dd').getBoundingClientRect(),main=document.querySelector('.order-layout-main').getBoundingClientRect();return {scrollY:scrollY,lastBottom:last.bottom,navTop:nav.top,mainBottom:main.bottom,viewportHeight:innerHeight};});
        assert.ok(bottom.lastBottom<=bottom.navTop-8,'last field clears fixed navigation after actual bottom scroll');metrics.mobileBottom=bottom;
        if(evidence)await page.screenshot({path:join(evidence,'r1-mobile-actual-bottom.png')});
        const back=page.getByRole('link',{name:'返回当前节点',exact:true});await back.focus();const backBounds=await back.boundingBox();assert.ok(backBounds.y+backBounds.height<bottom.navTop,'return action can be fully revealed');
      }
      if(version==='candidate'&&!draft){const before=results.find(result=>result.name===name&&result.viewport.width===viewport.width&&result.version==='before');assert.deepEqual(metrics.fields.map(({label,value})=>({label,value})),before.metrics.fields.map(({label,value})=>({label,value})),'all current/history projected facts retained');assert.deepEqual(metrics.links.map(linkIdentity).sort(),before.metrics.links.map(linkIdentity).sort(),'original navigation retained');}
      if(version==='candidate'&&!draft){
        if(family==='sourcing'){
          assert.equal(metrics.contextOpen,false,'context starts collapsed');
          if(viewport.width>800){if(metrics.main.width>1000||viewport.width===1440){assert.ok(metrics.photos.x<metrics.main.x,'wide reference photo left');assert.ok(Math.abs(metrics.photos.y-metrics.main.y)<2,'cards start together');}else assert.ok(metrics.photos.bottom<=metrics.main.y,'medium auxiliary photos yield main width');}
          else assert.ok(metrics.main.y<metrics.photos.y,'mobile main precedes photos');
          if(name==='owner-reference')assert.equal(await page.getByRole('button',{name:'批准方案',exact:true}).count(),1);
          else assert.equal(await page.getByRole('button',{name:'批准方案',exact:true}).count(),0);
          const photoToggle=page.getByRole('button',{name:'展开图片',exact:true});if(await photoToggle.count())await photoToggle.click();
          const summary=page.locator('.sourcing-order-photo-file > summary').first();await page.keyboard.press('Tab');await summary.focus();assert.equal(await page.locator('.sourcing-order-photo-file__peek').first().isVisible(),true,'keyboard reads full filename');await summary.press('Enter');assert.equal(await page.locator('.sourcing-order-photo-file__full').first().isVisible(),true,'native disclosure reads full filename');await summary.press('Enter');
          await page.locator('.sourcing-order-context > summary').click();assert.equal(await page.locator('.sourcing-workflow-rail').isVisible(),true,'fold reveals real rail');
        } else {
          const nameCell=page.locator('.rework-detail-image-card__filename').first();assert.equal(await nameCell.isVisible(),true,'filename remains visible at every width');assert.equal(await nameCell.evaluate(e=>getComputedStyle(e).whiteSpace),'nowrap','filename remains compact');
          const photo=page.locator('.rework-detail-image-card').first();await photo.focus();assert.ok(await page.locator('.rework-order-filename').innerText(),'keyboard exposes full name');await photo.click();await page.getByRole('dialog').waitFor();await page.getByRole('button',{name:'关闭',exact:true}).click();
          if(viewport.width<=800){const toggle=page.getByRole('button',{name:/订单流程/});assert.equal(await toggle.getAttribute('aria-expanded'),'false');await toggle.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'true');await toggle.press('Space');assert.equal(await toggle.getAttribute('aria-expanded'),'false');}
          if(viewport.width>800){
          const count=name.includes('six')?6:9;assert.equal(metrics.rail.nodes.length,count);assert.ok(metrics.main.width>viewport.width*.65,'task retains full available width');assert.ok(metrics.main.y>=Math.max(metrics.photos.bottom,metrics.flow.bottom)-1,'task follows paired support row');
          const first=metrics.rail.nodes[0],sixth=metrics.rail.nodes[5];assert.ok(metrics.rail.nodes.slice(0,5).every(node=>Math.abs(node.rect.y-first.rect.y)<1),'five nodes in row 1');assert.ok(metrics.rail.nodes.slice(5).every(node=>Math.abs(node.rect.y-sixth.rect.y)<1),'remaining nodes share row 2');assert.ok(Math.abs(parseFloat(sixth.before.left)-sixth.rect.width/2)<1,'sixth line starts at center');assert.ok(sixth.rect.y>first.rect.y,'sixth starts row 2');assert.ok(metrics.rail.bridge,'row turn retained');
          }
        }
      }
      results.push({name,family,version,viewport,filename,metrics});await page.close();
    }
  }
  assert.deepEqual(errors,[],'no browser errors');assert.deepEqual(external,[],'no external requests');
  const report={status:draft?'draft-capture':'passed',base,head:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),workingDiff:execFileSync('git',['diff','--stat'],{encoding:'utf8'}),approvedReferenceSha256:digest(reference),approvedPngSha256:digest(await readFile('tests/fixtures/approved-order-reference.png')),results,errors,external};
  if(evidence)await writeFile(join(evidence,'results.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify({status:report.status,frames:results.length,evidence}));
} finally { await browser?.close(); await new Promise(done=>server?server.close(done):done());await rm(output,{recursive:true,force:true}); }
