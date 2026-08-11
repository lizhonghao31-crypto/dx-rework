import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const read = (path: string) => readFile(path, "utf8");

describe("mobile primary navigation", () => {
  it("derives the visible mobile entry list from the existing authorized navigation", async () => {
    const components = await read("apps/web/src/components.tsx");

    expect(components).toContain('const MOBILE_PRIMARY_NAVIGATION_NAMES = ["我的待办", "发起返工", "全部订单"]');
    expect(components).toContain("const primaryNavigation = navigation.filter(isMobilePrimaryNavigation);");
    expect(components).toContain("const moreNavigation = navigation.filter((entry) => !isMobilePrimaryNavigation(entry));");
    expect(components).toContain("<PrimaryNavigation navigation={moreNavigation} active={active} basePath={basePath} />");
    expect(components).toContain('mobileNavigation?: "primary" | "transaction";');
    expect(components).toContain('mobileNavigation === "primary"');
    expect(components).not.toContain("mobile-flow-navigation");
  });

  it("keeps the navigation above the safe area and lets transaction forms opt out", async () => {
    const [css, app] = await Promise.all([
      read("apps/web/src/workflow-shell.css"),
      read("apps/web/src/App.tsx"),
    ]);

    expect(css).toContain(".app-shell > .mobile-primary-navigation");
    expect(css).toContain("margin-top: 0;");
    expect(css).toContain("position: fixed;");
    expect(css).toContain("env(safe-area-inset-bottom, 0px)");
    expect(css).toContain(".mobile-primary-navigation__more[open] .mobile-primary-navigation__drawer");
    expect(app).toContain('<Shell active="发起返工" mobileNavigation="transaction"><ReworkInitiationWorkbench /></Shell>');
    expect(app).toContain('<Shell active="全部订单" mobileNavigation="transaction"><ProcessConfigurationForm /></Shell>');
    expect(app).toContain('<Shell active="全部订单" mobileNavigation="transaction"><WorkReportingForm /></Shell>');
  });
});
