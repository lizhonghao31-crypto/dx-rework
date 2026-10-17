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
  for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
    const page=await browser.newPage({viewport});
    page.on("pageerror",error=>errors.push(error.message));
    await page.route("**/*",route=>{
      if(route.request().isNavigationRequest()&&new URL(route.request().url()).hostname==="127.0.0.1")return route.continue();
      external.push(route.request().url());return route.abort();
    });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    const category=page.getByRole("combobox",{name:"打板品类",exact:true});
    const select=async(name)=>{await category.fill(name);await page.getByRole("option",{name,exact:true}).click();};
    const confirm=page.locator("[data-system-dialog-confirm]"),cancel=page.locator("[data-system-dialog-cancel]");
    const snapshot=()=>page.evaluate(()=>structuredClone(window.developmentDraftFixture));
    const save=page.getByRole("button",{name:"保存开发资料草稿",exact:true});
    const back=page.getByRole("button",{name:"返回列表",exact:true});
    const baseline=(await snapshot()).saved.document;
    await select("TEST 短袖上衣");await page.getByText("执行单价：40.000 元/件",{exact:true}).waitFor();
    await back.click();await page.getByRole("dialog").waitFor();await cancel.click();
    assert.equal((await snapshot()).cancelled,0);assert.equal(await category.inputValue(),"TEST 短袖上衣");
    await page.evaluate(()=>{void window.checkDevelopmentDraftLeave();});
    // The promise is waiting for the existing internal-navigation confirmation.
    await page.getByRole("dialog").waitFor();await cancel.click();
    await page.waitForFunction(()=>window.developmentDraftFixture.leaveResult===false);
    await save.click();await page.getByRole("status").filter({hasText:"开发资料与订购草稿已保存"}).waitFor();
    let state=await snapshot();
    assert.equal(state.saved.document.patternCategoryId,"00000000-0000-4000-8000-000000000002");
    const {patternCategoryId,...other}=state.saved.document;assert.ok(patternCategoryId);
    assert.deepEqual(other,baseline);assert.equal(state.requests.filter(request=>request.method==="PUT").length,1);
    await back.click();await page.getByText("TEST 来源列表",{exact:true}).waitFor();assert.equal(await page.getByRole("dialog").count(),0);
    await page.getByRole("button",{name:"TEST 重开草稿"}).click();
    await page.getByText("执行单价：40.000 元/件",{exact:true}).waitFor();assert.equal(await category.inputValue(),"TEST 短袖上衣");
    await back.click();await page.evaluate(()=>{window.developmentDraftFixture.quoteAmount="44.000";window.developmentDraftFixture.quoteVersion=2;});
    await page.getByRole("button",{name:"TEST 重开草稿"}).click();await page.getByText("执行单价：44.000 元/件",{exact:true}).waitFor();
    await select("TEST 长裤");await page.getByRole("dialog").waitFor();await cancel.click();assert.equal(await category.inputValue(),"TEST 短袖上衣");
    await select("TEST 长裤");await page.getByRole("dialog").waitFor();await confirm.click();await page.getByText("执行单价：44.000 元/件",{exact:true}).waitFor();
    assert.equal(await category.inputValue(),"TEST 长裤");assert.equal(await page.getByRole("textbox",{name:"胸围 M",exact:true}).inputValue(),"60");
    await page.evaluate(()=>{window.developmentDraftFixture.failNextSave=true;});await save.click();await page.getByRole("alert").waitFor();
    assert.equal(await page.getByRole("status").filter({hasText:"开发资料与订购草稿已保存"}).count(),0);
    assert.equal((await snapshot()).saved.document.patternCategoryId,"00000000-0000-4000-8000-000000000002");
    await back.click();await page.getByRole("dialog").waitFor();await cancel.click();assert.equal(await category.inputValue(),"TEST 长裤");
    await save.click();await page.getByRole("status").filter({hasText:"开发资料与订购草稿已保存"}).waitFor();
    assert.equal((await snapshot()).saved.document.patternCategoryId,"00000000-0000-4000-8000-000000000003");
    await page.evaluate(()=>{window.developmentDraftFixture.failQuote=true;});await page.getByRole("button",{name:"刷新价格",exact:true}).click();await page.getByRole("alert").waitFor();
    await back.click();await page.getByText("TEST 来源列表",{exact:true}).waitFor();assert.equal(await page.getByRole("dialog").count(),0);
    await page.evaluate(()=>{window.developmentDraftFixture.failQuote=false;});await page.getByRole("button",{name:"TEST 重开草稿"}).click();await page.getByText("执行单价：44.000 元/件",{exact:true}).waitFor();
    assert.equal(await category.inputValue(),"TEST 长裤");
    if(evidence)await page.screenshot({path:join(evidence,`reopened-${viewport.width}.png`),fullPage:true});
    await select("TEST 短袖上衣");await page.getByRole("dialog").waitFor();await confirm.click();
    await back.click();await page.getByRole("dialog").waitFor();await confirm.click();await page.getByText("TEST 来源列表",{exact:true}).waitFor();
    await page.getByRole("button",{name:"TEST 重开草稿"}).click();await page.getByText("执行单价：44.000 元/件",{exact:true}).waitFor();
    assert.equal(await category.inputValue(),"TEST 长裤");
    results.push({viewport,checks:["legacy draft without category opens","category-only changes trigger both existing return and navigation guards","save stores only category and preserves three POs, M60, dates and instructions","saved return needs no confirmation","reopen restores selection and requests current quote","category switch cancel/confirm preserves M60","failed save preserves dirty state and persisted value","retry saves selection","quote refresh failure creates no false unsaved change","confirmed leave discards only unsaved selection"]});
    await page.close();
  }
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{
  if(evidence)await writeFile(join(evidence,"result.json"),JSON.stringify({results,errors,external,limitations:["Local Chromium and actual product components; API requests are synthetic intercepted responses, not deployed Acceptance.","PostgreSQL persistence and authorization are checked in the separate isolated integration suite."]},null,2));
  await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:results.length,checksPerViewport:results[0]?.checks.length,errors,external}));
