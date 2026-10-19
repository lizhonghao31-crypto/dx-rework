import {expect,it} from "vitest";
import {developmentNextSteps,developmentRoute} from "../../apps/api/src/production-platform/development-route.js";
it("moves no-craft cutting directly into sewing for every washing branch",()=>{
  for(const washing of ["免洗","内洗","外洗"] as const){
    const route=developmentRoute({craft:"无",washing});
    expect(route[route.indexOf("development_cutting")+1]).toBe("development_sewing");
    expect(route).not.toContain("development_sewing_transfer");
  }
});
it("describes the saved revision route without inventing skipped craft or washing nodes",()=>{
  const tasks=[{taskId:"sewing",taskKind:"development_sewing",routeVersion:2},{taskId:"tail",taskKind:"development_tail_check",routeVersion:2},{taskId:"old",taskKind:"development_sewing",routeVersion:1},{taskId:"skipped",taskKind:"development_cutting",routeVersion:2}];
  expect(developmentNextSteps(["development_sewing","development_tail_check","development_confirmation"],tasks,2)).toEqual([{taskId:"sewing",label:"尾查"},{taskId:"tail",label:"设计确认"}]);
});
it("describes material supply and recheck without exposing absent tasks or people",()=>{
  const tasks=[{taskId:"supply",taskKind:"development_material_supply",routeVersion:1},{taskId:"recheck",taskKind:"development_material_recheck",routeVersion:1}];
  expect(developmentNextSteps(developmentRoute({craft:"印花",washing:"外洗"}),tasks,1)).toEqual([{taskId:"supply",label:"物料复核"},{taskId:"recheck",label:"纸样"}]);
});
it("hands revision material checks to the saved successor and does not invent an absent successor",()=>{
  const tasks=[{taskId:"check",taskKind:"development_materials",routeVersion:2},{taskId:"recheck",taskKind:"development_material_recheck",routeVersion:2}];
  expect(developmentNextSteps(["development_materials","development_sewing","development_tail_check"],tasks,2)).toEqual([{taskId:"check",label:"车板"},{taskId:"recheck",label:"车板"}]);
  expect(developmentNextSteps(["development_sewing","development_materials"],tasks,2)).toEqual([]);
  expect(developmentNextSteps(["development_sewing","development_tail_check"],tasks,2)).toEqual([]);
});
it("keeps the clerk handover after craft confirmation",()=>{
  for(const craft of ["印花","绣花","印绣花"] as const){
    const route=developmentRoute({craft,washing:"免洗"});
    expect(route[route.indexOf("development_craft_confirmation")+1]).toBe("development_sewing_transfer");
    expect(route[route.indexOf("development_sewing_transfer")+1]).toBe("development_sewing");
  }
});
it("predicts the saved transfer when a garment craft revision inherits sewing",()=>{
  const route=['development_craft_confirmation','development_sewing_transfer','development_tail_check'];
  const confirmation={taskId:'confirm',taskKind:'development_craft_confirmation',routeVersion:2};
  expect(developmentNextSteps(route,[confirmation],2)).toEqual([{taskId:'confirm',label:'派工/转交车板'}]);
  const transfer={taskId:'transfer',taskKind:'development_sewing_transfer',routeVersion:2};
  expect(developmentNextSteps(route,[confirmation,transfer],2)).toEqual([{taskId:'confirm',label:'派工/转交车板'},{taskId:'transfer',label:'尾查'}]);
  const fullRoute=['development_craft_confirmation','development_sewing_transfer','development_sewing','development_tail_check'];
  expect(developmentNextSteps(fullRoute,[confirmation],2)).toEqual([{taskId:'confirm',label:'车板'}]);
});
