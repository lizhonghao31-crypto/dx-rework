import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
const app = read("../../apps/web/src/App.tsx");
const pages = read("../../apps/web/src/pages.tsx");
const fixtures = read("../../apps/web/src/fixtures.ts");
const main = read("../../apps/web/src/main.tsx");
const webCss = read("../../apps/web/src/styles.css");
const ui = read("../../packages/ui/src/index.tsx");
const tokens = read("../../packages/ui/src/tokens.css");
const components = read("../../packages/ui/src/components.css");
const uiPackage = read("../../packages/ui/package.json");
const auth = read("../../apps/web/src/auth.tsx");
const reworkForm = read("../../apps/web/src/rework-form.tsx");
const processConfigurationForm = read("../../apps/web/src/process-configuration-form.tsx");

describe("PR-01A UI prototype contract", () => {
  it.each(["/ui/management", "/ui/supervisor", "/ui/tasks", "/ui/tasks/", "/ui/qc/new", "/ui/master-data", "/ui/process-configuration", "/ui/piecework/collective", "/ui/audit", "/system/foundation"])("declares route %s", (route) => expect(app).toContain(route));
  it("routes the authenticated root to a business landing instead of the technical foundation", () => {
    expect(app).toContain('if (path === "/") return <HomeLanding />;');
    expect(app).toContain('target = "ui/management"');
    expect(app).toContain('user.businessRoles?.includes("owner_group")');
    expect(app).not.toContain("else page = <Foundation />;");
  });
  it("exports and explicitly imports reusable UI styles", () => {
    expect(existsSync(new URL("../../packages/ui/src/tokens.css", import.meta.url))).toBe(true);
    expect(existsSync(new URL("../../packages/ui/src/components.css", import.meta.url))).toBe(true);
    expect(uiPackage).toContain('"./tokens.css"');
    expect(uiPackage).toContain('"./components.css"');
    expect(main).toContain('import "@dx-rework/ui/tokens.css"');
    expect(main).toContain('import "@dx-rework/ui/components.css"');
    expect(tokens).toContain("--dx-v2-color-bg-canvas: #e8edf2");
    expect(webCss).not.toContain("--dx-v2-color-bg-canvas:");
  });
  it("implements explicit Button variants and interaction states", () => {
    expect(ui).toContain('type ButtonVariant = "primary" | "secondary"');
    expect(ui).toContain('variant = "secondary"');
    expect(components).toContain(".dx-button--primary:hover:not(:disabled)");
    expect(components).toContain(".dx-button--primary:active:not(:disabled)");
    expect(components).toContain(".dx-button:focus-visible");
    expect(components).toContain(".dx-button:disabled");
    expect(components).not.toContain(".dx-surface > .dx-button");
  });
  it("keeps collective snapshot membership dynamic and history immutable", () => {
    expect(fixtures).toContain("export const members =");
    expect(pages.match(/members\.length/g)?.length).toBeGreaterThanOrEqual(4);
    expect(pages).toContain("人员变化须新建成员版本；历史上数不反算");
    expect(pages).toContain("154.55 / members.length");
    expect(webCss).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr)");
    expect(webCss).not.toContain(".mobile-actions { grid-template-columns: 1fr; }");
  });
  it("preserves the PR-01 foundation fetch and diagnostic contract", () => {
    expect(pages).toContain('headers: { accept: "application/json" }');
    expect(pages).toContain("new AbortController()");
    expect(pages).toContain('error.name === "AbortError"');
    expect(pages).toContain("VersionResponseSchema.parse");
    expect(pages).toContain("Git SHA");
    expect(pages).toContain("Schema");
    expect(pages).toContain("当前页面仅用于验证独立前端、API 与版本追踪链路");
    expect(pages).toContain("不连接 ERP · 不启用钉钉 · 不写入生产数据");
  });
  it("loads public DingTalk client config and shows desktop QR without an extra page jump", () => {
    expect(auth).toContain('import.meta.env.BASE_URL');
    expect(auth).toContain('apiUrl("auth/client-config")');
    expect(auth).toContain('apiUrl("auth/mobile")');
    expect(auth).toContain('apiUrl("auth/qr/start")');
    expect(auth).toContain("if (!isContainer) return <QrLoginPage />;");
  });
  it("retains accessible status, meter, audit and touch contracts", () => {
    expect(ui).toContain('aria-hidden="true" className={`dx-meter');
    expect(pages).toContain("张文豪无本厂承担最终审批权");
    expect(components).toContain("min-height: 44px");
    expect(pages).not.toContain('href="#"');
  });
  it("turns only the approved QC page into an idempotent real workflow while admitting owners", () => {
    expect(app).toContain('<Shell active="发起返工"><ReworkInitiationForm /></Shell>');
    expect(app).toContain('{ requiredRole: "quality_control", requiredCapability: "rework:initiate" }');
    expect(app).toContain('const owner = { requiredRole: "owner_group" } as const');
    expect(reworkForm).toContain('"rework-orders/initiation-options"');
    expect(reworkForm).toContain('"idempotency-key"');
    expect(reworkForm).toContain("executeReworkSubmit");
    expect(reworkForm).toContain("crypto.subtle.digest");
    expect(reworkForm).toContain('upload.append("file", file)');
    expect(reworkForm).toContain("一单一个款号");
    expect(reworkForm).toContain("订单号（知道时填写）");
    expect(reworkForm).toContain("撤回修改");
    expect(reworkForm).toContain("取消返工单");
    expect(reworkForm).not.toContain("styleNos");
    expect(webCss).not.toContain("--dx-v2-color-primary:");
  });
  it("adds the PR-06 process page without replacing the established layout", () => {
    expect(app).toContain("requiredAnyOf");
    expect(app).toContain('requiredRole: "tail_supervisor"');
    expect(app).toContain('requiredRole: "ie_reviewer"');
    expect(processConfigurationForm).toContain('"rework-process-configurations/options"');
    expect(processConfigurationForm).toContain("/process-configuration/draft");
    expect(processConfigurationForm).toContain("/process-configuration/submit");
    expect(processConfigurationForm).toContain("/process-configuration/review");
    expect(processConfigurationForm).toContain("只舍不入");
    expect(processConfigurationForm).toContain("驳回必须填写原因");
    expect(webCss).toContain(".process-line__grid");
  });
});