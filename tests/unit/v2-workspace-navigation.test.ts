import { describe, expect, it } from "vitest";
import { digitalWorkspaceActive } from "../../apps/web/src/digital-workspace-navigation.js";
import { developmentWorkspaceReturnUrl } from "../../apps/web/src/development-workspace-return.js";
import { canAccessDigitalProduction, canAccessSourcing, canAccessProduction } from "../../apps/web/src/platform-modules.js";

describe("V2 shell route adapter", () => {
  it("selects only the current digital workspace and leaves domain detail routes alone", () => {
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=pattern")).toBe("digital-pattern");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=preparation&stage=bulk")).toBe("digital-pattern");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=factory")).toBe("digital-factory");
    expect(digitalWorkspaceActive("开发与大货办理", "?workspace=designer")).toBe("digital-designer");
    expect(digitalWorkspaceActive("cutting", "?workspace=pattern")).toBe("cutting");
    expect(digitalWorkspaceActive("生产管理座舱", "?workspace=unknown")).toBe("生产管理座舱");
  });
  it("keeps explicit creation and submitted-work entries distinct through safe return links", () => {
    const active=(search:string)=>digitalWorkspaceActive("开发与大货办理",search);
    expect(active("?workspace=designer&section=create")).toBe("digital-designer-create");
    expect(active("?workspace=designer&view=draft")).toBe("digital-designer-create");
    expect(active("?workspace=designer&section=workspace")).toBe("digital-designer");
    expect(active("?workspace=designer&section=create&section=workspace")).toBe("digital-designer");
    const root="/ui/digital-production?workspace=designer";
    const source=root+"&section=workspace&page=2&search=TEST";
    expect(developmentWorkspaceReturnUrl(source,"/")).toBe(source);
    expect(developmentWorkspaceReturnUrl(root+"&section=external","/")).toBeNull();
    expect(developmentWorkspaceReturnUrl(root+"&section=create&section=workspace","/")).toBeNull();
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
