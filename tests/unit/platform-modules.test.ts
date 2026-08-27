import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";
import {
  accessiblePlatformModules,
  canAccessSourcing,
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

  it("keeps a rework-only office user direct and sends dual-module users home", () => {
    const office = user(["quality_control"], ["todo:view", "rework:initiate"]);
    expect(platformLandingTarget(office)).toBe(landingTarget(office));
    expect(platformLandingTarget(user(["production_management"], ["todo:view", "sourcing:view"]))).toBe("ui/home");
  });

  it("derives the rework card href from the established landing function", () => {
    const dual = user(["order_merchandiser"], ["todo:view", "sourcing:view"]);
    const modules = accessiblePlatformModules(dual);
    expect(modules.map((module) => module.id)).toEqual(["sourcing", "rework"]);
    expect(modules.find((module) => module.id === "rework")?.href)
      .toBe(landingTarget(dual));
  });


  it("redirects only an unselected legacy default landing and preserves deep links", () => {
    const dual = user(["order_merchandiser"], ["todo:view", "sourcing:view"]);
    expect(shouldRedirectLegacyLandingToPlatformHome(dual, "/ui/my-tasks", "", null)).toBe(true);
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
    const [app, components, platformHome, platformCss, sourcingCss] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/components.tsx", "utf8"),
      readFile("apps/web/src/platform-home-page.tsx", "utf8"),
      readFile("apps/web/src/platform-home.css", "utf8"),
      readFile("apps/web/src/sourcing-workspace.css", "utf8"),
    ]);
    expect(app).toContain('path === "/ui/sourcing"');
    expect(app).toContain('{ requiredCapability: "sourcing:view" }');
    expect(app).toContain('path.startsWith("/ui/sourcing")');
    expect(app).toContain("useInitialPlatformEntryCheck(path, search)");
    expect(platformHome).toContain("platformModuleHref(module)");
    expect(components).toContain('mobile-primary-navigation__label">平台');
    expect(components).toContain("showPlatformHome={currentUser ? canAccessSourcing(currentUser) : false}");
    expect(platformCss).toContain("var(--dx-v2-");
    expect(platformCss).toContain("@media (max-width: 640px)");
    expect(platformCss).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(sourcingCss).toContain("var(--dx-v2-");
  });
});
