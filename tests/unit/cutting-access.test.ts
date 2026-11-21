import { describe, expect, it } from "vitest";

import {
  CUTTING_CAPABILITY_ROLES,
  CUTTING_FINANCE_READ_ROLES,
  canUseCutting,
} from "@dx-rework/contracts";
import { canAccessCutting } from "../../apps/web/src/cutting-access.js";

describe("cutting capability boundaries", () => {
  it("lets both cutting roles read and create records", () => {
    for (const role of ["cutting_supervisor", "cutting_worker"]) {
      expect(canUseCutting([role], ["cutting:orders:view"], "cutting:orders:view")).toBe(true);
      expect(canUseCutting([role], ["cutting:records:create"], "cutting:records:create")).toBe(true);
    }
  });

  it("keeps pattern-room and warehouse roles outside cutting", () => {
    for (const role of ["pattern_room_supervisor", "pattern_room_worker", "warehouse_receiver", "worker"]) {
      expect(canUseCutting([role], ["cutting:orders:view"], "cutting:orders:view")).toBe(false);
      expect(canUseCutting([role], ["cutting:records:create"], "cutting:records:create")).toBe(false);
    }
  });

  it("keeps management readers read-only and Root unrestricted", () => {
    for (const role of ["owner_group", "production_management", "order_merchandiser", "warehouse_supervisor"]) {
      expect(canUseCutting([role], ["cutting:orders:view"], "cutting:orders:view")).toBe(true);
      expect(canUseCutting([role], ["cutting:records:create"], "cutting:records:create")).toBe(false);
      expect(canUseCutting([role], ["cutting:records:correct"], "cutting:records:correct")).toBe(false);
    }
    expect(canUseCutting(["root_superuser"], [], "cutting:records:correct")).toBe(true);
  });

  it("preserves the union of a supervisor's independently assigned cutting role", () => {
    const roles = ["warehouse_supervisor", "cutting_worker"];
    expect(canUseCutting(roles, ["cutting:orders:view", "cutting:records:create"], "cutting:records:create")).toBe(true);
    expect(canUseCutting(roles, ["cutting:records:correct"], "cutting:records:correct")).toBe(false);
    expect(canUseCutting(["warehouse_supervisor"], [], "cutting:orders:view")).toBe(false);
  });

  it("declares correction capability only for Root", () => {
    expect(CUTTING_CAPABILITY_ROLES["cutting:records:correct"]).toEqual(["root_superuser"]);
  });

  it("requires both role and capability at the web entry while Root bypasses", () => {
    const base = { id: "u1", displayName: "测试", isRoot: false };
    expect(canAccessCutting({ ...base, businessRoles: ["cutting_worker"], capabilities: ["cutting:orders:view"] })).toBe(true);
    expect(canAccessCutting({ ...base, businessRoles: ["cutting_worker"], capabilities: [] })).toBe(false);
    expect(canAccessCutting({ ...base, businessRoles: ["owner_group"], capabilities: ["cutting:orders:view"] })).toBe(true);
    for (const role of CUTTING_FINANCE_READ_ROLES) {
      expect(canAccessCutting({ ...base, businessRoles: [role], capabilities: ["cutting:orders:view"] })).toBe(true);
      expect(canAccessCutting({ ...base, businessRoles: [role], capabilities: [] })).toBe(false);
      expect(canUseCutting([role], ["cutting:records:create"], "cutting:records:create")).toBe(false);
      expect(canUseCutting([role], ["cutting:records:correct"], "cutting:records:correct")).toBe(false);
    }
    expect(canAccessCutting({ ...base, businessRoles: ["sample_finance"], capabilities: ["cutting:orders:view"] })).toBe(false);
    expect(canAccessCutting({ ...base, businessRoles: ["sample_finance", "finance_read"], capabilities: ["cutting:orders:view"] })).toBe(true);
    expect(canUseCutting(["sample_finance", "cutting_worker"], ["cutting:records:create"], "cutting:records:create")).toBe(true);
    expect(canAccessCutting({ ...base, businessRoles: [], capabilities: [], isRoot: true })).toBe(true);
  });
});
