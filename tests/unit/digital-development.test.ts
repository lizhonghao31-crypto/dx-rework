import { describe,expect,it } from "vitest";
import { DEVELOPMENT_MEASUREMENTS, DevelopmentDocumentSchema, developmentPublishErrors } from "@dx-rework/contracts/digital-development";
import { buildTodoDeepLink,buildTodoExternalDeepLink } from "../../apps/api/src/todos/deep-link.js";
const document={documentFormatVersion:2,sizeQuantities:[1,0],template:"上衣",quantity:1,sampleSize:"M",orderDate:"2026-09-30",returnDate:null,unit:"cm",sizes:["M","L"],measurements:[{name:"胸围",values:["100","104"]}],interlining:"",placketInterlining:"",sewingThread:"",buttonholeThread:"",stitchDensity:"",washingIroning:"",packaging:"",formalSizes:"",casualSizes:"",mainLabel:false,mainLabelMethod:"",sizeLabel:false,careLabel:false,instructions:"",craft:"无",washing:"内洗",materials:[],files:[{attachmentId:"11111111-1111-4111-8111-111111111111",kind:"款图"}]};
describe("P05 fixed development form contract",()=>{
  it("preserves both source measurement templates and permits washing without film or craft sample",()=>{
    expect(DEVELOPMENT_MEASUREMENTS.上衣).toHaveLength(11);expect(DEVELOPMENT_MEASUREMENTS.裤子).toHaveLength(9);
    expect(DEVELOPMENT_MEASUREMENTS.裤子).toContain("坐围（浪上3 1/4度）");
    for(const template of ["上衣","裤子"])expect(developmentPublishErrors(DevelopmentDocumentSchema.parse({...document,template}))).toEqual([]);
  });
  it("rejects mismatched size columns, duplicate sizes and spoofed ownership",()=>{
    expect(DevelopmentDocumentSchema.safeParse({...document,sizes:["M","M"]}).success).toBe(false);
    expect(DevelopmentDocumentSchema.safeParse({...document,sizes:["M"]}).success).toBe(false);
    expect(DevelopmentDocumentSchema.safeParse({...document,createdBy:"another-person"}).success).toBe(false);
  });
  it("opens the actual development sheet under the acceptance prefix and refuses external delivery",()=>{
    const route={routeName:"digital_development" as const,entityId:"11111111-1111-4111-8111-111111111111",todoId:"22222222-2222-4222-8222-222222222222"};
    expect(buildTodoDeepLink("/acceptance/",route)).toContain("/acceptance/ui/digital-production?todo=");
    expect(buildTodoDeepLink("/acceptance/",route)).toContain(`development=${route.entityId}`);
    expect(()=>buildTodoExternalDeepLink("https://example.com/",route)).toThrow("仅限站内");
  });
});
