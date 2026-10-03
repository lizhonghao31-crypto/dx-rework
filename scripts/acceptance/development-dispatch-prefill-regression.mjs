import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// A real browser and real App with synthetic API responses; never connect to a live backend.
const base = new URL(process.env.DISPATCH_PREFILL_TEST_URL || 'http://127.0.0.1:3200');
assert(['127.0.0.1', 'localhost'].includes(base.hostname), 'Only a local frontend is permitted');
const id = '11111111-1111-4111-8111-111111111111';
const worker = '22222222-2222-4222-8222-222222222222';
const replacement = '33333333-3333-4333-8333-333333333333';
let dispatch = {version: 1, patternWorkerId: worker, cuttingWorkerId: worker, sewingWorkerId: worker};
const writes = [];
let candidatesFail = false;
const browser = await chromium.launch({headless: true, ...(process.env.CHROMIUM_PATH ? {executablePath: process.env.CHROMIUM_PATH} : {})});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(10_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => sessionStorage.setItem('dx-rework:platform-module', 'rework'));
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname.split('/api/')[1];
    let body = {};
    if (path === `digital-production/sources/${id}/execution/dispatch` && route.request().method() === 'PUT') {
      const input = route.request().postDataJSON();
      assert.equal(input.expectedVersion, dispatch.version);
      writes.push(input);
      dispatch = {version: dispatch.version + 1, patternWorkerId: input.patternWorkerId,
        cuttingWorkerId: input.cuttingWorkerId, sewingWorkerId: input.sewingWorkerId};
    } else {
      assert.equal(route.request().method(), 'GET', `Unexpected write: ${path}`);
      if (path === 'auth/me') body = {status: 'authorized', user: {id, displayName: '隔离主管', capabilities: [], businessRoles: ['pattern_room_supervisor']}};
      else if (path === 'digital-production/options') body = {creationEnabled: false, customers: []};
      else if (path === 'digital-production/access/options') body = {roles: [], actorId: id};
      else if (['digital-production/orders', 'digital-production/sources', 'digital-production/tasks'].includes(path)) body = {items: []};
      else if (path.endsWith('/development')) body = {sourceId: id, designStyleNo: '隔离回显', status: 'published', roundNumber: 1, version: 1, document: null, materialEvents: []};
      else if (path.endsWith('/development/rounds')) body = {rounds: [], draft: null};
      else if (path.endsWith('/execution')) body = {sheet: {canEdit: false, document: {materials: []}}, dispatch,
        tasks: [], facts: [], routeFacts: [], canDispatch: true};
      else if (path === 'digital-production/access/candidates') {
        await new Promise(resolve => setTimeout(resolve, 700));
        if (candidatesFail) return route.fulfill({status: 503, json: {error: {message: '隔离候选人员读取失败'}}});
        body = [worker, replacement].map((person, index) => ({id: person, displayName: `隔离师傅${index + 1}`, roles: ['pattern_room_worker']}));
      }
    }
    await route.fulfill({json: body});
  });
  const ready = async () => {
    await page.locator('select[name=pattern] option').filter({hasText: '隔离师傅2'}).waitFor({state: 'attached'});
    assert.equal(await page.locator('select[name=pattern]').inputValue(), dispatch.patternWorkerId);
    assert.equal(await page.locator('select[name=cutting]').inputValue(), dispatch.cuttingWorkerId);
    assert.equal(await page.locator('select[name=sewing]').inputValue(), dispatch.sewingWorkerId);
  };
  await page.goto(new URL(`/ui/digital-production?development=${id}`, base).href);
  await ready();
  assert.equal(writes.length, 0);
  await page.locator('select[name=pattern]').selectOption(replacement);
  await page.getByRole('button', {name: '保存预派', exact: true}).click();
  await page.waitForFunction(() => !document.querySelector('select[name=pattern]').disabled && !document.querySelector('select[name=pattern]').closest('fieldset').disabled);
  await ready();
  assert.deepEqual(writes, [{expectedVersion: 1, patternWorkerId: replacement, cuttingWorkerId: worker, sewingWorkerId: worker}]);
  await page.reload(); await ready();
  assert.equal(writes.length, 1);
  candidatesFail = true;
  await page.reload();
  await page.getByRole('alert').filter({hasText: '隔离候选人员读取失败'}).waitFor();
  assert.equal(await page.locator('select[name=pattern]').count(), 0);
  candidatesFail = false;
  await page.reload(); await ready();
  assert.deepEqual(errors, []);
  console.log('PASS: delayed options display all saved workers; changing one preserves the others; save/reopen and candidate failure/recovery; synthetic API only.');
} finally { await browser.close(); }
