// Owned local TEST database, original APIs and rendered pages. No response interception.
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {execFileSync} from "node:child_process";
import {readFile, mkdir, writeFile} from "node:fs/promises";
import pg from "pg";
import {mintAcceptanceLoginCode} from "../../apps/api/src/auth/acceptance-provider.ts";
const {chromium} = await import(process.env.PLAYWRIGHT_IMPORT || "playwright");
const env = JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE, "utf8"));
const fixture = JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE, "utf8"));
const origin = process.env.V2_CANDIDATE_URL || "http://127.0.0.1:3225", baseline = process.env.V2_BASELINE_URL || "http://127.0.0.1:3221", out = process.env.V2_REAL_EVIDENCE_DIR;
assert(out); assert.equal(fixture.runId, "TEST-V2-STAGE01-FIX");
for (const value of [origin, baseline, env.DATABASE_URL]) assert(["127.0.0.1", "localhost"].includes(new URL(value).hostname));
const db = new pg.Pool({connectionString: env.DATABASE_URL});
assert.equal((await db.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker, "dx-rework-isolated-test-v1");
const version = (await db.query("SELECT version() value")).rows[0].value;
await db.end(); await mkdir(out, {recursive: true});
const sha = execFileSync("git", ["rev-parse", "HEAD"], {encoding: "utf8"}).trim(), dirty = Boolean(execFileSync("git", ["status", "--porcelain"], {encoding: "utf8"}).trim());
const browser = await chromium.launch({executablePath: "/usr/bin/chromium", headless: true});
const checkpoint = process.env.V2_BROWSER_RESUME ? JSON.parse(await readFile(process.env.V2_BROWSER_RESUME, "utf8")) : null;
const results = checkpoint?.scenarios ?? [], errors = [], created = checkpoint?.createdLocalTestSources ?? [], run = checkpoint?.run ?? "TEST-PR2-GOLDEN-" + Date.now();
async function session(alias, target = origin) {
  const context = await browser.newContext({viewport: {width: 1672, height: 941}});
  const response = await context.request.post(target + "/api/auth/mobile", {data: {code: mintAcceptanceLoginCode(alias, env.ACCEPTANCE_LAB_SECRET)}});
  assert.equal(response.status(), 200, alias);
  const page = await context.newPage(); page.on("pageerror", error => errors.push({alias, message: error.message})); return page;
}
async function api(page, path, target = origin) {const response = await page.request.get(target + "/api/digital-production/" + path); assert.equal(response.status(), 200, path); return response.json();}
async function shot(page, name) {await page.screenshot({path: `${out}/${name}.png`, fullPage: false});}
async function layout(page) {assert.equal(await page.locator(".app-shell").count(), 1); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);}
async function designer(page, query = "") {await page.goto(origin + "/ui/digital-production?workspace=designer" + query); await page.locator(".development-workspace table tbody").waitFor({state: "attached"}); await page.getByRole("button", {name: "产品开发（无确定订单）", exact: true}).waitFor(); await page.waitForFunction(() => !document.querySelector(".development-list-panel")?.innerText.includes("正在读取开发档案")); await layout(page);}
async function development(page) {await page.locator(".development-editor").waitFor(); await page.getByText("款式设计与制作说明单", {exact: true}).waitFor();}
async function fillIdentity(page, style, type = "头版") {const form = page.locator(".development-create"); await form.getByLabel("开发类型", {exact: true}).selectOption(type); await form.getByLabel("设计款号", {exact: true}).fill(style); await form.getByLabel("客户", {exact: true}).selectOption("PD");}
async function fillOrder(page, second = false) {
  const form = page.locator(".development-create"); await form.getByLabel("颜色", {exact: true}).first().fill("黑"); await form.getByLabel("尺码", {exact: true}).first().fill("M"); await form.getByLabel("数量", {exact: true}).first().fill("5"); await form.getByLabel("PO 号", {exact: true}).first().fill(run + "-PO1");
  if (second) {await form.getByRole("button", {name: "添加款色 / PO", exact: true}).click(); await form.getByLabel("颜色", {exact: true}).nth(1).fill("白"); await form.getByLabel("尺码", {exact: true}).nth(1).fill("L"); await form.getByLabel("数量", {exact: true}).nth(1).fill("7"); await form.getByLabel("PO 号", {exact: true}).nth(1).fill(run + "-PO2");}
}
async function board(page, query = "") {await page.goto(origin + "/ui/digital-pattern-room" + query); await page.locator(".pattern-task-list h2").waitFor(); await page.waitForFunction(() => !document.querySelector(".pattern-workspace")?.innerText.includes("正在读取授权任务")); await layout(page);}
try {
  const designerPage = await session("sample-designer");
  let certainId, confirmed;
  if (!checkpoint) {
  await designer(designerPage, "&search=" + run);
  assert.equal(await designerPage.locator(".development-view-cards button").count(), 4);
  await designerPage.getByRole("button", {name: "产品开发（无确定订单）", exact: true}).click(); await designerPage.getByRole("button", {name: "新建开发单", exact: true}).click();
  await fillIdentity(designerPage, run + "-DEV", "开发板"); await shot(designerPage, "designer-no-order-form");
  await designerPage.getByRole("button", {name: "保存并填写开发单", exact: true}).click(); await development(designerPage);
  const sourceId = new URL(designerPage.url()).searchParams.get("development"); assert(sourceId); created.push(sourceId);
  await designerPage.getByLabel("数量", {exact: true}).first().fill("1"); await designerPage.getByLabel("样板尺码", {exact: true}).fill("M"); await designerPage.getByLabel("制作说明", {exact: true}).fill("TEST PR2-GOLDEN 保留已有开发资料");
  const saved = designerPage.waitForResponse(response => response.url().endsWith(`/sources/${sourceId}/development`) && response.request().method() === "PUT"); await designerPage.getByRole("button", {name: "保存草稿", exact: true}).click(); assert.equal((await saved).status(), 200);
  await designerPage.getByRole("button", {name: "打印 / 保存 PDF", exact: true}).waitFor(); await designerPage.waitForFunction(() => !document.querySelector(".development-editor")?.innerText.includes("保存中"));
  const sheetBefore = await api(designerPage, `sources/${sourceId}/development`);
  assert.equal(sheetBefore.developmentType, "开发板"); assert.equal(sheetBefore.document.instructions, "TEST PR2-GOLDEN 保留已有开发资料");
  await shot(designerPage, "designer-full-original-development"); await designerPage.getByRole("button", {name: "返回", exact: true}).click(); await designerPage.locator(".development-workspace table tbody tr").waitFor();
  await designerPage.getByRole("button", {name: "客户确定订单", exact: true}).click();
  assert.equal(await designerPage.locator(".development-create").getByLabel("设计款号", {exact: true}).inputValue(), run + "-DEV"); assert(await designerPage.locator(".development-create").getByLabel("设计款号", {exact: true}).evaluate(element => element.readOnly));
  assert.equal(await designerPage.locator(".development-create").getByLabel("客户", {exact: true}).isDisabled(), true);
  await fillOrder(designerPage, true); await shot(designerPage, "designer-confirm-existing-order"); await designerPage.getByRole("button", {name: "确认下单", exact: true}).click(); await development(designerPage);
  assert.equal(new URL(designerPage.url()).searchParams.get("development"), sourceId);
  const sheetAfter = await api(designerPage, `sources/${sourceId}/development`); assert.deepEqual(sheetAfter.document, sheetBefore.document); assert.equal(sheetAfter.version, sheetBefore.version);
  confirmed = await api(designerPage, `journeys/${sourceId}`); assert(confirmed.orderId); assert.equal(confirmed.lines.length, 2); assert.equal(confirmed.lines.reduce((sum, line) => sum + line.orderedQuantity, 0), 12); assert.notEqual(confirmed.stages.flatMap(stage => stage.nodes).find(node => node.key === "customer_sample").state, "completed");
  await designer(designerPage, "&search=" + run + "&view=ordered"); assert.equal((await api(designerPage, "workspaces/designer?search=" + run + "&view=ordered")).total, 1);
  await designerPage.locator(".development-row-select").first().click(); await designerPage.getByRole("link", {name: "查看完整订购信息", exact: true}).click(); await designerPage.getByRole("heading", {name: run + "-DEV", exact: true}).waitFor(); await shot(designerPage, "designer-original-order-info"); await designerPage.getByRole("link", {name: "返回开发工作台", exact: true}).click(); await designerPage.locator(".development-workspace table tbody tr").waitFor();
  assert.equal(new URL(designerPage.url()).searchParams.get("view"), "ordered");
  results.push({scenario: "no-order creation, full original draft/print controls, confirm only order information in the same archive and two-PO quantities, sample remains unconfirmed, original-order return", status: "pass"});
  await designerPage.getByRole("button", {name: "产品开发（有确定订单）", exact: true}).click(); await designerPage.getByRole("button", {name: "新建开发单", exact: true}).click(); await fillIdentity(designerPage, run + "-CERTAIN"); await fillOrder(designerPage, true);
  // Original schema rejects duplicate colors before the facade creates a source.
  await designerPage.locator(".development-create").getByLabel("颜色", {exact: true}).nth(1).fill("黑"); await designerPage.getByRole("button", {name: "保存并填写开发单", exact: true}).click(); await designerPage.getByRole("alert").filter({hasText: "颜色不能重复"}).waitFor(); assert.equal((await api(designerPage, "sources?search=" + run + "-CERTAIN")).items.length, 0);
  await designerPage.locator(".development-create").getByLabel("颜色", {exact: true}).nth(1).fill("白"); await shot(designerPage, "designer-certain-order-form"); await designerPage.getByRole("button", {name: "保存并填写开发单", exact: true}).click(); await development(designerPage);
  certainId = new URL(designerPage.url()).searchParams.get("development"); created.push(certainId); const certain = await api(designerPage, `journeys/${certainId}`);
  assert(certain.orderId); assert.equal(certain.lines.length, 2); assert.notEqual(certain.stages.flatMap(stage => stage.nodes).find(node => node.key === "customer_sample").state, "completed");
  const certainSheet = await api(designerPage, `sources/${certainId}/development`); assert.equal(certainSheet.status, "draft"); assert.equal(certainSheet.developmentType, "头版");
  results.push({scenario: "certain-order entry creates one original source plus its original order, duplicate-color validation prevents partial writes, no sample approval", status: "pass"});
  await designer(designerPage, "&search=" + run); await designerPage.getByRole("button", {name: "产品开发（无确定订单）", exact: true}).click(); await designerPage.getByRole("button", {name: "新建开发单", exact: true}).click();
  await designerPage.locator(".development-create").getByLabel("设计款号", {exact: true}).fill(run + "-GENERIC");
  assert.equal(await designerPage.locator(".development-create").getByLabel("客户", {exact: true}).inputValue(), "");
  await designerPage.getByRole("button", {name: "保存并填写开发单", exact: true}).click(); await development(designerPage);
  const genericId = new URL(designerPage.url()).searchParams.get("development"); assert(genericId); created.push(genericId);
  const genericBefore = await api(designerPage, `sources/${genericId}/development`); await designerPage.getByRole("button", {name: "返回", exact: true}).click();
  const genericRow = designerPage.locator(".development-workspace tbody tr").filter({hasText: run + "-GENERIC"}); await genericRow.waitFor(); await genericRow.getByRole("button", {name: "查看", exact: true}).click(); await designerPage.getByRole("button", {name: "客户确定订单", exact: true}).click();
  const genericForm = designerPage.locator(".development-create"), customerSelect = genericForm.getByLabel("客户", {exact: true});
  await customerSelect.selectOption("PD"); assert.equal(await customerSelect.isDisabled(), false); await fillOrder(designerPage, true);
  const originalDetails = await genericForm.locator("fieldset fieldset input").evaluateAll(inputs => inputs.map(input => input.value));
  const options = await api(designerPage, "options"), alternative = options.customers.find(customer => customer.code !== "PD"); assert(alternative);
  await customerSelect.selectOption(alternative.code); assert.equal(await customerSelect.isDisabled(), false);
  assert.deepEqual(await genericForm.locator("fieldset fieldset input").evaluateAll(inputs => inputs.map(input => input.value)), originalDetails);
  assert.deepEqual(await genericForm.getByLabel("产品分组", {exact: true}).locator("option").allTextContents(), alternative.productGroups);
  await genericForm.getByText("默认主跟单：" + (alternative.defaultMerchandiserName ?? "未配置，待主管指派"), {exact: true}).waitFor();
  await shot(designerPage, "designer-generic-customer-correction"); await genericForm.getByRole("button", {name: "确认下单", exact: true}).click(); await development(designerPage);
  assert.equal(new URL(designerPage.url()).searchParams.get("development"), genericId);
  const genericJourney = await api(designerPage, `journeys/${genericId}`), genericOrder = await api(designerPage, `orders/${genericJourney.orderId}`);
  assert.equal(genericJourney.customer, alternative.code); assert.equal(genericJourney.lines.length, 2); assert.equal(genericJourney.lines.reduce((sum, line) => sum + line.orderedQuantity, 0), 12);
  assert.equal(genericOrder.primaryMerchandiserId, alternative.defaultMerchandiserId ?? null);
  const genericAfter = await api(designerPage, `sources/${genericId}/development`); assert.deepEqual(genericAfter.document, genericBefore.document); assert.equal(genericAfter.version, genericBefore.version);
  assert.notEqual(genericJourney.stages.flatMap(stage => stage.nodes).find(node => node.key === "customer_sample").state, "completed");
  results.push({scenario: "generic source customer stays correctable, preserves two-PO order details and same development archive; customer-dependent groups/default merchandiser follow the corrected customer; fixed-customer source remains locked", status: "pass"});
  } else {certainId = created[1]; confirmed = await api(designerPage, `journeys/${created[0]}`);}
  const root = await session("root");
  await designer(root, "&search=TEST-PR03-PAGE&page=2&view=draft"); assert.equal(await root.locator(".development-workspace tbody tr").count(), 1); await shot(root, "root-designer-page2");
  await root.locator(".development-row-select").first().click(); await root.getByRole("link", {name: "打开完整开发单 / 附件 / 打印", exact: true}).click(); await development(root); await root.getByRole("button", {name: "返回", exact: true}).click(); await root.locator(".development-workspace tbody tr").waitFor(); assert.equal(new URL(root.url()).searchParams.get("page"), "2");
  results.push({scenario: "archive counts and pagination before slicing; selected development returns to page 2", status: "pass"});
  const supervisor = await session("pattern-room-supervisor");
  await board(supervisor, "?search=TEST-V2-PLAN"); const data = await api(supervisor, "workspaces/pattern?search=TEST-V2-PLAN"); assert(data.total > 0); assert.equal(data.archiveTotal, 1); assert.equal(await supervisor.locator(".pattern-board-column").count(), 7); assert.deepEqual(await supervisor.locator(".pattern-group-cards strong").allTextContents(), [data.counts.materials,data.counts.pattern,data.counts.cutting,data.counts.craft+data.counts.washing,data.counts.dispatch+data.counts.sewing,data.counts.check,data.counts.shipping].map(String));
  await shot(supervisor, "supervisor-real-board"); await supervisor.locator(".pattern-task-card").first().click(); await supervisor.locator(".pattern-detail-heading h2").waitFor(); await supervisor.getByText("面辅料情况", {exact: true}).first().waitFor(); assert.equal(await supervisor.getByText("成本预算表", {exact: true}).count(), 0); assert.equal(await supervisor.locator(".pattern-task-detail").getByRole("option", {name: "完成", exact: true}).count(), 0);
  await supervisor.getByRole("button", {name:"历史记录",exact:true}).click(); await supervisor.getByText("历史记录与核实", {exact: true}).click(); await shot(supervisor, "supervisor-selected-material-handover-history");
  const taskId = new URL(supervisor.url()).searchParams.get("task"); await supervisor.getByRole("button", {name:"当前交接",exact:true}).click(); await supervisor.locator(".pattern-task-detail").getByRole("link", {name: /查看开发单|打开开发办理/}).click(); await development(supervisor); assert.equal(new URL(supervisor.url()).searchParams.get("task"), taskId); await supervisor.getByRole("button", {name: "返回", exact: true}).click(); await supervisor.locator(".pattern-detail-heading h2").waitFor(); assert.equal(new URL(supervisor.url()).searchParams.get("task"), taskId);
  results.push({scenario: "supervisor seven visual lanes with original task columns/counts, nearby material/history/original task actions, no budget or generic completion, exact round/task and return", status: "pass"});
  await board(root, "?search=TEST-V2-PLAN&group=materials"); await root.locator(".pattern-task-card").first().click(); await root.getByRole("button", {name:"当前交接",exact:true}).click(); await root.getByRole("button", {name: "确认核配并交出", exact: true}).waitFor();
  const beforeTasks = await api(root, `sources/${fixture.sourceId}/execution`); const originalTaskIds = beforeTasks.tasks.map(task => task.taskId).sort();
  await root.getByRole("button", {name: "确认核配并交出", exact: true}).click(); await root.getByRole("alert").filter({hasText: "不能无主料通过"}).waitFor(); assert.deepEqual((await api(root, `sources/${fixture.sourceId}/execution`)).tasks.map(task => task.taskId).sort(), originalTaskIds); await shot(root, "root-no-main-material-original-gate");
  results.push({scenario: "original main-material gate rejects a no-main-material check from board UI, no successor task created", status: "pass"});
  const worker = await session("pattern-room-worker"); await board(worker, "?search=TEST-V2-PLAN"); await worker.locator(".pattern-task-card").first().click(); await worker.locator(".pattern-detail-heading h2").waitFor(); assert.equal(await worker.locator(".pattern-task-detail").getByRole("button", {name: "改派", exact: true}).count(), 0); assert.equal(await worker.locator(".pattern-task-detail").getByRole("button", {name: "保存状态", exact: true}).count(), 0);
  const deniedWorkspace = await worker.request.get(origin + "/api/digital-production/workspaces/designer"); assert.equal(deniedWorkspace.status(), 403);
  const deniedSource = await worker.request.get(origin + `/api/digital-production/sources/${certainId}/development`); assert([403, 404].includes(deniedSource.status()));
  const deniedBudget = await worker.request.get(origin + `/api/digital-production/orders/${confirmed.orderId}/budget`); assert([403, 404].includes(deniedBudget.status())); await shot(worker, "worker-original-scope-negative-actions");
  results.push({scenario: "worker read scope and negative manage/control actions; designer workspace, unrelated source and profit denied; existing A4 sibling metadata issue remains", status: "pass"});
  for (const width of [1672, 1280]) {await supervisor.setViewportSize({width, height: width === 1672 ? 941 : 800}); await board(supervisor, "?search=TEST-V2-PLAN"); await supervisor.locator(".pattern-task-card").first().click(); await supervisor.locator(".pattern-detail-columns").waitFor(); await shot(supervisor, `supervisor-${width}-board`); await designer(root, "&search=TEST-V2-PLAN"); await root.setViewportSize({width, height: width === 1672 ? 941 : 800}); await layout(root); await root.locator(".development-row-select").first().click(); await root.locator(".development-detail-columns").waitFor(); await shot(root, `root-${width}-designer`);}
  await board(root, "?search=TEST-NO-SUCH-PR2-GOLDEN"); await root.getByText("当前筛选暂无真实任务", {exact: true}).waitFor(); await shot(root, "root-board-real-empty");
  await board(root, `?search=TEST-V2-PLAN&task=${randomUUID()}`); await root.getByRole("alert").waitFor(); assert.equal(await root.locator(".pattern-detail-heading").count(), 0);
  results.push({scenario: "1672/1280 desktop overflow and formal pages, actual empty query and inaccessible selected task", status: "pass"});
  const old = await session("root", baseline), legacy = [];
  for (const path of ["/ui/pattern-room/orders", "/ui/sourcing/pending", "/ui/cutting", fixture.reviewUrl]) {
    for (const [page, target] of [[old, baseline], [root, origin]]) {await page.goto(target + path); await page.locator(".current-user").waitFor(); await page.waitForFunction(() => {const main = document.querySelector(".app-shell > main"); return main && !/正在加载|加载中|读取中|正在读取/.test(main.innerText);}); if (path === fixture.reviewUrl) await page.getByText("全部可确认", {exact: true}).waitFor(); if (path === "/ui/pattern-room/orders") await page.getByText("全部创建人", {exact: true}).waitFor({state: "attached"});}
    assert.equal(await root.locator(".app-shell > main").innerText(), await old.locator(".app-shell > main").innerText(), path); legacy.push({path, mainTextEqual: true});
  }
  await shot(root, "root-native-original-history-regression"); results.push({scenario: "four mature original module interiors equal baseline real API pages", status: "pass", legacy});
  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({sha, dirty, origin, baseline, baselineSha: "6deb13acf517ac323a041882660557667af45ea6", databaseVersion: version, runtime: "real local API/PostgreSQL; zero API interception", roles: ["root", "sample-designer", "pattern-room-supervisor", "pattern-room-worker"], desktop: [1672, 1280], createdLocalTestSources: created, scenarios: results, errors, acceptance: false, limitations: ["Mobile special validation deferred", "Full role relay and all craft/washing/revision browser paths not executed; original PostgreSQL suites cover them", "Existing A4 sibling-task metadata and warehouse todo entry defects remain", "Existing TEST image metadata has no stored image object; no upload/object-storage scenario claimed"]}, null, 2));
  console.log(`PASS ${results.length} PR2-GOLDEN real desktop scenarios; sha=${sha}; dirty=${dirty}`);
} catch (error) {
  await writeFile(`${out}/checkpoint.json`, JSON.stringify({run,scenarios:results,createdLocalTestSources:created},null,2));
  const pages = browser.contexts().flatMap(context => context.pages());
  for (let i = 0; i < pages.length; i++) await pages[i].screenshot({path: `${out}/failure-${i}.png`, fullPage: false}).catch(() => undefined);
  throw error;
} finally {await browser.close();}
