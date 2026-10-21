import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'dx-search-select-'));
let browser, server;
try {
  await build({configFile:false,esbuild:{jsx:'automatic'},define:{'process.env.NODE_ENV':'"production"'},build:{outDir:output,lib:{entry:resolve('tests/fixtures/searchable-select.tsx'),name:'SearchFixture',formats:['iife']}}});
  const files=await readdir(output),js=await readFile(join(output,files.find(file=>file.endsWith('.js'))),'utf8'),css=await readFile(join(output,files.find(file=>file.endsWith('.css'))),'utf8');
  const html=`<!doctype html><html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,'<\\/script')}</script></html>`;
  server=createServer((_request,response)=>{response.setHeader('content-type','text/html;charset=utf-8');response.end(html);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',args:['--no-sandbox']});
  for(const [width,height] of [[1440,1024],[1280,800],[768,1024],[390,844],[360,800]]) {
    const page=await browser.newPage({viewport:{width,height}}),errors=[];page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const factory=page.getByRole('combobox',{name:'加工厂'});
    await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(await page.locator('#result').innerText(),'');
    await factory.fill('不存在的工厂');await page.getByText('没有匹配的已有选项').waitFor();
    assert.equal(await page.locator('#changes').innerText(),'0');
    await factory.press('Enter');assert.equal(await page.locator('#result').innerText(),'');
    await factory.fill('  FACTORY 25  ');await factory.press('ArrowDown');await factory.press('Enter');
    await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(JSON.parse(await page.locator('#result').innerText()).supplierId,'factory-25');
    assert.equal(JSON.parse(await page.locator('#result').innerText()).personId,'p1');assert.equal(await page.locator('#changes').innerText(),'1');
    await factory.click();assert.equal(await page.getByRole('option').count(),31);await factory.fill('加工厂 2');
    assert.equal(await page.getByRole('option',{name:'加工厂 2',exact:true}).isDisabled(),true);
    await factory.press('Escape');assert.match(await factory.inputValue(),/Factory 25/);
    await page.getByRole('button',{name:'外部修改'}).click();assert.equal(await factory.inputValue(),'加工厂 3');
    await page.getByRole('button',{name:'收窄候选'}).click();await factory.fill('Factory');assert.equal(await page.getByRole('option').isDisabled(),true);await factory.press('Enter');assert.equal(await page.locator('#changes').innerText(),'1');await factory.press('Escape');
    const person=page.getByRole('combobox',{name:'主办'});await person.fill('李四');await person.press('ArrowDown');await person.press('Enter');
    await page.getByRole('button',{name:'保存',exact:true}).click();assert.equal(JSON.parse(await page.locator('#result').innerText()).personId,'p3');
    await page.getByRole('button',{name:'切换禁用'}).click();assert.equal(await factory.isDisabled(),true);assert.equal(await person.isDisabled(),true);
    await page.getByRole('button',{name:'切换禁用'}).click();
    await factory.click();await factory.fill('不存在');await factory.press('Tab');assert.equal(await factory.inputValue(),'加工厂 3');
    await page.getByRole('combobox',{name:'原有搜索'}).fill('原有');await page.getByRole('option',{name:'原有合法候选'}).waitFor();
    assert.deepEqual(errors,[]);const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}))}));if(overflow.scroll>width)console.log(JSON.stringify(overflow));assert.ok(overflow.scroll<=width);
    if(process.env.SEARCH_EVIDENCE_DIR){await mkdir(process.env.SEARCH_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SEARCH_EVIDENCE_DIR,`${width}.png`),fullPage:true});}
    await page.close();console.log(`PASS ${width}x${height}: legal options, required, FormData, keyboard, disabled, async options, legacy search`);
  }
  for (const [width,height,deviceScaleFactor] of [[1440,1024,1],[1366,600,1],[390,600,1],[1100,480,1.25]]) {
    const page=await browser.newPage({viewport:{width,height},deviceScaleFactor}),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/?floating`);
    const menu=page.getByRole('listbox');
    const assertInside=async()=>{
      await page.waitForFunction(()=>{const element=document.querySelector('[role="listbox"]');if(!element)return false;const r=element.getBoundingClientRect();return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;});
      const bounds=await menu.boundingBox(),viewport=page.viewportSize();assert.ok(bounds&&bounds.x>=0&&bounds.y>=0&&bounds.x+bounds.width<=viewport.width+1&&bounds.y+bounds.height<=viewport.height+1,JSON.stringify(bounds));
      assert.equal(await menu.evaluate(element=>element.parentElement===document.body),true);
    };
    const assertHit=async option=>{assert.equal(await option.evaluate(element=>{const b=element.getBoundingClientRect();return element.contains(document.elementFromPoint(b.x+b.width/2,b.y+b.height/2));}),true);};
    for(const stage of ['纸样','裁板','车板','尾部']) {
      const input=page.getByRole('combobox',{name:`${stage}师傅`});await input.click();await menu.waitFor();await assertInside();
      assert.equal(await menu.getByRole('option').count(),36);
      assert.equal(await page.locator(`select[name="${stage}"] option`).count(),36);
      const option=menu.getByRole('option',{name:'合成师傅1',exact:true});await assertHit(option);await option.click();
      assert.equal(await input.inputValue(),'合成师傅1');assert.equal(await menu.count(),0);
    }
    const input=page.getByRole('combobox',{name:'车板师傅'});await input.click();await assertInside();
    await menu.hover();await page.mouse.wheel(0,3000);
    const last=menu.getByRole('option',{name:'合成师傅34',exact:true});
    await page.waitForFunction(()=>{const m=document.querySelector('[role="listbox"]');return m&&m.scrollTop+m.clientHeight>=m.scrollHeight-2;});
    await assertHit(last);await last.click();await page.getByRole('button',{name:'保存测试选择'}).click();assert.equal(JSON.parse(await page.locator('#result').innerText()).车板,'person-34');
    await input.fill('已停用');assert.equal(await menu.getByRole('option').isDisabled(),true);await input.press('ArrowDown');await input.press('Enter');assert.equal(await page.locator('select[name="车板"]').inputValue(),'person-34');await input.press('Escape');
    await input.fill('不存在');await menu.getByText('没有匹配的已有选项').waitFor();await input.press('Tab');assert.equal(await menu.count(),0);assert.equal(await input.inputValue(),'合成师傅34');
    await input.fill('合成师傅3');await input.dispatchEvent('compositionstart');await input.press('ArrowDown');await input.press('Enter');assert.equal(await page.locator('select[name="车板"]').inputValue(),'person-34');await input.dispatchEvent('compositionend');await input.press('ArrowDown');await input.press('Enter');assert.equal(await input.inputValue(),'合成师傅3');
    await input.click();await page.locator('#outside').click();assert.equal(await menu.count(),0);
    await input.click();await page.getByRole('combobox',{name:'裁板师傅'}).click();assert.equal(await menu.count(),1);await input.click();assert.equal(await menu.count(),1);
    const before=await menu.boundingBox();await page.locator('#table-scroll').evaluate(element=>{element.scrollTop=20;});
    await page.waitForFunction(y=>{const m=document.querySelector('[role="listbox"]');return m&&Math.abs(m.getBoundingClientRect().y-y)>5;},before.y);
    await assertInside();await page.locator('#table-scroll').evaluate(element=>{element.scrollTop=500;});await menu.waitFor({state:'detached'});
    await page.locator('#table-scroll').evaluate(element=>{element.scrollTop=0;});await input.click();await page.getByRole('button',{name:'切换整表禁用'}).click();assert.equal(await input.isDisabled(),true);assert.equal(await menu.count(),0);
    await page.getByRole('button',{name:'切换整表禁用'}).click();await input.click();await page.locator('fieldset').evaluate(element=>{element.disabled=true;});await menu.waitFor({state:'detached'});assert.equal(await input.isDisabled(),true);
    await page.locator('fieldset').evaluate(element=>{element.disabled=false;});await input.click();await page.setViewportSize({width:Math.min(width,390),height:440});await assertInside();
    await page.evaluate(()=>window.scrollTo(0,600));await menu.waitFor({state:'detached'});
    assert.deepEqual(errors,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(process.env.SEARCH_EVIDENCE_DIR){await page.evaluate(()=>window.scrollTo(0,0));await input.click();await mkdir(process.env.SEARCH_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SEARCH_EVIDENCE_DIR,`portal-${width}-${deviceScaleFactor}.png`),fullPage:false});}
    await page.close();console.log(`PASS portal ${width}x${height} scale=${deviceScaleFactor}: table rows, mouse hit, last option, native data, IME, focus, scroll, resize, disabled`);
  }
  for (const denied of [false,true]) {
    const page=await browser.newPage(),pages=[];
    await page.route('**/*expected-receipts*',async route=>{
      const url=new URL(route.request().url()),pageNumber=Number(url.searchParams.get('page'));
      assert.equal(url.searchParams.get('cuttingOrderId'),'00000000-0000-4000-8000-000000000099');pages.push(pageNumber);
      if(denied&&pageNumber===2){await route.fulfill({status:403,json:{error:{message:'无权读取'}}});return;}
      const items=Array.from({length:31},(_,i)=>({productionOrderId:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,factoryDecisionId:null,firstStyleNo:'TEST',contractNumber:`合同${i}`,supplierName:`授权加工厂${i}`,shippedOn:'2026-10-14',expectedQuantity:10,receipts:[]}));
      await route.fulfill({json:{items:items.slice((pageNumber-1)*15,pageNumber*15),page:pageNumber,totalCount:31}});
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/?receipt`);
    if(denied){await page.getByRole('alert').waitFor();assert.equal(await page.getByRole('combobox').count(),0);assert.deepEqual(pages,[1,2]);}
    else {const input=page.getByRole('combobox',{name:'本次到货加工厂'});await input.fill('加工厂30');await page.getByRole('option',{name:/授权加工厂30/}).click();assert.equal(await page.locator('#shipment').innerText(),'授权加工厂30');assert.deepEqual(pages,[1,2,3]);}
    await page.close();console.log(`PASS scoped factory receipt pagination denied=${denied}`);
  }

} finally {await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});}
