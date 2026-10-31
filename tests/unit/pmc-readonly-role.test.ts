import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { canUseCutting } from "@dx-rework/contracts";
import { canUsePatternOrder } from "@dx-rework/contracts/pattern-orders";
import { canUsePatternPrice } from "@dx-rework/contracts/pattern-room";
import { accessiblePlatformModules } from "../../apps/web/src/platform-modules.js";
import { canReadDaxingPrice, canReadSupplierContactData, canReadSupplierPaymentData } from "../../apps/api/src/access/permission-sensitive-field-policy.js";
import { assertBusinessExportAllowed } from "../../apps/api/src/access/export-authority.js";
import { registerToolsRoutes, type ToolsHttpDependencies } from "../../apps/api/src/tools/routes.js";

// Approved PMC reads: explicit expectations, never a copy of the manager's writes.
const reads = ["cutting:orders:view", "dashboard:management:read", "external_responsibility:view", "own_factory:view",
  "pattern_room:catalog:read", "pattern_room:misc:quote", "pattern_room:orders:view", "pattern_room:prices:read",
  "people:read", "process_catalog:read", "receiving:export", "report:export", "report:view", "sourcing:view",
  "supplier_catalog:read", "supplier_contract_data:read", "supplier_profile:read", "todo:view", "wage:export", "wage:view",
  "tools:read", "supplier_onboarding:read", "todo:routing_exception_read"];

describe("PMC independent read-only role", () => {
  it("matches the manager's business modules without acquiring its actions", () => {
    const user = (role: string) => ({ id: "reader", businessRoles: [role], capabilities: reads });
    expect(accessiblePlatformModules(user("pmc")).map(x => x.id).sort())
      .toEqual(accessiblePlatformModules(user("production_management")).map(x => x.id).sort());
    expect(accessiblePlatformModules(user("pmc")).map(x => x.id)).toEqual(expect.arrayContaining(["sourcing", "cutting", "suppliers", "production", "pattern_room", "finance", "rework"]));
  });
  it("opens only the read sides of pattern and cutting, even with forged write capabilities", () => {
    expect(canUseCutting(["pmc"], reads, "cutting:orders:view")).toBe(true);
    expect(canUsePatternOrder(["pmc"], reads, "pattern_room:orders:view")).toBe(true);
    expect(canUsePatternPrice(["pmc"], reads, "pattern_room:prices:read")).toBe(true);
    expect(canUseCutting(["pmc"], [...reads, "cutting:records:create"], "cutting:records:create")).toBe(false);
    expect(canUsePatternOrder(["pmc"], [...reads, "pattern_room:orders:complete"], "pattern_room:orders:complete")).toBe(false);
    expect(canUsePatternPrice(["pmc"], [...reads, "pattern_room:prices:write"], "pattern_room:prices:write")).toBe(false);
    expect(canUsePatternOrder(["pmc", "pattern_room_worker"], [...reads, "pattern_room:orders:complete"], "pattern_room:orders:complete")).toBe(true);
    expect(canUsePatternPrice(["production_management"], ["pattern_room:prices:write"], "pattern_room:prices:write")).toBe(true);
    expect(canUsePatternPrice(["pmc", "production_management"], ["pattern_room:prices:write"], "pattern_room:prices:write")).toBe(true);
  });
  it("matches existing sensitive fields and exports, without expanding unrelated roles", () => {
    for (const role of ["pmc", "production_management"]) {
      expect(canReadDaxingPrice([role], false)).toBe(true);
      expect(canReadSupplierContactData([role], false)).toBe(true);
      expect(canReadSupplierPaymentData([role], false)).toBe(true);
      for (const capability of ["report:export", "receiving:export", "wage:export"]) expect(() => assertBusinessExportAllowed([role], capability)).not.toThrow();
    }
    expect(canReadDaxingPrice(["finance_read"], false)).toBe(false);
    expect(() => assertBusinessExportAllowed(["worker"])).toThrow();
  });
  it("allows attachment reads but refuses uploads/finalization, including forged mixed-use grants", async () => {
    const id = randomUUID(), download = vi.fn(async () => ({ downloadUrl: "https://example.invalid/read" }));
    const upload = vi.fn(), finalize = vi.fn();
    for (const capabilities of [reads, [...reads, "tools:user"]]) {
      const app = Fastify();
      registerToolsRoutes(app, { authenticate: async () => ({ id, businessRoles: ["pmc"], capabilities }),
        attachments: { createDownloadIntent: download, createUploadIntent: upload, finalize },
        exports: { query: vi.fn(async () => ({})) },
      } as unknown as ToolsHttpDependencies);
      try {
        expect((await app.inject({ method: "GET", url: `/tools/attachments/${id}/download` })).statusCode).toBe(200);
        expect((await app.inject({ method: "POST", url: "/tools/attachments/upload-intents", payload: {} })).statusCode).toBe(403);
        expect((await app.inject({ method: "POST", url: `/tools/attachments/${id}/finalize` })).statusCode).toBe(403);
      } finally { await app.close(); }
    }
    expect(download).toHaveBeenCalledTimes(2);expect(upload).not.toHaveBeenCalled();expect(finalize).not.toHaveBeenCalled();
  });
});

