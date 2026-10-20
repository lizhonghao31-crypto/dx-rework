// Local product-component regression; every API request is intercepted by the synthetic fixture.
import assert from "node:assert/strict";
import {build} from "vite";
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createServer} from "node:http";
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||"playwright");
const output=await mkdtemp(join(tmpdir(),"dx-development-draft-pattern-"));
const evidence=process.env.DEVELOPMENT_DRAFT_EVIDENCE;
const results=[],errors=[],external=[];
let browser,server;
try{
  await build({configFile:false,esbuild:{jsx:"automatic"},define:{"import.meta.env.BASE_URL":'"/"',"process.env.NODE_ENV":'"production"'},build:{outDir:output,lib:{entry:resolve("tests/fixtures/development-draft-pattern.tsx"),name:"DevelopmentDraftPattern",formats:["iife"]}}});
  const names=await readdir(output),js=await readFile(join(output,names.find(name=>name.endsWith(".js"))),"utf8"),css=await readFile(join(output,names.find(name=>name.endsWith(".css"))),"utf8");
  const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi,"<\\/script")}</script></html>`;
  server=createServer((_request,response)=>{response.setHeader("content-type","text/html;charset=utf-8");response.end(html);});
  await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||"/usr/bin/chromium",args:["--no-sandbox"]});
  if(evidence)await mkdir(evidence,{recursive:true});
  for(const profile of [{width:1440,height:900},{width:1366,height:900,noOrder:true},{width:390,height:844},{width:1440,height:900,stress:true},{width:1440,height:900,legacyPo:true}]){
    const {noOrder,stress,legacyPo,...viewport}=profile,page=await browser.newPage({viewport});
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/*",route=>{
      const url=new URL(route.request().url());
      if(route.request().isNavigationRequest()&&url.hostname==="127.0.0.1")return route.continue();
      if(url.hostname==="127.0.0.1"&&url.pathname.includes('/development/attachments/'))return route.fulfill({contentType:'image/png',body:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a7V8AAAAASUVORK5CYII=','base64')});
      external.push(route.request().url());return route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}?p03=1${noOrder?"&noOrder=1":""}${stress?"&stress=1":""}${legacyPo?"&legacyPo=1":""}`);
    const snapshot=()=>page.evaluate(()=>structuredClone(window.developmentDraftFixture));
    const save=page.getByRole("button",{name:"保存开发资料草稿",exact:true});
    const confirm=page.locator("[data-system-dialog-confirm]");
    await page.getByLabel("M尺码制作数量",{exact:true}).waitFor();
    assert.equal(await page.getByLabel("本轮打样尺码",{exact:true}).count(),0);
    assert.equal(await page.locator('.development-create-card').count(),noOrder?1:2);
    assert.equal(await page.locator('.development-section-group').count(),2);
    assert.equal(await page.locator('.development-create-grid').first().locator(':scope>label').count(),4);
    assert.equal(await page.locator('.development-create-grid-secondary').locator(':scope>label').count(),noOrder?3:5);
    assert.equal(await page.getByLabel("开发下单日期",{exact:true}).inputValue(),"2026-10-17");
    assert.equal(await page.getByLabel("开发下单日期",{exact:true}).getAttribute("readonly"),"");
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),"page must not overflow horizontally");
    assert.equal(await page.locator('.development-visible-material-label').filter({hasText:/^品名/}).count(),stress?100:1);
    if(legacyPo){
      await page.getByLabel("尺码列 1",{exact:true}).fill("S");await page.getByLabel("PO 2 尺码 1",{exact:true}).fill("XL");assert.equal(await page.getByLabel("尺码列 1",{exact:true}).inputValue(),"S");assert.equal(await page.getByLabel("PO 1 订购数量 1",{exact:true}).inputValue(),"400");assert.equal(await page.getByLabel("PO 2 订购数量 1",{exact:true}).inputValue(),"200");await page.getByRole("button",{name:"补充本 PO 尺码",exact:true}).click();await page.getByLabel("PO 2 尺码 2",{exact:true}).fill("XXL");await page.getByLabel("PO 2 订购数量 2",{exact:true}).fill("0");assert.equal(await page.getByLabel("尺码列 2",{exact:true}).inputValue(),"XS");
    }else if(!noOrder){
      const details=page.locator('.development-create-details');
      await details.getByRole('button',{name:'添加款色 / PO',exact:true}).click();
      await page.getByLabel('尺码列 1',{exact:true}).fill('TEST共用码');
      assert.equal(await page.getByLabel('PO 2 尺码 1',{exact:true}).innerText(),'TEST共用码');
      assert.equal(await page.getByLabel('PO 1 订购数量 1',{exact:true}).inputValue(),'400');
      const sizeBox=await page.getByLabel('尺码列 1',{exact:true}).boundingBox(),quantityBox=await page.getByLabel('PO 1 订购数量 1',{exact:true}).boundingBox();
      assert.ok(Math.abs(sizeBox.y-quantityBox.y)<3,'PO name and order quantity are on the same row');
      await page.getByLabel('尺码列 1',{exact:true}).fill('M');
      if(stress){
        for(let index=2;index<10;index++)await details.getByRole('button',{name:'添加款色 / PO',exact:true}).click();
        for(let index=2;index<8;index++){await details.getByRole('button',{name:'添加尺码列',exact:true}).click();await page.getByLabel(`尺码列 ${index+1}`,{exact:true}).fill(`TEST码${index+1}`);await page.getByLabel(`PO 1 订购数量 ${index+1}`,{exact:true}).fill('0');}
        assert.equal(await page.getByLabel('PO 10 尺码 8',{exact:true}).innerText(),'TEST码8');
      }else{await details.getByRole('button',{name:'删除 PO',exact:true}).last().click();await confirm.click();}
      assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'wide PO matrix scrolls only inside its own container');
    }
    await page.getByLabel("M尺码制作数量",{exact:true}).fill("1.5");await save.click();
    await page.getByRole("alert").filter({hasText:"制作数量须为0—100000整数"}).waitFor();
    assert.equal((await snapshot()).requests.filter(r=>r.method==='PUT').length,0);
    assert.equal(await page.getByLabel("M尺码制作数量",{exact:true}).inputValue(),"1.5");
    await page.getByLabel("M尺码制作数量",{exact:true}).fill("2");
    await page.getByRole("button",{name:"M尺码右移",exact:true}).click();
    assert.equal(await page.locator("#development-sizes").getByLabel("制作尺码列 1",{exact:true}).inputValue(),"L");
    assert.equal(await page.getByLabel("L尺码制作数量",{exact:true}).inputValue(),"1");
    assert.equal(await page.getByLabel("胸围 M",{exact:true}).inputValue(),"60");
    const template=page.getByRole('combobox',{name:'尺寸模板',exact:true});
    await template.selectOption('裤子');await confirm.click();
    assert.equal(await page.getByLabel("M尺码制作数量",{exact:true}).inputValue(),"2");
    await page.getByLabel("M尺码制作数量",{exact:true}).fill("3");
    await page.getByRole('button',{name:'撤回模板替换',exact:true}).click();await confirm.click();
    assert.equal(await page.getByLabel("M尺码制作数量",{exact:true}).inputValue(),"2");
    assert.equal(await page.getByLabel("胸围 M",{exact:true}).inputValue(),"60");
    await page.locator('#development-sizes').getByRole('button',{name:'删除制作尺码列 3',exact:true}).click();await confirm.click();
    const sizes=page.locator('#development-sizes');await sizes.getByRole('button',{name:/添加尺码列/}).click();
    await page.locator('#development-sizes').getByLabel('制作尺码列 3',{exact:true}).fill('XL');await page.getByLabel('XL尺码制作数量',{exact:true}).fill('0');
    await page.evaluate(()=>{window.developmentDraftFixture.failNextSave=true;});await save.click();await page.getByRole('alert').filter({hasText:'TEST 保存失败'}).waitFor();
    assert.equal(await page.getByLabel('M尺码制作数量',{exact:true}).inputValue(),'2');
    await save.click();await page.getByRole('status').filter({hasText:'开发资料与订购草稿已保存'}).waitFor();
    const state=await snapshot();assert.deepEqual(state.saved.document.sizes,['L','M','XL']);assert.deepEqual(state.saved.document.sizeQuantities,[1,2,0]);
    assert.equal(state.saved.document.customerOrderDraft.order.lines.reduce((sum,line)=>sum+line.sizes.reduce((n,row)=>n+Number(row.quantity),0),0),600);
    await page.evaluate(()=>scrollTo(0,document.body.scrollHeight));
    const box=await save.boundingBox();assert.ok(box&&box.y>=0&&box.y+box.height<=viewport.height,'single sticky save remains reachable');
    await page.evaluate(()=>scrollTo(0,0));
    if(evidence)await page.screenshot({path:join(evidence,`making-${viewport.width}-${legacyPo?'legacy-po':noOrder?'no-order':stress?'stress':'order'}.png`),fullPage:!stress});
    await page.getByRole('button',{name:'返回列表',exact:true}).click();await page.getByRole('button',{name:'TEST 重开草稿',exact:true}).click();
    assert.equal(await page.getByLabel('M尺码制作数量',{exact:true}).inputValue(),'2');assert.equal(await page.getByLabel('XL尺码制作数量',{exact:true}).inputValue(),'0');
    assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    if(legacyPo){assert.equal(state.saved.document.customerOrderDraft.order.lines[0].sizes[0].size,'S');assert.equal(state.saved.document.customerOrderDraft.order.lines[1].sizes[0].size,'XL');}
    results.push({profile,checks:['approved 5/4 groups and two basic rows','server date read-only and independent','no separate sample-size input','visible material name/spec labels','invalid raw quantity retained and no write','size identity/count/dimension move together','template replacement/undo retains aligned quantities','remove/add size clears only that column','failed save preserves values, retry persists','PO 600 independent from making 3','one sticky toolbar at end','reopen keeps counts'],limits:'Actual React product components with synthetic TEST HTTP responses; services and PostgreSQL verified separately. Desktop zoom and site/ECS are not claimed.'});await page.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{
  if(evidence)await writeFile(join(evidence,"result.json"),JSON.stringify({results,errors,external,limitations:["Local Chromium and actual product components; API requests are synthetic intercepted responses, not deployed Acceptance.","PostgreSQL persistence and authorization are checked in the separate isolated integration suite."]},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:results.length,checksPerViewport:results[0]?.checks.length,errors,external}));
