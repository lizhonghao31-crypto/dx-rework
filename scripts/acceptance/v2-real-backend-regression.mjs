// Local, owned TEST data only. Run with node --import tsx; never intercept API responses.
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import pg from "pg";
import { mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.ts";

const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || "playwright");
const env = JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE, "utf8"));
const fixture = JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE, "utf8"));
const candidate = process.env.V2_CANDIDATE_URL || "http://127.0.0.1:3210";
const baseline = process.env.V2_BASELINE_URL || "http://127.0.0.1:3209";
const out = process.env.V2_REAL_EVIDENCE_DIR;
assert(out, "explicit evidence directory required");
for (const value of [candidate, baseline, env.DATABASE_URL]) {
  assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(value).hostname), "local endpoints only");
}
assert.equal(fixture.runId, "TEST-V2-STAGE01-FIX");
assert.equal(env.ACCEPTANCE_LAB_ENABLED, "true");
const db = new pg.Pool({ connectionString: env.DATABASE_URL });
assert.equal((await db.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker, "dx-rework-isolated-test-v1");
assert.equal((await db.query("SELECT design_style_no FROM digital_production_sources WHERE source_id=$1", [fixture.sourceId])).rows[0].design_style_no, "TEST-V2-PLAN");
assert.equal((await db.query("SELECT style_no FROM rework_orders WHERE rework_order_id=$1", [fixture.reworkId])).rows[0].style_no, "TEST-V2-NATIVE");
const version = (await db.query("SELECT version() value")).rows[0].value;
await db.end();
await mkdir(out, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() !== "";
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_BIN || "/usr/bin/chromium", headless: true });
const results = [], errors = [];
async function session(origin, alias, viewport = { width: 1672, height: 941 }) {
  const context = await browser.newContext({ viewport });
  const response = await context.request.post(origin + "/api/auth/mobile", { data: { code: mintAcceptanceLoginCode(alias, env.ACCEPTANCE_LAB_SECRET) } });
  assert.equal(response.status(), 200, "standard local identity login: " + alias);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push({ alias, message: error.message }));
  return page;
}
async function visit(page, origin, path) {
  console.log("Visit", origin, path);
  await page.goto(origin + path);
  await page.locator(".current-user").waitFor({ state: "attached" });
  // Original modules poll indicators; readiness is their own rendered loading state.
  await page.waitForFunction(() => {
    const main = document.querySelector(".app-shell > main");
    return main && !main.querySelector('[aria-busy="true"]') && !/正在加载|加载中|读取中|正在读取/.test(main.innerText);
  });
  // The original readonly panel initializes its price inputs in a later effect.
  if (path === fixture.reviewUrl) await page.locator(".quantity-review-heading").getByText("全部可确认", { exact: true }).waitFor();
}
async function shot(page, name) { await page.screenshot({ path: `${out}/${name}.png`, fullPage: true }); }
async function common(page, expectedKpi) {
  assert.equal(await page.locator(".app-shell").count(), 1);
  assert.equal(await page.locator(".current-user").count(), 1);
  assert.equal(await page.locator(".dx-production-ui").count(), 1);
  assert.equal(await page.locator(".dx-production-header").count(), 1);
  assert.equal(await page.locator(".dx-production-kpi").count(), expectedKpi);
  assert.equal(await page.locator(".dx-production-filters").count(), 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
try {
  const root = await session(candidate, "root");
  await visit(root, candidate, "/ui/digital-cockpit");
  await root.getByRole("button", { name: "TEST-V2-PLAN", exact: true }).waitFor();
  await common(root, 5);
  assert.equal(await root.locator(".dx-production-table").count(), 1);
  assert.equal(await root.locator(".dx-production-pagination").count(), 1);
  const nav = root.locator(".desktop-navigation");
  const navText = await nav.innerText();
  assert(navText.indexOf("外发定价&选厂") < navText.indexOf("订单开裁"));
  assert.equal(await nav.locator("details").filter({ has: root.locator("summary").getByText("生产填报", { exact: true }) }).count(), 0);
  const board = nav.locator("details").filter({ has: root.locator("summary").getByText("产品开发打板", { exact: true }) });
  const boardLinks = await board.locator("a strong").allTextContents();
  assert.deepEqual(boardLinks, ["板房管理台", "订单打板/杂事看板", "板房数据沙盘", "价格管控"]);
  assert.equal(await board.getByRole("link", { name: "创建订单", exact: true }).count(), 0);
  await shot(root, "root-1672-cockpit");
  results.push({ scenario: "public cockpit components / navigation", status: "pass", role: "root", viewport: "1672x941" });

  await visit(root, candidate, "/ui/digital-analysis");
  await root.getByText("共 2 条", { exact: false }).waitFor();
  await common(root, 6);
  assert.equal(await root.locator(".dx-production-table tbody tr").count(), 2);
  await shot(root, "root-1672-analysis");
  await root.getByLabel("客户", { exact: true }).fill("TEST-ABSENT");
  await root.getByText("当前授权范围无节点样本", { exact: true }).waitFor();
  await shot(root, "root-analysis-empty");
  results.push({ scenario: "public analysis components / real empty filter", status: "pass", role: "root" });

  await visit(root, candidate, "/ui/digital-production");
  await root.getByText("TEST-V2-ORDER", { exact: true }).first().waitFor();
  await common(root, 0);
  await shot(root, "root-1672-production");
  const journeyResponse = await root.request.get(`${candidate}/api/digital-production/journeys/${fixture.sourceId}`);
  assert.equal(journeyResponse.status(), 200);
  const journey = await journeyResponse.json();
  const nodes = journey.stages.flatMap(stage => stage.nodes);
  const material = nodes.find(node => node.instanceId === `material:${fixture.materialId}:1`);
  assert.equal(material.expectedAt, "2026-10-03");
  assert.equal(material.expectedKind, "plan");
  assert.equal(material.expectedPrecision, "date");
  assert.equal(material.enteredAt, null);
  assert.equal(material.sla, "not_set");
  assert(material.risks.includes("overdue"));
  await visit(root, candidate, material.records[0].url);
  const row = root.locator(`#material-${fixture.materialId}`);
  await row.waitFor();
  assert((await row.innerText()).includes("原预计：2026-10-03"));
  assert.equal(await root.getByLabel("预计到料日期", { exact: true }).inputValue(), "2026-10-03");
  assert.equal(new URL(root.url()).searchParams.get("round"), "1");
  await shot(root, "root-material-anchor");
  await root.getByRole("button", { name: "返回", exact: true }).click();
  await root.locator(".dx-production-header").waitFor();
  assert.equal(new URL(root.url()).searchParams.has("development"), false);
  results.push({ scenario: "real material plan / exact original anchor / original return", status: "pass", role: "root", node: material.key });

  await visit(root, candidate, fixture.reviewUrl);
  await root.getByText("历史节点 · 只读", { exact: true }).first().waitFor();
  assert.equal(await root.locator(".rework-history-readonly").count(), 1);
  const historyUrl = new URL(fixture.reviewUrl, candidate);
  const historyResponse = await root.request.get(`${candidate}/api/rework-orders/${fixture.reworkId}/history/${historyUrl.searchParams.get("node")}?entryId=${historyUrl.searchParams.get("entryId")}`);
  assert.equal(historyResponse.status(), 200);
  assert.equal((await historyResponse.json()).entry.id, historyUrl.searchParams.get("entryId"));
  await shot(root, "root-exact-rework-review");
  await root.getByRole("link", { name: "返回当前节点", exact: true }).click();
  await root.locator(".rework-detail-layout").waitFor();
  assert.equal(new URL(root.url()).searchParams.has("entryId"), false);
  await shot(root, "root-rework-current");
  const invalid = `${fixture.reviewUrl.replace(/entryId=[^&]+/, "entryId=00000000-0000-4000-8000-000000000001")}`;
  await visit(root, candidate, invalid);
  await root.getByRole("link", { name: "返回当前节点", exact: true }).waitFor();
  assert.equal(await root.locator(".rework-history-readonly [aria-busy=false]").count(), 1);
  await shot(root, "root-rework-invalid-history");
  results.push({ scenario: "exact review audit entry / readonly / original return / real invalid entry", status: "pass", role: "root" });
  assert(fixture.responsibilityUrl, "original responsibility TEST draft required");
  await visit(root, candidate, fixture.responsibilityUrl);
  await root.getByText("历史节点 · 只读", { exact: true }).first().waitFor();
  const responsibilityUrl = new URL(fixture.responsibilityUrl, candidate);
  const responsibilityResponse = await root.request.get(`${candidate}/api/rework-orders/${fixture.reworkId}/history/responsibility?entryId=${responsibilityUrl.searchParams.get("entryId")}`);
  assert.equal(responsibilityResponse.status(), 200);
  assert.equal((await responsibilityResponse.json()).entry.id, responsibilityUrl.searchParams.get("entryId"));
  await shot(root, "root-exact-rework-responsibility");
  results.push({ scenario: "exact responsibility draft audit entry / readonly original page", status: "pass", role: "root" });

  const old = await session(baseline, "root");
  await visit(old, baseline, "/ui/digital-cockpit");
  await old.getByRole("button", { name: "TEST-V2-PLAN", exact: true }).waitFor();
  await shot(old, "baseline-public-cockpit");
  await visit(old, baseline, "/ui/digital-analysis");
  await old.locator(".digital-analysis-table tbody tr").first().waitFor();
  await shot(old, "baseline-public-analysis");
  await visit(old, baseline, "/ui/digital-production");
  await old.getByText("TEST-V2-ORDER", { exact: true }).first().waitFor();
  await shot(old, "baseline-public-production");
  for (const path of ["/ui/pattern-room/orders", "/ui/pattern-room/create", "/ui/pattern-room/prices", "/ui/sourcing/pending", "/ui/cutting", "/ui/orders", "/ui/production-reporting", "/ui/suppliers", "/ui/samples", "/ui/finance", fixture.reviewUrl]) {
    await visit(old, baseline, path);
    await visit(root, candidate, path);
    if (path === "/ui/pattern-room/orders") {
      // People filters are a second original query after the list response.
      await old.locator(".pattern-filters select").nth(3).waitFor();
      await root.locator(".pattern-filters select").nth(3).waitFor();
    }
    if (path === "/ui/pattern-room/create") {
      await old.locator(".pattern-order-form").waitFor();
      await root.locator(".pattern-order-form").waitFor();
    }
    assert.equal(await root.locator(".app-shell > main").innerText(), await old.locator(".app-shell > main").innerText(), "unchanged mature content " + path);
    const states = async page => page.locator(".app-shell > main input,.app-shell > main select,.app-shell > main button").evaluateAll(elements => elements.map(element => ({ tag: element.tagName, disabled: element.disabled, value: element.tagName === "BUTTON" ? element.textContent : element.value })));
    assert.deepEqual(await states(root), await states(old), "unchanged fields and controls " + path);
    results.push({ scenario: "baseline mature content / fields / control state", path, status: "pass", role: "root", backend: "same local PostgreSQL/API" });
    if (path === fixture.reviewUrl) { await shot(old, "baseline-native-review"); await shot(root, "candidate-native-review"); }
  }

  await visit(root, candidate, "/ui/digital-cockpit");
  await root.setViewportSize({ width: 390, height: 844 });
  assert.equal(await root.locator(".app-shell > aside").isVisible(), false);
  await root.getByLabel("更多导航").click();
  const mobile = root.getByRole("navigation", { name: "移动端主导航" });
  await mobile.getByRole("link", { name: "生产数据填报", exact: false }).waitFor();
  await shot(root, "root-390-drawer");
  await mobile.getByRole("link", { name: "生产数据填报", exact: false }).click();
  await root.getByRole("heading", { name: "生产数据填报", exact: true }).waitFor();
  await root.getByLabel("更多导航").click();
  assert.equal(await mobile.getByRole("link", { name: "生产数据填报", exact: false }).getAttribute("aria-current"), "page");
  results.push({ scenario: "mobile original reporting entry / active context", status: "pass", role: "root", viewport: "390x844" });
  await visit(root, candidate, "/ui/digital-analysis");
  await root.getByText("共 2 条", { exact: false }).waitFor();
  await common(root, 6);
  await shot(root, "root-390-analysis");
  results.push({ scenario: "mobile analysis / contained table scroll / no document overflow", status: "pass", role: "root", viewport: "390x844" });

  const worker = await session(candidate, "pattern-room-worker");
  await visit(worker, candidate, "/ui/digital-cockpit");
  const workerNav = worker.locator(".desktop-navigation");
  assert.equal(await workerNav.getByRole("link", { name: "创建订单", exact: false }).count(), 0);
  assert.equal(await workerNav.getByRole("link", { name: "生产数据填报", exact: false }).count(), 0);
  assert.equal(await workerNav.getByText("外发定价&选厂", { exact: true }).count(), 0);
  const workerJourney = await worker.request.get(`${candidate}/api/digital-production/journeys/${fixture.sourceId}`);
  assert.equal(workerJourney.status(), 200);
  const workerNodes = (await workerJourney.json()).stages.flatMap(stage => stage.nodes);
  assert.equal(workerNodes.some(node => node.instanceId === `material:${fixture.materialId}:1`), false);
  const denied = await worker.request.get(`${candidate}/api/rework-orders/${fixture.reworkId}/history/responsibility`);
  assert([403, 404].includes(denied.status()));
  await shot(worker, "worker-1672-allowed-task-menu");
  results.push({ scenario: "assigned worker task scope / absent source plans / denied responsibility / menu negatives", status: "pass", role: "pattern-room-worker" });

  assert.deepEqual(errors, []);
  await writeFile(`${out}/result.json`, JSON.stringify({ sha, dirty, candidate, baseline, baselineSha: process.env.V2_BASELINE_SHA, runtime: "real local API and PostgreSQL; zero API interception", databaseVersion: version, roles: ["root", "pattern-room-worker"], viewports: ["1672x941 @100%", "390x844 @100%"], fixture: { runId: fixture.runId, sourceId: fixture.sourceId, orderId: fixture.orderId, reworkId: fixture.reworkId, missingImageObject: fixture.missingLocalImageObject }, scenarios: results, errors, acceptance: false, limitations: ["Independent all-node plans await a business registration rule", "Known A4 defects remain", "Full role handoff UAT and online Acceptance not executed", "Local TEST image metadata has no stored object; missing-image state only"] }, null, 2));
  console.log(`PASS ${results.length} real-backend scenarios; dirty=${dirty}; local evidence only`);
} finally { await browser.close(); }
