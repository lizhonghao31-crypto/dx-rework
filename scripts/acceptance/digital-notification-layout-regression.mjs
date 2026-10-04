import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

// Real shared Shell + notification, with all API calls intercepted by an isolated queue.
const base = new URL(process.env.NOTIFICATION_TEST_URL || 'http://127.0.0.1:3200');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only a local frontend is permitted');
const evidence = resolve(process.env.NOTIFICATION_EVIDENCE_DIR || '/tmp/digital-notification-evidence');
await mkdir(evidence, {recursive: true});
const actor = '11111111-1111-4111-8111-111111111111';
const eventId = index => `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`;
const notice = (index, title, actionable = true) => ({eventId: eventId(index), title, actionable,
  route: {routeName: 'digital_development', entityId: actor, todoId: eventId(index)}, createdAt: '2026-10-03T00:00:00Z'});
const queue = [notice(1, '隔离履约单 · 开发车缝：已超时')];
let current = null, claims = 0, reads = 0, ackFails = false, releaseAck;
const acknowledgements = [];
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dx-rework:platform-module', 'rework'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/')[1];
    const respond = (json, status = 200) => route.fulfill({status, json, headers: {'x-dx-rework-actor-id': actor}});
    if (path === 'digital-production/notifications/claim') {
      assert.equal(route.request().method(), 'POST'); claims++;
      current ??= queue.shift() || null;
      return respond({notification: current});
    }
    if (path?.startsWith('digital-production/notifications/')) {
      if (path.endsWith('/acknowledge')) {
        assert.equal(route.request().method(), 'POST');
        acknowledgements.push(path.split('/')[2]);
        if (ackFails) return respond({}, 503);
        if (releaseAck === 'hold') await new Promise(done => { releaseAck = done; });
        current = null; return respond({});
      }
      assert.equal(route.request().method(), 'GET'); reads++;
      return respond({notification: current});
    }
    assert.equal(route.request().method(), 'GET', `Unexpected write: ${path}`);
    if (path === 'auth/me') return respond({status: 'authorized', user: {id: actor, displayName: '隔离技术主管', capabilities: ['todo:view'], businessRoles: ['pattern_room_supervisor']}});
    if (path === 'todos/mine/indicator') return respond({pendingCount: queue.length + (current ? 1 : 0)});
    if (path === 'digital-production/options') return respond({creationEnabled: false, customers: []});
    if (path === 'digital-production/access/options') return respond({roles: [], actorId: actor});
    if (['digital-production/orders', 'digital-production/sources', 'digital-production/tasks'].includes(path)) return respond({items: []});
    return respond({error: {message: '隔离详情'}}, 403);
  });
  await page.goto(new URL('/ui/digital-production', base).href);
  const toast = page.getByRole('region', {name: '站内提醒', exact: true});
  const refresh = () => page.evaluate(() => window.dispatchEvent(new Event('dx-rework:todo-refresh')));
  await toast.waitFor();
  assert.equal(await toast.getAttribute('aria-live'), 'polite');
  const dimensions = [];
  for (const [width, height] of [[1440,1024], [1280,800], [768,1024], [390,844], [360,800], [320,568]]) {
    await page.setViewportSize({width, height});
    const box = await toast.boundingBox();
    assert(box && box.width <= 300 && box.x >= 0 && box.x + box.width <= width);
    assert(box.height <= 160, 'Short message must remain compact');
    assert.equal(await toast.evaluate(el => getComputedStyle(el).position), 'fixed');
    assert.equal(await toast.evaluate(el => el.scrollWidth <= el.clientWidth), true);
    if (width > 800) {
      assert(Math.abs(width - box.x - box.width - 16) <= 1);
      assert(Math.abs(height - box.y - box.height - 16) <= 1);
      assert.equal(await page.locator('.app-shell > aside').evaluate(el => getComputedStyle(el).position), 'sticky');
    } else {
      assert(Math.abs(box.y - 72) <= 1);
      const nav = await page.locator('.mobile-primary-navigation').boundingBox();
      assert(nav && box.y + box.height < nav.y, 'Notification must leave mobile bottom controls free');
      assert(await toast.getByRole('button', {name: '我知道了'}).evaluate(el => el.getBoundingClientRect().height >= 44));
    }
    dimensions.push({width, height, toast: box});
    await page.screenshot({path: resolve(evidence, `${width}x${height}.png`)});
  }
  await page.setViewportSize({width: 1280, height: 800});
  const initialClaims = claims;
  await Promise.all([
    page.waitForResponse(response => /notifications\/222/.test(response.url())),
    page.evaluate(() => { for(let i=0;i<20;i++) window.dispatchEvent(new Event('dx-rework:todo-refresh')); }),
  ]);
  assert.equal(claims, initialClaims, 'Refreshing a visible message must not claim hidden queued messages');
  assert.equal(await page.locator('.digital-notification-toast').count(), 1);
  assert(reads >= 1);
  ackFails = true;
  await toast.getByRole('button', {name: '我知道了'}).click();
  await toast.getByRole('alert').waitFor();
  assert.equal(await toast.getByRole('alert').textContent(), '确认未成功，请重试');
  ackFails = false;
  releaseAck = 'hold';
  await toast.getByRole('button', {name: '我知道了'}).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.digital-notification-toast button')].every(button => button.disabled));
  assert.equal(acknowledgements.length, 2);
  releaseAck();
  await toast.waitFor({state: 'hidden'});

  await page.setViewportSize({width: 390, height: 844});
  // While entering text, do not claim a message or cover the focused control.
  await page.getByLabel('搜索款号 / PO').focus();
  queue.push(notice(2, '长消息'.repeat(40) + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.repeat(3), false));
  const beforeTyping = claims;
  await refresh();
  assert.equal(claims, beforeTyping);
  await page.getByLabel('搜索款号 / PO').blur();
  await refresh(); await toast.waitFor();
  assert.equal(await toast.getByRole('button', {name: '查看', exact: true}).count(), 1);
  assert.equal(await toast.evaluate(el => el.scrollWidth <= el.clientWidth), true);
  const longBox = await toast.boundingBox();
  assert(longBox.height <= 844 * 0.3 + 1);
  const closeBox = await toast.getByRole('button', {name: '我知道了'}).boundingBox();
  assert(closeBox && closeBox.y >= longBox.y && closeBox.y + closeBox.height <= longBox.y + longBox.height, 'Long text must leave acknowledgement fully visible');
  await page.screenshot({path: resolve(evidence, 'mobile-long-message.png')});
  await page.getByLabel('搜索款号 / PO').focus();
  await toast.waitFor({state: 'hidden'});
  await page.getByLabel('搜索款号 / PO').blur(); await toast.waitFor();
  // Reading elsewhere removes this message on refresh; no local acknowledgement is fabricated.
  current = null;
  await refresh(); await toast.waitFor({state: 'hidden'});
  assert.equal(acknowledgements.length, 2);
  queue.push(notice(3, '第三条'), notice(4, '第四条'));
  await refresh(); await toast.waitFor();
  assert.equal(await toast.locator('p').first().textContent(), '第三条');
  await toast.getByRole('button', {name: '我知道了'}).focus();
  await page.keyboard.press('Enter');
  await toast.locator('p').filter({hasText: '第四条'}).waitFor();
  assert.equal(await page.locator('.digital-notification-toast').count(), 1);
  const beforeGo = acknowledgements.length;
  await toast.getByRole('button', {name: '去处理'}).click();
  await page.waitForURL(url => url.searchParams.get('development') === actor);
  assert.equal(acknowledgements.length, beforeGo + 1);
  assert.equal(new URL(page.url()).searchParams.get('todo'), eventId(4));
  assert.deepEqual(errors, []);
  await writeFile(resolve(evidence, 'dimensions.json'), JSON.stringify(dimensions, null, 2));
  console.log('PASS: six viewports, compact fixed placement, mobile bottom controls, long text, input focus, polite region, repeated events, single-message queue, external read, failed/busy acknowledgement, keyboard close and destination.');
} finally { await browser.close(); }
