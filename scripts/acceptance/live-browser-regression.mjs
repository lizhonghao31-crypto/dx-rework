import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const baseRaw = process.env.ACCEPTANCE_PUBLIC_URL?.trim();
const controlCode = process.env.ACCEPTANCE_CONTROL_CODE?.trim();
const expectedSha = process.env.ACCEPTANCE_EXPECTED_SHA?.trim();
const evidenceDir = resolve(process.env.ACCEPTANCE_EVIDENCE_DIR ?? "acceptance-live-evidence");

if (!baseRaw || !controlCode || !expectedSha) {
  throw new Error("Acceptance live regression requires URL, one-time control code and expected SHA");
}
if (!/^[0-9a-f]{40}$/.test(expectedSha)) throw new Error("Acceptance expected SHA is invalid");

const base = new URL(baseRaw);
if (base.protocol !== "https:") throw new Error("Acceptance live regression requires HTTPS");
if (base.hostname === "dxerp.org.cn" || base.hostname === "www.dxerp.org.cn") {
  throw new Error("Acceptance live regression refuses the production domain");
}
base.pathname = base.pathname.replace(/\/$/, "") + "/";
base.search = "";
base.hash = "";

await mkdir(evidenceDir, { recursive: true });

const versionResponse = await fetch(new URL("version", base));
if (!versionResponse.ok) throw new Error(`Acceptance version endpoint returned HTTP ${versionResponse.status}`);
const version = await versionResponse.json();
if (version.gitSha !== expectedSha) {
  throw new Error(`Acceptance version mismatch: expected ${expectedSha}, got ${String(version.gitSha)}`);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
let businessPage;
let commandCenterPage;
let matrixSummary = "";

try {
  await page.goto(new URL("ui/acceptance-lab", base).toString(), { waitUntil: "domcontentloaded" });
  await page.getByRole("heading", { name: "取得验收控制权限" }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(evidenceDir, "01-lab-locked.png"), fullPage: true });

  await page.locator("textarea").fill(controlCode);
  await page.getByRole("button", { name: "进入验收中心" }).click();
  await page.getByRole("heading", { name: "角色权限验收中心" }).waitFor({ timeout: 30_000 });

  const matrixButton = page.getByRole("button", { name: "运行全部角色权限矩阵" });
  await matrixButton.click();
  await page.waitForFunction(() => {
    const buttons = [...document.querySelectorAll("button")];
    return buttons.some((button) =>
      button.textContent?.trim() === "运行全部角色权限矩阵"
      && !button.disabled,
    );
  }, undefined, { timeout: 120_000 });

  matrixSummary = (await page.locator(".acceptance-matrix-summary").innerText()).trim();
  const match = matrixSummary.match(/(\d+)\s*通过\s*·\s*(\d+)\s*失败/);
  if (!match) throw new Error(`Acceptance matrix summary is unreadable: ${matrixSummary}`);
  if (Number(match[2]) !== 0) throw new Error(`Acceptance approved matrix has failures: ${matrixSummary}`);
  await page.screenshot({ path: resolve(evidenceDir, "02-role-matrix.png"), fullPage: true });

  const rootCard = page.locator(".acceptance-identity").filter({ hasText: "[UAT] Root" });
  await rootCard.getByRole("button", { name: "切换到此身份" }).click();
  const current = page.locator(".acceptance-current");
  await current.getByText("[UAT] Root", { exact: true }).waitFor({ timeout: 30_000 });
  await current.getByText("Root", { exact: true }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: resolve(evidenceDir, "03-root-selected.png"), fullPage: true });

  const openBusiness = current.getByRole("link", { name: "新窗口打开当前身份业务页" });
  [businessPage] = await Promise.all([
    context.waitForEvent("page"),
    openBusiness.click(),
  ]);
  await businessPage.waitForLoadState("domcontentloaded");
  if (businessPage.url().includes("/auth/denied")) throw new Error("Root business landing was denied");
  await businessPage.screenshot({ path: resolve(evidenceDir, "04-root-business.png"), fullPage: true });

  commandCenterPage = await context.newPage();
  await commandCenterPage.setViewportSize({ width: 1536, height: 960 });
  await commandCenterPage.goto(new URL("ui/acceptance/production-command-center", base).toString(), { waitUntil: "domcontentloaded" });
  await commandCenterPage.locator('[data-acceptance-command-center-ready="true"]').waitFor({ timeout: 30_000 });
  const commandShell = commandCenterPage.locator(".production-command-shell");
  await commandShell.screenshot({ path: resolve(evidenceDir, "05-production-command-center-desktop-1536x960.png") });
  await commandCenterPage.setViewportSize({ width: 390, height: 844 });
  await commandShell.screenshot({ path: resolve(evidenceDir, "06-production-command-center-mobile-390x844.png") });

  await page.getByRole("button", { name: "结束验收" }).click();
  await page.getByRole("heading", { name: "取得验收控制权限" }).waitFor({ timeout: 30_000 });

  await writeFile(resolve(evidenceDir, "acceptance-result.json"), JSON.stringify({
    formatVersion: 1,
    gitSha: expectedSha,
    schemaVersion: version.schemaVersion ?? null,
    expectedSchemaVersion: version.expectedSchemaVersion ?? null,
    matrixSummary,
    rootLandingPath: new URL(businessPage.url()).pathname,
    productionCommandCenterPath: "/ui/acceptance/production-command-center",
    completedAt: new Date().toISOString(),
  }, null, 2) + "\n");
} catch (error) {
  await page.screenshot({ path: resolve(evidenceDir, "99-failure.png"), fullPage: true }).catch(() => undefined);
  throw error;
} finally {
  await commandCenterPage?.close().catch(() => undefined);
  await businessPage?.close().catch(() => undefined);
  await context.close();
  await browser.close();
}
