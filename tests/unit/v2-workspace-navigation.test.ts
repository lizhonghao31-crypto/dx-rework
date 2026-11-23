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
  it('preserves original-directory search and independent page positions only in the selected records area',()=>{
    const id='b92e6815-5892-4c51-b3c9-5e70ddbd1546';
    const root=`/ui/digital-production?workspace=designer&section=workspace&development=${id}&area=records`;
    const target=root+'&page=2&search=TEST&originalSearch=%E7%89%88%E6%9C%AC%202&originaldevelopmentPage=2&originalbudgetPage=3&originalinstructionPage=4&originalquotationPage=5';
    expect(developmentWorkspaceReturnUrl(target,'/')).toBe(target);
    for(const suffix of ['&originalbudgetPage=0','&originalbudgetPage=1.5','&originalbudgetPage=1000001','&originalbudgetPage=2&originalbudgetPage=3','&originalSearch='+('x'.repeat(101))])expect(developmentWorkspaceReturnUrl(root+suffix,'/')).toBeNull();
    expect(developmentWorkspaceReturnUrl(root.replace('area=records','area=development')+'&originalSearch=x','/')).toBe(root.replace('area=records','area=development')+'&originalSearch=x');
    expect(developmentWorkspaceReturnUrl('/ui/digital-production?workspace=designer&originalbudgetPage=2','/')).toBeNull();
  });
  it('keeps harmless original-directory state bound to the same source through all real workbench areas',()=>{
    const root='/ui/digital-production?workspace=designer&section=workspace&development=b92e6815-5892-4c51-b3c9-5e70ddbd1546&page=2&search=TEST&originalSearch=needle&originaldevelopmentPage=2';
    for(const area of ['document','development','customer','handover','records','history']){
      const target=root+'&area='+area;expect(developmentWorkspaceReturnUrl(target,'/')).toBe(target);
    }
    expect(developmentWorkspaceReturnUrl(root.replace('&development=b92e6815-5892-4c51-b3c9-5e70ddbd1546','')+'&area=development','/')).toBeNull();
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
