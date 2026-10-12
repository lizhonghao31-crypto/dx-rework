// Real React detail page with offline synthetic requests; never contacts a business API.
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || "playwright");
const output = await mkdtemp(join(tmpdir(), "dx-ie-precount-"));
let browser, server;
try {
  await build({ configFile: false, esbuild: { jsx: "automatic" }, define: { "import.meta.env.BASE_URL": '"/"', "process.env.NODE_ENV": '"production"' }, build: { outDir: output, lib: { entry: resolve("tests/fixtures/ie-precount-entry.tsx"), name: "IePrecountEntry", formats: ["iife"] } } });
  const names = await readdir(output);
  const js = await readFile(join(output, names.find(name => name.endsWith(".js"))), "utf8");
  const css = await readFile(join(output, names.find(name => name.endsWith(".css"))), "utf8");
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script></html>`;
  server = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", args: ["--no-sandbox"] });
  const results = [];
  for (const width of [390, 1440]) for (const stage of ["N04", "N05"]) for (const role of ["ie", "root", "tail", "readonly-ie", "mixed", "delegated-ie"]) for (const tailRequired of [false, true]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    console.log(`scenario ${width}/${stage}/${role}/tail=${tailRequired}`);
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=${stage}&role=${role === "readonly-ie" ? "ie" : role}&readonly=${role === "readonly-ie" ? 1 : 0}&tail=${tailRequired ? 1 : 0}`);
    try {
      if (stage === "N04" || ["ie", "readonly-ie"].includes(role)) await page.getByLabel("返工任务进度汇总").waitFor({ timeout: 5000 });
      else await page.getByRole("heading", { name: "按工序核对", exact: true }).waitFor({ timeout: 5000 });
    } catch (error) {
      console.log(await page.locator("body").innerText(), await page.evaluate(() => window.iePrecountRequests), errors);
      throw error;
    }
    const editor = page.getByRole("button", { name: "IE预核", exact: true });
    if (["ie", "root", "mixed", "delegated-ie"].includes(role)) {
      assert.equal(await editor.count(), 1);
      await editor.click();
      await page.getByRole("spinbutton", { name: "TEST 工序预核数量" }).fill("2");
      await page.getByRole("textbox", { name: "TEST 工序预核备注" }).fill("入口回归");
      if (process.env.DX_IE_PRECOUNT_EVIDENCE_DIR && role === "ie") {
        await page.screenshot({ path: join(process.env.DX_IE_PRECOUNT_EVIDENCE_DIR, `${stage}-${width}-tail-${tailRequired}-editor.png`), fullPage: true });
      }
      await page.locator(".n04-ie-precount-confirm").click();
      await page.locator(".n04-ie-precount-latest").filter({ hasText: "2件" }).waitFor();
      await page.locator(".n04-ie-precount-latest").click();
      await page.locator(".n04-ie-precount-detail").filter({ hasText: "入口回归" }).waitFor();
      const mutations = await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"));
      assert.equal(mutations.length, 1);
      assert.match(mutations[0].path, /\/ie-precounts$/);
      assert.equal(mutations[0].body.quantity, 2);
      const ledger = await page.evaluate(() => window.iePrecountEntries);
      assert.equal(ledger.length, 2);
      assert.equal(ledger[1].quantity, 3);
      assert.equal(await page.evaluate(() => window.iePrecountStatus), stage === "N05" ? "pending_order_review" : "in_progress");
      assert.equal(await page.getByRole("button", { name: "我已完工&上数", exact: true }).count(), 0);
    } else {
      assert.equal(await editor.count(), 0);
      assert.equal(await page.locator(".n04-ie-precount-editor").count(), 0);
      assert.equal((await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"))).length, 0);
    }
    assert.deepEqual(errors, []);
    if (stage === "N05") {
      const tailRequests = await page.evaluate(() => window.iePrecountRequests.filter(request => request.path.endsWith("tail-inspection")));
      assert.equal(tailRequests.length > 0, tailRequired && ["root", "tail", "mixed"].includes(role));
      if (["ie", "readonly-ie"].includes(role)) {
        assert.equal(await page.getByRole("button", {name: "确认数量并提交 IE", exact: true}).count(), 0);
        assert.equal(await page.getByLabel("拟提交单价（元/件）").count(), 0);
        assert.equal(await page.getByRole("button", { name: /新增员工|移除|代为报数|完工上数|整查完成|IE 复核/ }).count(), 0);
        assert.equal(await page.getByRole("heading", { name: "按工序核对", exact: true }).count(), 0);
        assert.equal(await page.getByRole("button", { name: "整查预核数量" }).count(), 0);
        assert.ok((await page.evaluate(() => window.iePrecountRequests)).some(request => request.path.endsWith("whole-order-review")));
      }
    }
    results.push({ width, stage, role, tailRequired, passed: true });
    await page.close();
  }
  for (const width of [390, 1440]) for (const role of ["ie", "root", "readonly-ie", "tail"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=N06&role=${role === "readonly-ie" ? "ie" : role}&readonly=${role === "readonly-ie" ? 1 : 0}`);
    if (role === "tail") await page.getByText("当前用户无权读取最终数量确认信息", { exact: true }).waitFor();
    else await page.getByRole("heading", { name: "按工序核对", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "IE预核", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("返工任务进度汇总").count(), 0);
    assert.equal((await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"))).length, 0);
    results.push({ width, stage: "N06", role, passed: true });
    await page.close();
  }
  for (const fault of ["overview", "tail", "missing", "facts"]) {
    const page = await browser.newPage({viewport:{width:1440,height:900}});
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=N05&role=${fault === "tail" ? "root" : "ie"}&tail=1&fault=${fault}`);
    const expected = { overview: "TEST 审核摘要读取失败", tail: "TEST 整查读取失败", missing: "TEST 订单不存在", facts: "TEST 执行事实读取失败" };
    await page.getByText(expected[fault], {exact:true}).waitFor({timeout:5000});
    assert.equal(await page.getByRole("heading", {name:"按工序核对",exact:true}).count(),0);
    assert.equal(await page.getByRole("button", {name:"确认数量并提交 IE",exact:true}).count(),0);
    assert.equal((await page.evaluate(()=>window.iePrecountRequests.filter(request=>request.method!=="GET"))).length,0);
    results.push({fault,passed:true});await page.close();
  }
  for (const width of [390, 1440]) for (const readOnly of [false, true]) for (const delay of ["facts", "summary", "both"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=N05&role=ie&tail=1&delay=${delay}&readonly=${readOnly ? 1 : 0}`);
    await page.getByLabel("返工任务进度汇总").waitFor({ timeout: 5000 });
    const readEvents = await page.evaluate(() => window.ieReadEvents);
    assert.equal(readEvents.findIndex(event => event.event === "summary403") < readEvents.findIndex(event => event.event === "facts"), delay === "facts");
    assert.equal(await page.getByText("当前用户无权读取最终数量确认信息", { exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "IE预核", exact: true }).count(), readOnly ? 0 : 1);
    assert.equal((await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"))).length, 0);
    results.push({ width, stage: "N05", readOnly, delay, summary403BeforeFacts: delay === "facts", passed: true });
    await page.close();
  }
  for (const width of [390, 1440]) for (const role of ["ie", "root"]) for (const late of ["facts", "summary"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    const errors = []; page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=N05&role=${role}&switch=1&late=${late}`);
    await page.waitForFunction(() => window.iePrecountRequests.some(request => request.path.endsWith("whole-order-review")) && window.iePrecountRequests.some(request => request.path.endsWith("work-tasks")));
    await page.getByRole("button", { name: "切换到新订单", exact: true }).click();
    await page.getByText("TEST 新工序", { exact: true }).waitFor({ timeout: 5000 });
    await page.waitForTimeout(750); // Let the obsolete order response complete before asserting isolation.
    assert.equal(await page.getByText("TEST 旧工序", { exact: true }).count(), 0);
    assert.equal(await page.getByText("TEST 新工序", { exact: true }).count(), 1);
    assert.equal(await page.getByText("当前用户无权读取最终数量确认信息", { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    assert.equal((await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"))).length, 0);
    results.push({ width, role, switchingOrder: true, lateOldResponse: late, passed: true });
    await page.close();
  }
  console.log(JSON.stringify({ localOnly: true, synthetic: true, results }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
