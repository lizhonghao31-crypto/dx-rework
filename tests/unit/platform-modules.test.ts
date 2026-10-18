import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";
import {
  accessiblePlatformModules,
  canAccessSourcing,
  canAccessDigitalProduction,
  PLATFORM_MODULE_QUERY,
  platformLandingTarget,
  platformModuleHref,
  shouldRedirectLegacyLandingToPlatformHome,
} from "../../apps/web/src/platform-modules.js";

const user = (
  roles: readonly string[],
  capabilities: readonly string[],
  isRoot = false,
): AuthorizedUser => ({ id: "user-1", displayName: "测试用户", businessRoles: roles, capabilities, isRoot });

describe("thin platform module routing", () => {
  it("admits root, owner and explicit capability while rejecting a role name alone", () => {
    expect(canAccessSourcing(user([], [], true))).toBe(true);
    expect(canAccessSourcing(user(["owner_group"], []))).toBe(true);
    expect(canAccessSourcing(user(["custom_role"], ["sourcing:view"]))).toBe(true);
    expect(canAccessSourcing(user(["production_management"], ["todo:view"]))).toBe(false);
  });

  it.each([
    ["worker", ["work:report", "todo:view"], "ui/frontline/tasks?kind=worker"],
    ["warehouse_receiver", ["receiving:create", "todo:view"], "ui/receiving"],
    ["tail_inspector", ["tail_inspection:report", "todo:view"], "ui/frontline/tasks?kind=tail_inspection"],
  ] as const)("keeps %s on the existing direct landing", (role, capabilities, expected) => {
    expect(platformLandingTarget(user([role], capabilities))).toBe(expected);
  });

  it("keeps a rework-only office user direct and sends dual-module users into the unified shell", () => {
    const office = user(["quality_control"], ["todo:view", "rework:initiate"]);
    expect(platformLandingTarget(office)).toBe(landingTarget(office));
    expect(platformLandingTarget(user(["production_management"], ["todo:view", "sourcing:view"]))).toBe("ui/my-tasks");
  });

  it("exposes digital navigation only to existing authorized roles", () => {
    expect(canAccessDigitalProduction(user([], [], true))).toBe(true);
    expect(canAccessDigitalProduction(user(["production_management"], []))).toBe(true);
    expect(canAccessDigitalProduction(user(["pattern_room_supervisor"], []))).toBe(true);
    expect(canAccessDigitalProduction(user(["worker"], ["todo:view"]))).toBe(false);
    expect(canAccessDigitalProduction(user(["finance"], []))).toBe(false);
  });

  it("derives the rework card href from the established landing function", () => {
    const dual = user(["order_merchandiser"], ["todo:view", "sourcing:view"]);
    const modules = accessiblePlatformModules(dual);
    expect(modules.map((module) => module.id)).toEqual(["sourcing", "production", "rework", "digital"]);
    expect(modules.find((module) => module.id === "rework")?.href)
      .toBe(landingTarget(dual));
  });


  it("retires the legacy module selector without redirecting valid unified-shell links", () => {
    const dual = user(["order_merchandiser"], ["todo:view", "sourcing:view"]);
    expect(shouldRedirectLegacyLandingToPlatformHome(dual, "/ui/my-tasks", "", null)).toBe(false);
    expect(shouldRedirectLegacyLandingToPlatformHome(
      dual,
      "/ui/my-tasks",
      `?${PLATFORM_MODULE_QUERY}=rework`,
      null,
    )).toBe(false);
    expect(shouldRedirectLegacyLandingToPlatformHome(dual, "/ui/my-tasks", "", "rework")).toBe(false);
    expect(shouldRedirectLegacyLandingToPlatformHome(dual, "/ui/my-tasks/task-1", "", null)).toBe(false);

    const reworkOnly = user(["quality_control"], ["todo:view", "rework:initiate"]);
    expect(shouldRedirectLegacyLandingToPlatformHome(reworkOnly, "/ui/my-tasks", "", null)).toBe(false);
  });

  it("marks rework intent while keeping the official sourcing entry direct", () => {
    const dual = user(["production_management"], ["todo:view", "sourcing:view"]);
    const modules = accessiblePlatformModules(dual);
    const rework = modules.find((module) => module.id === "rework");
    const sourcing = modules.find((module) => module.id === "sourcing");
    expect(rework && platformModuleHref(rework)).toContain(`${PLATFORM_MODULE_QUERY}=rework`);
    expect(sourcing && platformModuleHref(sourcing)).toBe("ui/sourcing/pending");
  });

  it("protects sourcing with AuthGate and keeps the unified desktop CSS token-based", async () => {
    const [app, components, shellCss, sourcingCss, sourcingPage, tokens] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/shell-navigation.css", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
      readFile("apps/web/src/sourcing-workspace-page.tsx", "utf8"),
      readFile("packages/ui/src/tokens.css", "utf8"),
    ]);
    expect(app).toContain('path === "/ui/sourcing"');
    expect(app).toContain('{ requiredCapability: "sourcing:view" }');
    expect(app).toContain('path.startsWith("/ui/sourcing")');
    expect(app).toContain("useInitialPlatformEntryCheck(path, search)");
    expect(app).not.toContain("PlatformHomePage");
    expect(app).toContain('if (path === "/ui/home") page = <HomeLanding />');
    expect(components).not.toContain('mobile-primary-navigation__label">平台');
    expect(components).toContain('"外发定价&选厂": { label: "外发", glyph: "发" }');
    expect(shellCss).toContain(".dx-nav-item.is-active .primary-navigation__copy small");
    expect(shellCss).toContain("color: #fff");
    expect(sourcingCss).toContain("border: 1px solid var(--dx-form-control-border)");
    expect(tokens).toContain("--dx-form-control-border: #c9ced6;");
    expect(sourcingCss).toContain("@media (min-width: 761px)");
    expect(sourcingCss).toContain(".sourcing-order-detail .rework-detail-core-facts");
    expect(sourcingCss).toContain("grid-template-columns: repeat(7, minmax(0, 1fr))");
    expect(sourcingCss).toContain("grid-column: 1 / -1");
    // Main work stays before the optional context and photos in narrow reading order.
    const regions = [
      '<KeyFacts className="sourcing-key-facts"',
      'order-layout-main${',
      '{!financialReadView ? orderLineItems : null}',
      '<ActionBar className="sourcing-owner-actions"',
      '<details className="sourcing-order-context"',
      '<DecisionSummary title=',
      'className="order-layout-aside"',
    ].map(marker => sourcingPage.indexOf(marker));
    expect(regions.every(index => index >= 0)).toBe(true);
    expect(regions).toEqual([...regions].sort((left, right) => left - right));
  });
});
