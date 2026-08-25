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

  it("routes wage users to a page they can actually open", () => {
    expect(landingTarget(user(["wage:view"]))).toBe("ui/wages");
  });

  it("routes each single frontline role directly to its own work page", () => {
    expect(landingTarget(user(["receiving:create", "todo:view"], ["warehouse_receiver"]))).toBe("ui/receiving");
    expect(landingTarget(user(["work:report", "todo:view"], ["worker"]))).toBe("ui/frontline/tasks?kind=worker");
    expect(landingTarget(user(["tail_inspection:report", "todo:view"], ["tail_inspector"]))).toBe("ui/frontline/tasks?kind=tail_inspection");
  });

  it("keeps the frontline chooser only when an account has multiple frontline jobs", () => {
    expect(landingTarget(user(
      ["receiving:create", "work:report", "todo:view"],
      ["warehouse_receiver", "worker"],
    ))).toBe("ui/frontline");
  });

  it("does not treat a role without its matching capability as a direct work entry", () => {
    expect(landingTarget(user(["todo:view"], ["warehouse_receiver"]))).toBe("ui/my-tasks");
  });

  it("keeps Root and management users on the management landing", () => {
    expect(landingTarget({
      ...user(["receiving:create", "todo:view"], ["warehouse_receiver"]),
      isRoot: true,
    })).toBe("ui/management");
    expect(landingTarget(user(
      ["dashboard:management:read", "work:report", "todo:view"],
      ["owner_group", "worker"],
    ))).toBe("ui/management");
  });

  it("routes master-data-only users to a page they can actually open", () => {
    expect(landingTarget(user(["master_data:manage"]))).toBe("ui/master-data");
  });

  it("does not guess an unauthorized default page for an unknown role", () => {
    expect(landingTarget(user([],["unknown_role"]))).toBeNull();
  });
});
