// No live API: loads only responses captured from the synthetic PostgreSQL regression.
import assert from "node:assert/strict";
import {build} from "vite";
import {mkdtemp,readFile,readdir,rm,mkdir,writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {createServer} from "node:http";
const input=process.env.ERP_BULK_CUSTOMER_EVIDENCE;
if(!input)throw new Error("ERP_BULK_CUSTOMER_EVIDENCE must point to the isolated PostgreSQL test response JSON");
const evidence=JSON.parse(await readFile(input,"utf8"));
assert.ok(evidence.customer&&evidence.style&&evidence.orderId);
assert.equal(evidence.styleSearch.items.find(item=>item.orderId===evidence.orderId)?.customer,evidence.customer);
assert.equal(evidence.customerSearch.items.find(item=>item.orderId===evidence.orderId)?.customer,evidence.customer);
const {chromium}=await import(process.env.PLAYWRIGHT_IMPORT||"playwright"),output=await mkdtemp(join(tmpdir(),"dx-bulk-customer-"));
const directory=process.env.BULK_CUSTOMER_BROWSER_EVIDENCE,errors=[],external=[],results=[];
let browser,server;
try{
 await build({configFile:false,esbuild:{jsx:"automatic"},define:{"import.meta.env.BASE_URL":'"/"',"process.env.NODE_ENV":'"production"'},build:{outDir:output,lib:{entry:resolve("tests/fixtures/bulk-workroom-customer.tsx"),name:"BulkCustomer",formats:["iife"]}}});
 const names=await readdir(output),js=await readFile(join(output,names.find(name=>name.endsWith(".js"))),"utf8"),css=await readFile(join(output,names.find(name=>name.endsWith(".css"))),"utf8");
 const html=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>window.bulkCustomerEvidence=${JSON.stringify(evidence).replace(/</g,"\\u003c")};${js.replace(/<\/script/gi,"<\\/script")}</script></html>`;
 server=createServer((_request,response)=>{response.setHeader("content-type","text/html;charset=utf-8");response.end(html);});await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
 browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||"/usr/bin/chromium",args:["--no-sandbox"]});
 if(directory)await mkdir(directory,{recursive:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}]){
  const page=await browser.newPage({viewport});page.on("pageerror",error=>errors.push(error.message));
  await page.route("**/*",route=>{if(route.request().isNavigationRequest()&&new URL(route.request().url()).hostname==="127.0.0.1")return route.continue();external.push(route.request().url());return route.abort();});
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const card=page.locator(".pattern-task-card").filter({hasText:evidence.style});
  await card.getByText(`${evidence.customer} · 母单 ${evidence.orderId}`,{exact:true}).waitFor();
  assert.equal(await card.getByText(/客户未登记/).count(),0);
  const search=page.getByRole("textbox",{name:"关键词"});await search.fill(evidence.customer.toLowerCase());
  await page.waitForFunction(customer=>new URL(window.bulkCustomerRequests.at(-1),location.href).searchParams.get("search")===customer,evidence.customer.toLowerCase());
  await card.getByText(`${evidence.customer} · 母单 ${evidence.orderId}`,{exact:true}).waitFor();
  assert.equal(new URL(page.url()).searchParams.get("search"),evidence.customer.toLowerCase());
  await search.fill("TEST-NONMATCHING-CUSTOMER");await page.getByText("当前范围暂无大货任务",{exact:true}).waitFor();
  assert.equal(await page.locator(".pattern-task-card").count(),0);
  await search.fill(evidence.style);await card.getByText(`${evidence.customer} · 母单 ${evidence.orderId}`,{exact:true}).waitFor();
  if(directory)await page.screenshot({path:join(directory,`customer-${viewport.width}.png`),fullPage:true});
  results.push({viewport,checks:["same TEST order renders the persisted mother customer","lowercase customer search keeps the order and current query","nonmatching customer search produces no false hit","style search restores the same customer/identity"]});await page.close();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
}finally{
 if(directory)await writeFile(join(directory,"result.json"),JSON.stringify({results,errors,external,source:input,limitations:["Local product component with response JSON from isolated PostgreSQL TEST commands; no real account, live API or deployed Acceptance.","No UI or layout changes in this PR; this checks customer text/search consumption only."]},null,2));
 await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));await rm(output,{recursive:true,force:true});
}
console.log(JSON.stringify({passed:results.length,checksPerViewport:results[0]?.checks.length,errors,external}));
