import { describe, expect, it } from "vitest";
import { digitalWorkspaceActive } from "../../apps/web/src/digital-workspace-navigation.js";
import { canAccessDigitalProduction, canAccessSourcing, canAccessProduction } from "../../apps/web/src/platform-modules.js";

describe("V2 shell route adapter", () => {
  it("selects only the current digital workspace and leaves domain detail routes alone", () => {
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=pattern")).toBe("digital-pattern");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=preparation&stage=bulk")).toBe("digital-preparation");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=factory")).toBe("digital-factory");
    expect(digitalWorkspaceActive("开发与大货办理", "?workspace=designer")).toBe("digital-designer");
    expect(digitalWorkspaceActive("cutting", "?workspace=pattern")).toBe("cutting");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=unknown")).toBe("生产管理座舱");
  });
  it("retains Root and original non-Root module permissions without granting new capabilities", () => {
    const user = { id: "TEST", displayName: "TEST", capabilities: [], businessRoles: [] as string[] };
    expect(canAccessDigitalProduction({ ...user, isRoot: true })).toBe(true);
    expect(canAccessSourcing({ ...user, isRoot: true })).toBe(true);
    expect(canAccessDigitalProduction({ ...user, businessRoles: ["pattern_room_worker"] })).toBe(true);
    expect(canAccessSourcing({ ...user, businessRoles: ["pattern_room_worker"] })).toBe(false);
    expect(canAccessProduction({ ...user, businessRoles: ["pattern_room_worker"] })).toBe(false);
    expect(canAccessDigitalProduction({ ...user, businessRoles: ["worker"] })).toBe(false);
  });
});
