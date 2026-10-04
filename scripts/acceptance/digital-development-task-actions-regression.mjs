import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { DIGITAL_TASK_ROLES } from '../../apps/api/src/production-platform/task-access-repository.ts';

// Synthetic API only; never use live sessions or business data.
const base = new URL(process.env.DIGITAL_QUERY_TEST_URL || 'http://127.0.0.1:3200');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only a local frontend is permitted');
const source = '11111111-1111-4111-8111-111111111111';
const taskId = '33333333-3333-4333-8333-333333333333';
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage({viewport: {width: 1280, height: 800}});
  page.setDefaultTimeout(10_000);
  let role = 'pattern_room_worker';
  const task = {taskId, orderId: null, sourceId: source, routeVersion: 3, occurrence: 3,
    taskKind: 'development_sewing', label: '离线车板任务', state: 'ready',
    enteredAt: null, completedAt: null, recordedAt: '2026-10-04T00:00:00Z',
    dueAt: null, warningAt: null, slaHours: null, policyVersion: 1, paused: false,
    routeProgress: {completed: 0, applicable: 1, cancelled: 0}, assigneeName: '离线工人',
    hasHandover: true, canExecute: true, canManage: false, canControl: false, canCorrect: false,
    timeQuality: '缺失', blockedReason: null};
  const writes = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dx-rework:platform-module', 'rework'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/')[1];
    if (route.request().method() !== 'GET') {
      assert([`digital-production/tasks/${taskId}/handover`, `digital-production/tasks/${taskId}/feedback`].includes(path), `Unexpected write: ${path}`);
      writes.push({path, body: route.request().postDataJSON()});
      return route.fulfill({json: {taskId}});
    }
    let body;
    if (path === 'auth/me') body = {status: 'authorized', user: {id: source, displayName: '离线角色', capabilities: [], businessRoles: [role], isRoot: role === 'root_superuser'}};
    else if (path === 'digital-production/options') body = {creationEnabled: false, customers: []};
    else if (path === 'digital-production/access/options') body = {roles: [role], actorId: source};
    else if (path === 'digital-production/tasks') body = {items: [task]};
    else if (path === `digital-production/tasks/${taskId}`) body = task;
    else if (path === `digital-production/tasks/${taskId}/history`) body = {events: [{eventId: source, kind: 'created', occurredAt: null, recordedAt: '2026-10-04T00:00:00Z', quality: '缺失', correctsEventId: null, payload: {note: '保留离线历史'}, actorName: '离线工人'}], revisions: []};
    else if (path === 'digital-production/access/candidates') body = [];
    else if (path === 'digital-production/orders' || path === 'digital-production/sources') body = {items: []};
    else return route.fulfill({status: 403, json: {error: {message: `离线详情 ${path}${new URL(route.request().url()).search}`}}});
    return route.fulfill({json: body});
  });
  const taskUrl = new URL(`/ui/digital-production?task=${taskId}`, base).href;
  const open = async () => {await page.goto(taskUrl, {waitUntil: 'domcontentloaded'}); await page.getByRole('heading', {name: '离线车板任务 · 第3轮', exact: true}).waitFor();};
  const action = page.locator('select[name="action"]');
  for (const [kind, requiredRole] of Object.entries(DIGITAL_TASK_ROLES).filter(([kind]) => kind.startsWith('development_'))) {
    task.taskKind = kind; task.requiredRole = requiredRole; role = requiredRole;
    for (const handover of [true, false]) {
      task.hasHandover = handover; await open();
      assert.equal(await page.locator('select[name="action"] option[value="complete"]').count(), 0, kind);
      assert.equal(await action.count(), handover ? 1 : 0, kind);
      await page.getByRole('link', {name: '打开开发办理', exact: true}).waitFor();
      await page.getByRole('button', {name: '反馈阻断', exact: true}).waitFor();
      await page.getByText('历史记录与核实', {exact: true}).click();
      await page.getByText('保留离线历史', {exact: true}).waitFor();
    }
  }
  console.log('PASS: all declared development nodes hide generic completion, retain available handover/feedback/history.');
  task.taskKind = 'development_sewing'; role = 'pattern_room_worker'; task.hasHandover = true;
  await open();
  assert.equal(await action.inputValue(), 'handover');
  const form = page.locator('form').filter({has: action});
  await form.locator('select[name="timeMode"]').selectOption('unknown');
  await form.getByLabel('备注', {exact: true}).fill('离线补记交接');
  await form.getByRole('button', {name: '提交', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('select[name="action"]').disabled && !document.querySelector('select[name="action"]').closest('fieldset').disabled);
  assert.equal(writes.length, 1); assert(writes[0].path.endsWith('/handover'));
  assert.deepEqual(writes[0].body, {note: '离线补记交接', occurredAt: null});
  await page.getByLabel('原因', {exact: true}).fill('离线阻断');
  await page.getByRole('button', {name: '反馈阻断', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('select[name="action"]').closest('fieldset').disabled);
  assert.equal(writes.length, 2); assert(writes[1].path.endsWith('/feedback'));
  assert.deepEqual(writes[1].body, {reason: '离线阻断', blocked: true});
  for (const actorRole of ['pattern_room_worker', 'pattern_room_tail_inspector', 'sample_designer', 'development_clerk', 'root_superuser']) {
    role = actorRole; await open();
    await page.getByRole('link', {name: '打开开发办理', exact: true}).click();
    await page.getByRole('alert').filter({hasText: `sources/${source}/development?round=3`}).first().waitFor();
    assert.equal(new URL(page.url()).search, `?development=${source}&round=3`);
    await page.goBack(); await page.getByRole('link', {name: '打开开发办理', exact: true}).waitFor();
    await page.goForward(); await page.getByRole('alert').filter({hasText: '?round=3'}).first().waitFor();
    await page.getByRole('button', {name: '返回', exact: true}).click();
    assert.equal(new URL(page.url()).search, '');
  }
  task.canExecute = false; await open();
  assert.equal(await action.count(), 0);
  assert.equal(await page.getByRole('button', {name: '反馈阻断', exact: true}).count(), 0);
  await page.getByRole('link', {name: '查看开发单', exact: true}).waitFor();
  task.canExecute = true;
  for (const state of ['completed', 'cancelled']) {
    task.state = state; await open(); assert.equal(await action.count(), 0);
    await page.getByRole('link', {name: '查看开发单', exact: true}).waitFor();
  }
  task.state = 'ready'; task.taskKind = 'budget'; role = 'sample_designer'; await open();
  assert.equal(await action.inputValue(), 'complete');
  assert.equal(await action.locator('option[value="handover"]').count(), 1);
  await page.setViewportSize({width: 390, height: 844});
  task.taskKind = 'development_sewing'; role = 'pattern_room_worker'; await open();
  const link = page.getByRole('link', {name: '打开开发办理', exact: true}); await link.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await link.click(); await page.getByRole('alert').filter({hasText: '?round=3'}).first().waitFor();
  assert.deepEqual(errors, []);
  console.log('PASS: all 17 development nodes with/without handover; unchanged handover/feedback payloads and history; execute denial and terminal states; generic budget completion retained; five role displays, round query, Back/Forward/Return, mobile entry. Synthetic API only.');
} finally {await browser.close();}
