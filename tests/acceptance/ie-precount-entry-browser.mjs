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
  for (const width of [390, 1440]) for (const stage of ["N04", "N05"]) for (const role of ["ie", "root", "tail", "readonly-ie"]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    console.log(`scenario ${width}/${stage}/${role}`);
    const errors = [];
    page.on("pageerror", error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}/?stage=${stage}&role=${role === "readonly-ie" ? "ie" : role}&readonly=${role === "readonly-ie" ? 1 : 0}`);
    try {
      if (stage === "N04") await page.getByLabel("返工任务进度汇总").waitFor({ timeout: 5000 });
      else await page.getByRole("heading", { name: "按工序核对", exact: true }).waitFor({ timeout: 5000 });
    } catch (error) {
      console.log(await page.locator("body").innerText(), await page.evaluate(() => window.iePrecountRequests), errors);
      throw error;
    }
    const editor = page.getByRole("button", { name: "IE预核", exact: true });
    if (["ie", "root"].includes(role)) {
      assert.equal(await editor.count(), 1);
      await editor.click();
      await page.getByRole("spinbutton", { name: "TEST 工序预核数量" }).fill("7");
      await page.getByRole("textbox", { name: "TEST 工序预核备注" }).fill("入口回归");
      if (process.env.DX_IE_PRECOUNT_EVIDENCE_DIR && role === "ie") {
        await page.screenshot({ path: join(process.env.DX_IE_PRECOUNT_EVIDENCE_DIR, `${stage}-${width}-editor.png`), fullPage: true });
      }
      await page.locator(".n04-ie-precount-confirm").click();
      await page.locator(".n04-ie-precount-latest").filter({ hasText: "7件" }).waitFor();
      await page.locator(".n04-ie-precount-latest").click();
      await page.locator(".n04-ie-precount-detail").filter({ hasText: "入口回归" }).waitFor();
      const mutations = await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"));
      assert.equal(mutations.length, 1);
      assert.match(mutations[0].path, /\/ie-precounts$/);
      assert.equal(mutations[0].body.quantity, 7);
      const ledger = await page.evaluate(() => window.iePrecountEntries);
      assert.equal(ledger.length, 2);
      assert.equal(ledger[1].quantity, 3);
      assert.equal(await page.getByRole("button", { name: "我已完工&上数", exact: true }).count(), 0);
    } else {
      assert.equal(await editor.count(), 0);
      assert.equal(await page.locator(".n04-ie-precount-editor").count(), 0);
      assert.equal((await page.evaluate(() => window.iePrecountRequests.filter(request => request.method !== "GET"))).length, 0);
    }
    assert.deepEqual(errors, []);
    results.push({ width, stage, role, passed: true });
    await page.close();
  }
  console.log(JSON.stringify({ localOnly: true, synthetic: true, results }, null, 2));
} finally {
  await browser?.close();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(output, { recursive: true, force: true });
}
