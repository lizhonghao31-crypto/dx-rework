import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import {
  hasPageAccess,
  type AuthorizedUser,
} from "../../apps/web/src/auth.js";
import { landingTarget } from "../../apps/web/src/landing-target.js";

const zeroRoleRoot: AuthorizedUser = {
  displayName: "Root",
  capabilities: [],
  businessRoles: [],
  isRoot: true,
};

describe("zero-role Root UI entry contract", () => {
  it("lets Root enter any page requirement without an ordinary business role", () => {
    expect(hasPageAccess(zeroRoleRoot)).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "owner_group",
      requiredCapability: "access:admin",
    })).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "worker",
      requiredCapability: "work:report",
    })).toBe(true);
    expect(hasPageAccess(zeroRoleRoot, {
      requiredRole: "administrative_clerk",
      requiredCapability: "wage:administrative_review",
    })).toBe(true);
  });

  it("lands a zero-role Root on the management dashboard", () => {
    expect(landingTarget(zeroRoleRoot)).toBe("ui/management");
  });

  it("keeps /auth/me Root-aware instead of deriving access only from role capabilities", async () => {
    const source = await readFile(
      new URL("../../apps/api/src/auth/routes.ts", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const isRoot = options.isRootUser ? await options.isRootUser(user.id) : false;");
    expect(source).toContain('status: user.capabilities.length || isRoot ? "authorized" : "no_role"');
  });

  it("keeps all numbered workflow modules visible to Root", async () => {
    const source = await readFile(
      new URL("../../apps/web/src/components.tsx", import.meta.url),
      "utf8",
    );

    expect(source).toContain("const isRoot = currentUser?.isRoot === true;");
    expect(source).toContain("const managementAccess = isRoot ||");
    expect(source).toContain("const initiationAccess = isRoot ||");
    expect(source).toContain("const processAccess = isRoot ||");
    expect(source).toContain("const workAccess = isRoot ||");
    expect(source).toContain("const responsibilityAccess = isRoot ||");
    expect(source).toContain("const ownFactoryAccess = isRoot ||");
    expect(source).toContain("const externalResponsibilityAccess = isRoot ||");
    expect(source).toContain("const wageAccess = isRoot ||");
    expect(source).toContain("const masterDataAccess = isRoot ||");
    expect(source).toContain("const auditAccess = isRoot ||");
    expect(source).toContain("const technicalAdminAccess = isRoot ||");
    for (let step = 0; step <= 12; step += 1) {
      expect(source).toContain(`step: "${step}"`);
    }
  });
});
