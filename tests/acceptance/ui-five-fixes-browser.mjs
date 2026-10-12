// Actual React components and contracts, all fetches synthetic, no live business operations.
import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'dx-ui-five-'));
const evidence = process.env.DX_UI_FIVE_EVIDENCE_DIR;
let browser, server;
const results = [];
try {
  const buildFixture = async (entry, destination) => {
    await build({ configFile: false, esbuild: { jsx: 'automatic' }, define: { 'import.meta.env.BASE_URL': '"/"', 'process.env.NODE_ENV': '"production"' }, build: { outDir: destination, lib: { entry: resolve(entry), name: 'UiFiveFixes', formats: ['iife'] } } });
    const names = await readdir(destination), js = await readFile(join(destination, names.find(n => n.endsWith('.js'))), 'utf8'), css = await readFile(join(destination, names.find(n => n.endsWith('.css'))), 'utf8');
    return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><div id="root"></div><script>${js.replace(/<\/script/gi, '<\\/script')}</script></html>`;
  };
  const html = await buildFixture('tests/fixtures/ui-five-fixes.tsx', join(output, 'main'));
  const detailHtml = await buildFixture('tests/fixtures/ie-precount-entry.tsx', join(output, 'detail'));
  server = createServer((req, res) => { res.setHeader('content-type', 'text/html;charset=utf-8'); res.end(new URL(req.url, 'http://localhost').searchParams.get('mode') === 'detail' ? detailHtml : html); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const base = `http://127.0.0.1:${server.address().port}/`;
  const createPage = async (width, query) => {
    const page = await browser.newPage({ viewport: { width, height: 960 } });
    const errors = []; page.on('pageerror', error => errors.push(String(error)));
    await page.route('**/api/tools/attachments/**', route => route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="160"><rect width="320" height="160" fill="#cce7f6"/><rect x="80" y="30" width="160" height="100" fill="#336c95"/></svg>' }));
    await page.goto(base + '?' + query);
    return { page, errors };
  };
  const writes = page => page.evaluate(() => window.uiFiveRequests.filter(r => r.method !== 'GET'));
  const confirmDialog = async (page, accept = true) => {
    await page.getByRole('dialog').waitFor();
    await page.getByRole('dialog').getByRole('button', { name: accept ? '确认' : '取消', exact: true }).click();
  };
  const fillCreation = async (page, intent) => {
    if (intent === 'certain_order') { await page.getByLabel('设计款号', { exact: true }).fill('TEST-STYLE'); await page.getByLabel('客户', { exact: true }).selectOption('TEST'); }
    await page.getByLabel('尺码列 1', { exact: true }).fill('S');
    await page.getByLabel('PO 1 颜色', { exact: true }).fill('红');
    await page.getByLabel('PO 1 颜色外文', { exact: true }).fill('RED');
  };
  for (const width of [390, 1440, 2048]) {
    for (const intent of ['confirm_order', 'certain_order']) {
      const { page, errors } = await createPage(width, `mode=create&intent=${intent}`);
      await page.getByRole('button', { name: '返回列表', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '返回列表', exact: true }).count(), 1);
      assert.equal(await page.locator('.development-create-heading').getByRole('button', { name: '返回列表', exact: true }).count(), 1);
      assert.equal(await page.getByRole('columnheader', { name: '颜色', exact: true }).count(), 1);
      assert.equal(await page.getByRole('columnheader', { name: '删除 PO', exact: true }).count(), 0);
      assert.equal(await page.locator('[aria-label*="代用款号"]').count(), 0);
      assert.equal(await page.getByLabel('代用款号（选填）', { exact: true }).count(), 1);
      assert.equal(await page.getByLabel('PO 1 订购数量 1', { exact: true }).inputValue(), '');
      await fillCreation(page, intent);
      await page.getByRole('status').filter({ hasText: '总订购数量：0 件' }).waitFor();
      const submit = page.getByRole('button', { name: intent === 'confirm_order' ? '确认下单' : '创建订单', exact: true });
      for (const raw of ['', '0', '-1', '0.5', '文字']) {
        await page.getByLabel('PO 1 订购数量 1', { exact: true }).fill(raw);
        await submit.click();
        assert.equal((await writes(page)).length, 0);
        if (['-1', '0.5', '文字'].includes(raw)) {
          assert.equal(await page.getByLabel('PO 1 订购数量 1', { exact: true }).getAttribute('aria-invalid'), 'true');
          assert.match(await page.locator('.development-quantity-error').first().innerText(), /非负整数/);
          assert.match(await page.locator('.development-total-quantity').innerText(), /请修正数量/);
        } else assert.match(await page.locator('.development-total-quantity').innerText(), /0 件/);
      }
      await page.getByLabel('PO 1 订购数量 1', { exact: true }).fill('2');
      await page.getByRole('button', { name: '添加尺码列', exact: true }).click();
      await page.getByLabel('尺码列 2', { exact: true }).fill('M');
      await page.getByLabel('PO 1 订购数量 2', { exact: true }).fill('3');
      await page.getByLabel('PO 1 出货日期', { exact: true }).fill('2026-11-02');
      await page.getByRole('button', { name: '添加款色 / PO', exact: true }).click();
      assert.equal(await page.getByLabel('PO 2 订购数量 1', { exact: true }).inputValue(), '');
      assert.equal(await page.getByLabel('PO 2 出货日期', { exact: true }).inputValue(), '2026-11-02');
      await page.getByLabel('PO 2 颜色', { exact: true }).fill('白');
      await page.getByLabel('PO 2 颜色外文', { exact: true }).fill('WHITE');
      await page.getByLabel('PO 2 订购数量 1', { exact: true }).fill('4');
      await page.getByLabel('PO 2 订购数量 2', { exact: true }).fill('0');
      await page.getByLabel('PO 2 出货日期', { exact: true }).fill('2026-11-05');
      await page.getByLabel('尺码列 1', { exact: true }).fill('均码');
      assert.equal(await page.getByLabel('PO 1 订购数量 1', { exact: true }).inputValue(), '2');
      await page.getByLabel('尺码列 2', { exact: true }).fill('36');
      assert.equal(await page.getByLabel('PO 1 订购数量 2', { exact: true }).inputValue(), '3');
      assert.match(await page.locator('.development-total-quantity').innerText(), /9 件/);
      assert.equal(await page.getByRole('columnheader', { name: '删除 PO', exact: true }).count(), 1);
      if (evidence) await page.screenshot({ path: join(evidence, `creation-${intent}-${width}.png`), fullPage: true });
      await page.getByRole('button', { name: '返回列表', exact: true }).click(); await confirmDialog(page, false);
      assert.equal(await page.evaluate(() => window.uiFiveCancelled), false);
      await submit.click();
      await page.waitForURL(/mode=order/);
      await page.locator('.digital-mother-readonly').waitFor();
      const read = await page.evaluate(() => window.uiFiveRead);
      assert.deepEqual(read.lines.map(l => [l.color, l.colorForeign, l.customerWarehouseArrivalDate]), [['红', 'RED', '2026-11-02'], ['白', 'WHITE', '2026-11-05']]);
      assert.deepEqual(read.lines.map(l => l.sizes), [[{ size: '均码', quantity: 2 }, { size: '36', quantity: 3 }], [{ size: '均码', quantity: 4 }]]);
      assert.deepEqual(errors, []);
      results.push({ width, intent, emptyZeroAndInvalid: true, twoColorFieldsSaveRead: true, sizeNames: ['均码', '36'], positivePayloadTotal: 9, dirtyReturnCancelled: true, passed: true });
      await page.close();
    }
    {
      const { page, errors } = await createPage(width, 'mode=create&intent=confirm_order');
      await fillCreation(page, 'confirm_order');
      await page.getByLabel('PO 1 订购数量 1', { exact: true }).fill('2');
      await page.getByLabel('PO 1 出货日期', { exact: true }).fill('2026-11-02');
      await page.getByRole('button', { name: '添加尺码列', exact: true }).click();
      await page.getByLabel('尺码列 2', { exact: true }).fill('M');
      await page.getByLabel('PO 1 订购数量 2', { exact: true }).fill('3');
      await page.getByRole('button', { name: '删除尺码列 1', exact: true }).click(); await confirmDialog(page);
      assert.equal(await page.getByLabel('尺码列 1', { exact: true }).inputValue(), 'M');
      assert.equal(await page.getByLabel('PO 1 订购数量 1', { exact: true }).inputValue(), '3');
      assert.equal(await page.getByLabel('PO 1 出货日期', { exact: true }).inputValue(), '2026-11-02');
      await page.getByRole('button', { name: '添加款色 / PO', exact: true }).click();
      await page.getByLabel('PO 2 订购数量 1', { exact: true }).fill('4');
      await page.getByLabel('PO 2 出货日期', { exact: true }).fill('2026-11-05');
      await page.getByRole('button', { name: '删除 PO', exact: true }).first().click(); await confirmDialog(page);
      assert.equal(await page.getByLabel('PO 1 订购数量 1', { exact: true }).inputValue(), '4');
      assert.equal(await page.getByLabel('PO 1 出货日期', { exact: true }).inputValue(), '2026-11-05');
      assert.equal(await page.getByRole('button', { name: '删除 PO', exact: true }).count(), 0);
      await page.getByRole('button', { name: '返回列表', exact: true }).click(); await confirmDialog(page);
      assert.equal(await page.evaluate(() => window.uiFiveCancelled), true);
      assert.equal((await writes(page)).length, 0); assert.deepEqual(errors, []);
      results.push({ width, deleteSizeAndPoPreservesRemaining: true, onePoRetained: true, dirtyReturnConfirmed: true, passed: true });
      await page.close();
    }
    for (const mode of ['cards', 'basic']) {
      const { page, errors } = await createPage(width, `mode=${mode}`);
      await page.locator('.reporting-order-card__title-line').first().waitFor();
      const checks = await page.locator('.reporting-order-card__title-line').evaluateAll(lines => lines.map(line => {
        const strong = line.querySelector('strong'), badge = line.querySelector('.dx-badge');
        const a = strong.getBoundingClientRect(), b = badge.getBoundingClientRect(), p = line.getBoundingClientRect();
        const heading = line.closest('.reporting-order-card__heading').getBoundingClientRect();
        return { sameTitleLine: Boolean(strong && badge), titleUsesHeadingWidth: Math.abs(p.width - heading.width) < 2, contained: b.right <= p.right + 1 && a.right <= p.right + 1, shortGap: strong.textContent === 'TEST-SHORT' ? b.left - a.right : null };
      }));
      assert.ok(checks.every(c => c.sameTitleLine && c.contained));
      if (width > 760) assert.ok(checks.every(c => c.titleUsesHeadingWidth), JSON.stringify(checks));
      assert.ok(checks.filter(c => c.shortGap !== null).every(c => c.shortGap >= 0 && c.shortGap <= 16));
      assert.deepEqual(errors, []);
      if (evidence) await page.screenshot({ path: join(evidence, `${mode}-${width}.png`), fullPage: true });
      results.push({ width, mode, statusAdjacentToStyle: true, longStyleWraps: true, titleUsesHeadingWidth: checks.every(c => c.titleUsesHeadingWidth), passed: true }); await page.close();
    }
    {
      const { page, errors } = await createPage(width, 'mode=detail&stage=N05&role=ie&tail=1&picture=1');
      await page.locator('.rework-governed').waitFor();
      await page.getByLabel('返工任务进度汇总').waitFor();
      await page.locator('.rework-detail-image-card img').first().waitFor();
      const metrics = await page.evaluate(() => {
        const main = document.querySelector('main'), detail = document.querySelector('.rework-governed'), style = getComputedStyle(main), img = detail.querySelector('img');
        return { available: main.getBoundingClientRect().width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight), detail: detail.getBoundingClientRect().width, mainMax: style.maxWidth, detailMax: getComputedStyle(detail).maxWidth, imageFit: getComputedStyle(img).objectFit, imageLoaded: img.complete && img.naturalWidth === 320 && img.naturalHeight === 160, overflow: document.documentElement.scrollWidth > innerWidth + 2 };
      });
      assert.ok(Math.abs(metrics.available - metrics.detail) < 2, JSON.stringify(metrics));
      assert.equal(metrics.mainMax, 'none'); assert.equal(metrics.detailMax, 'none');
      assert.equal(metrics.imageFit, 'contain'); assert.equal(metrics.imageLoaded, true); assert.equal(metrics.overflow, false); assert.deepEqual(errors, []);
      if (evidence) await page.screenshot({ path: join(evidence, `detail-${width}.png`), fullPage: true });
      results.push({ width, mode: 'detail', metrics, passed: true }); await page.close();
    }
    {
      const { page, errors } = await createPage(width, 'mode=create&intent=confirm_order&slow=1');
      await fillCreation(page, 'confirm_order'); await page.getByLabel('PO 1 订购数量 1', { exact: true }).fill('2');
      const more = page.locator('details.mobile-primary-navigation__more');
      if (width <= 800 && await more.count()) await more.locator(':scope > summary').click();
      if (width > 800) {
        const group = page.locator('.desktop-navigation__group').filter({ has: page.locator('a[href^="/ui/digital-pattern-room"]') });
        if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
      }
      const link = page.locator('a[href^="/ui/digital-pattern-room"]:visible').first();
      await link.waitFor();
      assert.equal(await link.locator('svg').count(), 1);
      if (evidence) await page.screenshot({ path: join(evidence, `navigation-${width}.png`), fullPage: true });
      if (width <= 800 && await more.count()) await more.locator(':scope > summary').click();
      await page.getByRole('button', { name: '确认下单', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '返回列表', exact: true }).isDisabled(), true);
      await page.waitForURL(/mode=order/); assert.deepEqual(errors, []);
      results.push({ width, navigationIcon: true, busyReturnDisabled: true, passed: true }); await page.close();
    }
  }
  {
    const { page, errors } = await createPage(2048, 'mode=unrelated');
    await page.getByText('TEST 其他页面', { exact: true }).waitFor();
    assert.equal(await page.locator('main').evaluate(main => getComputedStyle(main).maxWidth), '1480px'); assert.deepEqual(errors, []);
    results.push({ otherPageWidthUnchanged: true, passed: true }); await page.close();
  }
  {
    const { page, errors } = await createPage(1440, 'mode=dashboard');
    await page.locator('.reporting-order-card__heading').waitFor();
    assert.equal(await page.locator('.reporting-order-card__title-line').count(), 0);
    assert.equal(await page.locator('.reporting-order-card__heading > .dx-badge').count(), 1);
    assert.deepEqual(errors, []);
    results.push({ dashboardCardLayoutUnchanged: true, passed: true }); await page.close();
  }
  const report = { localOnly: true, synthetic: true, noLiveBusinessAccess: true, viewports: [390, 1440, 2048], results };
  if (evidence) await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true });
}
