import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { initialInstruction } from '@dx-rework/contracts/production-instruction';

// Offline UI regression: every API response is synthetic; no database or live session.
const base = new URL(process.env.DIGITAL_QUERY_TEST_URL || 'http://127.0.0.1:3200');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only a local frontend is permitted');
const source = '11111111-1111-4111-8111-111111111111';
const order = '22222222-2222-4222-8222-222222222222';
const taskId = '33333333-3333-4333-8333-333333333333';
const other = '44444444-4444-4444-8444-444444444444';
const task = { taskId, sourceId: source, routeVersion: 2, label: '隔离纸样任务', state: 'pending',
  routeProgress: {completed: 0, applicable: 1}, taskKind: 'development_pattern', canExecute: false };
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  let editable = false;
  let releaseWrite;
  let writingStarted = false;
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => { sessionStorage.setItem('dx-rework:platform-module', 'rework'); });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/')[1];
    if (editable && route.request().method() === 'PUT' && /\/(instruction|development)$/.test(path)) {
      writingStarted = true;
      await new Promise(resolve => { releaseWrite = resolve; });
      return route.fulfill({status: 503, json: {error: {message: '隔离保存失败，保留输入'}}});
    }
    assert.equal(route.request().method(), 'GET', `Unexpected write: ${path}`);
    let data;
    if (path === 'auth/me') data = {status: 'authorized', user: {id: source, displayName: '离线板房师傅', capabilities: [], businessRoles: ['pattern_room_worker']}};
    else if (path === 'digital-production/options') data = {creationEnabled: false, customers: []};
    else if (path === 'digital-production/access/options') data = {roles: ['pattern_room_worker'], actorId: source};
    else if (path === 'digital-production/tasks') data = {items: [task]};
    else if (path === `digital-production/tasks/${taskId}`) data = task;
    else if (path === `digital-production/tasks/${taskId}/history`) data = {events: [], revisions: []};
    else if (path === 'digital-production/orders' || path === 'digital-production/sources') data = {items: []};
    else if (path === `digital-production/orders/${order}/bulk-preparation`) data = {
      dispatch: {}, reasons: [], tasks: [], facts: [], cutting: {lines: []}, instructionVersion: 3,
    };
    else if (editable && path === `digital-production/sources/${source}/development`) data = {
      sourceId: source, designStyleNo: '隔离开发单', developmentType: '头版', designerName: '隔离设计师',
      status: 'draft', version: 1, document: null, canEdit: true, materialEvents: [],
    };
    else if (editable && path === `digital-production/orders/${order}/instruction`) data = {
      order: {productionOrderId: order, designStyleNo: '隔离制单', version: 1, lines: []}, document: initialInstruction(),
      version: 1, versions: [], canEdit: true, dateRequests: [], printedBy: '隔离跟单',
    };
    else return route.fulfill({status: 403, json: {error: {message: `隔离详情 ${path}${new URL(route.request().url()).search}`}}});
    await route.fulfill({json: data});
  });
  const url = query => new URL(`/ui/digital-production${query}`, base).href;
  const detail = text => page.getByRole('alert').filter({hasText: text}).first().waitFor();
  const list = () => page.getByRole('heading', {name: '数字生产订单', exact: true}).waitFor();
  // Additional links exercise the same shared anchor interceptor, without a reload.
  const clickRoute = async query => {
    await page.evaluate(href => { const link = document.createElement('a'); link.id = 'offline-route'; link.href = href; link.textContent = '离线切换'; document.body.append(link); }, url(query));
    await page.locator('#offline-route').click();
    await page.locator('#offline-route').evaluate(node => node.remove());
  };
  await page.goto(url(`?task=${taskId}`));
  await page.getByRole('link', {name: '查看开发单', exact: true}).click();
  await detail(`sources/${source}/development?round=2`);
  await page.goBack(); await list();
  await page.goForward(); await detail(`sources/${source}/development?round=2`);
  await clickRoute(`?development=${other}&round=3`);
  await detail(`sources/${other}/development?round=3`);
  await page.getByRole('button', {name: '返回', exact: true}).click(); await list();
  assert.equal(new URL(page.url()).search, '');
  await page.getByRole('button', {name: '订单列表', exact: true}).click(); await list();
  // Revisiting the just-closed URL must reopen the detail, including after Back/Forward.
  await clickRoute(`?development=${other}&round=3`); await detail(`sources/${other}/development?round=3`);
  await page.goBack(); await list(); await page.goForward(); await detail(`sources/${other}/development?round=3`);
  await page.goto(url(`?bulk=${order}`));
  await page.getByRole('link', {name: '查看本轮制单', exact: true}).click();
  await detail(`orders/${order}/instruction?version=3`);
  await page.goBack(); await page.getByRole('heading', {name: '大货产前准备', exact: true}).waitFor();
  await page.goForward(); await detail(`orders/${order}/instruction?version=3`);
  await clickRoute(`?instruction=${other}&instructionVersion=2`); await detail(`orders/${other}/instruction?version=2`);
  await page.getByRole('button', {name: '返回', exact: true}).click(); await list();
  assert.equal(new URL(page.url()).search, '');
  await page.goto(url(`?development=${source}&round=2`)); await detail(`sources/${source}/development?round=2`);
  await page.goto(url(`?instruction=${order}&instructionVersion=3`)); await detail(`orders/${order}/instruction?version=3`);
  // Review regression: dirty editors must survive Back, same-page links, and cancelled Return.
  editable = true;
  await page.goto(url(''));
  await list();
  await clickRoute(`?development=${source}`);
  await page.getByLabel('样板尺码', {exact: true}).fill('保留我的修改');
  await page.evaluate(() => history.back());
  await page.getByRole('dialog').getByRole('button', {name: '取消', exact: true}).click();
  await page.waitForURL(url(`?development=${source}`));
  assert.equal(await page.getByLabel('样板尺码', {exact: true}).inputValue(), '保留我的修改');
  await clickRoute(`?task=${taskId}`);
  await page.getByRole('dialog').getByRole('button', {name: '取消', exact: true}).click();
  assert.equal(await page.getByLabel('样板尺码', {exact: true}).inputValue(), '保留我的修改');
  await page.getByRole('button', {name: '返回', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: '取消', exact: true}).click();
  assert.equal(await page.getByLabel('样板尺码', {exact: true}).inputValue(), '保留我的修改');
  await page.getByRole('button', {name: '保存草稿', exact: true}).click();
  await page.waitForFunction(() => document.querySelector('.development-controls button').disabled);
  assert(writingStarted);
  await clickRoute(`?task=${taskId}`);
  assert.equal(new URL(page.url()).search, `?development=${source}`);
  releaseWrite();
  await detail('隔离保存失败');
  await page.getByRole('button', {name: '返回', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: '确认', exact: true}).click();
  await list(); // One confirmation only; no duplicate from Return plus shared guard.

  // Freeze the autosave clock: navigation before its 1200ms timer must retain the draft.
  await page.clock.install({time: new Date("2026-10-03T00:00:00Z")});
  await page.clock.pauseAt(new Date("2026-10-03T00:00:01Z"));
  await clickRoute(`?instruction=${order}`);
  await page.getByRole('textbox', {name: '款名', exact: true}).fill('未保存制单');
  await page.evaluate(() => history.back());
  await page.getByRole('dialog').getByRole('button', {name: '取消', exact: true}).click();
  await page.waitForURL(url(`?instruction=${order}`));
  assert.equal(await page.getByRole('textbox', {name: '款名', exact: true}).inputValue(), '未保存制单');
  await clickRoute(`?task=${taskId}`);
  // Autosave starting while the confirmation is open must also block confirmed departure.
  writingStarted = false;
  await page.clock.runFor(1500);
  await page.waitForFunction(() => document.querySelector('.instruction-controls button').disabled);
  assert(writingStarted);
  await page.getByRole('dialog').getByRole('button', {name: '确认', exact: true}).click();
  assert.equal(new URL(page.url()).search, `?instruction=${order}`);
  releaseWrite();
  await detail('隔离保存失败');
  assert.equal(await page.getByRole('textbox', {name: '款名', exact: true}).inputValue(), '未保存制单');
  await page.getByRole('button', {name: '返回', exact: true}).click();
  await page.getByRole('dialog').getByRole('button', {name: '确认', exact: true}).click();
  await page.clock.runFor(200);
  await list();
  assert.deepEqual(errors, []);
  console.log('PASS: actual task/development and bulk/instruction links, direct URLs, Back/Forward, different IDs/versions, close/reopen, dirty cancellation and in-flight write guards; offline responses only.');
} finally { await browser.close(); }
