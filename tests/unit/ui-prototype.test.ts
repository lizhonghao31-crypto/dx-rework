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
const reworkV2Form = read("../../apps/web/src/rework-v2-form.tsx");
const reworkDetail = read("../../apps/web/src/rework-detail-page.tsx");
const attachmentUpload = read("../../apps/web/src/attachment-upload.ts");
const processConfigurationForm = read("../../apps/web/src/process-worker-assignment-form.tsx");
const landingTarget = read("../../apps/web/src/landing-target.ts");

describe("PR-01A UI prototype contract", () => {
  it.each(["/ui/supervisor", "/ui/tasks", "/ui/tasks/", "/ui/qc/new", "/ui/master-data", "/ui/process-configuration", "/ui/piecework/collective", "/ui/audit", "/system/foundation"])("declares route %s", (route) => expect(app).toContain(route));
  it("routes the authenticated root to a business landing instead of the technical foundation", () => {
    expect(app).toContain('if (path === "/") return <HomeLanding />;');
    expect(app).toContain("const target = landingTarget(body.user);");
    expect(landingTarget).toContain('user.isRoot === true');
    expect(landingTarget).toContain('hasStandardWorkspaceRole(user) && has(user, "todo:view")');
    expect(landingTarget).toContain('return "ui/my-tasks"');
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
    expect(pages).toContain("操作权限与审批人始终按 root 的最新有效授权确定");
    expect(components).toContain("min-height: 44px");
    expect(pages).not.toContain('href="#"');
  });
  it("turns the approved QC page into an idempotent real v2 workflow while admitting owners and root", () => {
    expect(app).toContain('<Shell active="发起返工" mobileNavigation="transaction"><ReworkInitiationV2Form /></Shell>');
    expect(app).toContain('{ requiredRole: "quality_control", requiredCapability: "rework:initiate" }');
    expect(app).toContain('const owner = { requiredRole: "owner_group" } as const');
    expect(reworkV2Form).toContain('"rework-orders/initiation-options"');
    expect(reworkV2Form).toContain('"idempotency-key"');
    expect(reworkV2Form).toContain("executeReworkSubmit");
    expect(reworkV2Form).toContain("submit-v2");
    expect(reworkV2Form).toContain("sha256Hex");
    expect(attachmentUpload).toContain("crypto.subtle.digest");
    expect(reworkV2Form).toContain('upload.append("file", file)');
    expect(reworkV2Form).toContain("款号 <b>*</b>");
    expect(reworkV2Form).toContain("加工厂 <b>*</b>");
    expect(reworkV2Form).toContain("订单跟单 <b>*</b>");
    expect(reworkV2Form).toContain("上传报告 <b>*</b>");
    expect(reworkV2Form).toContain("<summary>更多信息</summary>");
    expect(reworkV2Form).not.toContain("styleNos");
    expect(reworkDetail).toContain("撤回修改");
    expect(reworkDetail).toContain("取消返工单");
    expect(webCss).not.toContain("--dx-v2-color-primary:");
  });
  it("adds the merged N02 process and worker page without replacing the established layout", () => {
    expect(app).toContain("requiredAnyOf");
    expect(app).toContain('requiredRole: "tail_supervisor"');
    expect(app).toContain('requiredRole: "ie_reviewer"');
    expect(processConfigurationForm).toContain('"rework-process-configurations/options"');
    expect(processConfigurationForm).toContain("/process-configuration/draft");
    expect(processConfigurationForm).toContain("/process-configuration/submit");
    expect(processConfigurationForm).toContain("/process-configuration/review");
    expect(processConfigurationForm).toContain("分配工序 &工人");
    expect(processConfigurationForm).toContain("候选单价（元/件）");
    expect(processConfigurationForm).toContain("尾查工序");
  });
});
