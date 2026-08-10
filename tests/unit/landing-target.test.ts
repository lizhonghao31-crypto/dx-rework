import { describe, expect, it } from "vitest";

import { landingTarget } from "../../apps/web/src/landing-target.js";

const user = (capabilities: string[], businessRoles: string[] = []) => ({
  displayName: "测试用户",
  capabilities,
  businessRoles,
});

describe("business landing target", () => {
  it("routes external payables users to the external responsibility queue", () => {
    expect(landingTarget(user(["external_responsibility:view"]))).toBe("ui/external-responsibilities");
  });

  it("routes responsibility-only users to N07 instead of work reporting", () => {
    expect(landingTarget(user(["responsibility:takeover"]))).toBe("ui/responsibility");
  });

  it("routes wage and work-reporting roles to pages they can actually open", () => {
    expect(landingTarget(user(["wage:view"]))).toBe("ui/wages");
    expect(landingTarget(user(["work:report"], ["worker"]))).toBe("ui/work-reporting");
  });

  it("routes master-data-only users to a page they can actually open", () => {
    expect(landingTarget(user(["master_data:manage"]))).toBe("ui/master-data");
  });

  it("does not guess an unauthorized default page for an unknown role", () => {
    expect(landingTarget(user([],["unknown_role"]))).toBeNull();
  });
});
