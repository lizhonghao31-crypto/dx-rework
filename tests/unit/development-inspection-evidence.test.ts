import {describe,expect,it} from "vitest";
import type {DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {validateDevelopmentMeasurements} from "../../apps/api/src/production-platform/development-inspection-evidence.js";
import {developmentSlaRoute} from "../../apps/api/src/production-platform/development-sla-enrollment.js";
const document={sizes:["M","L"],measurements:[{name:"胸围",values:["90","94"]},{name:"衣长",values:["60","62"]}]} as DevelopmentDocument;
describe("development inspection evidence",()=>{
  it("keeps the wash check before dispatch and omits it entirely for no-wash work",()=>{
    const wash=developmentSlaRoute({craft:"印花",washing:"内洗"});
    expect(wash.indexOf("development_pre_wash_check")).toBe(wash.indexOf("development_sewing")+1);
    expect(wash.indexOf("development_washing_dispatch")).toBe(wash.indexOf("development_pre_wash_check")+1);
    expect(wash).not.toContain("development_shipping");
    expect(developmentSlaRoute({craft:"无",washing:"免洗"})).toEqual(["development_pattern","development_cutting","development_sewing","development_tail_check","development_confirmation"]);
  });
  it("accepts exact published positions and size columns, rejects missing or relabelled measurements",()=>{
    const actual=[{name:"胸围",values:["89.5","93"]},{name:"衣长",values:["59","61"]}];
    expect(()=>validateDevelopmentMeasurements(document,actual)).not.toThrow();
    expect(()=>validateDevelopmentMeasurements(document,undefined)).toThrow("实际尺寸");
    expect(()=>validateDevelopmentMeasurements(document,[...actual].reverse())).toThrow();
    expect(()=>validateDevelopmentMeasurements(document,[actual[0]!])).toThrow();
    expect(()=>validateDevelopmentMeasurements(document,[{...actual[0]!,values:["89.5",""]},actual[1]!])).toThrow();
    expect(()=>validateDevelopmentMeasurements(document,[{...actual[0]!,values:["照样","93"]},actual[1]!])).toThrow();
  });
});
