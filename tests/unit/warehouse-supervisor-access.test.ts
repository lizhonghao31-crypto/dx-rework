import { describe, expect, it } from "vitest";
import { hasWarehouseReceivingRole } from "@dx-rework/contracts";
import { accessiblePlatformModules } from "../../apps/web/src/platform-modules.js";
import { assertBusinessExportAllowed } from "../../apps/api/src/access/export-authority.js";

describe("warehouse supervisor inherits receiving while adding cutting read", () => {
  it("admits both warehouse roles and rejects unrelated roles", () => {
    expect(hasWarehouseReceivingRole(["warehouse_receiver"])).toBe(true);
    expect(hasWarehouseReceivingRole(["warehouse_supervisor"])).toBe(true);
    expect(hasWarehouseReceivingRole(["order_merchandiser"])).toBe(false);
    expect(hasWarehouseReceivingRole([])).toBe(false);
  });

  it("exposes receiving and cutting without granting finance or exports", () => {
    const user = { id: "TEST", displayName: "TEST仓库主管", isRoot: false,
      businessRoles: ["warehouse_supervisor"],
      capabilities: ["receiving:create", "receiving:packing_manage", "tools:user", "cutting:orders:view"] };
    expect(accessiblePlatformModules(user).map(module => module.id)).toContain("cutting");
    expect(accessiblePlatformModules({ ...user, businessRoles: ["warehouse_receiver"] }).map(module => module.id)).not.toContain("cutting");
    expect(() => assertBusinessExportAllowed(user.businessRoles, "receiving:export")).toThrow();
  });
});
