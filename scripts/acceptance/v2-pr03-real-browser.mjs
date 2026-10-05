// Owned local TEST database and actual APIs only; desktop validation, no response interception.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { mintAcceptanceLoginCode } from "../../apps/api/src/auth/acceptance-provider.ts";
import { journeyReturnUrl } from "../../packages/contracts/src/digital-production-journey.ts";
const { chromium } = await import(process.env.PLAYWRIGHT_IMPORT || "playwright");
const env = JSON.parse(await readFile(process.env.V2_LOCAL_ENV_FILE, "utf8"));
const fixture = JSON.parse(await readFile(process.env.V2_LOCAL_FIXTURE_FILE, "utf8"));
const origin = process.env.V2_CANDIDATE_URL || "http://127.0.0.1:3212";
const out = process.env.V2_REAL_EVIDENCE_DIR;
assert(out);
for (const value of [origin, env.DATABASE_URL]) assert(["127.0.0.1", "localhost"].includes(new URL(value).hostname));
assert.equal(fixture.runId, "TEST-V2-STAGE01-FIX");
const db = new pg.Pool({ connectionString: env.DATABASE_URL });
assert.equal((await db.query("SELECT shobj_description(oid,'pg_database') marker FROM pg_database WHERE datname=current_database()")).rows[0].marker, "dx-rework-isolated-test-v1");
assert.equal((await db.query("SELECT design_style_no FROM digital_production_sources WHERE source_id=$1", [fixture.sourceId])).rows[0].design_style_no, "TEST-V2-PLAN");
const version = (await db.query("SELECT version() value")).rows[0].value;
await db.end();
await mkdir(out, { recursive: true });
const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const dirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim());
const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true });
const scenarios = [], errors = [];
async function session(alias) {
  const context = await browser.newContext({ viewport: { width: 1672, height: 941 } });
  const login = await context.request.post(origin + "/api/auth/mobile", { data: { code: mintAcceptanceLoginCode(alias, env.ACCEPTANCE_LAB_SECRET) } });
  assert.equal(login.status(), 200);
  const page = await context.newPage();
  page.on("pageerror", error => errors.push({ alias, message: error.message }));
  return page;
}
const api = async (page, path) => {
  const response = await page.request.get(origin + "/api/digital-production/" + path);
  assert.equal(response.status(), 200, path);
  return response.json();
};
async function command(page, path, body) {
  const response = await page.request.post(origin + "/api/digital-production/" + path, { headers: { "idempotency-key": randomUUID() }, data: body });
  assert.equal(response.status(), 200, path + " original TEST command: " + await response.text());
  return response.json();
}
async function ready(page, detail = true) {
  await page.locator(".journey-orders[aria-busy=false]").waitFor();
  if (detail) await page.locator(".journey-flow").waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
}
async function visit(page, search = "") {
  await page.goto(origin + "/ui/digital-cockpit" + search);
  await ready(page);
}
async function shot(page, name) { await page.screenshot({ path: out + "/" + name + ".png", fullPage: true }); }
async function kpiCheck(page, filter) {
  const data = await api(page, "journeys?" + filter);
  const values = [data.summary.all, data.summary.active, data.summary.dueSoon, data.summary.overdue, data.summary.blocked, data.summary.completed].map(String);
  assert.deepEqual(await page.locator(".journey-kpis strong").allTextContents(), values);
  assert((await page.getByRole("navigation", { name: "分页", exact: true }).innerText()).includes("共 " + data.total + " 条"));
  return data;
}
try {
  const root = await session("root");
  // Confirm this owned TEST source through the original source/order service.
  const source = (await api(root, "sources?search=TEST-V2-PLAN")).items.find(item => item.sourceId === fixture.sourceId);
  assert(source);
  const candidates = await api(root, "access/candidates");
  const merchandiser = candidates.find(item => item.roles.includes("order_merchandiser") && item.displayName.startsWith("[UAT]"));
  assert(merchandiser);
  if (!source.productionOrderId) await command(root, "sources/" + source.sourceId + "/confirm", { customerCode: "PD", productGroup: "男装", designStyleNo: source.designStyleNo, temporaryStyleNo: source.temporaryStyleNo, primaryMerchandiserId: merchandiser.id, orderDate: "2026-10-01", contractDeliveryDate: "2026-10-20", lines: [{ poNumber: "TEST-PR03-PO1", color: "黑", sizes: [{ size: "M", quantity: 5 }] }, { poNumber: "TEST-PR03-PO2", color: "白", sizes: [{ size: "L", quantity: 7 }] }] });
  const existing = [...(await api(root, "sources?search=TEST-PR03-PAGE&page=1")).items, ...(await api(root, "sources?search=TEST-PR03-PAGE&page=2")).items];
  for (let i = 0; i < 21; i++) {
    const style = "TEST-PR03-PAGE-" + String(i).padStart(2, "0");
    if (!existing.some(item => item.designStyleNo === style)) await command(root, "sources", { developmentType: "头版", designStyleNo: style, temporaryStyleNo: null, customerCode: "PD" });
  }
  await visit(root, "?search=TEST-V2-PLAN");
  let data = await kpiCheck(root, "search=TEST-V2-PLAN");
  assert.equal(data.total, 1);
  assert.equal(data.items[0].orderId !== null, true);
  assert.equal(await root.locator(".journey-kpis button").count(), 6);
  assert.equal(await root.locator(".journey-flow > section").count(), 7);
  assert.equal(await root.locator(".app-shell").count(), 1);
  await shot(root, "root-1672-formal-seven-flow");
  scenarios.push({ scenario: "formal route consumes Journey / six KPI / seven phases / joined two-PO source once", status: "pass" });
  await root.locator(".journey-kpis button").nth(3).click();
  await ready(root);
  data = await kpiCheck(root, "search=TEST-V2-PLAN&kpi=overdue");
  assert.equal(data.total, data.summary.overdue);
  assert((await root.locator(".journey-orders").innerText()).includes("物料补齐"));
  await root.locator(".journey-hit").filter({ hasText: "物料补齐" }).click();
  const materialRow = root.locator('[id="journey-node-material:' + fixture.materialId + ':1"]');
  await materialRow.waitFor();
  assert((await materialRow.innerText()).includes("2026-10-03"));
  assert((await materialRow.innerText()).includes("尚未启动 SLA"));
  await shot(root, "root-overdue-exact-node");
  scenarios.push({ scenario: "overdue KPI agrees with service / hit reason focuses exact date-only plan node", status: "pass" });
  await root.getByRole("button", { name: "更多筛选", exact: true }).click();
  const filters = root.locator(".journey-filters");
  await filters.getByLabel("客户", { exact: true }).selectOption("PD");
  await filters.getByLabel("跟单", { exact: true }).selectOption(merchandiser.id);
  await filters.getByLabel("品类 / 款式", { exact: true }).selectOption("上衣");
  await filters.getByLabel("小流程", { exact: true }).selectOption("development_material_supply");
  await filters.getByLabel("风险", { exact: true }).selectOption("overdue");
  await filters.getByRole("button", { name: "查询", exact: true }).click();
  await ready(root);
  const combo = "search=TEST-V2-PLAN&customer=PD&merchandiserId=" + merchandiser.id + "&category=" + encodeURIComponent("上衣") + "&node=development_material_supply&risk=overdue&kpi=overdue";
  data = await kpiCheck(root, combo);
  assert.equal(data.total, 1);
  assert.equal(data.items[0].id, fixture.sourceId);
  await shot(root, "root-combined-filter");
  scenarios.push({ scenario: "customer + merchandiser + category + exact node + risk combined positive match", status: "pass" });
  await root.locator(".journey-hit").filter({ hasText: "物料补齐" }).click();
  const before = new URL(root.url()).search;
  await materialRow.getByRole("link", { name: "查看原记录", exact: true }).click();
  await root.locator("#material-" + fixture.materialId).waitFor();
  assert.equal(new URL(root.url()).hash, "#material-" + fixture.materialId);
  assert.equal(await root.getByLabel("预计到料日期", { exact: true }).inputValue(), "2026-10-03");
  await shot(root, "root-original-material-anchor");
  await root.getByRole("link", { name: "返回生产管理座舱", exact: true }).click();
  await ready(root);
  assert.equal(new URL(root.url()).search, before);
  assert.equal(await filters.getByLabel("跟单", { exact: true }).inputValue(), merchandiser.id);
  await materialRow.getByRole("link", { name: "查看原记录", exact: true }).click();
  await root.locator("#material-" + fixture.materialId).waitFor();
  await root.getByRole("button", { name: "返回", exact: true }).click();
  await ready(root);
  assert.equal(new URL(root.url()).search, before);
  scenarios.push({ scenario: "exact original material UI / date value / both original and shell return restore filters, selection, expansion and focus", status: "pass" });
  await visit(root, "?search=TEST-PR03-PAGE&page=2");
  data = await kpiCheck(root, "search=TEST-PR03-PAGE&page=2");
  assert.equal(data.total, 21);
  assert.equal(await root.locator(".journey-orders tbody tr").count(), 1);
  const pageContext = new URL(root.url()).search;
  await root.locator(".journey-order-select").click();
  await root.getByRole("button", { name: "展开全部小流程", exact: true }).click();
  const original = root.locator(".journey-node-table").getByRole("link", { name: "查看原记录", exact: true }).first();
  await original.click();
  await root.getByRole("link", { name: "返回生产管理座舱", exact: true }).click();
  await ready(root);
  assert.equal(new URL(root.url()).searchParams.get("page"), "2");
  assert.equal(new URL(root.url()).searchParams.get("search"), new URLSearchParams(pageContext).get("search"));
  await shot(root, "root-pagination-return");
  scenarios.push({ scenario: "real 21-source pagination and original-record return keep page two and selected source", status: "pass" });
  await visit(root, "?search=TEST-V2-PLAN");
  for (const [width, height] of [[1440, 1024], [1280, 800]]) { await root.setViewportSize({ width, height }); await ready(root); assert.equal(await root.locator(".journey-flow > section").count(), 7); await shot(root, "root-" + width + "-formal"); }
  scenarios.push({ scenario: "desktop 1672 / 1440 / 1280; all phases visible; no document overflow", status: "pass" });
  await root.goto(origin + "/ui/digital-cockpit?search=TEST-ABSENT-PR03");
  await ready(root, false);
  assert((await root.getByRole("status").innerText()).includes("没有订单"));
  await kpiCheck(root, "search=TEST-ABSENT-PR03");
  await shot(root, "root-real-empty");
  await root.goto(origin + "/ui/digital-cockpit?selected=00000000-0000-4000-8000-000000000001");
  await root.getByRole("alert").waitFor();
  assert.equal(await root.locator(".journey-detail").count(), 0);
  await shot(root, "root-real-invalid-selected");
  scenarios.push({ scenario: "real empty query / original 404 selected-order error without stale details", status: "pass" });
  const context = { search: "TEST-V2-PLAN", selected: fixture.sourceId, expanded: "development", page: 1, kpi: "all" };
  const history = new URL(fixture.reviewUrl, origin);
  history.searchParams.set("returnTo", journeyReturnUrl(context));
  await root.goto(history.href);
  await root.getByText("历史节点 · 只读", { exact: true }).first().waitFor();
  assert.equal(new URL(root.url()).searchParams.get("entryId"), new URL(fixture.reviewUrl, origin).searchParams.get("entryId"));
  await root.getByRole("link", { name: "返回当前节点", exact: true }).click();
  await root.getByRole("link", { name: "返回生产管理座舱", exact: true }).click();
  await ready(root);
  assert.equal(new URL(root.url()).searchParams.get("selected"), fixture.sourceId);
  scenarios.push({ scenario: "standalone original TEST native readonly entry / current node / cockpit return adapter", status: "pass" });
  const worker = await session("pattern-room-worker");
  await visit(worker, "?search=TEST-V2-PLAN");
  assert.equal(await worker.getByRole("button", { name: "工序时效设定", exact: true }).count(), 0);
  assert.equal(await worker.locator(".journey-document").filter({ hasText: "预算" }).count(), 0);
  const denied = await worker.request.get(origin + "/api/digital-production/journeys/" + fixture.reworkId);
  assert([403, 404].includes(denied.status()));
  await shot(worker, "worker-1672-authorized-journey");
  scenarios.push({ scenario: "real assigned worker / no policy management or budget records / unrelated detail denied", status: "pass" });
  assert.deepEqual(errors, []);
  await writeFile(out + "/result.json", JSON.stringify({ sha, dirty, runtime: "real local API + PostgreSQL; no interception", databaseVersion: version, roles: ["root", "pattern-room-worker"], viewports: ["1672x941", "1440x1024", "1280x800"], scenarios, errors, limitations: ["Mobile special validation deferred by user", "All-node plan registration remains undefined", "Known A4 defects not fixed", "Full role-handoff UAT and online Acceptance not run", "Native history return adapter uses standalone original TEST history; no claim of a fully received digital order"] }, null, 2));
  console.log("PASS", scenarios.length, "real desktop scenarios; dirty=" + dirty);
} finally { await browser.close(); }
