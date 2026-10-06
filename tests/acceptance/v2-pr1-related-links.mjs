// Local UI contract matrix: real login, explicit task-response fixtures, no business writes.
import assert from 'node:assert/strict';
import {readFile, mkdir, writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {mintAcceptanceLoginCode} from '../../apps/api/src/auth/acceptance-provider.ts';
import {journeyReturnUrl} from '../../packages/contracts/src/digital-production-journey.ts';
const {chromium} = await import(process.env.PLAYWRIGHT_IMPORT || 'playwright');
const env = JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE, 'utf8'));
const fixture = JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE, 'utf8'));
const origin = process.env.V2_CANDIDATE_URL || 'http://127.0.0.1:3221';
const out = process.env.V2_REAL_EVIDENCE_DIR;
assert(out);
assert(['localhost', '127.0.0.1'].includes(new URL(origin).hostname));
assert.equal(fixture.runId, 'TEST-PR1-ACCEPT-20261006');
await mkdir(out, {recursive:true});
const sha = execFileSync('git', ['rev-parse', 'HEAD'], {encoding:'utf8'}).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain'], {encoding:'utf8'}).trim());
const browser = await chromium.launch({executablePath:'/usr/bin/chromium', headless:true});
const results = [], errors = [], writes = [];
try {
  const context = await browser.newContext({viewport:{width:1672, height:941}});
  const login = await context.request.post(origin + '/api/auth/mobile', {data:{code:mintAcceptanceLoginCode('root', env.ACCEPTANCE_LAB_SECRET)}});
  assert.equal(login.status(), 200);
  const taskPath = '/api/digital-production/tasks/' + fixture.taskId;
  const response = await context.request.get(origin + taskPath);
  assert.equal(response.status(), 200);
  const task = await response.json();
  assert.equal(task.state, 'completed');
  const page = await context.newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', r => {if(r.url().includes('/api/digital-production/') && !['GET','HEAD'].includes(r.method())) writes.push(new URL(r.url()).pathname);});
  const returnTo = journeyReturnUrl({page:1, kpi:'all', search:'', selected:fixture.sourceId, round:1});
  const cases = [
    {key:'development', taskKind:'development_confirmation', sourceId:fixture.sourceId, orderId:null},
    {key:'factory', taskKind:'bulk_qc', sourceId:null, orderId:fixture.sourceId},
    {key:'bulk', taskKind:'bulk_pattern', sourceId:null, orderId:fixture.sourceId},
    {key:'budget', taskKind:'sourcing_preparation', sourceId:null, orderId:fixture.sourceId},
  ];
  for (const target of cases) {
    await page.route(origin + taskPath, route => route.fulfill({json:{...task, ...target, canExecute:true, canCorrect:true}}));
    for (const view of ['read', 'correct', 'handle']) {
      const name = target.key + '-' + view;
      try {
        await page.goto(origin + '/ui/digital-production?task=' + fixture.taskId + '&taskView=' + view + '&returnTo=' + encodeURIComponent(returnTo));
        const panel = page.getByLabel('座舱原任务详情');
        await panel.getByRole('heading', {name:fixture.style, exact:true}).waitFor();
        const hrefs = await panel.locator('a').evaluateAll(links => links.map(a => a.href));
        const resourceLinks = hrefs.filter(href => ['development','factory','bulk','budget'].some(key => new URL(href).searchParams.has(key)));
        assert.equal(resourceLinks.length, view === 'handle' ? 1 : 0, name);
        if (view === 'handle') {
          const link = new URL(resourceLinks[0]);
          assert.equal(link.searchParams.get(target.key), fixture.sourceId);
          assert.equal(link.searchParams.get('returnTo'), returnTo);
        }
        await panel.getByText('历史记录与核实', {exact:true}).click();
        assert.equal(await panel.getByRole('link', {name:'进入时间核实', exact:true}).count(), view === 'read' ? 1 : 0);
        assert.equal((await panel.getByRole('button', {name:'保存核实', exact:true}).count()) > 0, view !== 'read');
        if (view !== 'handle') assert.equal(await panel.locator('fieldset').count(), 0);
        if (target.key === 'development' && view !== 'handle') await page.screenshot({path:out + '/' + name + '.png'});
        results.push({name, status:'PASS'});
      } catch (e) {results.push({name, status:'FAIL', error:e.message}); throw e;}
    }
    await page.unroute(origin + taskPath);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(writes.filter(path => path !== '/api/digital-production/notifications/claim'), []);
} finally {
  await writeFile(out + '/related-links-result.json', JSON.stringify({sha, dirty, results, errors, writes, limitations:['UI contract matrix intercepts only the task response; fixtures are not business UAT', 'No business writes or deployment']}, null, 2));
  await browser.close();
}
console.log(JSON.stringify({sha, dirty, passed:results.filter(r => r.status === 'PASS').length}));
