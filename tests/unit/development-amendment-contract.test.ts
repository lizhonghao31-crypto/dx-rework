import {describe,it,expect} from "vitest";
import {randomUUID} from "node:crypto";
import {initialDevelopmentDocument} from "../../apps/web/src/digital-development-editing.js";
import {DevelopmentDocumentSchema,developmentPublishErrors,type DevelopmentDocument} from "@dx-rework/contracts/digital-development";
import {DevelopmentReturnIssueSchema,developmentAmendmentErrors,SaveDevelopmentAmendmentSchema} from "@dx-rework/contracts/digital-development-amendments";
import {validateDevelopmentReturn} from "../../apps/api/src/production-platform/development-supply.js";
const document=():DevelopmentDocument=>({...initialDevelopmentDocument(),quantity:1,sizeQuantities:[1,0],sampleSize:"M",orderDate:"2026-10-20",files:[{attachmentId:randomUUID(),kind:"款图"}],materials:[]});
const material=(requiredThisRound=false)=>({materialId:randomUUID(),category:"主布" as const,label:"主布A",name:"TEST棉布",specification:"",quantity:"1",color:"黑",supplier:"",width:"",weight:"",composition:"",consumption:"",requiredThisRound,available:true,expectedDate:null});
describe("P02 publication, returns and same-round correction boundaries",()=>{
 it("keeps incomplete draft saveable but applies the same main-fabric specification rule to initial and added rows",()=>{
  for(const required of [false,true]){const value={...document(),materials:[material(required)]};expect(DevelopmentDocumentSchema.safeParse(value).success).toBe(true);expect(developmentPublishErrors(value)).toContain("主布A缺规格，请设计师填写主布规格");value.materials[0]!.specification="TEST 40支";expect(developmentPublishErrors(value)).toEqual([]);}
 });
 it("does not make an empty template material mandatory or add weight/width/supplier requirements",()=>{
  const value=document(),empty={...material(),label:"主布 A",name:"",quantity:"",color:"",available:false};value.materials=[empty];expect(developmentPublishErrors(value)).toEqual([]);value.materials=[{...material(),specification:"40支"}];expect(developmentPublishErrors(value)).toEqual([]);
 });
 it("allows a named material correction without treating the designer as the clerk",()=>{
  const before={...document(),materials:[{...material(),specification:"40支"}]},after=structuredClone(before);after.materials[0]!.specification="42支";expect(developmentAmendmentErrors(before,after)).toEqual([]);after.materials[0]!.requiredThisRound=true;expect(developmentAmendmentErrors(before,after).join()).toContain("文员使用确认");
 });
 it("refuses production quantity/size/craft changes and invented arrival facts through a correction",()=>{
  const before={...document(),materials:[{...material(),available:false}]};for(const patch of [{quantity:2},{sizes:["L"]},{craft:"印花" as const}])expect(developmentAmendmentErrors(before,{...before,...patch}).join()).toContain("复版");const after=structuredClone(before);after.materials[0]!.available=true;expect(developmentAmendmentErrors(before,after).join()).toContain("实物到货");
 });
 it("does not let deleting or clearing a published material bypass the clerk's unused confirmation",()=>{
  const before={...document(),materials:[{...material(),specification:"40支"}]};expect(developmentAmendmentErrors(before,{...before,materials:[]}).join()).toContain("文员的本轮不用确认");
  const blank={...before.materials[0]!,name:"",specification:"",quantity:"",color:"",available:false};expect(developmentAmendmentErrors({...before,materials:[{...before.materials[0]!,available:false}]},{...before,materials:[blank]}).join()).toContain("删除或清空");
 });
 it("requires exact issue location/reason and refuses same-field contradictions while permitting another document issue",()=>{
  const value={...document(),materials:[material()]},id=value.materials[0]!.materialId,base={taskId:randomUUID(),result:"缺项退回" as const,note:"",items:[{materialId:id,physical:true,quantity:true,color:true,specification:true}]};
  expect(()=>validateDevelopmentReturn(value,base)).toThrow("具体材料");expect(()=>validateDevelopmentReturn(value,{...base,returnIssues:[{materialId:id,field:"physical",reason:"未到"}]})).toThrow("矛盾");expect(()=>validateDevelopmentReturn(value,{...base,returnIssues:[{materialId:null,field:"instructions",reason:"说明写错方向"}]})).not.toThrow();
  expect(DevelopmentReturnIssueSchema.safeParse({materialId:null,field:"physical",reason:"未到"}).success).toBe(false);expect(DevelopmentReturnIssueSchema.safeParse({materialId:id,field:"name",reason:""}).success).toBe(false);
 });
 it("validates source/round/version/task identity rather than accepting an unversioned correction",()=>{
  const input={taskId:randomUUID(),roundNumber:1,expectedDocumentVersion:2,expectedDraftVersion:0,document:document(),reason:"补规格"};expect(SaveDevelopmentAmendmentSchema.safeParse(input).success).toBe(true);expect(SaveDevelopmentAmendmentSchema.safeParse({...input,roundNumber:0}).success).toBe(false);expect(SaveDevelopmentAmendmentSchema.safeParse({...input,expectedDocumentVersion:undefined}).success).toBe(false);
 });
});