import { moduleCanWrite } from "../../apps/web/src/member-module-policy.js";
import { registerPmcReadonlyHttpGuard } from "../../apps/api/src/access/pmc-readonly-http.js";
import { pmcEffectiveCapabilities } from "@dx-rework/contracts";
import { canReadSupplierApplications, canApproveSupplier, canRequestSupplier } from "../../apps/web/src/supplier-onboarding-model.js";

describe("PMC mutation boundary and role union",()=>{
  it("blocks direct business writes and batches, including forged grants, while retaining auth and authorized export reads",async()=>{
    const app=Fastify(),called=vi.fn();
    registerPmcReadonlyHttpGuard(app,async()=>({id:"pmc",businessRoles:["pmc"],capabilities:[...reads,"sourcing:decision:record","tools:user"]}));
    const writes=["/sourcing/cases/x/decision","/production-reporting/orders/x/reports","/work-reports/batch","/pattern-room/prices/hourly","/master-data/suppliers","/cutting/orders/x/records","/todos/routing-exceptions/x/transfer","/acceptance-clock/advance","/auth/unrecognized-business-mutation"];
    for(const path of [...writes,"/auth/logout","/tools/exports","/access/data-export/authorize"]) app.post(path,async()=>{called();return{ok:true};});
    try{
      for(const path of writes) expect((await app.inject({method:"POST",url:path,headers:{cookie:"dx_rework_session=test"}})).statusCode,path).toBe(403);
      expect(called).not.toHaveBeenCalled();
      for(const path of ["/auth/logout","/tools/exports","/access/data-export/authorize"]) expect((await app.inject({method:"POST",url:path,headers:{cookie:"dx_rework_session=test"}})).statusCode).toBe(200);
    }finally{await app.close();}
  });
  it("preserves Root and each existing role's union, without converting PMC into a manager alias",async()=>{
    for(const roles of [["production_management"],["pmc","production_management"],["pmc","worker"]]) {
      expect(pmcEffectiveCapabilities(roles,["sourcing:decision:record","work:report"])).toEqual(["sourcing:decision:record","work:report"]);
    }
    expect(pmcEffectiveCapabilities(["pmc"],[...reads,"work:report"])).toEqual(reads);
    for(const module of ["rework","sourcing"] as const){
      expect(moduleCanWrite({businessRoles:["pmc"]},module)).toBe(false);
      expect(moduleCanWrite({businessRoles:["pmc","worker"]},module)).toBe(true);
      expect(moduleCanWrite({businessRoles:["pmc"],isRoot:true},module)).toBe(true);
    }
    expect(pmcEffectiveCapabilities(["pmc"],["work:report"],true)).toEqual(["work:report"]);
    for(const roles of [["pmc","worker"],["pmc"]]) {
      const app=Fastify();registerPmcReadonlyHttpGuard(app,async()=>({id:"test",businessRoles:roles,capabilities:[]}),async()=>roles.length===1);
      app.post("/business-write",async()=>({ok:true}));
      try{expect((await app.inject({method:"POST",url:"/business-write",headers:{cookie:"dx_rework_session=test"}})).statusCode).toBe(200);}finally{await app.close();}
    }
  });
  it("separates supplier application viewing from approval, resubmission and creation",()=>{
    const pmc={id:"test",businessRoles:["pmc"],capabilities:reads};
    expect(canReadSupplierApplications(pmc)).toBe(true);expect(canApproveSupplier(pmc)).toBe(false);expect(canRequestSupplier(pmc)).toBe(false);
    expect(canApproveSupplier({...pmc,capabilities:[...reads,"supplier_onboarding:approve"]})).toBe(false);
    expect(canReadSupplierApplications({...pmc,businessRoles:["worker"]})).toBe(false);
  });
});
