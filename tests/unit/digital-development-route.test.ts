import {expect,it} from "vitest";
import {developmentRoute} from "../../apps/api/src/production-platform/development-route.js";
it("moves no-craft cutting directly into sewing for every washing branch",()=>{
  for(const washing of ["免洗","内洗","外洗"] as const){
    const route=developmentRoute({craft:"无",washing});
    expect(route[route.indexOf("development_cutting")+1]).toBe("development_sewing");
    expect(route).not.toContain("development_sewing_transfer");
  }
});
it("keeps the clerk handover after craft confirmation",()=>{
  for(const craft of ["印花","绣花","印绣花"] as const){
    const route=developmentRoute({craft,washing:"免洗"});
    expect(route[route.indexOf("development_craft_confirmation")+1]).toBe("development_sewing_transfer");
    expect(route[route.indexOf("development_sewing_transfer")+1]).toBe("development_sewing");
  }
});
