import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

import type { AuthorizedUser } from "../../apps/web/src/auth.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";
import {
  accessiblePlatformModules,
  canAccessSourcing,
  platformLandingTarget,
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

  it("protects sourcing with AuthGate and keeps new CSS token-based and mobile single-column", async () => {
    const [app, platformCss, sourcingCss] = await Promise.all([
      readFile("apps/web/src/App.tsx", "utf8"),
      readFile("apps/web/src/platform-home.css", "utf8"),
      readFile("apps/web/src/sourcing-shell.css", "utf8"),
    ]);
    expect(app).toContain('path === "/ui/sourcing"');
    expect(app).toContain('{ requiredCapability: "sourcing:view" }');
    expect(app).toMatch(/path === "\/ui\/sourcing"[\s\S]*?<AuthGate requiredAnyOf=/);
    expect(platformCss).toContain("var(--dx-v2-");
    expect(platformCss).toContain("@media (max-width: 640px)");
    expect(platformCss).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(sourcingCss).toContain("var(--dx-v2-");
  });
});
