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

describe("PR-01A UI prototype contract", () => {
  it.each(["/ui/management", "/ui/supervisor", "/ui/tasks", "/ui/tasks/", "/ui/qc/new", "/ui/piecework/collective", "/system/foundation"])("declares route %s", (route) => expect(app).toContain(route));
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
  it("loads public DingTalk client config and prefixes auth navigation with Vite BASE_URL", () => {
    expect(auth).toContain('import.meta.env.BASE_URL');
    expect(auth).toContain('apiUrl("auth/client-config")');
    expect(auth).toContain('apiUrl("auth/mobile")');
    expect(auth).toContain('apiUrl("auth/qr/start")');
    expect(auth).toContain('pageUrl("auth/qr")');
  });
  it("retains accessible status, meter, audit and touch contracts", () => {
    expect(ui).toContain('aria-hidden="true" className={`dx-meter');
    expect(pages).toContain("张文豪无本厂承担最终审批权");
    expect(components).toContain("min-height: 44px");
    expect(pages).not.toContain('href="#"');
  });
});
