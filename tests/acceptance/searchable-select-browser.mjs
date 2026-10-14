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
    await page.getByRole('searchbox',{name:'原有搜索'}).fill('原有');await page.getByRole('option',{name:'原有合法候选'}).waitFor();
    assert.deepEqual(errors,[]);const overflow=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,items:Array.from(document.querySelectorAll('body *')).filter(el=>el.getBoundingClientRect().right>innerWidth).map(el=>({tag:el.tagName,cls:el.className,right:el.getBoundingClientRect().right,width:el.getBoundingClientRect().width}))}));if(overflow.scroll>width)console.log(JSON.stringify(overflow));assert.ok(overflow.scroll<=width);
    if(process.env.SEARCH_EVIDENCE_DIR){await mkdir(process.env.SEARCH_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.SEARCH_EVIDENCE_DIR,`${width}.png`),fullPage:true});}
    await page.close();console.log(`PASS ${width}x${height}: legal options, required, FormData, keyboard, disabled, async options, legacy search`);
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
