// Local synthetic UI only. The fixture captures all POSTs and never calls an API.
import assert from "node:assert/strict";
import { readFile,writeFile } from "node:fs/promises";
import { createServer } from "node:http";
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||"playwright");
const html=await readFile(process.env.R3_TRANSFER_FRAME,"utf8"),baseline=process.env.R3_EXPECT_BASELINE==="1";
const server=createServer((_request,response)=>{response.setHeader("content-type","text/html; charset=utf-8");response.end(html);});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const origin=`http://127.0.0.1:${server.address().port}`,browser=await chromium.launch({headless:true,executablePath:"/usr/bin/chromium"});
const page=await browser.newPage({viewport:{width:1440,height:1024}}),errors=[],results=[];
page.on("pageerror",error=>errors.push(String(error)));
const ready=async(query="")=>{
  await page.goto(origin+query);await page.getByRole("button",{name:"订单转厂",exact:true}).click();
  await page.getByLabel("新加工单价",{exact:true}).waitFor();
};
try{
  await ready();const price=page.getByLabel("新加工单价",{exact:true}),total=page.getByLabel("新总额",{exact:true});
  assert.equal(await price.inputValue(),"4.12");assert.equal(await total.inputValue(),baseline?"—":"82.47");
  await page.locator("#sourcing-transfer-form label").filter({hasText:"新加工厂"}).locator("select").selectOption("00000000-0000-4000-8000-000000000040");
  await page.getByLabel("转厂原因",{exact:true}).fill("TEST 未手改单价");await page.getByRole("button",{name:"提交转厂",exact:true}).click();
  await page.waitForFunction(()=>globalThis.__r3TransferRequests.length===1);
  assert.equal(await page.evaluate(()=>globalThis.__r3TransferRequests[0].body.unitPrice),"4.1234");
  results.push("未手改单价提交保留4.1234");
  await ready();await price.focus();assert.equal(await price.inputValue(),baseline?"4.12":"4.1234");
  await price.press("End");await price.press("Backspace");assert.equal(await price.inputValue(),baseline?"4.1":"4.123");
  await page.getByLabel("转厂原因",{exact:true}).fill("TEST 聚焦局部修改");await page.locator("#sourcing-transfer-form label").filter({hasText:"新加工厂"}).locator("select").selectOption("00000000-0000-4000-8000-000000000040");
  await page.getByRole("button",{name:"提交转厂",exact:true}).click();await page.waitForFunction(()=>globalThis.__r3TransferRequests.length===1);
  assert.equal(await page.evaluate(()=>globalThis.__r3TransferRequests[0].body.unitPrice),baseline?"4.1":"4.123");
  results.push(baseline?"旧版首次聚焦4.12、局部修改提交4.1":"首次聚焦4.1234、局部修改提交4.123");
  await ready();await price.focus();assert.equal(await price.inputValue(),baseline?"4.12":"4.1234");
  await price.fill("4.1234");await price.blur();assert.equal(await price.inputValue(),"4.12");assert.equal(await total.inputValue(),baseline?"—":"82.47");
  await price.focus();assert.equal(await price.inputValue(),"4.1234");await price.fill("4.12345");assert.equal(await total.inputValue(),"—");results.push(baseline?"旧版合法四位预览仍为—":"合法四位预览与超四位拒绝");
  await ready("?multi=1");assert.equal(await total.inputValue(),baseline?"—":"8.24");results.push("多行逐项取分后汇总");
  await ready();await price.focus();assert.equal(await price.inputValue(),baseline?"4.12":"4.1234");
  await price.fill("4.1235");assert.match(await page.locator(".sourcing-factory-change__delta").innerText(),/\+/);
  await price.fill("4.1233");assert.match(await page.locator(".sourcing-factory-change__delta").innerText(),/-/);
  results.push("原四位价格阈值的涨跌方向保持");
  assert.deepEqual(errors,[]);
}finally{
  if(process.env.R3_TRANSFER_RESULT)await writeFile(process.env.R3_TRANSFER_RESULT,JSON.stringify({baseline,results,errors,limitations:["Offline synthetic UI; no actual UAT, no backend or business data writes"]},null,2));
  await browser.close();await new Promise(resolve=>server.close(resolve));
}
console.log(JSON.stringify({baseline,passed:results.length}));
