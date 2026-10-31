import assert from 'node:assert/strict';
import { build } from 'vite';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const output = await mkdtemp(join(tmpdir(), 'dx-warehouse-ui-')), evidence = process.env.WAREHOUSE_UI_EVIDENCE_DIR;
const results = []; let browser, server;
const orderPath = '/ui/cutting/orders/00000000-0000-4000-8000-000000000010';
try {
  if (evidence) await mkdir(evidence, { recursive: true });
  await build({ configFile: false, esbuild: { jsx: 'automatic' }, define: { 'import.meta.env.BASE_URL': '"/"', 'process.env.NODE_ENV': '"production"' },
    build: { outDir: output, lib: { entry: resolve('tests/fixtures/warehouse-supervisor.tsx'), name: 'WarehouseSupervisor', formats: ['iife'] } } });
  const files = await readdir(output), js = await readFile(join(output, files.find(n => n.endsWith('.js'))), 'utf8'), css = await readFile(join(output, files.find(n => n.endsWith('.css'))), 'utf8');
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>' + css + '</style><div id="root"></div><script>' + js.replace(/<\/script/gi, '<\\/script') + '</script></html>';
  server = createServer((request, response) => {
    if (request.url.includes('/download')) { response.setHeader('content-type', 'image/svg+xml'); response.end('<svg xmlns="http://www.w3.org/2000/svg" width="200" height="120"><text x="10" y="60">TEST sheet</text></svg>'); }
    else { response.setHeader('content-type', 'text/html;charset=utf-8'); response.end(html); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'] });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const pageFor = async (width, role, recorded = false, path = orderPath) => {
    const page = await browser.newPage({ viewport: { width, height: 960 } }), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + path + '?role=' + role + '&recorded=' + (recorded ? '1' : '0'));
    return { page, errors };
  };
  for (const role of ['supervisor','pmc']) for (const width of [390, 1440]) for (const recorded of [false, true]) {
    const { page, errors } = await pageFor(width, role, recorded);
    await page.locator('.cutting-detail__facts').waitFor();
    assert.equal(await page.locator('input[type=file]').count(), 0);
    assert.equal(await page.locator('.cutting-count-control input').count(), 0);
    for (const name of ['提交登记', '修正', '上传裁床单']) assert.equal(await page.getByRole('button', { name, exact: true }).count(), 0);
    if (recorded) {
      await page.getByText('TEST裁床工人', { exact: true }).waitFor();
      assert.equal(await page.locator('.cutting-sheet-readonly a').count(), 1);
    } else await page.getByRole('status').filter({ hasText: '尚未登记实裁' }).waitFor();
    assert.equal((await page.evaluate(() => window.warehouseTestRequests.filter(r => r.method !== 'GET'))).length, 0);
    assert.equal(await page.evaluate(() => document.body.scrollWidth > innerWidth), false);
    assert.deepEqual(errors, []);
    if (evidence) await page.screenshot({ path: join(evidence, role + '-' + width + '-' + (recorded ? 'recorded' : 'pending') + '.png') });
    results.push({ width, role, recorded, readOnly: true, passed: true }); await page.close();
  }
  for (const width of [390, 1440]) {
    const { page, errors } = await pageFor(width, 'mixed');
    await page.locator('.cutting-count-control input').first().waitFor();
    await page.locator('.cutting-count-control input').nth(0).fill('100');
    await page.locator('.cutting-count-control input').nth(1).fill('2020');
    await page.locator('input[type=file]').setInputFiles({ name: 'TEST裁床单.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', 'base64') });
    await page.getByRole('button', { name: '提交登记', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('.cutting-record-actions button').disabled);
    await page.getByRole('button', { name: '提交登记', exact: true }).click();
    await page.getByText('裁床实裁已登记。', { exact: true }).waitFor();
    const requests = await page.evaluate(() => window.warehouseTestRequests.filter(r => r.method === 'POST'));
    assert.equal(requests.filter(r => r.path.endsWith('/cutting/orders/00000000-0000-4000-8000-000000000010/attachments/upload-intents')).length, 1);
    assert.equal(requests.filter(r => r.path.endsWith('/records')).length, 1);
    assert.equal(requests.filter(r => r.path.endsWith('/tools/attachments/upload-intents')).length, 0);
    assert.deepEqual(errors, []); results.push({ width, role: 'mixed', scopedUploadAndRecordRetained: true, passed: true }); await page.close();
  }
  {
    const { page } = await pageFor(1440, 'supervisor', false, '/ui/cutting');
    await page.locator('.cutting-card').waitFor();
    await page.locator('aside').getByText('仓库主管', { exact: true }).waitFor();
    assert.ok(await page.locator('aside a[href="/ui/orders"]').count());
    assert.equal(await page.locator('aside a[href="/ui/finance"]').count(), 0);
    await page.locator('.cutting-card a').click(); await page.locator('.cutting-detail__facts').waitFor();
    await page.locator('aside a[href="/ui/orders"]').click();
    await page.getByRole('link', { name: '＋ 仓库收货', exact: true }).click();
    await page.getByText('点击收货', { exact: true }).waitFor();
    results.push({ role: 'supervisor', listDetailAndReceivingNavigation: true, passed: true }); await page.close();
  }
  {
    const { page } = await pageFor(390, 'receiver');
    await page.getByRole('heading', { name: '无权访问此页面' }).waitFor();
    assert.equal(await page.locator('.cutting-detail__facts').count(), 0);
    results.push({ role: 'receiver', cuttingDenied: true, passed: true }); await page.close();
  }
  {
    const { page } = await pageFor(1440, 'root', true);
    await page.getByRole('button', { name: '修正', exact: true }).waitFor();
    results.push({ role: 'root', correctionRetained: true, passed: true }); await page.close();
  }
  const report = { localOnly: true, synthetic: true, noRealBusinessAccess: true, results };
  if (evidence) await writeFile(join(evidence, 'browser-result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); if (server) await new Promise(resolve => server.close(resolve)); await rm(output, { recursive: true, force: true });
}
