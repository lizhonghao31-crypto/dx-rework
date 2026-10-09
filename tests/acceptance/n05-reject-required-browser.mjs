// Run with PLAYWRIGHT_IMPORT pointing to an installed Playwright module.
// All requests are intercepted in the fixture; this never contacts a business API.
import assert from "node:assert/strict";
import { build } from "vite";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || "playwright");
const output = await mkdtemp(join(tmpdir(), "dx-n05-required-"));
await build({ configFile: false, esbuild: { jsx: "automatic" }, define: { "import.meta.env.BASE_URL": '"/"', "process.env.NODE_ENV": '"production"' },
  build: { outDir: output, lib: { entry: resolve("tests/fixtures/n05-reject-required.tsx"), name: "N05Required", formats: ["iife"] } } });
const names = await readdir(output);
const js = await readFile(join(output, names.find(name => name.endsWith(".js"))), "utf8");
const css = await readFile(join(output, names.find(name => name.endsWith(".css"))), "utf8");
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, "<\\/script")}</script></html>`;
const server = createServer((_request, response) => { response.setHeader("content-type", "text/html; charset=utf-8"); response.end(html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium" });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [], results = [], baseline = process.env.N05_EXPECT_BASELINE === "1";
page.on("pageerror", error => errors.push(String(error)));
const reset = async () => {
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole("button", { name: /TEST 工序.*已上报/ }).click();
  await page.getByRole("button", { name: "驳回", exact: true }).click();
  await page.getByRole("dialog").waitFor();
};
const input = page.locator("[data-system-dialog-input]");
const confirm = page.locator("[data-system-dialog-confirm]");
const requestCount = () => page.evaluate(() => window.n05Requests.length);
try {
  for (const value of ["", "   "]) {
    await reset(); await input.fill(value); await confirm.click();
    if (baseline) await page.getByRole("dialog").waitFor({ state: "detached" });
    else {
      await page.getByRole("alert").filter({ hasText: "驳回原因必填" }).waitFor();
      assert.equal(await page.getByRole("dialog").count(), 1);
      assert.equal(await input.inputValue(), value);
      assert.equal(await input.getAttribute("aria-invalid"), "true");
    }
    assert.equal(await requestCount(), 0);
    results.push(baseline ? `旧版空白 ${JSON.stringify(value)} 静默关闭` : `空白 ${JSON.stringify(value)} 必填并保留弹窗`);
  }
  await reset();
  if (!baseline) { await confirm.click(); await page.getByRole("alert").waitFor(); }
  await page.locator("[data-system-dialog-cancel]").click();
  await page.getByRole("dialog").waitFor({ state: "detached" }); assert.equal(await requestCount(), 0);
  results.push("取消退出且不提交");
  await reset(); await input.press("Escape"); await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await requestCount(), 0); results.push("Escape 原规则不变");
  await reset();
  if (!baseline) {
    await input.fill("   "); await input.press("Enter"); await page.getByRole("alert").waitFor();
    assert.equal(await requestCount(), 0);
  }
  await input.fill("  TEST 请核对报数  ");
  if (!baseline) assert.equal(await page.getByRole("alert").count(), 0);
  await input.press("Enter");
  await page.waitForFunction(() => window.n05Requests.length === 1);
  assert.deepEqual(await page.evaluate(() => window.n05Requests[0].body), {
    expectedOrderVersion: 7, rejectedPersonId: "00000000-0000-4000-8000-000000000003", reason: "TEST 请核对报数",
  });
  assert.equal(await page.getByLabel("有效数量", { exact: true }).inputValue(), "10");
  results.push("有效原因按原 payload 提交一次，数量保持10");
  await page.getByRole("button", { name: "其它弹窗" }).click(); await confirm.click();
  await page.getByRole("dialog").waitFor({ state: "detached" });
  assert.equal(await page.locator("output").innerText(), "value:"); results.push("其它可选 prompt 仍允许空白确认");
  assert.deepEqual(errors, []);
} finally {
  if (process.env.N05_RESULT) await writeFile(process.env.N05_RESULT, JSON.stringify({ baseline, results, errors, limitations: ["本机 Chromium + 合成 fixture，未部署，未执行线上 UAT"] }, null, 2));
  await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true });
}
console.log(JSON.stringify({ baseline, passed: results.length }));
